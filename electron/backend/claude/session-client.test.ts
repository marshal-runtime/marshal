import { fileURLToPath } from "node:url";

import type {
  ModelInfo,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SessionMessage,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../../testing/harness/test-double";
import type {
  RuntimePermissionHandler,
  RuntimeSessionHooks,
  RuntimeTool,
} from "../runtime-contract";
import { AsyncInputQueue } from "./async-input";
import { ADDITIONAL_PROBE_MODEL_IDS, ClaudeRuntimeClient, expandClaudeModels } from "./client";
import { ClaudeProcessRegistry } from "./process-registry";
import type { ClaudeSdkFacade } from "./sdk-facade";
import { CLAUDE_QUERY_CONTROL_TIMEOUT_MS } from "./session";

class FakeQuery {
  readonly output = new AsyncInputQueue<SDKMessage>();
  readonly interrupt = vi.fn<Query["interrupt"]>(async () => undefined);
  readonly initializationResult = vi.fn<Query["initializationResult"]>(async () =>
    testDouble({
      commands: [],
      agents: [],
      output_style: "default",
      available_output_styles: [],
      models: [],
      account: {},
    }),
  );
  readonly setModel = vi.fn<Query["setModel"]>(async () => undefined);
  readonly applyFlagSettings = vi.fn<Query["applyFlagSettings"]>(async () => undefined);
  readonly supportedModels = vi.fn<Query["supportedModels"]>(async () => []);
  readonly mcpServerStatus = vi.fn<Query["mcpServerStatus"]>(async () => []);
  readonly toggleMcpServer = vi.fn<Query["toggleMcpServer"]>(async () => undefined);
  readonly setMcpServers = vi.fn<Query["setMcpServers"]>(async () => ({
    added: [],
    removed: [],
    errors: {},
  }));
  readonly accountInfo = vi.fn<Query["accountInfo"]>(async () => ({}));
  readonly getContextUsage = vi.fn<Query["getContextUsage"]>(async () =>
    testDouble({
      categories: [],
      totalTokens: 0,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 0,
      gridRows: [],
      model: "claude-sonnet-5",
      memoryFiles: [],
      mcpTools: [],
      systemTools: [],
      systemPromptSections: [],
      agents: [],
      isAutoCompactEnabled: true,
    }),
  );
  readonly close = vi.fn<Query["close"]>(() => this.output.close());
  readonly query: Query;

  constructor() {
    const iterator = this.output[Symbol.asyncIterator]();
    this.query = testDouble<Query>({
      [Symbol.asyncIterator]: () => iterator,
      next: () => iterator.next(),
      return: async () => {
        this.output.close();
        return { value: undefined, done: true };
      },
      throw: async (error?: unknown) => {
        this.output.fail(error);
        throw error;
      },
      interrupt: this.interrupt,
      initializationResult: this.initializationResult,
      setModel: this.setModel,
      applyFlagSettings: this.applyFlagSettings,
      supportedModels: this.supportedModels,
      mcpServerStatus: this.mcpServerStatus,
      toggleMcpServer: this.toggleMcpServer,
      setMcpServers: this.setMcpServers,
      accountInfo: this.accountInfo,
      getContextUsage: this.getContextUsage,
      close: this.close,
    });
  }

  push(message: SDKMessage): void {
    this.output.push(message);
  }
}

function assistantMessage(text: string, sessionId: string): SDKMessage {
  return testDouble({
    type: "assistant",
    message: testDouble({
      id: `assistant-${text}`,
      content: [{ type: "text", text }],
    }),
    parent_tool_use_id: null,
    uuid: `assistant-wire-${text}`,
    session_id: sessionId,
  });
}

function successResult(sessionId: string, userMessageId: string, text: string): SDKResultMessage {
  return testDouble({
    type: "result",
    subtype: "success",
    duration_ms: 5,
    duration_api_ms: 4,
    is_error: false,
    num_turns: 1,
    result: text,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: testDouble({}),
    modelUsage: {},
    permission_denials: [],
    user_message_uuid: userMessageId,
    uuid: `result-${userMessageId}`,
    session_id: sessionId,
  });
}

function errorResult(sessionId: string, userMessageId: string): SDKResultMessage {
  return testDouble({
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 5,
    duration_api_ms: 4,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: testDouble({}),
    modelUsage: {},
    permission_denials: [],
    errors: ["API request failed"],
    uuid: `result-${userMessageId}`,
    session_id: sessionId,
  });
}

function userStoppedToolResult(sessionId: string, userMessageId: string): SDKResultMessage {
  return testDouble({
    ...errorResult(sessionId, userMessageId),
    stop_reason: "tool_use",
    errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
  });
}

function createFacade(streams: FakeQuery[], messages: SessionMessage[] = []) {
  const captured: Array<Parameters<ClaudeSdkFacade["query"]>[0]> = [];
  const query = vi.fn<ClaudeSdkFacade["query"]>((params) => {
    captured.push(params);
    const stream = streams.shift();
    if (!stream) throw new Error("No fake Claude query available");
    return stream.query;
  });
  const deleteSession = vi.fn<ClaudeSdkFacade["deleteSession"]>(async () => undefined);
  const getSessionMessages = vi.fn<ClaudeSdkFacade["getSessionMessages"]>(async () => messages);
  const facade = testDouble<ClaudeSdkFacade>({
    query,
    deleteSession,
    getSessionMessages,
  });
  return { facade, captured, deleteSession, getSessionMessages, query };
}

it("exports cold Claude retained history without launching a query", async () => {
  const { facade, query, getSessionMessages } = createFacade(
    [],
    [
      testDouble<SessionMessage>({
        type: "user",
        isCompactSummary: true,
        message: { content: [{ type: "text", text: "Latest compacted decisions" }] },
      }),
      testDouble<SessionMessage>({
        type: "assistant",
        message: { content: [{ type: "text", text: "Recent answer" }] },
      }),
    ],
  );
  const client = new ClaudeRuntimeClient(
    facade,
    { workspaceDir: "/workspace", env: {} },
    new ClaudeProcessRegistry(),
  );
  await expect(client.readConversationState("native-id", "/repo")).resolves.toEqual({
    version: 1,
    sourceRuntimeId: "claude",
    summary: "Latest compacted decisions",
    messages: [{ role: "assistant", content: "Recent answer" }],
  });
  expect(getSessionMessages).toHaveBeenCalledWith("native-id", {
    dir: "/repo",
    includeSystemMessages: true,
  });
  expect(query).not.toHaveBeenCalled();
});

function promptIterator(
  params: Parameters<ClaudeSdkFacade["query"]>[0],
): AsyncIterator<SDKUserMessage> {
  if (typeof params.prompt === "string") {
    throw new Error("Expected Claude streaming-input prompt");
  }
  return params.prompt[Symbol.asyncIterator]();
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("ClaudeRuntimeClient sessions", () => {
  it("exports the retained compaction chain and expands a prior runtime handoff once", async () => {
    const { handoffUserPrompt } = await import("../conversation-state");
    const imported = {
      version: 1 as const,
      sourceRuntimeId: "cursor",
      summary: "Prior context",
      messages: [{ role: "assistant" as const, content: "prior reply" }],
    };
    const messages: SessionMessage[] = [
      testDouble({ type: "user", message: { content: handoffUserPrompt(imported, "work") } }),
      testDouble({
        type: "user",
        isCompactSummary: true,
        message: { content: "Latest retained Claude summary" },
      }),
      testDouble({ type: "user", message: { content: "continue" } }),
      testDouble({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "completed" },
            { type: "tool_use", name: "read", input: { path: "a" } },
          ],
        },
      }),
      testDouble({
        type: "assistant",
        parent_tool_use_id: "subagent",
        message: { content: "private subagent transcript" },
      }),
    ];
    const { facade, getSessionMessages } = createFacade([new FakeQuery()], messages);
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: "/workspace", env: {} },
      new ClaudeProcessRegistry(),
    );
    const session = await client.createSession({ conversationState: imported });
    const state = await session.exportConversationState();
    expect(state.summary).toBe("Latest retained Claude summary");
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toEqual({ role: "user", content: "continue" });
    expect(state.messages[1].content).toContain("read");
    expect(JSON.stringify(state)).not.toMatch(/private subagent|prior reply|Prior context/);
    expect(getSessionMessages).toHaveBeenCalledWith(session.sessionId, {
      dir: "/workspace",
      includeSystemMessages: true,
    });
    await session.destroy();
  });

  it.each(["success", "failed", "unconfirmed"] as const)(
    "compacts the persistent session and reports %s",
    async (outcome) => {
      const fake = new FakeQuery();
      const { facade, captured } = createFacade([fake]);
      const client = new ClaudeRuntimeClient(
        facade,
        { workspaceDir: "/workspace", env: {} },
        new ClaudeProcessRegistry(),
      );
      const session = await client.resumeSession("compact-session", {});
      const input = promptIterator(captured[0]);
      const compact = session.rpc?.history?.compact?.();
      if (!compact) throw new Error("Missing compaction RPC");
      const settled = compact.then(
        () => "success",
        (error: Error) => error.message,
      );
      const user = await input.next();
      if (user.done) throw new Error("Input closed");
      expect(user.value.message.content).toBe("/compact");
      expect(user.value.session_id).toBe("compact-session");
      await expect(session.send({ prompt: "during compaction" })).rejects.toThrow(
        "compaction to finish",
      );
      if (outcome === "success")
        fake.push(
          testDouble({
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "manual", pre_tokens: 10000 },
            uuid: "boundary",
            session_id: session.sessionId,
          }),
        );
      if (outcome === "failed")
        fake.push(
          testDouble({
            type: "system",
            subtype: "status",
            status: null,
            compact_result: "failed",
            compact_error: "Unable to compact",
            uuid: "status",
            session_id: session.sessionId,
          }),
        );
      fake.push(successResult(session.sessionId, user.value.uuid!, ""));
      expect(await settled).toBe(
        outcome === "success"
          ? "success"
          : outcome === "failed"
            ? "Unable to compact"
            : "Claude did not confirm session compaction.",
      );
      await session.send({ prompt: "continue" });
      expect((await input.next()).done).toBe(false);
      expect(captured).toHaveLength(1);
      await session.destroy();
    },
  );

  it("rejects pending compaction when its session closes", async () => {
    const fake = new FakeQuery();
    const { facade, captured } = createFacade([fake]);
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: "/workspace", env: {} },
      new ClaudeProcessRegistry(),
    );
    const session = await client.createSession({});
    const compact = session.rpc?.history?.compact?.();
    if (!compact) throw new Error("Missing compaction RPC");
    const outcome = compact.catch((error: Error) => error.message);
    await promptIterator(captured[0]).next();
    await session.destroy();
    expect(await outcome).toMatch(/closed|disconnect/i);
  });

  it("refuses manual compaction while a response is pending", async () => {
    const fake = new FakeQuery();
    const { facade } = createFacade([fake]);
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: "/workspace", env: {} },
      new ClaudeProcessRegistry(),
    );
    const session = await client.createSession({});
    await session.send({ prompt: "work" });
    await expect(session.rpc?.history?.compact?.()).rejects.toThrow("current response");
    await session.destroy();
  });

  it("gives a tool-free planner no built-ins and no Marshal MCP server", async () => {
    const fake = new FakeQuery();
    const { facade, captured } = createFacade([fake]);
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: String.raw`C:\workspace`, env: {} },
      new ClaudeProcessRegistry(),
    );
    const handler = vi.fn<RuntimeTool["handler"]>(async () => "unused");
    const hostTool = testDouble<RuntimeTool>({
      name: "runtimeSearch",
      parameters: { type: "object", properties: {} },
      handler,
    });
    const permissionHandler = vi.fn<RuntimePermissionHandler>(async () => ({
      kind: "approve-once",
    }));

    const session = await client.createSession({
      tools: [hostTool],
      availableTools: [],
      onPermissionRequest: permissionHandler,
    });

    expect(captured[0]?.options?.tools).toEqual([]);
    expect(captured[0]?.options?.skills).toEqual([]);
    expect(captured[0]?.options?.mcpServers).toBeUndefined();
    expect(captured[0]?.options?.toolAliases).toBeUndefined();
    const canUseTool = captured[0]?.options?.canUseTool;
    expect(canUseTool).toBeTypeOf("function");
    const permissionOptions = testDouble<Parameters<NonNullable<typeof canUseTool>>[2]>({
      signal: new AbortController().signal,
      toolUseID: "planner-tool-call",
      requestId: "planner-permission-request",
    });
    await expect(canUseTool?.("Bash", { command: "pwd" }, permissionOptions)).resolves.toEqual({
      behavior: "deny",
      message: "This tool is not available in this session.",
    });
    await expect(
      canUseTool?.("mcp__marshal__runtimeSearch", {}, permissionOptions),
    ).resolves.toEqual({
      behavior: "deny",
      message: "This tool is not available in this session.",
    });
    expect(permissionHandler).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    await session.destroy();
  });

  it("force-kills only the owned Claude process when query close never settles", async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeQuery();
      fake.close.mockImplementation(() => undefined);
      const { facade } = createFacade([fake]);
      const processes = new ClaudeProcessRegistry();
      const forceKill = vi.spyOn(processes, "forceKillSession").mockReturnValue([]);
      const client = new ClaudeRuntimeClient(
        facade,
        { workspaceDir: String.raw`C:\workspace`, env: {} },
        processes,
      );
      const session = await client.resumeSession("wedged-session", {});

      const disconnect = session.disconnect();
      await vi.advanceTimersByTimeAsync(CLAUDE_QUERY_CONTROL_TIMEOUT_MS);

      await expect(disconnect).resolves.toBeUndefined();
      expect(forceKill).toHaveBeenCalledExactlyOnceWith("wedged-session");
      await expect(session.send({ prompt: "after close" })).rejects.toThrow(/is closed/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a wedged interrupt and closes the unusable Claude session", async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeQuery();
      fake.interrupt.mockImplementation(() => new Promise(() => {}));
      const { facade } = createFacade([fake]);
      const processes = new ClaudeProcessRegistry();
      const forceKill = vi.spyOn(processes, "forceKillSession").mockReturnValue([]);
      const client = new ClaudeRuntimeClient(
        facade,
        { workspaceDir: String.raw`C:\workspace`, env: {} },
        processes,
      );
      const session = await client.resumeSession("wedged-interrupt", {});

      const abort = session.abort();
      const outcome = abort.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(CLAUDE_QUERY_CONTROL_TIMEOUT_MS);

      await expect(outcome).resolves.toMatchObject({
        message: expect.stringContaining("Claude interrupt did not settle"),
      });
      expect(forceKill).toHaveBeenCalledExactlyOnceWith("wedged-interrupt");
      await expect(session.send({ prompt: "after abort" })).rejects.toThrow(/is closed/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allocates a stable ID without a dummy turn and reuses one streaming query", async () => {
    const fake = new FakeQuery();
    const { facade, captured, query } = createFacade([fake]);
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: String.raw`C:\workspace`, env: {} },
      new ClaudeProcessRegistry(),
    );

    const session = await client.createSession({ streaming: true });
    const runtimeEvents: string[] = [];
    session.on((event) => runtimeEvents.push(event.type));

    expect(session.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(captured[0]?.options?.sessionId).toBe(session.sessionId);
    expect(captured[0]?.options?.resume).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(fake.initializationResult).toHaveBeenCalledOnce();

    const input = promptIterator(captured[0]);
    const firstMessageId = await session.send({ prompt: "first turn" });
    await expect(input.next()).resolves.toMatchObject({
      value: {
        type: "user",
        message: { role: "user", content: "first turn" },
        uuid: firstMessageId,
        session_id: session.sessionId,
        origin: { kind: "human" },
      },
    });
    fake.push(assistantMessage("first answer", session.sessionId));
    fake.push(successResult(session.sessionId, firstMessageId, "first answer"));
    await flush();
    expect(runtimeEvents).toContain("session.usage_info");

    const secondPromise = session.sendAndWait({
      prompt: "second turn",
      attachments: [
        {
          type: "file",
          path: fileURLToPath(new URL("../../../package.json", import.meta.url)),
          displayName: "package.json",
        },
      ],
    });
    const secondInput = await input.next();
    if (secondInput.done) throw new Error("Claude input stream closed unexpectedly");
    expect(Array.isArray(secondInput.value.message.content)).toBe(true);
    expect(secondInput.value.message.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("second turn"),
        }),
      ]),
    );
    const secondMessageId = secondInput.value.uuid;
    if (!secondMessageId) throw new Error("Claude input message did not include a UUID");
    fake.push(assistantMessage("second answer", session.sessionId));
    fake.push(successResult(session.sessionId, secondMessageId, "second answer"));

    await expect(secondPromise).resolves.toMatchObject({
      type: "assistant.message",
      data: {
        messageId: "assistant-second answer",
        content: "second answer",
      },
    });
    expect(query).toHaveBeenCalledTimes(1);
    await session.disconnect();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("resumes by ID and exposes abort, model, MCP, auth, and OAuth-limit controls", async () => {
    const fake = new FakeQuery();
    fake.mcpServerStatus.mockResolvedValue([{ name: "github", status: "connected" }]);
    fake.accountInfo.mockResolvedValue({
      apiProvider: "bedrock",
      tokenSource: "environment",
    });
    const { facade, captured } = createFacade([fake]);
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: String.raw`C:\workspace`, env: {} },
      new ClaudeProcessRegistry(),
    );
    const onSessionEnd = vi.fn<NonNullable<RuntimeSessionHooks["onSessionEnd"]>>();
    const session = await client.resumeSession("22222222-2222-4222-8222-222222222222", {
      hooks: { onSessionEnd },
      mcpServers: {
        github: {
          type: "http",
          url: "https://example.test/mcp",
          tools: ["*"],
        },
      },
    });
    const events: string[] = [];
    session.on((event) => events.push(event.type));

    expect(captured[0]?.options?.resume).toBe("22222222-2222-4222-8222-222222222222");
    expect(captured[0]?.options?.sessionId).toBeUndefined();

    await session.abort();
    await session.setModel("claude-opus-4-8", { reasoningEffort: "max" });
    await expect(session.rpc?.mcp?.list?.()).resolves.toEqual([
      { name: "github", status: "connected" },
    ]);
    await session.rpc?.mcp?.disable?.({ serverName: "github" });
    await session.rpc?.mcp?.enable?.({ serverName: "github" });
    await session.rpc?.mcp?.reload?.();
    await expect(session.rpc?.auth?.getStatus()).resolves.toMatchObject({
      apiProvider: "bedrock",
      tokenSource: "environment",
    });
    await expect(session.rpc?.mcp?.oauth?.login({ serverName: "github" })).rejects.toThrow(
      /does not run interactive MCP OAuth/,
    );

    expect(fake.interrupt).toHaveBeenCalledOnce();
    expect(onSessionEnd).toHaveBeenCalledWith(
      { reason: "abort" },
      { sessionId: "22222222-2222-4222-8222-222222222222" },
    );
    expect(fake.setModel).toHaveBeenCalledWith("claude-opus-4-8");
    expect(fake.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: "max" });
    expect(fake.toggleMcpServer).toHaveBeenNthCalledWith(1, "github", false);
    expect(fake.toggleMcpServer).toHaveBeenNthCalledWith(2, "github", true);
    expect(fake.setMcpServers).toHaveBeenCalledWith(
      expect.objectContaining({
        github: expect.objectContaining({
          type: "http",
          url: "https://example.test/mcp",
        }),
      }),
    );
    expect(events).toContain("abort");
    expect(events).toContain("session.model_change");
    await session.disconnect();
  });

  it("rejects failed turns and reports them through the runtime error hook", async () => {
    const fake = new FakeQuery();
    const { facade, captured } = createFacade([fake]);
    const onErrorOccurred = vi.fn<NonNullable<RuntimeSessionHooks["onErrorOccurred"]>>(
      async () => undefined,
    );
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: String.raw`C:\workspace`, env: {} },
      new ClaudeProcessRegistry(),
    );
    const session = await client.createSession({
      hooks: { onErrorOccurred },
    });
    const input = promptIterator(captured[0]);
    const result = session.sendAndWait({ prompt: "fail" });
    const user = await input.next();
    if (user.done) throw new Error("Claude input stream closed unexpectedly");

    const userMessageId = user.value.uuid;
    if (!userMessageId) throw new Error("Claude input message did not include a UUID");
    fake.push(errorResult(session.sessionId, userMessageId));

    await expect(result).rejects.toThrow("API request failed");
    await flush();
    expect(onErrorOccurred).toHaveBeenCalledWith(
      expect.objectContaining({
        errorContext: "claude-result",
        recoverable: false,
      }),
      { sessionId: session.sessionId },
    );
    await session.disconnect();
  });

  it.each([true, false])(
    "classifies late null-stop results only after an explicit interrupt (%s)",
    async (interrupt) => {
      const fake = new FakeQuery();
      const { facade, captured } = createFacade([fake]);
      const onErrorOccurred = vi.fn<NonNullable<RuntimeSessionHooks["onErrorOccurred"]>>(
        async () => undefined,
      );
      const client = new ClaudeRuntimeClient(
        facade,
        { workspaceDir: String.raw`C:\workspace`, env: {} },
        new ClaudeProcessRegistry(),
      );
      const session = await client.createSession({ hooks: { onErrorOccurred } });
      const input = promptIterator(captured[0]);
      const events: string[] = [];
      session.on((event) => events.push(event.type));
      const oldResult = session.sendAndWait({ prompt: "original work" });
      const oldUser = await input.next();
      if (oldUser.done || !oldUser.value.uuid) throw new Error("Missing original UUID");
      if (interrupt) await session.abort();
      const newResult = session.sendAndWait({ prompt: "operator steering" });
      const newUser = await input.next();
      if (newUser.done || !newUser.value.uuid) throw new Error("Missing steering UUID");
      const oldOutcome = oldResult.then(
        (value) => value,
        (error: unknown) => String(error),
      );
      fake.push(
        testDouble<SDKResultMessage>({
          ...errorResult(session.sessionId, oldUser.value.uuid),
          errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
        }),
      );
      expect(await oldOutcome).toBe(
        interrupt
          ? undefined
          : "Error: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
      );
      await flush();
      expect(onErrorOccurred).toHaveBeenCalledTimes(interrupt ? 0 : 1);
      expect(events.filter((event) => event === "session.error")).toHaveLength(interrupt ? 0 : 1);
      expect(events.filter((event) => event === "session.idle")).toHaveLength(interrupt ? 0 : 1);
      fake.push(successResult(session.sessionId, newUser.value.uuid, "steered answer"));
      await expect(newResult).resolves.toMatchObject({ data: { content: "steered answer" } });
      await session.disconnect();
    },
  );

  it("settles a user-declined tool turn without reporting a runtime error", async () => {
    const fake = new FakeQuery();
    const { facade, captured } = createFacade([fake]);
    const onErrorOccurred = vi.fn<NonNullable<RuntimeSessionHooks["onErrorOccurred"]>>(
      async () => undefined,
    );
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: String.raw`C:\workspace`, env: {} },
      new ClaudeProcessRegistry(),
    );
    const session = await client.createSession({ hooks: { onErrorOccurred } });
    const input = promptIterator(captured[0]);
    const result = session.sendAndWait({ prompt: "decline tool" });
    const user = await input.next();
    if (user.done || !user.value.uuid) throw new Error("Missing Claude user message UUID");

    fake.push(userStoppedToolResult(session.sessionId, user.value.uuid));

    await expect(result).resolves.toBeUndefined();
    await flush();
    expect(onErrorOccurred).not.toHaveBeenCalled();
    await session.disconnect();
  });

  it("rejects invalid attachments without poisoning later sends", async () => {
    const fake = new FakeQuery();
    const { facade, captured } = createFacade([fake]);
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: String.raw`C:\workspace`, env: {} },
      new ClaudeProcessRegistry(),
    );
    const session = await client.createSession({});
    const input = promptIterator(captured[0]);

    await expect(
      session.send({
        prompt: "bad attachment",
        attachments: [
          {
            type: "file",
            path: fileURLToPath(new URL("missing-attachment.png", import.meta.url)),
          },
        ],
      }),
    ).rejects.toThrow(/ENOENT|no such file/i);

    const messageId = await session.send({ prompt: "after failure" });
    await expect(input.next()).resolves.toMatchObject({
      value: {
        uuid: messageId,
        message: { role: "user", content: "after failure" },
      },
    });
    await session.disconnect();
  });

  it("maps persisted history and deletes active sessions through the SDK", async () => {
    const fake = new FakeQuery();
    const history = [
      testDouble<SessionMessage>({
        type: "assistant",
        uuid: "history-1",
        session_id: "session-history",
        message: testDouble({
          id: "message-history",
          content: [{ type: "text", text: "persisted answer" }],
        }),
        parent_tool_use_id: null,
        parent_agent_id: null,
      }),
    ];
    const { facade, deleteSession, getSessionMessages } = createFacade([fake], history);
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: String.raw`C:\workspace`, env: {} },
      new ClaudeProcessRegistry(),
    );
    const session = await client.resumeSession("session-history", {
      cwd: String.raw`C:\scoped-workspace`,
    });
    fake.push(
      testDouble<SDKMessage>({
        type: "assistant",
        message: testDouble({
          id: "message-history",
          content: [{ type: "text", text: "persisted answer" }],
        }),
        parent_tool_use_id: null,
        uuid: "live-history-assistant",
        session_id: "session-history",
      }),
    );
    fake.push(successResult("session-history", "history-user", "persisted answer"));
    await flush();

    const events = await session.getMessages();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session.usage_info",
        }),
      ]),
    );
    expect(
      events.filter(
        (event) => event.type === "assistant.message" && event.data.messageId === "message-history",
      ),
    ).toEqual([
      expect.objectContaining({
        type: "assistant.message",
        data: {
          messageId: "message-history",
          content: "persisted answer",
        },
      }),
    ]);
    expect(getSessionMessages).toHaveBeenCalledWith("session-history", {
      dir: String.raw`C:\scoped-workspace`,
      includeSystemMessages: true,
    });

    await client.deleteSession("session-history");

    expect(fake.close).toHaveBeenCalledOnce();
    expect(deleteSession).toHaveBeenCalledWith("session-history", {
      dir: String.raw`C:\scoped-workspace`,
    });
  });

  it("searches all Claude projects when deleting an inactive session", async () => {
    const { facade, deleteSession } = createFacade([]);
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: String.raw`C:\workspace`, env: {} },
      new ClaudeProcessRegistry(),
    );

    await client.deleteSession("inactive-session");

    expect(deleteSession).toHaveBeenCalledWith("inactive-session");
  });

  it("marks a session closed when the persistent Claude query exits unexpectedly", async () => {
    const fake = new FakeQuery();
    const { facade } = createFacade([fake]);
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: String.raw`C:\workspace`, env: {} },
      new ClaudeProcessRegistry(),
    );
    const session = await client.createSession({});
    const events: string[] = [];
    session.on((event) => events.push(event.type));

    fake.output.close();
    await flush();

    expect(events).toContain("session.error");
    await expect(session.send({ prompt: "too late" })).rejects.toThrow(/is closed/);
  });

  it("rejects session creation when the Claude initialize handshake fails", async () => {
    const fake = new FakeQuery();
    fake.initializationResult.mockRejectedValue(new Error("resume target not found"));
    const { facade } = createFacade([fake]);
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: String.raw`C:\workspace`, env: {} },
      new ClaudeProcessRegistry(),
    );

    await expect(client.resumeSession("missing-session", {})).rejects.toThrow(
      "resume target not found",
    );
    expect(fake.close).toHaveBeenCalledOnce();
  });
});

describe("ClaudeRuntimeClient metadata and lifecycle", () => {
  it("lists models through a no-prompt control query and caches the result", async () => {
    const fake = new FakeQuery();
    fake.supportedModels.mockResolvedValue([
      testDouble<ModelInfo>({
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        displayName: "Sonnet 5",
        description: "Balanced model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high", "max"],
        supportsAdaptiveThinking: true,
      }),
    ]);
    const probeFakes = ADDITIONAL_PROBE_MODEL_IDS.map(() => new FakeQuery());
    const { facade, captured, query } = createFacade([fake, ...probeFakes]);
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: String.raw`C:\workspace`, env: { ANTHROPIC_API_KEY: "key" } },
      new ClaudeProcessRegistry(),
    );

    await expect(client.listModels()).resolves.toEqual([
      expect.objectContaining({
        id: "sonnet",
        name: "Sonnet 5 (Latest)",
        supportedReasoningEfforts: ["low", "high", "max"],
        defaultReasoningEffort: "high",
        capabilities: { supports: { reasoningEffort: true } },
      }),
      expect.objectContaining({
        id: "claude-sonnet-5",
        name: "Sonnet 5",
        billing: expect.objectContaining({ pinned: true, alias: "sonnet" }),
      }),
    ]);
    await client.listModels();

    // One base no-model query plus one probe per ADDITIONAL_PROBE_MODEL_IDS entry;
    // the cached second listModels() call issues no further queries.
    expect(query).toHaveBeenCalledTimes(1 + ADDITIONAL_PROBE_MODEL_IDS.length);
    expect(captured[0]?.options).toMatchObject({
      persistSession: false,
      tools: [],
    });
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("merges additional models discovered by probing options.model beyond the default shortlist", async () => {
    const fake = new FakeQuery();
    fake.supportedModels.mockResolvedValue([
      testDouble<ModelInfo>({
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        displayName: "Sonnet",
        description: "Balanced model",
      }),
    ]);
    const probeFakes = ADDITIONAL_PROBE_MODEL_IDS.map(() => new FakeQuery());
    const opus48Index = ADDITIONAL_PROBE_MODEL_IDS.indexOf("claude-opus-4-8");
    probeFakes[opus48Index].supportedModels.mockResolvedValue([
      testDouble<ModelInfo>({
        value: "claude-opus-4-8",
        resolvedModel: "claude-opus-4-8",
        displayName: "Opus 4.8",
        description: "Previous-generation Opus",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportsAdaptiveThinking: true,
      }),
    ]);
    const fable51Index = ADDITIONAL_PROBE_MODEL_IDS.indexOf("claude-fable-5-1");
    probeFakes[fable51Index].supportedModels.mockResolvedValue([
      testDouble<ModelInfo>({
        value: "claude-fable-5-1",
        resolvedModel: "claude-fable-5-1",
        displayName: "Fable",
        description: "Most capable widely released model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportsAdaptiveThinking: true,
      }),
    ]);
    const { facade, captured } = createFacade([fake, ...probeFakes]);
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: "/workspace", env: {} },
      new ClaudeProcessRegistry(),
    );

    const models = await client.listModels();

    expect(models).toContainEqual(
      expect.objectContaining({ id: "claude-opus-4-8", name: "Opus 4.8" }),
    );
    // The SDK reports claude-fable-5-1's display name as just "Fable"; the
    // catalog derives the version suffix from the id so the picker can tell
    // it apart from the alias entry.
    expect(models).toContainEqual(
      expect.objectContaining({ id: "claude-fable-5-1", name: "Fable 5.1" }),
    );
    // sonnet's resolvedModel differs from its alias value, so expandClaudeModels
    // pins it as a second entry; the remaining probe results are all the empty
    // default, so only the two mocked matches above add further entries.
    expect(models).toHaveLength(4);

    const opus48Call = captured[1 + opus48Index];
    expect(opus48Call?.options).toMatchObject({ model: "claude-opus-4-8" });
  });

  it("keeps the alias's (Latest) label when its resolved target is already listed", async () => {
    const models = expandClaudeModels([
      testDouble<ModelInfo>({
        value: "fable",
        resolvedModel: "claude-fable-5-1",
        displayName: "Fable",
      }),
      testDouble<ModelInfo>({
        value: "claude-fable-5-1",
        resolvedModel: "claude-fable-5-1",
        displayName: "Fable",
      }),
    ]);

    expect(models).toEqual([
      expect.objectContaining({ id: "fable", name: "Fable (Latest)" }),
      expect.objectContaining({ id: "claude-fable-5-1", name: "Fable 5.1" }),
    ]);
  });

  it("reports isolated auth state and implements the frozen login/logout methods", async () => {
    const { facade } = createFacade([]);
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: String.raw`C:\workspace`, env: {} },
      new ClaudeProcessRegistry(),
    );

    await expect(client.getAuthStatus()).resolves.toMatchObject({
      isAuthenticated: false,
      statusMessage: expect.stringContaining("Claude subscription"),
    });
    await expect(client.login({ type: "api-key", apiKey: "sk-ant-test" })).resolves.toEqual({
      status: "authenticated",
    });
    await expect(client.getAuthStatus()).resolves.toMatchObject({
      isAuthenticated: true,
      login: "api-key",
    });
    await expect(client.login({ type: "browser" })).rejects.toThrow(/browser login is unavailable/);
    await client.logout();
    await expect(client.getAuthStatus()).resolves.toMatchObject({
      isAuthenticated: false,
    });
  });

  it("accepts supported cloud-provider credentials without exposing claude.ai OAuth", async () => {
    const { facade } = createFacade([]);
    const client = new ClaudeRuntimeClient(
      facade,
      {
        workspaceDir: String.raw`C:\workspace`,
        env: { CLAUDE_CODE_USE_VERTEX: "1" },
      },
      new ClaudeProcessRegistry(),
    );

    await expect(client.getAuthStatus()).resolves.toMatchObject({
      isAuthenticated: true,
      login: "google-vertex",
    });
  });

  it("recognizes mixed-case credentials on Windows", async () => {
    const { facade } = createFacade([]);
    const client = new ClaudeRuntimeClient(
      facade,
      {
        workspaceDir: String.raw`C:\workspace`,
        env: { anthropic_api_key: "key" },
      },
      new ClaudeProcessRegistry(),
    );

    await expect(client.getAuthStatus()).resolves.toMatchObject({
      isAuthenticated: process.platform === "win32",
    });
  });

  it("exposes tracked process handles and force-stops owned processes", async () => {
    const kill = vi.fn<(signal: NodeJS.Signals) => boolean>(() => true);
    const secondKill = vi.fn<(signal: NodeJS.Signals) => boolean>(() => true);
    const killOwnedProcessTree = vi.fn<(pid: number) => { killed: boolean }>(() => ({
      killed: true,
    }));
    const process = testDouble<SpawnedProcess>({
      killed: false,
      exitCode: null,
      kill,
      once: vi.fn<SpawnedProcess["once"]>(),
    });
    const secondProcess = testDouble<SpawnedProcess>({
      killed: false,
      exitCode: null,
      kill: secondKill,
      once: vi.fn<SpawnedProcess["once"]>(),
    });
    Reflect.set(process, "pid", 4242);
    Reflect.set(secondProcess, "pid", 4343);
    const registry = new ClaudeProcessRegistry(killOwnedProcessTree);
    registry.add(process);
    registry.add(secondProcess);
    const { facade } = createFacade([]);
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: String.raw`C:\workspace`, env: {} },
      registry,
    );

    expect(client.process).toMatchObject({
      pid: 4242,
      exitCode: null,
      killed: false,
    });
    client.markForceStopping();
    expect(killOwnedProcessTree).toHaveBeenCalledWith(4242);
    expect(killOwnedProcessTree).toHaveBeenCalledWith(4343);
    expect(kill).not.toHaveBeenCalled();
    expect(secondKill).not.toHaveBeenCalled();
    await expect(client.stop()).resolves.toEqual([]);
  });

  it("unsubscribes event listeners and stops active sessions", async () => {
    const fake = new FakeQuery();
    const { facade } = createFacade([fake]);
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: String.raw`C:\workspace`, env: {} },
      new ClaudeProcessRegistry(),
    );
    const session = await client.createSession({});
    const events: string[] = [];
    const unsubscribe = session.on((event) => events.push(event.type));

    fake.push(
      testDouble<SDKMessage>({
        type: "system",
        subtype: "notification",
        key: "one",
        text: "first",
        priority: "low",
        uuid: "notification-1",
        session_id: session.sessionId,
      }),
    );
    await flush();
    unsubscribe();
    fake.push(
      testDouble<SDKMessage>({
        type: "system",
        subtype: "notification",
        key: "two",
        text: "second",
        priority: "low",
        uuid: "notification-2",
        session_id: session.sessionId,
      }),
    );
    await flush();

    expect(events).toEqual(["session.status"]);
    await expect(client.stop()).resolves.toEqual([]);
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("replays initialization-time events to the first subscriber", async () => {
    const fake = new FakeQuery();
    const { facade } = createFacade([fake]);
    const client = new ClaudeRuntimeClient(
      facade,
      { workspaceDir: String.raw`C:\workspace`, env: {} },
      new ClaudeProcessRegistry(),
    );
    const session = await client.createSession({});
    fake.push(
      testDouble<SDKMessage>({
        type: "system",
        subtype: "init",
        model: "claude-sonnet-5",
        mcp_servers: [{ name: "github", status: "pending" }],
        uuid: "init-late-subscriber",
        session_id: session.sessionId,
      }),
    );
    await flush();
    const events: string[] = [];

    session.on((event) => events.push(event.type));

    expect(events).toEqual(["session.model_change", "session.mcp_servers_loaded"]);
    await session.disconnect();
  });
});
