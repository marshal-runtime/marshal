import * as fs from "fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { isRuntimeAuthError } from "../common/foundation/auth/auth-errors";
import type { SessionMetadata, TurnEvent } from "../common/marshal-ipc-contract";
import { isRuntimeUsageLimitError } from "../common/runtime-usage-limit";
import { CodexRuntimeClient } from "./backend/codex/client";
import type {
  CodexNotification,
  CodexRpcConnection,
  CodexServerRequestHandler,
  CodexTransportErrorHandler,
} from "./backend/codex/jsonl-rpc";
import type { ResultDecoder } from "./backend/codex/protocol";
import type { PersistedSession } from "./session-store";
import { SessionTestAccess, createTestBackend } from "./testing/harness";

const m = await vi.hoisted(async () => await import("./test-helpers/session-test-mocks"));
vi.mock("fs", m.fsFactory);
vi.mock("./session-archive", m.sessionArchiveFactory);
vi.mock("child_process", m.childProcessFactory);
vi.mock("electron", m.electronFactory);
vi.mock("@github/copilot-sdk", m.copilotSdkFactory);
vi.mock("./skills", m.skillsFactory);
vi.mock("./cli-path", m.cliPathFactory);
vi.mock("./safe-storage-file");
vi.mock("./workspace-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspace-store")>()),
  getActiveWorkspaceRoot: () => "/test/workspace",
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fs).existsSync.mockReturnValue(false);
  vi.mocked(fs).readdirSync.mockReturnValue([]);
});

/** Minimal Codex app-server stand-in: answers requests from a script and lets the test push notifications. */
class ScriptedAppServer implements CodexRpcConnection {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly process = { pid: 7, exitCode: null, killed: false, kill: () => true };
  private readonly handlers = new Set<(notification: CodexNotification) => void>();

  constructor(private readonly respond: (method: string, params: unknown) => unknown) {}

  async request<T>(method: string, params: unknown, decoder: ResultDecoder<T>): Promise<T> {
    this.requests.push({ method, params });
    return decoder(await this.respond(method, params));
  }
  async notify(): Promise<void> {}
  onNotification(handler: (notification: CodexNotification) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  onError(_handler: CodexTransportErrorHandler): () => void {
    return () => {};
  }
  setServerRequestHandler(_handler: CodexServerRequestHandler | null): void {}
  async shutdown(): Promise<Error[]> {
    return [];
  }
  emit(method: string, params: unknown): void {
    for (const handler of this.handlers) handler({ method, params });
  }
}

const AUTH_FAILURE = {
  message: "Your access token could not be refreshed. Please log out and sign in again.",
  codexErrorInfo: "unauthorized",
  additionalDetails: null,
};

function failedTurn(id: string): Record<string, unknown> {
  return {
    id,
    items: [],
    status: "failed",
    error: AUTH_FAILURE,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1_000,
  };
}

function appServerFor(extra: (method: string) => unknown = () => undefined): ScriptedAppServer {
  return new ScriptedAppServer((method) => {
    switch (method) {
      case "initialize":
        return {
          userAgent: "codex-test",
          codexHome: "/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        };
      case "thread/start":
        return { thread: { id: "thread-1", turns: [] }, model: "gpt-5.6-sol" };
      case "mcpServerStatus/list":
        return { data: [], nextCursor: null };
      case "turn/start":
        return {
          turn: { id: "turn-1", items: [], status: "inProgress", error: null },
        };
      default: {
        const response = extra(method);
        if (response === undefined) throw new Error(`unexpected ${method}`);
        return response;
      }
    }
  });
}

/** A SessionManager whose "codex-chat" session runs on a real Codex client over `appServer`. */
async function codexChat(appServer: ScriptedAppServer, indexRuntimeId = "copilot") {
  const codex = await CodexRuntimeClient.initialize(appServer, "/test/workspace");
  const { SessionManager } = await import("./sessions");
  const backend = await createTestBackend();
  const mgr = new SessionManager("/test/workspace", backend);
  const access = new SessionTestAccess(mgr);
  const sessionId = "codex-chat";
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal persisted fixture
  const persisted = {
    id: sessionId,
    name: "Codex chat",
    model: "gpt-5.6-sol",
    runtimeId: "copilot",
    backendOrigin: "copilot",
    createdAt: new Date(0).toISOString(),
    messages: [],
  } as unknown as PersistedSession;
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal index row
  const indexRow = {
    id: sessionId,
    name: "Codex chat",
    runtimeId: indexRuntimeId,
    backendOrigin: "copilot",
  } as SessionMetadata;
  const index = { sessions: [indexRow], activeSessionId: "another-chat" };
  vi.spyOn(access.store, "loadIndex").mockReturnValue(index);
  vi.spyOn(access.store, "loadSessionData").mockImplementation((id) =>
    id === sessionId ? persisted : null,
  );
  vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
  vi.spyOn(mgr, "appendMessage").mockImplementation((id, message) => {
    if (id === sessionId) persisted.messages.push(message);
    return true;
  });
  access.client = codex;
  await access.createSDKSession(sessionId, true);
  const authErrors: string[] = [];
  mgr.setAuthErrorCallback((error) => authErrors.push(error));

  const turnEvents: TurnEvent[] = [];
  mgr.addEventListener((id, event) => {
    if (id === sessionId) turnEvents.push(event);
  });
  return { mgr, backend, sessionId, persisted, turnEvents, authErrors };
}

describe("SessionManager with a Codex turn that fails before replying", () => {
  it("leaves exactly one persisted, actionable error entry in the chat", async () => {
    const appServer = appServerFor();
    const { mgr, backend, sessionId, persisted, turnEvents, authErrors } =
      await codexChat(appServer);

    await backend.sessions.send(sessionId, { prompt: "start the overnight task" });
    expect(appServer.requests.map((request) => request.method)).toContain("turn/start");

    appServer.emit("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: AUTH_FAILURE,
    });
    appServer.emit("turn/completed", { threadId: "thread-1", turn: failedTurn("turn-1") });

    await vi.waitFor(() =>
      expect(turnEvents.some((event) => event.type === "turn:idle")).toBe(true),
    );
    expect(turnEvents.filter((event) => event.type === "turn:error")).toHaveLength(1);
    const errorEntries = persisted.messages.filter((message) => message.error === true);
    expect(errorEntries).toEqual([
      expect.objectContaining({
        role: "assistant",
        content:
          "Codex isn't signed in or its sign-in expired. Sign in under Settings → Runtime accounts.",
      }),
    ]);
    expect(mgr.getSessionView(sessionId).view.status).toBe("ready");
    expect(turnEvents.find((event) => event.type === "turn:error")).toMatchObject({
      code: "authentication_failed",
    });
    expect(authErrors).toEqual([
      "Codex isn't signed in or its sign-in expired. Sign in under Settings → Runtime accounts.",
    ]);
  });

  it("keeps a peer-runtime session's sign-in failure off the active runtime's sign-in notice", async () => {
    const appServer = appServerFor();
    const { backend, sessionId, persisted, turnEvents, authErrors } = await codexChat(
      appServer,
      "codex",
    );

    await backend.sessions.send(sessionId, { prompt: "start the overnight task" });
    appServer.emit("turn/completed", { threadId: "thread-1", turn: failedTurn("turn-1") });

    await vi.waitFor(() =>
      expect(turnEvents.some((event) => event.type === "turn:idle")).toBe(true),
    );
    expect(authErrors).toEqual([]);
    expect(persisted.messages.filter((message) => message.error === true)).toHaveLength(1);
  });

  it("rejects a collected turn that failed sign-in with a typed auth error", async () => {
    const appServer = appServerFor();
    const { mgr, sessionId } = await codexChat(appServer);

    const settled = mgr.sendAndCollect("continue the goal", 60_000, undefined, sessionId).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() =>
      expect(appServer.requests.map((request) => request.method)).toContain("turn/start"),
    );
    appServer.emit("turn/completed", { threadId: "thread-1", turn: failedTurn("turn-1") });

    const error = await settled;
    expect(isRuntimeAuthError(error)).toBe(true);
    expect(error).toMatchObject({ code: "authentication_failed" });
  });

  it("rejects a collected turn refused for usage limits with a typed error carrying the reset time", async () => {
    const resetsAtSeconds = Math.floor(Date.now() / 1_000) + 3_600;
    const appServer = appServerFor((method) =>
      method === "account/rateLimits/read"
        ? {
            rateLimits: {
              primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetsAtSeconds },
            },
          }
        : undefined,
    );
    const { mgr, sessionId, persisted, turnEvents } = await codexChat(appServer);

    const collected = mgr.sendAndCollect("continue the goal", 60_000, undefined, sessionId);
    const settled = collected.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() =>
      expect(appServer.requests.map((request) => request.method)).toContain("turn/start"),
    );
    const limit = {
      message: "You've hit your usage limit.",
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: null,
    };
    appServer.emit("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: limit,
    });
    appServer.emit("turn/completed", {
      threadId: "thread-1",
      turn: { ...failedTurn("turn-1"), error: limit },
    });

    const error = await settled;
    expect(isRuntimeUsageLimitError(error)).toBe(true);
    expect(error).toMatchObject({ code: "usage_limit", retryAt: resetsAtSeconds * 1_000 });
    expect(turnEvents.find((event) => event.type === "turn:error")).toMatchObject({
      code: "usage_limit",
      retryAt: resetsAtSeconds * 1_000,
    });
    expect(persisted.messages.filter((message) => message.error === true)).toEqual([
      expect.objectContaining({
        content: expect.stringMatching(/^Codex usage limit reached\. It resets /),
      }),
    ]);
  });
});
