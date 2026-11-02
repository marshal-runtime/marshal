import { describe, expect, it, vi } from "vitest";

const readConversationState = vi.hoisted(() =>
  vi.fn<(rolloutPath: string, codexHome: string) => Promise<unknown>>(),
);
vi.mock("./conversation-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./conversation-state")>()),
  readCodexConversationState: readConversationState,
}));

import type { RuntimeSessionEvent } from "../../../common/runtime-events";
import type {
  RuntimeAuthLoginRequest,
  RuntimePermissionRequest,
  RuntimePermissionHandler,
  RuntimePreToolUseHookInput,
  RuntimeProcessHandle,
  RuntimeToolInvocation,
} from "../runtime-contract";
import { CodexRuntimeClient } from "./client";
import type {
  CodexNotification,
  CodexRequestOptions,
  CodexRpcConnection,
  CodexServerRequest,
  CodexServerRequestHandler,
  CodexTransportErrorHandler,
} from "./jsonl-rpc";
import { isRecord, type ResultDecoder } from "./protocol";

interface RequestRecord {
  method: string;
  params: unknown;
  options?: CodexRequestOptions;
}

class FakeConnection implements CodexRpcConnection {
  readonly requests: RequestRecord[] = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readonly process: RuntimeProcessHandle = {
    pid: 99,
    exitCode: null,
    killed: false,
    kill: vi.fn<RuntimeProcessHandle["kill"]>(() => true),
  };
  readonly shutdown = vi.fn<CodexRpcConnection["shutdown"]>(async () => []);
  private readonly responses = new Map<string, unknown[]>();
  private readonly notificationHandlers = new Set<(notification: CodexNotification) => void>();
  private readonly errorHandlers = new Set<CodexTransportErrorHandler>();
  private serverRequestHandler: CodexServerRequestHandler | null = null;
  closed = false;

  isClosed(): boolean {
    return this.closed;
  }

  queue(method: string, response: unknown): void {
    const responses = this.responses.get(method) ?? [];
    responses.push(response);
    this.responses.set(method, responses);
  }

  queueFactory(method: string, response: () => unknown): void {
    this.queue(method, response);
  }

  async request<T>(
    method: string,
    params: unknown,
    decoder: ResultDecoder<T>,
    options?: CodexRequestOptions,
  ): Promise<T> {
    this.requests.push({ method, params, ...(options ? { options } : {}) });
    const responses = this.responses.get(method);
    if (!responses || responses.length === 0) {
      throw new Error(`No fake response queued for ${method}`);
    }
    const queued = responses.shift();
    const raw = typeof queued === "function" ? queued() : queued;
    return decoder(await raw);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.notifications.push({ method, params });
  }

  onNotification(handler: (notification: CodexNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onError(handler: CodexTransportErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  setServerRequestHandler(handler: CodexServerRequestHandler | null): void {
    this.serverRequestHandler = handler;
  }

  emit(method: string, params: unknown): void {
    for (const handler of this.notificationHandlers) handler({ method, params });
  }

  emitError(error: Error): void {
    for (const handler of this.errorHandlers) handler(error);
  }

  async invoke(request: CodexServerRequest): Promise<unknown> {
    if (!this.serverRequestHandler) throw new Error("server request handler is not installed");
    return this.serverRequestHandler(request);
  }
}

function initializeResponse(): unknown {
  return {
    userAgent: "codex-test",
    codexHome: "C:\\codex-home",
    platformFamily: "windows",
    platformOs: "windows",
  };
}

function threadResponse(id = "thread-1", model = "gpt-5.4"): unknown {
  return {
    thread: { id, turns: [] },
    model,
    modelProvider: "openai",
    reasoningEffort: "medium",
  };
}

function turn(id: string, status = "inProgress", items: unknown[] = []): unknown {
  return {
    id,
    items,
    status,
    error: null,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1_000,
  };
}

async function createClient(
  connection: FakeConnection,
  options: { experimentalApi?: boolean } = {},
): Promise<CodexRuntimeClient> {
  connection.queue("initialize", initializeResponse());
  return CodexRuntimeClient.initialize(connection, "C:\\workspace", options);
}

function queueSessionStart(connection: FakeConnection, id = "thread-1"): void {
  connection.queue("thread/start", threadResponse(id));
  connection.queue("mcpServerStatus/list", { data: [], nextCursor: null });
}

function requestByMethod(connection: FakeConnection, method: string): RequestRecord {
  const request = connection.requests.find((entry) => entry.method === method);
  if (!request) throw new Error(`Missing request ${method}`);
  return request;
}

describe("CodexRuntimeClient", () => {
  it("initializes the protocol and projects thread-local tools, MCP, and instructions", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    await client.createSession({
      clientName: "marshal-test",
      model: "gpt-5.4",
      reasoningEffort: "high",
      systemMessage: { content: "Marshal instructions", mode: "replace" },
      mcpServers: {
        local: {
          type: "stdio",
          command: "node",
          args: ["server.js"],
          env: { SAFE: "1" },
          workingDirectory: "C:\\workspace",
          tools: ["read"],
          timeout: 5_000,
        },
        remote: {
          type: "sse",
          url: "https://mcp.example.test/sse",
          headers: { Authorization: "Bearer token" },
        },
      },
      tools: [
        {
          name: "host_tool",
          description: "Host tool",
          eagerLoad: true,
          parameters: { type: "object", properties: { id: { type: "string" } } },
          handler: async () => "ok",
        },
      ],
      onPermissionRequest: () => ({ kind: "approve-once" }),
    });

    expect(requestByMethod(connection, "initialize").params).toEqual({
      clientInfo: {
        name: "marshal",
        title: "Marshal",
        version: "0.162.1",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    expect(connection.notifications).toEqual([{ method: "initialized", params: undefined }]);
    expect(requestByMethod(connection, "thread/start").params).toMatchObject({
      cwd: "C:\\workspace",
      runtimeWorkspaceRoots: ["C:\\workspace"],
      model: "gpt-5.4",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
      baseInstructions: expect.stringContaining("Marshal instructions"),
      config: {
        model_reasoning_effort: "high",
        mcp_servers: {
          local: {
            command: "node",
            args: ["server.js"],
            env: { SAFE: "1" },
            cwd: "C:\\workspace",
            enabled_tools: ["read"],
            default_tools_approval_mode: "prompt",
            tool_timeout_sec: 5,
          },
          remote: {
            url: "https://mcp.example.test/sse",
            http_headers: { Authorization: "Bearer token" },
            default_tools_approval_mode: "prompt",
          },
        },
      },
      dynamicTools: [
        {
          type: "function",
          name: "host_tool",
          description: "Host tool",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      ],
    });
    expect(requestByMethod(connection, "thread/start").params).not.toHaveProperty(
      "developerInstructions",
    );
  });

  it("does not advertise experimental APIs when disabled and rejects dynamic tools", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection, { experimentalApi: false });
    queueSessionStart(connection);

    await expect(
      client.createSession({
        tools: [{ name: "host_tool", handler: async () => "ok" }],
      }),
    ).rejects.toThrow("experimentalApi");
    await client.createSession({});
    expect(requestByMethod(connection, "initialize").params).toMatchObject({
      capabilities: { experimentalApi: false },
    });
    expect(requestByMethod(connection, "thread/start").params).not.toHaveProperty(
      "runtimeWorkspaceRoots",
    );
  });

  it("maps finalized runtime attachments to native media and safe path metadata", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const session = await client.createSession({});
    connection.queue("turn/start", { turn: turn("turn-attachments") });

    await session.send({
      prompt: "Review the attached material",
      attachments: [
        {
          type: "file",
          path: "C:\\workspace\\diagram.PNG",
          displayName: "Architecture",
        },
        { type: "file", path: "C:\\workspace\\recording.mp3" },
        { type: "file", path: "C:\\workspace\\notes.txt", displayName: "Notes" },
        { type: "directory", path: "C:\\workspace\\fixtures", displayName: "Fixtures" },
      ],
    });

    expect(requestByMethod(connection, "turn/start").params).toMatchObject({
      input: [
        {
          type: "text",
          text: "Review the attached material",
          text_elements: [],
        },
        {
          type: "text",
          text:
            "Host-selected local attachments are available at these exact paths:\n" +
            '[{"type":"file","path":"C:\\\\workspace\\\\diagram.PNG","displayName":"Architecture"},' +
            '{"type":"file","path":"C:\\\\workspace\\\\recording.mp3"},' +
            '{"type":"file","path":"C:\\\\workspace\\\\notes.txt","displayName":"Notes"},' +
            '{"type":"directory","path":"C:\\\\workspace\\\\fixtures","displayName":"Fixtures"}]',
          text_elements: [],
        },
        { type: "localImage", path: "C:\\workspace\\diagram.PNG" },
        { type: "localAudio", path: "C:\\workspace\\recording.mp3" },
      ],
    });
  });

  it("streams a turn without emitting a generic running status", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const session = await client.createSession({ model: "gpt-5.4" });
    const events: RuntimeSessionEvent[] = [];
    session.on((event) => events.push(event));
    connection.queue("turn/start", { turn: turn("turn-1") });

    const resultPromise = session.sendAndWait({ prompt: "hello" }, 1_000);
    await vi.waitFor(() =>
      expect(connection.requests.some((request) => request.method === "turn/start")).toBe(true),
    );
    connection.emit("turn/started", {
      threadId: "thread-1",
      turn: turn("turn-1"),
    });
    connection.emit("item/reasoning/summaryTextDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reason-1",
      delta: "Thinking",
      summaryIndex: 0,
    });
    connection.emit("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: "Hello",
    });
    connection.emit("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 2_000,
      item: { type: "agentMessage", id: "message-1", text: "Hello" },
    });
    connection.emit("thread/tokenUsage/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        last: {
          totalTokens: 15,
          inputTokens: 10,
          cachedInputTokens: 3,
          cacheWriteInputTokens: 1,
          outputTokens: 5,
          reasoningOutputTokens: 2,
        },
        total: {
          totalTokens: 915,
          inputTokens: 610,
          cachedInputTokens: 303,
          cacheWriteInputTokens: 1,
          outputTokens: 305,
          reasoningOutputTokens: 2,
        },
        modelContextWindow: 200_000,
      },
    });
    connection.emit("turn/completed", {
      threadId: "thread-1",
      turn: turn("turn-1", "completed", [{ type: "agentMessage", id: "message-1", text: "Hello" }]),
    });

    await expect(resultPromise).resolves.toMatchObject({
      type: "assistant.message",
      data: { content: "Hello", reasoningText: "Thinking" },
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "session.status",
        data: { status: "running" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.usage_info",
        data: { currentTokens: 15, tokenLimit: 200_000 },
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "assistant.reasoning_delta",
      "assistant.message_delta",
      "assistant.message",
      "assistant.usage",
      "session.usage_info",
      "session.status",
      "session.idle",
    ]);
  });

  it("keeps retryable errors and thread-idle status nonterminal", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const session = await client.createSession({});
    const events: RuntimeSessionEvent[] = [];
    session.on((event) => events.push(event));

    connection.emit("error", {
      threadId: "thread-1",
      turnId: "turn-retry",
      willRetry: true,
      error: {
        message: "temporary upstream failure",
        codexErrorInfo: "HttpConnectionFailed",
        additionalDetails: null,
      },
    });
    connection.emit("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "session.status",
        data: {
          status: "retrying",
          message: "temporary upstream failure",
        },
      }),
      expect.objectContaining({
        type: "session.status",
        data: { status: "idle" },
      }),
    ]);
  });

  it("reports a failed turn exactly once, with sign-in guidance for auth failures", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const onErrorOccurred = vi.fn<() => void>();
    const session = await client.createSession({ hooks: { onErrorOccurred } });
    const events: RuntimeSessionEvent[] = [];
    session.on((event) => events.push(event));
    const error = {
      message: "Your access token could not be refreshed. Please log out and sign in again.",
      codexErrorInfo: "unauthorized",
      additionalDetails: null,
    };

    connection.emit("error", { threadId: "thread-1", turnId: "turn-1", willRetry: false, error });
    connection.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", items: [], status: "failed", error },
    });

    const errors = events.filter((event) => event.type === "session.error");
    expect(errors).toEqual([
      expect.objectContaining({
        data: {
          message:
            "Codex isn't signed in or its sign-in expired. Sign in under Settings → Runtime accounts.",
          errorType: "authentication_failed",
        },
      }),
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "session.error",
      "session.status",
      "session.idle",
    ]);
    await Promise.resolve();
    expect(onErrorOccurred).not.toHaveBeenCalled();
  });

  it("reports a usage-limited turn with its reset time, keeping later events in order", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const session = await client.createSession({});
    const events: RuntimeSessionEvent[] = [];
    session.on((event) => events.push(event));
    const resetsAtSeconds = Math.floor(Date.now() / 1_000) + 3_600;
    const weeklyResetSeconds = resetsAtSeconds + 86_400;
    let answerRateLimits!: (value: unknown) => void;
    connection.queueFactory(
      "account/rateLimits/read",
      () =>
        new Promise((resolve) => {
          answerRateLimits = resolve;
        }),
    );
    const error = {
      message: "You've hit your usage limit.",
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: null,
    };

    connection.emit("error", { threadId: "thread-1", turnId: "turn-1", willRetry: false, error });
    connection.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", items: [], status: "failed", error },
    });
    connection.emit("thread/status/changed", { threadId: "thread-1", status: "idle" });
    expect(events).toEqual([]);

    answerRateLimits({
      rateLimits: {
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetsAtSeconds },
        secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: weeklyResetSeconds },
      },
    });
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));

    expect(events.map((event) => event.type)).toEqual([
      "session.error",
      "session.status",
      "session.idle",
      "session.status",
    ]);
    expect(events[0]).toMatchObject({
      data: {
        errorType: "usage_limit",
        retryAt: weeklyResetSeconds * 1_000,
        message: expect.stringMatching(/^Codex usage limit reached\. It resets /),
      },
    });
    expect(requestByMethod(connection, "account/rateLimits/read").options).toEqual({
      timeoutMs: 5_000,
    });
  });

  it("falls back to the last rate-limit update when the read fails, and shows near-limit status", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const session = await client.createSession({});
    const events: RuntimeSessionEvent[] = [];
    session.on((event) => events.push(event));
    connection.queue("turn/start", { turn: turn("turn-1") });
    await session.send({ prompt: "work" });
    const resetsAtSeconds = Math.floor(Date.now() / 1_000) + 600;

    connection.emit("account/rateLimits/updated", {
      rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null } },
    });
    expect(events).toEqual([]);
    connection.emit("account/rateLimits/updated", {
      rateLimits: {
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetsAtSeconds },
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "session.status",
        data: { status: expect.stringContaining("Codex has used 100% of its 5-hour limit") },
      }),
    ]);

    connection.queueFactory("account/rateLimits/read", () => {
      throw new Error("[codex-app-server] account/rateLimits/read timed out after 5000 ms");
    });
    connection.emit("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [],
        status: "failed",
        error: { message: "budget", codexErrorInfo: "sessionBudgetExceeded" },
      },
    });

    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "session.error")).toBe(true),
    );
    expect(events.find((event) => event.type === "session.error")).toMatchObject({
      data: { errorType: "usage_limit", retryAt: resetsAtSeconds * 1_000 },
    });
  });

  it("reads plan usage without a session and falls back to the last notice when the read fails", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    const resetsAtSeconds = Math.floor(Date.now() / 1_000) + 600;
    const account = { type: "chatgpt", email: "user@example.test", planType: "plus" };
    connection.queue("account/read", { account, requiresOpenaiAuth: true });
    connection.queue("account/rateLimits/read", {
      rateLimits: {
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: resetsAtSeconds },
        secondary: { usedPercent: 50, windowDurationMins: 10_080, resetsAt: resetsAtSeconds },
      },
    });

    await expect(client.getUsage()).resolves.toMatchObject({
      available: true,
      plan: "plus",
      windows: [
        { kind: "five_hour", usedPercent: 25, source: "fetch" },
        { kind: "weekly", usedPercent: 50, source: "fetch" },
      ],
    });

    connection.queue("account/read", { account, requiresOpenaiAuth: true });
    connection.queueFactory("account/rateLimits/read", () => {
      throw new Error("[codex-app-server] account/rateLimits/read timed out after 5000 ms");
    });
    await expect(client.getUsage()).resolves.toMatchObject({
      available: true,
      windows: [{ kind: "five_hour", source: "event" }, { kind: "weekly" }],
    });
  });

  it("reports signed-out and API-key Codex accounts as unavailable without reading limits", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    connection.queue("account/read", { account: null, requiresOpenaiAuth: true });
    connection.queue("account/read", { account: { type: "apiKey" }, requiresOpenaiAuth: false });

    await expect(client.getUsage()).resolves.toMatchObject({
      available: false,
      reason: "signed_out",
    });
    await expect(client.getUsage()).resolves.toMatchObject({
      available: false,
      reason: "not_applicable",
    });
  });

  it("keeps the error notification's detail when the failed completion omits it", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const session = await client.createSession({});
    const events: RuntimeSessionEvent[] = [];
    session.on((event) => events.push(event));

    connection.emit("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: {
        message: "stream closed",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
      },
    });
    connection.emit("turn/completed", { threadId: "thread-1", turn: turn("turn-1", "failed") });

    expect(events.filter((event) => event.type === "session.error")).toEqual([
      expect.objectContaining({
        data: { message: "stream closed", errorType: "responseStreamDisconnected" },
      }),
    ]);
  });

  it("replays the MCP snapshot emitted before the first subscriber attaches", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    connection.queue("thread/start", threadResponse());
    connection.queue("mcpServerStatus/list", {
      data: [{ name: "github", authStatus: "oAuth" }],
      nextCursor: null,
    });
    const session = await client.createSession({
      mcpServers: {
        github: { type: "http", url: "https://mcp.example.test" },
      },
    });
    const events: RuntimeSessionEvent[] = [];

    session.on((event) => events.push(event));

    expect(events).toEqual([
      expect.objectContaining({
        type: "session.mcp_servers_loaded",
        data: {
          servers: [
            {
              name: "github",
              status: "connected",
              source: "thread-config",
            },
          ],
        },
      }),
    ]);
  });

  it("uses modifiedPrompt hook output and serializes concurrent turn starts", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    let releaseHook!: () => void;
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const session = await client.createSession({
      hooks: {
        onUserPromptSubmitted: async ({ prompt }) => {
          await hookGate;
          return { modifiedPrompt: `${prompt} [fresh context]` };
        },
      },
    });
    connection.queue("turn/start", { turn: turn("turn-hook") });
    connection.queue("turn/steer", { turnId: "turn-hook" });

    const first = session.send({ prompt: "hello" });
    const overlap = session.send({ prompt: "overlap" });
    releaseHook();
    await expect(first).resolves.toBe("turn-hook");
    await expect(overlap).resolves.toBe("turn-hook");
    expect(requestByMethod(connection, "turn/start").params).toMatchObject({
      input: [
        {
          type: "text",
          text: "hello [fresh context]",
          text_elements: [],
        },
      ],
    });
    expect(connection.requests.filter((request) => request.method === "turn/start")).toHaveLength(
      1,
    );
    expect(requestByMethod(connection, "turn/steer").params).toMatchObject({
      expectedTurnId: "turn-hook",
      input: [{ type: "text", text: "overlap [fresh context]", text_elements: [] }],
    });
  });

  it("drops sends queued behind a turn start that the user aborted", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    let releaseHook!: () => void;
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const session = await client.createSession({
      hooks: { onUserPromptSubmitted: async () => hookGate },
    });

    const first = session.send({ prompt: "first" });
    const queued = session.send({ prompt: "queued" });
    await session.abort();
    releaseHook();
    await expect(first).rejects.toThrow("turn start was aborted");
    await expect(queued).rejects.toThrow("turn start was aborted");
    expect(connection.requests.some((request) => request.method === "turn/start")).toBe(false);

    connection.queue("turn/start", { turn: turn("turn-after-abort") });
    await expect(session.send({ prompt: "next" })).resolves.toBe("turn-after-abort");
  });

  it("ends the turn locally when turn/interrupt does not answer in time", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const session = await client.createSession({});
    const events: RuntimeSessionEvent[] = [];
    session.on((event) => events.push(event));
    connection.queue("turn/start", { turn: turn("turn-stuck") });
    const waiting = session.sendAndWait({ prompt: "long job" });
    await vi.waitFor(() =>
      expect(connection.requests.some((request) => request.method === "turn/start")).toBe(true),
    );
    connection.queueFactory("turn/interrupt", () => {
      throw new Error("[codex-app-server] turn/interrupt timed out after 5000 ms");
    });

    await session.abort();

    expect(requestByMethod(connection, "turn/interrupt").options).toEqual({ timeoutMs: 5_000 });
    await expect(waiting).resolves.toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(["abort", "session.status", "session.idle"]);

    connection.emit("turn/completed", {
      threadId: "thread-1",
      turn: turn("turn-stuck", "interrupted"),
    });
    expect(events.filter((event) => event.type === "session.idle")).toHaveLength(1);

    connection.queue("turn/start", { turn: turn("turn-next") });
    await expect(session.send({ prompt: "again" })).resolves.toBe("turn-next");
    expect(connection.requests.some((request) => request.method === "turn/steer")).toBe(false);
  });

  it("answers currentTime/read with the host clock", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    await client.createSession({});
    const before = Math.floor(Date.now() / 1_000);

    const response = await connection.invoke({
      id: 41,
      method: "currentTime/read",
      params: { threadId: "thread-1" },
    });

    expect(isRecord(response)).toBe(true);
    const currentTimeAt = isRecord(response) ? response["currentTimeAt"] : undefined;
    expect(typeof currentTimeAt).toBe("number");
    expect(currentTimeAt).toBeGreaterThanOrEqual(before);
    expect(currentTimeAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1_000));
  });

  it("refuses an external token refresh and labels the failed turn as a sign-in problem", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const session = await client.createSession({});
    const events: RuntimeSessionEvent[] = [];
    session.on((event) => events.push(event));
    connection.queue("turn/start", { turn: turn("turn-1") });
    await session.send({ prompt: "work" });

    await expect(
      connection.invoke({
        id: 42,
        method: "account/chatgptAuthTokens/refresh",
        params: { reason: "unauthorized", previousAccountId: null },
      }),
    ).rejects.toThrow("external token refresh is not supported");
    connection.emit("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        items: [],
        status: "failed",
        error: { message: "stream error: 401", codexErrorInfo: null, additionalDetails: null },
      },
    });

    expect(events.filter((event) => event.type === "session.error")).toEqual([
      expect.objectContaining({
        data: {
          message:
            "Codex isn't signed in or its sign-in expired. Sign in under Settings → Runtime accounts.",
          errorType: "authentication_failed",
        },
      }),
    ]);
  });

  it("steers a busy turn through turn/steer instead of failing or interrupting", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const session = await client.createSession({
      hooks: {
        onUserPromptSubmitted: async ({ prompt }) => ({ modifiedPrompt: `${prompt} [ctx]` }),
      },
    });
    connection.queue("turn/start", { turn: turn("turn-1") });
    await expect(session.send({ prompt: "start" })).resolves.toBe("turn-1");

    connection.queue("turn/steer", { turnId: "turn-1" });
    await expect(session.send({ prompt: "steer this" })).resolves.toBe("turn-1");

    expect(requestByMethod(connection, "turn/steer").params).toMatchObject({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "steer this [ctx]", text_elements: [] }],
    });
    expect(connection.requests.filter((request) => request.method === "turn/start")).toHaveLength(
      1,
    );
    expect(connection.requests.some((request) => request.method === "turn/interrupt")).toBe(false);
  });

  it("falls back to a fresh turn when the steered turn completes concurrently", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const session = await client.createSession({});
    connection.queue("turn/start", { turn: turn("turn-1") });
    await expect(session.send({ prompt: "start" })).resolves.toBe("turn-1");

    connection.queueFactory("turn/steer", () => {
      connection.emit("turn/completed", {
        threadId: "thread-1",
        turn: turn("turn-1", "completed"),
      });
      throw new Error("[codex-app-server] turn/steer failed (-32602): turn is not active");
    });
    connection.queue("turn/start", { turn: turn("turn-2") });

    await expect(session.send({ prompt: "delivered anyway" })).resolves.toBe("turn-2");
    const starts = connection.requests.filter((request) => request.method === "turn/start");
    expect(starts).toHaveLength(2);
    expect(starts[1].params).toMatchObject({
      input: [{ type: "text", text: "delivered anyway", text_elements: [] }],
    });
  });

  it("rethrows a steer failure while the turn is still active, and a retry delivers once", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const session = await client.createSession({});
    connection.queue("turn/start", { turn: turn("turn-1") });
    await expect(session.send({ prompt: "start" })).resolves.toBe("turn-1");

    connection.queueFactory("turn/steer", () => {
      throw new Error("steer rejected");
    });
    await expect(session.send({ prompt: "retry me" })).rejects.toThrow("steer rejected");
    // The active turn was not restarted or interrupted by the failure.
    expect(connection.requests.filter((request) => request.method === "turn/start")).toHaveLength(
      1,
    );
    expect(connection.requests.some((request) => request.method === "turn/interrupt")).toBe(false);

    // A duplicate retry of the same message delivers exactly once.
    connection.queue("turn/steer", { turnId: "turn-1" });
    await expect(session.send({ prompt: "retry me" })).resolves.toBe("turn-1");
    expect(connection.requests.filter((request) => request.method === "turn/steer")).toHaveLength(
      2,
    );
  });

  it("resolves the original and the steered sendAndWait on the shared turn completion", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const session = await client.createSession({});
    connection.queue("turn/start", { turn: turn("turn-1") });
    const original = session.sendAndWait({ prompt: "start" }, 1_000);
    await vi.waitFor(() =>
      expect(connection.requests.some((request) => request.method === "turn/start")).toBe(true),
    );
    connection.queue("turn/steer", { turnId: "turn-1" });
    const steered = session.sendAndWait({ prompt: "and also" }, 1_000);
    await vi.waitFor(() =>
      expect(connection.requests.some((request) => request.method === "turn/steer")).toBe(true),
    );

    connection.emit("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 2_000,
      item: { type: "agentMessage", id: "message-1", text: "Combined answer" },
    });
    connection.emit("turn/completed", {
      threadId: "thread-1",
      turn: turn("turn-1", "completed", [
        { type: "agentMessage", id: "message-1", text: "Combined answer" },
      ]),
    });

    await expect(original).resolves.toMatchObject({ data: { content: "Combined answer" } });
    await expect(steered).resolves.toMatchObject({ data: { content: "Combined answer" } });
  });

  it("reconciles a completion delivered with the turn-start response", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const session = await client.createSession({});
    connection.queueFactory("turn/start", () => {
      connection.emit("item/completed", {
        threadId: "thread-1",
        turnId: "turn-fast",
        completedAtMs: 2_000,
        item: { type: "agentMessage", id: "message-fast", text: "Fast" },
      });
      connection.emit("turn/completed", {
        threadId: "thread-1",
        turn: turn("turn-fast", "completed", [
          { type: "agentMessage", id: "message-fast", text: "Fast" },
        ]),
      });
      return { turn: turn("turn-fast") };
    });

    await expect(session.sendAndWait({ prompt: "fast" })).resolves.toMatchObject({
      data: { content: "Fast" },
    });
    connection.queue("turn/start", { turn: turn("turn-next") });
    await expect(session.send({ prompt: "next" })).resolves.toBe("turn-next");
  });

  it("fences and interrupts a turn whose start response arrives after abort", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const session = await client.createSession({});
    let resolveTurnStart!: (value: unknown) => void;
    connection.queue(
      "turn/start",
      new Promise<unknown>((resolve) => {
        resolveTurnStart = resolve;
      }),
    );
    connection.queue("turn/interrupt", {});

    const send = session.send({ prompt: "slow start" });
    await vi.waitFor(() =>
      expect(connection.requests.some((request) => request.method === "turn/start")).toBe(true),
    );
    const rejection = send.catch((error: unknown) => error);
    await session.abort();
    await expect(rejection).resolves.toMatchObject({ name: "AbortError" });
    resolveTurnStart({ turn: turn("turn-late") });
    await vi.waitFor(() =>
      expect(
        connection.requests.some(
          (request) =>
            request.method === "turn/interrupt" &&
            isRecord(request.params) &&
            request.params["turnId"] === "turn-late",
        ),
      ).toBe(true),
    );
  });

  it("executes dynamic tools with correlation and abort signals", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    let secondInvocation: RuntimeToolInvocation | undefined;
    const handler = vi
      .fn<(args: unknown, invocation: RuntimeToolInvocation) => Promise<string>>()
      .mockResolvedValueOnce("first result")
      .mockImplementationOnce(async (_args, invocation) => {
        secondInvocation = invocation;
        return new Promise<string>((_resolve, reject) => {
          invocation.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      });
    const onPermissionRequest = vi.fn<RuntimePermissionHandler>(async () => ({
      kind: "approve-once",
    }));
    await client.createSession({
      tools: [
        {
          name: "host_tool",
          description: "Host tool",
          supportsAbortSignal: true,
          handler,
        },
      ],
      onPermissionRequest,
    });

    await expect(
      connection.invoke({
        id: 40,
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          namespace: null,
          tool: "host_tool",
          arguments: { id: 1 },
        },
      }),
    ).resolves.toEqual({
      contentItems: [{ type: "inputText", text: "first result" }],
      success: true,
    });
    expect(handler).toHaveBeenCalledWith(
      { id: 1 },
      expect.objectContaining({
        sessionId: "thread-1",
        toolCallId: "call-1",
        toolName: "host_tool",
      }),
    );
    expect(onPermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "custom-tool",
        toolCallId: "call-1",
        toolName: "host_tool",
      }),
      { sessionId: "thread-1" },
    );

    const pending = connection.invoke({
      id: "server-2",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-2",
        callId: "call-2",
        namespace: null,
        tool: "host_tool",
        arguments: {},
      },
    });
    await vi.waitFor(() => expect(secondInvocation).toBeDefined());
    connection.emit("serverRequest/resolved", {
      threadId: "thread-1",
      requestId: "server-2",
    });
    await vi.waitFor(() => expect(secondInvocation?.signal?.aborted).toBe(true));

    await expect(pending).resolves.toEqual({
      contentItems: [
        { type: "inputText", text: "Host tool request was cancelled before execution" },
      ],
      success: false,
    });
  });

  it("fails dynamic tool execution closed when host permission is denied", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const handler = vi.fn<(args: unknown, invocation: RuntimeToolInvocation) => Promise<string>>(
      async () => "must not run",
    );
    await client.createSession({
      tools: [{ name: "host_tool", handler }],
      onPermissionRequest: () => ({ kind: "reject", feedback: "blocked" }),
    });

    await expect(
      connection.invoke({
        id: 41,
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-denied",
          namespace: null,
          tool: "host_tool",
          arguments: {},
        },
      }),
    ).resolves.toEqual({
      contentItems: [{ type: "inputText", text: "blocked" }],
      success: false,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not execute a dynamic tool after its server request is resolved", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const handler = vi.fn<(args: unknown, invocation: RuntimeToolInvocation) => Promise<string>>(
      async () => "must not run",
    );
    let permissionStarted!: () => void;
    const permissionObserved = new Promise<void>((resolve) => {
      permissionStarted = resolve;
    });
    await client.createSession({
      tools: [{ name: "host_tool", handler }],
      onPermissionRequest: async () => {
        permissionStarted();
        return new Promise<never>(() => {});
      },
    });

    const pending = connection.invoke({
      id: "cancel-before-execute",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-cancelled",
        namespace: null,
        tool: "host_tool",
        arguments: {},
      },
    });
    await permissionObserved;
    connection.emit("serverRequest/resolved", {
      threadId: "thread-1",
      requestId: "cancel-before-execute",
    });

    await expect(pending).resolves.toEqual({
      contentItems: [
        { type: "inputText", text: "Host tool use is unavailable without user approval" },
      ],
      success: false,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("aborts pending server requests when the transport fails", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const handler = vi.fn<(args: unknown, invocation: RuntimeToolInvocation) => Promise<string>>(
      async () => "must not run",
    );
    let permissionStarted!: () => void;
    const permissionObserved = new Promise<void>((resolve) => {
      permissionStarted = resolve;
    });
    await client.createSession({
      tools: [{ name: "host_tool", handler }],
      onPermissionRequest: async () => {
        permissionStarted();
        return new Promise<never>(() => {});
      },
    });
    const pending = connection.invoke({
      id: "transport-failure",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-transport",
        namespace: null,
        tool: "host_tool",
        arguments: {},
      },
    });
    await permissionObserved;

    connection.closed = true;
    connection.emitError(new Error("connection lost"));

    await expect(pending).resolves.toEqual({
      contentItems: [
        { type: "inputText", text: "Host tool use is unavailable without user approval" },
      ],
      success: false,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("interrupts native tools when the host pre-tool hook denies them", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const onPermissionRequest = vi.fn<RuntimePermissionHandler>(async () => ({
      kind: "approve-once",
    }));
    await client.createSession({
      hooks: {
        onPreToolUse: () => ({
          permissionDecision: "deny",
          permissionDecisionReason: "resource limit",
        }),
      },
      onPermissionRequest,
    });
    connection.queue("turn/interrupt", {});
    connection.emit("item/started", {
      threadId: "thread-1",
      turnId: "turn-denied",
      startedAtMs: 1_000,
      item: {
        type: "commandExecution",
        id: "command-denied",
        command: "git status",
        cwd: "C:\\workspace",
        status: "inProgress",
      },
    });
    await vi.waitFor(() =>
      expect(connection.requests.some((request) => request.method === "turn/interrupt")).toBe(true),
    );

    await expect(
      connection.invoke({
        id: 42,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-denied",
          itemId: "command-denied",
          startedAtMs: 1,
          environmentId: "local",
          command: "git status",
          cwd: "C:\\workspace",
        },
      }),
    ).resolves.toEqual({ decision: "decline" });
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });

  it("declines MCP approval when the correlated pre-tool hook denies it", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const onPermissionRequest = vi.fn<RuntimePermissionHandler>(async () => ({
      kind: "approve-once",
    }));
    await client.createSession({
      hooks: {
        onPreToolUse: () => ({
          permissionDecision: "deny",
          permissionDecisionReason: "MCP tool blocked",
        }),
      },
      onPermissionRequest,
    });
    connection.queue("turn/interrupt", {});
    connection.emit("item/started", {
      threadId: "thread-1",
      turnId: "turn-mcp",
      startedAtMs: 1_000,
      item: {
        type: "mcpToolCall",
        id: "mcp-item",
        server: "github",
        tool: "delete_issue",
        arguments: { id: 7 },
        status: "inProgress",
      },
    });

    await expect(
      connection.invoke({
        id: 43,
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-mcp",
          serverName: "github",
          mode: "form",
          message: "Approve tool",
          requestedSchema: {},
          _meta: {
            codex_approval_kind: "mcp_tool_call",
            tool_name: "delete_issue",
            tool_params: { id: 7 },
          },
        },
      }),
    ).resolves.toEqual({ action: "decline", content: null, _meta: null });
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });

  it("requires a separate visible gate for command-level extra permissions", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const seen: RuntimePermissionRequest[] = [];
    await client.createSession({
      onPermissionRequest: async (request) => {
        seen.push(request);
        return request.kind === "shell"
          ? { kind: "approve-once" }
          : { kind: "reject", feedback: "extra access denied" };
      },
    });

    await expect(
      connection.invoke({
        id: 44,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-extra",
          itemId: "command-extra",
          startedAtMs: 1,
          environmentId: "local",
          command: "curl https://example.test",
          cwd: "C:\\workspace",
          additionalPermissions: {
            network: { enabled: true },
            fileSystem: null,
          },
          networkApprovalContext: { host: "example.test" },
        },
      }),
    ).resolves.toEqual({ decision: "decline" });
    expect(seen).toEqual([
      expect.objectContaining({ kind: "shell", toolCallId: "command-extra" }),
      expect.objectContaining({
        kind: "custom-tool",
        toolCallId: "command-extra",
        toolName: expect.stringMatching(/^codex_request_permissions_[0-9a-f]{16}$/),
        toolArgs: expect.objectContaining({
          additionalPermissions: {
            network: { enabled: true },
            fileSystem: null,
          },
          networkApprovalContext: { host: "example.test" },
        }),
      }),
    ]);
  });

  it("interrupts a native sub-agent's turn when the host pre-tool hook denies its tool", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const onPreToolUse = vi.fn<(input: RuntimePreToolUseHookInput) => unknown>(() => ({
      permissionDecision: "deny",
      permissionDecisionReason: "resource limit",
    }));
    await client.createSession({ hooks: { onPreToolUse } });
    connection.emit("thread/started", {
      thread: { id: "child-1", turns: [], parentThreadId: "thread-1" },
    });
    connection.queue("turn/interrupt", {});

    connection.emit("item/started", {
      threadId: "child-1",
      turnId: "turn-child",
      startedAtMs: 1_000,
      item: {
        type: "commandExecution",
        id: "child-command",
        command: "rm -rf build",
        cwd: "C:\\workspace",
        status: "inProgress",
      },
    });

    await vi.waitFor(() =>
      expect(requestByMethod(connection, "turn/interrupt").params).toEqual({
        threadId: "child-1",
        turnId: "turn-child",
      }),
    );
    expect(onPreToolUse).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "shell" }),
      expect.anything(),
    );
  });

  it("answers a native sub-agent's approvals through the root session and keeps its chatter out", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const seenPaths: string[] = [];
    const session = await client.createSession({
      onPermissionRequest: async (request) => {
        seenPaths.push(typeof request["path"] === "string" ? request["path"] : "");
        return { kind: "approve-once" };
      },
    });
    const events: RuntimeSessionEvent[] = [];
    session.on((event) => events.push(event));
    connection.queue("turn/start", { turn: turn("turn-root") });
    await session.send({ prompt: "split the work" });

    connection.emit("thread/started", {
      thread: {
        id: "child-1",
        turns: [],
        parentThreadId: null,
        source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 1 } } },
      },
    });
    connection.emit("item/started", {
      threadId: "child-1",
      turnId: "turn-child",
      startedAtMs: 1_000,
      item: {
        type: "fileChange",
        id: "child-file",
        status: "inProgress",
        changes: [{ path: "C:\\workspace\\child.ts", kind: "update", diff: "@@" }],
      },
    });
    connection.emit("item/agentMessage/delta", {
      threadId: "child-1",
      turnId: "turn-child",
      itemId: "child-message",
      delta: "child says hi",
    });

    await expect(
      connection.invoke({
        id: 70,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "child-1",
          turnId: "turn-child",
          itemId: "child-file",
          startedAtMs: 1,
          reason: null,
          grantRoot: null,
        },
      }),
    ).resolves.toEqual({ decision: "accept" });
    connection.emit("turn/completed", {
      threadId: "child-1",
      turn: turn("turn-child", "completed"),
    });
    expect(seenPaths).toEqual(["C:\\workspace\\child.ts"]);
    expect(events).toEqual([]);
  });

  it("learns grandchild threads from collab-agent items and asks the server for unknown ones", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const onPermissionRequest = vi.fn<RuntimePermissionHandler>(async () => ({
      kind: "approve-once",
    }));
    await client.createSession({ onPermissionRequest });
    const commandApproval = (id: number, threadId: string): CodexServerRequest => ({
      id,
      method: "item/commandExecution/requestApproval",
      params: { threadId, turnId: "turn-x", itemId: `cmd-${id}`, command: "ls" },
    });

    connection.emit("item/started", {
      threadId: "thread-1",
      turnId: "turn-root",
      startedAtMs: 1_000,
      item: {
        type: "collabAgentToolCall",
        id: "spawn-1",
        tool: "spawn_agent",
        senderThreadId: "thread-1",
        receiverThreadIds: ["child-a"],
      },
    });
    connection.emit("item/completed", {
      threadId: "child-a",
      turnId: "turn-a",
      completedAtMs: 1_000,
      item: {
        type: "collabAgentToolCall",
        id: "spawn-2",
        tool: "spawn_agent",
        senderThreadId: "child-a",
        receiverThreadIds: ["grandchild"],
      },
    });
    await expect(connection.invoke(commandApproval(71, "grandchild"))).resolves.toEqual({
      decision: "accept",
    });

    connection.queue("thread/read", {
      thread: { id: "missed-child", turns: [], parentThreadId: "thread-1" },
    });
    await expect(connection.invoke(commandApproval(72, "missed-child"))).resolves.toEqual({
      decision: "accept",
    });
    expect(requestByMethod(connection, "thread/read").params).toEqual({
      threadId: "missed-child",
      includeTurns: false,
    });

    connection.queue("thread/read", { thread: { id: "stranger", turns: [] } });
    await expect(connection.invoke(commandApproval(73, "stranger"))).rejects.toThrow(
      "server request targets an inactive thread",
    );
    expect(onPermissionRequest).toHaveBeenCalledTimes(2);
  });

  it("authorizes every path in a multi-file patch before accepting it", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const seenPaths: string[] = [];
    await client.createSession({
      onPermissionRequest: async (request) => {
        const path = typeof request["path"] === "string" ? request["path"] : "";
        seenPaths.push(path);
        return path.endsWith("safe.ts") ? { kind: "approve-once" } : { kind: "reject" };
      },
    });
    connection.emit("item/started", {
      threadId: "thread-1",
      turnId: "turn-files",
      startedAtMs: 1_000,
      item: {
        type: "fileChange",
        id: "file-many",
        status: "inProgress",
        changes: [
          {
            path: "C:\\workspace\\safe.ts",
            kind: {
              type: "update",
              move_path: "C:\\Users\\user\\.ssh\\config",
            },
            diff: "@@",
          },
        ],
      },
    });

    await expect(
      connection.invoke({
        id: 45,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-files",
          itemId: "file-many",
          startedAtMs: 1,
          reason: "edit files",
          grantRoot: null,
        },
      }),
    ).resolves.toEqual({ decision: "decline" });
    expect(seenPaths).toEqual(["C:\\workspace\\safe.ts", "C:\\Users\\user\\.ssh\\config"]);
  });

  it("routes command, file, MCP, and permission approvals with request correlation", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const seen: RuntimePermissionRequest[] = [];
    await client.createSession({
      onPermissionRequest: async (request) => {
        seen.push(request);
        return { kind: "approve-once" };
      },
    });
    connection.emit("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 1_000,
      item: {
        type: "fileChange",
        id: "file-1",
        status: "inProgress",
        changes: [{ path: "C:\\workspace\\file.ts", kind: "update", diff: "@@" }],
      },
    });

    await expect(
      connection.invoke({
        id: 50,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "command-1",
          startedAtMs: 1,
          approvalId: "approval-1",
          environmentId: "local",
          command: "git status",
          cwd: "C:\\workspace",
          reason: "inspect",
          commandActions: [],
        },
      }),
    ).resolves.toEqual({ decision: "accept" });
    await expect(
      connection.invoke({
        id: "file-request",
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "file-1",
          startedAtMs: 1,
          reason: "edit",
          grantRoot: null,
        },
      }),
    ).resolves.toEqual({ decision: "accept" });
    await expect(
      connection.invoke({
        id: 52,
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          serverName: "github",
          mode: "form",
          message: "Approve tool",
          requestedSchema: {},
          _meta: {
            codex_approval_kind: "mcp_tool_call",
            tool_name: "delete_issue",
            tool_title: "Delete issue",
            tool_description: "Deletes one issue.",
            tool_params: { id: 7 },
          },
        },
      }),
    ).resolves.toEqual({ action: "accept", content: null, _meta: null });
    await expect(
      connection.invoke({
        id: 53,
        method: "item/permissions/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "permission-1",
          environmentId: "local",
          startedAtMs: 1,
          cwd: "C:\\workspace",
          reason: "write elsewhere",
          permissions: { fileSystem: { write: ["C:\\other"] }, network: null },
        },
      }),
    ).resolves.toEqual({
      permissions: { fileSystem: { write: ["C:\\other"] }, network: null },
      scope: "turn",
    });

    expect(seen).toEqual([
      expect.objectContaining({
        kind: "shell",
        toolCallId: "command-1",
        requestId: 50,
        approvalId: "approval-1",
      }),
      expect.objectContaining({
        kind: "write",
        toolCallId: "file-1",
        requestId: "file-request",
        path: "C:\\workspace\\file.ts",
      }),
      expect.objectContaining({
        kind: "mcp",
        requestId: 52,
        serverName: "github",
        toolName: "delete_issue",
        toolTitle: "Delete issue",
        toolArgs: { id: 7 },
      }),
      expect.objectContaining({
        kind: "custom-tool",
        toolCallId: "permission-1",
        requestId: 53,
        toolName: expect.stringMatching(/^codex_request_permissions_[0-9a-f]{16}$/),
        toolArgs: expect.objectContaining({
          permissions: { fileSystem: { write: ["C:\\other"] }, network: null },
        }),
      }),
    ]);
  });

  it("unwraps the login-shell wrapper before requesting shell approval", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const seen: RuntimePermissionRequest[] = [];
    await client.createSession({
      onPermissionRequest: async (request) => {
        seen.push(request);
        return { kind: "approve-once" };
      },
    });

    await connection.invoke({
      id: 60,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-wrapped",
        startedAtMs: 1,
        environmentId: "local",
        command: "/bin/zsh -lc 'git status && ls'",
        cwd: "/workspace",
      },
    });
    await connection.invoke({
      id: 61,
      method: "execCommandApproval",
      params: {
        threadId: "thread-1",
        callId: "legacy-wrapped",
        command: ["/bin/zsh", "-lc", "git status && ls"],
        cwd: "/workspace",
        reason: null,
      },
    });
    // A non-wrapper command must pass through untouched.
    await connection.invoke({
      id: 62,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-plain",
        startedAtMs: 1,
        environmentId: "local",
        command: "git status",
        cwd: "/workspace",
      },
    });

    expect(seen).toEqual([
      expect.objectContaining({
        kind: "shell",
        toolCallId: "command-wrapped",
        command: "git status && ls",
        fullCommandText: "git status && ls",
      }),
      expect.objectContaining({
        kind: "shell",
        toolCallId: "legacy-wrapped",
        command: "git status && ls",
        fullCommandText: "git status && ls",
      }),
      expect.objectContaining({
        kind: "shell",
        toolCallId: "command-plain",
        command: "git status",
      }),
    ]);
  });

  it("fails approvals closed when the user is unavailable", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    await client.createSession({});

    await expect(
      connection.invoke({
        id: 60,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "command-1",
          startedAtMs: 1,
          environmentId: null,
          command: "rm file",
          cwd: "C:\\workspace",
        },
      }),
    ).resolves.toEqual({ decision: "decline" });
  });

  it("maps account login flows, auth status, models, MCP status, and OAuth", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    connection.queue("account/read", {
      account: { type: "chatgpt", email: "user@example.test", planType: "pro" },
      requiresOpenaiAuth: true,
    });
    connection.queue("model/list", {
      data: [
        {
          id: "gpt-5.4",
          model: "gpt-5.4",
          displayName: "GPT-5.4",
          description: "Model",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low" },
            { reasoningEffort: "ultra", description: "Ultra" },
          ],
          defaultReasoningEffort: "low",
          inputModalities: ["text", "image"],
          isDefault: true,
        },
      ],
      nextCursor: null,
    });
    connection.queue("account/login/start", {
      type: "chatgpt",
      loginId: "login-browser",
      authUrl: "https://auth.example.test",
    });
    connection.queue("account/login/start", {
      type: "chatgptDeviceCode",
      loginId: "login-device",
      verificationUrl: "https://device.example.test",
      userCode: "ABCD",
    });
    connection.queue("account/login/start", { type: "chatgptAuthTokens" });
    connection.queue("account/logout", {});

    await expect(client.getAuthStatus()).resolves.toEqual({
      isAuthenticated: true,
      login: "user@example.test",
      statusMessage: "pro",
    });
    await expect(client.listModels()).resolves.toEqual([
      expect.objectContaining({
        id: "gpt-5.4",
        name: "GPT-5.4",
        featured: true,
        supportedReasoningEfforts: ["low"],
        defaultReasoningEffort: "low",
        capabilities: expect.objectContaining({ supportsVision: true }),
      }),
    ]);
    await expect(client.login({ type: "browser" })).resolves.toEqual({
      status: "pending",
      method: "browser",
      loginId: "login-browser",
      authorizationUrl: "https://auth.example.test",
    });
    await expect(client.login({ type: "device-code" })).resolves.toEqual({
      status: "pending",
      method: "device-code",
      loginId: "login-device",
      verificationUri: "https://device.example.test",
      userCode: "ABCD",
    });
    const externalToken: RuntimeAuthLoginRequest = {
      type: "external-token",
      accessToken: "secret",
      accountId: "account-1",
      planType: "pro",
    };
    await expect(client.login(externalToken)).resolves.toEqual({ status: "authenticated" });
    expect(
      connection.requests.filter((request) => request.method === "account/login/start")[2],
    ).toEqual({
      method: "account/login/start",
      params: {
        type: "chatgptAuthTokens",
        accessToken: "secret",
        chatgptAccountId: "account-1",
        chatgptPlanType: "pro",
      },
    });
    await expect(client.logout()).resolves.toBeUndefined();

    queueSessionStart(connection);
    connection.queue("mcpServerStatus/list", {
      data: [{ name: "github", authStatus: "notLoggedIn" }],
      nextCursor: null,
    });
    connection.queue("mcpServer/oauth/login", {
      authorizationUrl: "https://mcp.example.test/oauth",
    });
    const session = await client.createSession({});
    await expect(session.rpc?.mcp?.list?.()).resolves.toEqual({
      data: [{ name: "github", authStatus: "notLoggedIn" }],
      nextCursor: null,
    });
    await expect(session.rpc?.mcp?.oauth?.login({ serverName: "github" })).resolves.toEqual({
      authorizationUrl: "https://mcp.example.test/oauth",
    });
  });

  it("resumes, reads, interrupts, unsubscribes, deletes, and shuts down threads", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    connection.queue("thread/resume", threadResponse("thread-existing"));
    connection.queue("mcpServerStatus/list", { data: [], nextCursor: null });
    const session = await client.resumeSession("thread-existing", { model: "gpt-5.4" });
    connection.queue("turn/start", { turn: turn("turn-existing") });
    connection.queue("turn/interrupt", {});
    connection.queue("thread/read", {
      thread: {
        id: "thread-existing",
        turns: [
          turn("turn-history", "completed", [
            { type: "agentMessage", id: "history-message", text: "History" },
          ]),
        ],
      },
    });
    connection.queue("thread/unsubscribe", { status: "unsubscribed" });
    connection.queue("thread/delete", {});

    await expect(session.send({ prompt: "continue" })).resolves.toBe("turn-existing");
    await expect(session.abort()).resolves.toBeUndefined();
    await expect(session.getMessages()).resolves.toEqual([
      expect.objectContaining({
        type: "assistant.message",
        data: { messageId: "history-message", content: "History" },
      }),
    ]);
    await expect(session.disconnect()).resolves.toBeUndefined();
    await expect(client.deleteSession("thread-existing")).resolves.toBeUndefined();
    await expect(client.stop()).resolves.toEqual([]);

    expect(connection.requests.map((request) => request.method)).toEqual(
      expect.arrayContaining([
        "thread/resume",
        "turn/start",
        "turn/interrupt",
        "thread/read",
        "thread/unsubscribe",
        "thread/delete",
      ]),
    );
    expect(connection.shutdown).toHaveBeenCalledWith({ force: false });
  });

  it("bounds session-end hooks independently from transport shutdown", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    await client.createSession({
      hooks: {
        onSessionEnd: () => new Promise<void>(() => {}),
      },
    });
    vi.useFakeTimers();
    try {
      const stopping = client.stop();
      expect(connection.shutdown).toHaveBeenCalledWith({ force: false });
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(stopping).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a process crash during a turn once, with reconnect guidance, and closes the session", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const session = await client.createSession({});
    const events: RuntimeSessionEvent[] = [];
    session.on((event) => events.push(event));
    connection.queue("turn/start", { turn: turn("turn-1") });
    await session.send({ prompt: "work" });

    connection.closed = true;
    connection.emitError(new Error("process crashed"));
    connection.emitError(new Error("process crashed"));

    expect(events.filter((event) => event.type === "session.error")).toEqual([
      expect.objectContaining({
        data: {
          message:
            "Codex stopped unexpectedly and this reply was cut short. Send your message again to reconnect.",
          errorType: "connection_lost",
        },
      }),
    ]);
    expect(session.isClosed()).toBe(true);
    expect(client.isClosed()).toBe(true);
  });

  it("closes idle sessions silently when the process dies", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const session = await client.createSession({});
    const events: RuntimeSessionEvent[] = [];
    session.on((event) => events.push(event));

    connection.closed = true;
    connection.emitError(new Error("process exited with code 1"));

    expect(events.filter((event) => event.type === "session.error")).toEqual([]);
    expect(session.isClosed()).toBe(true);
  });

  it("keeps sessions open after a non-fatal transport error", async () => {
    const connection = new FakeConnection();
    const client = await createClient(connection);
    queueSessionStart(connection);
    const session = await client.createSession({});

    connection.emitError(new Error("Codex notification handler failed"));

    expect(session.isClosed()).toBe(false);
    expect(client.isClosed()).toBe(false);
  });
  describe("tool set drift on resume", () => {
    const handler = async () => "ok";
    const toolsV1 = [{ name: "alpha", parameters: { type: "object" }, eagerLoad: true, handler }];
    const toolsV2 = [
      { name: "alpha", parameters: { type: "object" }, eagerLoad: true, handler },
      { name: "beta", parameters: { type: "object" }, eagerLoad: true, handler },
    ];
    const handoffState = {
      version: 1 as const,
      sourceRuntimeId: "codex",
      messages: [{ role: "user" as const, content: "earlier" }],
    };

    async function startThreadWithTools(
      connection: FakeConnection,
      client: CodexRuntimeClient,
      tools: typeof toolsV1,
    ): Promise<void> {
      queueSessionStart(connection, "thread-old");
      await client.createSession({ tools });
    }

    it("resumes the same thread when the tool set is unchanged", async () => {
      const connection = new FakeConnection();
      const client = await createClient(connection);
      await startThreadWithTools(connection, client, toolsV1);
      connection.queue("thread/resume", threadResponse("thread-old"));
      connection.queue("mcpServerStatus/list", { data: [], nextCursor: null });

      const session = await client.resumeSession("thread-old", { tools: [...toolsV1].reverse() });

      expect(session.sessionId).toBe("thread-old");
      expect(session.takeResumeHandoff?.()).toBeUndefined();
      expect(connection.requests.filter((entry) => entry.method === "thread/start")).toHaveLength(
        1,
      );
    });

    it("starts a new thread with the current tools and hands the old context to the host", async () => {
      const connection = new FakeConnection();
      const client = await createClient(connection);
      await startThreadWithTools(connection, client, toolsV1);
      readConversationState.mockResolvedValueOnce(handoffState);
      connection.queue("thread/read", {
        thread: { id: "thread-old", path: "/home/rollout.jsonl", turns: [] },
      });
      queueSessionStart(connection, "thread-new");

      const session = await client.resumeSession("thread-old", { tools: toolsV2 });

      expect(session.sessionId).toBe("thread-new");
      expect(connection.requests.map((entry) => entry.method)).not.toContain("thread/resume");
      const restart = connection.requests.filter((entry) => entry.method === "thread/start")[1];
      expect(restart?.params).toMatchObject({
        dynamicTools: [
          expect.objectContaining({ name: "alpha" }),
          expect.objectContaining({ name: "beta" }),
        ],
      });
      expect(session.takeResumeHandoff?.()).toEqual(handoffState);
      expect(session.takeResumeHandoff?.()).toBeUndefined();

      connection.queue("thread/resume", threadResponse("thread-new"));
      connection.queue("mcpServerStatus/list", { data: [], nextCursor: null });
      const again = await client.resumeSession("thread-new", { tools: toolsV2 });
      expect(again.sessionId).toBe("thread-new");
    });

    it("keeps resuming the frozen thread when its context cannot be exported", async () => {
      const connection = new FakeConnection();
      const client = await createClient(connection);
      await startThreadWithTools(connection, client, toolsV1);
      readConversationState.mockRejectedValueOnce(new Error("encrypted compaction"));
      connection.queue("thread/read", {
        thread: { id: "thread-old", path: "/home/rollout.jsonl", turns: [] },
      });
      connection.queue("thread/resume", threadResponse("thread-old"));
      connection.queue("mcpServerStatus/list", { data: [], nextCursor: null });

      const session = await client.resumeSession("thread-old", { tools: toolsV2 });

      expect(session.sessionId).toBe("thread-old");
      expect(session.takeResumeHandoff?.()).toBeUndefined();
      expect(connection.requests.filter((entry) => entry.method === "thread/start")).toHaveLength(
        1,
      );
    });

    it("records the tool set for a thread it has not seen, without replacing it", async () => {
      const connection = new FakeConnection();
      const client = await createClient(connection);
      connection.queue("thread/resume", threadResponse("thread-legacy"));
      connection.queue("mcpServerStatus/list", { data: [], nextCursor: null });
      await client.resumeSession("thread-legacy", { tools: toolsV1 });
      connection.queue("thread/read", {
        thread: { id: "thread-legacy", path: "/home/rollout.jsonl", turns: [] },
      });
      readConversationState.mockResolvedValueOnce(handoffState);
      queueSessionStart(connection, "thread-next");

      const next = await client.resumeSession("thread-legacy", { tools: toolsV2 });

      expect(next.sessionId).toBe("thread-next");
    });
  });

  describe("deferred host tools", () => {
    it("defers non-eager tools into one namespace and keeps eager ones top-level", async () => {
      const connection = new FakeConnection();
      const client = await createClient(connection);
      queueSessionStart(connection);
      const handler = vi.fn<(args: unknown) => Promise<string>>(async () => "lazy result");
      await client.createSession({
        tools: [
          { name: "eager_tool", eagerLoad: true, handler: async () => "eager" },
          { name: "lazy_tool", description: "Lazy", handler },
        ],
        onPermissionRequest: () => ({ kind: "approve-once" }),
      });

      const start = requestByMethod(connection, "thread/start").params;
      expect(isRecord(start) ? start["dynamicTools"] : undefined).toEqual([
        expect.objectContaining({ type: "function", name: "eager_tool" }),
        {
          type: "namespace",
          name: "marshal_host_tools",
          description: expect.stringContaining("tool_search"),
          tools: [expect.objectContaining({ name: "lazy_tool", deferLoading: true })],
        },
      ]);

      await expect(
        connection.invoke({
          id: 50,
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "call-1",
            namespace: "marshal_host_tools",
            tool: "lazy_tool",
            arguments: {},
          },
        }),
      ).resolves.toEqual({
        contentItems: [{ type: "inputText", text: "lazy result" }],
        success: true,
      });
      expect(handler).toHaveBeenCalledOnce();
    });

    it("does not resolve tools called through a foreign namespace", async () => {
      const connection = new FakeConnection();
      const client = await createClient(connection);
      queueSessionStart(connection);
      await client.createSession({
        tools: [{ name: "lazy_tool", handler: async () => "result" }],
      });

      await expect(
        connection.invoke({
          id: 51,
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "call-2",
            namespace: "other",
            tool: "lazy_tool",
            arguments: {},
          },
        }),
      ).resolves.toMatchObject({ success: false });
    });

    it("advertises every tool eagerly for restricted sessions", async () => {
      const connection = new FakeConnection();
      const client = await createClient(connection);
      queueSessionStart(connection);
      await client.createSession({
        availableTools: ["lazy_tool"],
        tools: [{ name: "lazy_tool", handler: async () => "result" }],
      });

      expect(requestByMethod(connection, "thread/start").params).toMatchObject({
        dynamicTools: [expect.objectContaining({ type: "function", name: "lazy_tool" })],
      });
    });
  });

  describe("manual compaction", () => {
    async function startedSession(connection: FakeConnection) {
      const client = await createClient(connection);
      queueSessionStart(connection);
      return client.createSession({});
    }

    it("starts thread/compact/start and settles on the compaction turn's completion", async () => {
      const connection = new FakeConnection();
      const session = await startedSession(connection);
      connection.queue("thread/compact/start", {});

      let settled = false;
      const compaction = session.rpc?.history?.compact?.()?.then(() => {
        settled = true;
      });
      await vi.waitFor(() =>
        expect(connection.requests.at(-1)?.method).toBe("thread/compact/start"),
      );
      expect(requestByMethod(connection, "thread/compact/start").params).toEqual({
        threadId: "thread-1",
      });

      connection.emit("turn/started", { threadId: "thread-1", turn: turn("turn-compact") });
      connection.emit("turn/completed", {
        threadId: "thread-other-turn",
        turn: turn("turn-unrelated", "completed"),
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      connection.emit("turn/completed", {
        threadId: "thread-1",
        turn: turn("turn-compact", "completed"),
      });
      await compaction;
      expect(settled).toBe(true);
    });

    it("rejects when the compaction turn fails", async () => {
      const connection = new FakeConnection();
      const session = await startedSession(connection);
      connection.queue("thread/compact/start", {});
      const compaction = session.rpc?.history?.compact?.();
      const outcome = compaction?.then(
        () => null,
        (error: unknown) => error,
      );
      await vi.waitFor(() =>
        expect(connection.requests.at(-1)?.method).toBe("thread/compact/start"),
      );
      connection.emit("turn/started", { threadId: "thread-1", turn: turn("turn-compact") });
      connection.emit("turn/completed", {
        threadId: "thread-1",
        turn: {
          id: "turn-compact",
          items: [],
          status: "failed",
          error: { message: "context window exceeded" },
          startedAt: 1,
          completedAt: 2,
          durationMs: 1_000,
        },
      });
      await expect(outcome).resolves.toMatchObject({ message: "context window exceeded" });
    });

    it("rejects while a turn is active and without sending a request", async () => {
      const connection = new FakeConnection();
      const session = await startedSession(connection);
      connection.queue("turn/start", { turn: turn("turn-busy") });
      await session.send({ prompt: "work" });

      await expect(session.rpc?.history?.compact?.()).rejects.toThrow(
        "Wait for the current response to finish before compacting.",
      );
      expect(connection.requests.map((entry) => entry.method)).not.toContain(
        "thread/compact/start",
      );
    });

    it("propagates a failed start request and allows a retry", async () => {
      const connection = new FakeConnection();
      const session = await startedSession(connection);
      connection.queueFactory("thread/compact/start", () => {
        throw new Error("thread not found");
      });
      await expect(session.rpc?.history?.compact?.()).rejects.toThrow("thread not found");
      connection.queue("thread/compact/start", {});
      const retry = session.rpc?.history?.compact?.();
      await vi.waitFor(() =>
        expect(connection.requests.filter((e) => e.method === "thread/compact/start")).toHaveLength(
          2,
        ),
      );
      connection.emit("turn/started", { threadId: "thread-1", turn: turn("turn-2") });
      connection.emit("turn/completed", {
        threadId: "thread-1",
        turn: turn("turn-2", "completed"),
      });
      await expect(retry).resolves.toEqual({});
    });
  });
});
