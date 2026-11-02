import * as fs from "fs";

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { TurnEvent } from "../common/marshal-ipc-contract";
import * as safeStorage from "./safe-storage-file";
import { STUCK_TIMEOUT_MS } from "./session-view-builder";
import { SessionTestAccess, createTestBackend } from "./testing/harness";

const m = await vi.hoisted(async () => await import("./test-helpers/session-test-mocks"));
vi.mock("fs", m.fsFactory);
vi.mock("./session-archive", m.sessionArchiveFactory);
vi.mock("child_process", m.childProcessFactory);
vi.mock("electron", m.electronFactory);
vi.mock("@github/copilot-sdk", m.copilotSdkFactory);
vi.mock("./skills", m.skillsFactory);
vi.mock("./cli-path", m.cliPathFactory);
vi.mock("./safe-storage-file", () => ({
  readEncryptedFileSync: vi.fn<(path: string) => string>(() => "{}"),
  writeEncryptedFileSync: vi.fn<(path: string, content: string) => void>(),
  readEncryptedFile: vi.fn<(path: string) => Promise<string>>(async () => "{}"),
  writeEncryptedFile: vi.fn<(path: string, content: string) => Promise<void>>(async () => {}),
}));

function isPersistedAssistantMessage(value: unknown): value is { role: string; content: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    Reflect.get(value, "role") === "assistant" &&
    Reflect.get(value, "content") === "Persisted reply"
  );
}

const mockedFs = vi.mocked(fs);

beforeEach(() => {
  vi.clearAllMocks();
  mockedFs.existsSync.mockReturnValue(false);
  mockedFs.readdirSync.mockReturnValue([]);
});

/** Create a SessionManager with an SDK session and capture the event handler */
async function createManagerWithSession(sessionId = "test-session") {
  mockedFs.existsSync.mockReturnValue(false);
  const { SessionManager } = await import("./sessions");
  const mgr = new SessionManager("/test/workspace", await createTestBackend());
  const access = new SessionTestAccess(mgr);

  let eventHandler: ((event: any) => void) | null = null;

  const mockSdkSession = {
    sessionId: "sdk-test",
    on: vi.fn<(handler: any) => void>((handler: any) => {
      eventHandler = handler;
    }),
    send: vi.fn<() => Promise<string>>(),
    destroy: vi.fn<() => void>(),
  };
  const mockCreateSession = vi
    .fn<(...args: any[]) => Promise<typeof mockSdkSession>>()
    .mockResolvedValue(mockSdkSession);
  access.client = { createSession: mockCreateSession };

  await access.createSDKSession(sessionId, true);

  return { mgr, access, mockSdkSession, mockCreateSession, eventHandler: eventHandler! };
}

// ---------------------------------------------------------------------------
// Event forwarding to renderer
// ---------------------------------------------------------------------------

describe("Event forwarding (TurnEvents)", () => {
  it("forwards text delta with session ID", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();
    const events: any[] = [];
    mgr.addEventListener((sid: string, event: any) => events.push({ sid, event }));

    eventHandler({ type: "assistant.message_delta", data: { deltaContent: "Hello world" } });

    expect(events).toHaveLength(1);
    expect(events[0].sid).toBe("test-session");
    expect(events[0].event.type).toBe("turn:text-delta");
    expect(events[0].event.delta).toBe("Hello world");
  });

  it("forwards assistant.message as turn:message-committed", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();
    const events: any[] = [];
    mgr.addEventListener((sid: string, event: any) => events.push({ sid, event }));

    eventHandler({ type: "assistant.message", data: { content: "Complete response" } });

    expect(events).toHaveLength(1);
    expect(events[0].event.type).toBe("turn:message-committed");
    expect(events[0].event.message.content).toBe("Complete response");
  });

  it("forwards tool execution lifecycle as turn:tools-updated events", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();
    const eventTypes: string[] = [];
    mgr.addEventListener((_sid: string, event: any) => eventTypes.push(event.type));

    eventHandler({
      type: "tool.execution_start",
      data: { toolName: "filesystem__read_file", toolCallId: "tc-1" },
    });
    eventHandler({ type: "tool.execution_complete", data: { toolCallId: "tc-1", success: true } });

    // tool.execution_start produces turn:tools-updated.
    // tool.execution_complete produces [turn:tools-updated, turn:tool-completed].
    // tool.execution_end IS normalized by the backend (mapped to tool-result),
    // but the TurnAccumulator deduplicates: if tool.execution_end and
    // tool.execution_complete both arrive for the same toolCallId, only the
    // first produces turn:tool-completed.
    expect(eventTypes).toEqual(["turn:tools-updated", "turn:tools-updated", "turn:tool-completed"]);
  });

  it("forwards session.idle as turn:idle", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();
    const events: any[] = [];
    mgr.addEventListener((_sid: string, event: any) => events.push(event));

    eventHandler({ type: "session.idle", data: {} });

    expect(events[0].type).toBe("turn:idle");
  });

  it("persists a tool-only turn on idle", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();
    const appendSpy = vi.spyOn(mgr, "appendMessage").mockImplementation(() => true);

    eventHandler({
      type: "tool.execution_start",
      data: { toolName: "filesystem__read_file", toolCallId: "tc-1" },
    });
    eventHandler({ type: "tool.execution_complete", data: { toolCallId: "tc-1", success: true } });
    eventHandler({ type: "session.idle", data: {} });

    expect(appendSpy).toHaveBeenCalledWith(
      "test-session",
      expect.objectContaining({
        role: "assistant",
        toolCalls: expect.arrayContaining([expect.objectContaining({ id: "tc-1" })]),
      }),
      expect.any(Object),
    );
  });

  it("forwards error as turn:error", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();
    const events: any[] = [];
    mgr.addEventListener((_sid: string, event: any) => events.push(event));

    eventHandler({ type: "session.error", data: { message: "SDK error" } });

    expect(events[0].type).toBe("turn:error");
    expect(events[0].error).toBe("SDK error");
  });
});

// ---------------------------------------------------------------------------
// MCP server status / OAuth event forwarding (plugin remote MCP support)
// ---------------------------------------------------------------------------

describe("MCP server status & OAuth event forwarding", () => {
  it("forwards mcp.oauth_required to mcpStatusCallback", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();
    const turnEvents: any[] = [];
    const mcpEvents: any[] = [];
    mgr.addEventListener((_sid: string, event: any) => turnEvents.push(event));
    mgr.getMcpStatusManager().setMcpStatusCallback((event) => mcpEvents.push(event));

    eventHandler({
      type: "mcp.oauth_required",
      data: { requestId: "req-1", serverName: "powerbi", serverUrl: "https://x" },
    });

    // Routed via mcpStatusCallback, not via TurnAccumulator
    expect(turnEvents).toHaveLength(0);
    expect(mcpEvents).toEqual([
      {
        type: "mcp-oauth-required",
        requestId: "req-1",
        serverName: "powerbi",
        serverUrl: "https://x",
        // sessionId is stamped by SessionManager.subscribeToBackendEvents so the
        // OAuth IPC handler can pick the originating session as the executor.
        sessionId: "test-session",
      },
    ]);
  });

  it("forwards mcp.oauth_completed to mcpStatusCallback", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();
    const mcpEvents: any[] = [];
    mgr.getMcpStatusManager().setMcpStatusCallback((event) => mcpEvents.push(event));

    eventHandler({ type: "mcp.oauth_completed", data: { requestId: "req-1" } });

    expect(mcpEvents).toEqual([{ type: "mcp-oauth-completed", requestId: "req-1" }]);
  });

  it("forwards session.mcp_server_status_changed to mcpStatusCallback", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();
    const mcpEvents: any[] = [];
    mgr.getMcpStatusManager().setMcpStatusCallback((event) => mcpEvents.push(event));

    eventHandler({
      type: "session.mcp_server_status_changed",
      data: { serverName: "powerbi", status: "failed" },
    });

    expect(mcpEvents).toEqual([
      { type: "mcp-server-status", serverName: "powerbi", status: "failed" },
    ]);
  });

  it("fans out session.mcp_servers_loaded as one mcpStatusCallback per server", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();
    const mcpEvents: any[] = [];
    mgr.getMcpStatusManager().setMcpStatusCallback((event) => mcpEvents.push(event));

    eventHandler({
      type: "session.mcp_servers_loaded",
      data: {
        servers: [
          { name: "fs", status: "connected", source: "user" },
          { name: "powerbi", status: "needs-auth", source: "plugin" },
        ],
      },
    });

    expect(mcpEvents).toHaveLength(2);
    expect(mcpEvents[0]).toMatchObject({ serverName: "fs", status: "connected" });
    expect(mcpEvents[1]).toMatchObject({ serverName: "powerbi", status: "needs-auth" });
  });

  it("does not invoke mcpStatusCallback when none registered (no crash)", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();
    const turnEvents: any[] = [];
    mgr.addEventListener((_sid: string, event: any) => turnEvents.push(event));

    expect(() =>
      eventHandler({
        type: "mcp.oauth_required",
        data: { requestId: "req-1", serverName: "x", serverUrl: "y" },
      }),
    ).not.toThrow();
    expect(turnEvents).toHaveLength(0);
  });

  // Pin SessionManager.connectMcpPipeline as the composition-root wrapper:
  // McpStatusManager.connectPipeline has its own dedicated tests in
  // mcp-status-manager.marshal.test.ts, but the *wrapper* on SessionManager that
  // `main.ts` actually calls has no direct test. The whole point of the
  // narrowing is that `main.ts` never reaches for `getMcpStatusManager()`,
  // so if a future refactor silently re-couples the composition root to
  // the `@internal` getter, no test catches it. This test pins both halves
  // (disabledProvider + statusCallback) route correctly through the wrapper.
  it("connectMcpPipeline wires both the disabledProvider and the statusCallback", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();
    const disabledProvider = vi
      .fn<(sessionId: string) => Set<string>>()
      .mockReturnValue(new Set(["ExampleMcp"]));
    const statusCallback = vi.fn<(event: any) => void>();

    mgr.connectMcpPipeline({ disabledProvider, statusCallback });

    // disabledProvider half: visible through the narrowed mcpStatus surface.
    expect(mgr.mcpStatus.getDisabledMcps("test-session")).toEqual(new Set(["ExampleMcp"]));
    expect(disabledProvider).toHaveBeenCalledWith("test-session");

    // statusCallback half: an MCP-namespaced backend event routes through
    // the wrapper-installed callback (NOT the test-only setter path).
    eventHandler({
      type: "session.mcp_server_status_changed",
      data: { serverName: "powerbi", status: "failed" },
    });
    expect(statusCallback).toHaveBeenCalledWith({
      type: "mcp-server-status",
      serverName: "powerbi",
      status: "failed",
    });
  });
});

// ---------------------------------------------------------------------------
// Busy state tracking
// ---------------------------------------------------------------------------

describe("Busy state tracking", () => {
  it("clears busy on session.idle", async () => {
    const { access, eventHandler } = await createManagerWithSession();
    access.busyTracker.setBusy("test-session");

    eventHandler({ type: "session.idle", data: {} });

    expect(access.busyTracker.isBusy("test-session")).toBe(false);
  });

  it("clears busy on error", async () => {
    const { access, eventHandler } = await createManagerWithSession();
    access.busyTracker.setBusy("test-session");

    eventHandler({ type: "session.error", data: { message: "fail" } });

    expect(access.busyTracker.isBusy("test-session")).toBe(false);
  });

  it("does not clear busy on message_delta (still processing)", async () => {
    const { access, eventHandler } = await createManagerWithSession();
    access.busyTracker.setBusy("test-session");

    eventHandler({ type: "assistant.message_delta", data: { deltaContent: "..." } });

    expect(access.busyTracker.isBusy("test-session")).toBe(true);
  });

  it("keeps long-running tools busy and emits a status handle instead of idle", async () => {
    vi.useFakeTimers();
    try {
      const { mgr, access, eventHandler } = await createManagerWithSession();
      const events: any[] = [];
      mgr.addEventListener((_sid: string, event: any) => events.push(event));
      access.busyTracker.setBusy("test-session");

      eventHandler({
        type: "tool.execution_start",
        data: { toolCallId: "tool-1", toolName: "powershell", arguments: { command: "build" } },
      });

      await vi.advanceTimersByTimeAsync(STUCK_TIMEOUT_MS + 100);

      expect(access.busyTracker.isBusy("test-session")).toBe(true);
      expect(events.some((event) => event.type === "turn:idle")).toBe(false);
      expect(events.some((event) => event.type === "turn:error")).toBe(false);
      expect(
        events.some((event) => event.type === "turn:status" && event.status.includes("tool-1")),
      ).toBe(true);
      expect(mgr.listRunningTools("test-session")[0]).toEqual(
        expect.objectContaining({ handle: "test-session:tool-1", longRunning: true }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to cancel a turn-scoped running tool that holds no cancellation token", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();
    const cancelSpy = vi.spyOn(mgr, "cancelTurn").mockResolvedValue(undefined);

    eventHandler({
      type: "tool.execution_start",
      data: { toolCallId: "tool-1", toolName: "powershell", arguments: { command: "build" } },
    });

    const result = await mgr.cancelRunningTool("test-session:tool-1");

    expect(result).toEqual(
      expect.objectContaining({ success: false, handle: "test-session:tool-1" }),
    );
    expect(cancelSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Background session message saving
// ---------------------------------------------------------------------------

describe("Message persistence via TurnAccumulator", () => {
  it("saves assistant message and marks unread for background session", async () => {
    const { mgr, access, eventHandler } = await createManagerWithSession();
    access.currentSessionId = "other-session";

    const appendSpy = vi.spyOn(mgr, "appendMessage").mockImplementation(() => true);
    const unreadSpy = vi.spyOn(mgr, "markUnread").mockImplementation(() => {});

    eventHandler({
      type: "assistant.message",
      data: { content: "Background reply from automation", messageId: "msg-bg" },
    });

    expect(appendSpy).toHaveBeenCalledWith(
      "test-session",
      expect.objectContaining({
        role: "assistant",
        content: "Background reply from automation",
      }),
      expect.any(Object),
    );
    expect(unreadSpy).toHaveBeenCalledWith("test-session");
  });

  it("saves assistant message for the current foreground session too", async () => {
    const { mgr, access, eventHandler } = await createManagerWithSession();
    access.currentSessionId = "test-session"; // same session

    const appendSpy = vi.spyOn(mgr, "appendMessage").mockImplementation(() => true);

    eventHandler({
      type: "assistant.message",
      data: { content: "Foreground reply" },
    });

    // appendMessage is now called for ALL sessions (not just background)
    expect(appendSpy).toHaveBeenCalledWith(
      "test-session",
      expect.objectContaining({
        role: "assistant",
        content: "Foreground reply",
      }),
      expect.any(Object),
    );
  });

  it("saves partial content when turn:idle fires with pending content (safety net)", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();

    const appendSpy = vi.spyOn(mgr, "appendMessage").mockImplementation(() => true);

    // Stream some deltas without a final assistant.message
    eventHandler({ type: "assistant.message_delta", data: { deltaContent: "partial text" } });

    // Fire session.idle — the safety net should persist accumulated content
    eventHandler({ type: "session.idle", data: {} });

    expect(appendSpy).toHaveBeenCalledWith(
      "test-session",
      expect.objectContaining({
        role: "assistant",
        content: "partial text",
      }),
      expect.any(Object),
    );
  });

  it("saves partial content when turn:error fires with accumulated text", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();

    const appendSpy = vi.spyOn(mgr, "appendMessage").mockImplementation(() => true);

    // Stream some deltas
    eventHandler({ type: "assistant.message_delta", data: { deltaContent: "partial text" } });

    // Error mid-stream — should persist the partial content
    eventHandler({ type: "session.error", data: { message: "timeout" } });

    expect(appendSpy).toHaveBeenCalledWith(
      "test-session",
      expect.objectContaining({
        role: "assistant",
        content: "partial text",
      }),
      expect.any(Object),
    );
  });

  it("does NOT save message_delta events (only full messages)", async () => {
    const { mgr, access, eventHandler } = await createManagerWithSession();
    access.currentSessionId = "other-session";

    const appendSpy = vi.spyOn(mgr, "appendMessage").mockImplementation(() => true);

    eventHandler({
      type: "assistant.message_delta",
      data: { deltaContent: "partial..." },
    });

    expect(appendSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// setQuestion wiring (SessionManager → TurnAccumulator)
// ---------------------------------------------------------------------------

describe("setQuestion wiring via tool-result with question field", () => {
  it("buffers a question from tool-result into the accumulator", async () => {
    const { mgr, access } = await createManagerWithSession();

    // Emit a tool-result BackendEvent with a question field directly through
    // the backend's subscriber mechanism (simulates askUser post-hook emission).
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- accessing internal test API
    const backend = access.backend as any;
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- casting internal subscriber set
    const subscribers = backend.getSessionSubscribers?.("test-session") as
      | Set<(event: any) => void>
      | undefined;
    expect(subscribers).toBeDefined();
    expect(subscribers!.size).toBeGreaterThan(0);

    for (const listener of subscribers!) {
      listener({
        type: "tool-result",
        toolCallId: "tc-ask",
        result: "{}",
        success: true,
        question: {
          title: "Pick one",
          options: ["A", "B"],
          type: "ask_user",
        },
      });
    }

    const acc = mgr.getAccumulator("test-session");
    expect(acc.hasPendingQuestion()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sendAndCollect — queue serialization and event listener cleanup
// ---------------------------------------------------------------------------

describe("sendAndCollect", () => {
  it("serializes concurrent calls via queue", async () => {
    const { mgr, access } = await createManagerWithSession();
    access.currentSessionId = "test-session";
    access.sessions = new Map([["test-session", { id: "test-session", name: "Test" }]]);

    const callOrder: number[] = [];
    vi.spyOn(mgr, "sendMessage").mockImplementation(async () => {
      const callNum = callOrder.length + 1;
      callOrder.push(callNum);
      await new Promise((r) => setTimeout(r, 10));
      mgr.emitEvent("test-session", {
        type: "turn:text-delta",
        delta: `response-${callNum}`,
      } as TurnEvent);
      mgr.emitEvent("test-session", { type: "turn:idle" } as TurnEvent);
    });

    const [result1, result2] = await Promise.all([
      mgr.sendAndCollect("msg-1", 5000),
      mgr.sendAndCollect("msg-2", 5000),
    ]);

    expect(result1).toEqual({ kind: "ok", text: "response-1" });
    expect(result2).toEqual({ kind: "ok", text: "response-2" });
    expect(callOrder).toEqual([1, 2]);
  });

  it("other listeners still receive events during collection", async () => {
    const { mgr, access } = await createManagerWithSession();
    access.currentSessionId = "test-session";
    access.sessions = new Map([["test-session", { id: "test-session", name: "Test" }]]);

    const otherEvents: unknown[] = [];
    mgr.addEventListener((_sid: string, event: unknown) => otherEvents.push(event));

    vi.spyOn(mgr, "sendMessage").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      mgr.emitEvent("test-session", { type: "turn:text-delta", delta: "hi" } as TurnEvent);
      mgr.emitEvent("test-session", { type: "turn:idle" } as TurnEvent);
    });

    await mgr.sendAndCollect("test", 5000);

    const types = otherEvents.map((e: any) => e.type);
    expect(types).toContain("turn:text-delta");
    expect(types).toContain("turn:idle");
  });

  it("does not treat a recoverable same-turn retry (turn:error retrying) as fatal", async () => {
    const { mgr, access } = await createManagerWithSession();
    access.currentSessionId = "test-session";
    access.sessions = new Map([["test-session", { id: "test-session", name: "Test" }]]);

    vi.spyOn(mgr, "sendMessage").mockImplementation(async () => {
      // Transient recoverable model_call error mid-turn; the SDK retries and
      // the turn then completes.
      mgr.emitEvent("test-session", {
        type: "turn:error",
        error: "503 service unavailable",
        retrying: true,
      } as TurnEvent);
      mgr.emitEvent("test-session", {
        type: "turn:text-delta",
        delta: "recovered answer",
      } as TurnEvent);
      mgr.emitEvent("test-session", { type: "turn:idle" } as TurnEvent);
    });

    const result = await mgr.sendAndCollect("test", 5000);
    expect(result).toEqual({ kind: "ok", text: "recovered answer" });
  });

  it("rejects on a non-recoverable turn:error with the de-masked message", async () => {
    const { mgr, access } = await createManagerWithSession();
    access.currentSessionId = "test-session";
    access.sessions = new Map([["test-session", { id: "test-session", name: "Test" }]]);

    vi.spyOn(mgr, "sendMessage").mockImplementation(async () => {
      mgr.emitEvent("test-session", {
        type: "turn:error",
        error: "fatal backend failure",
      } as TurnEvent);
    });

    await expect(mgr.sendAndCollect("test", 5000)).rejects.toThrow("fatal backend failure");
  });

  it("discards pre-retry partial content when a retrying error precedes the retry", async () => {
    const { mgr, access } = await createManagerWithSession();
    access.currentSessionId = "test-session";
    access.sessions = new Map([["test-session", { id: "test-session", name: "Test" }]]);

    vi.spyOn(mgr, "sendMessage").mockImplementation(async () => {
      mgr.emitEvent("test-session", {
        type: "turn:text-delta",
        delta: "partial-fail",
      } as TurnEvent);
      mgr.emitEvent("test-session", {
        type: "turn:error",
        error: "503",
        retrying: true,
      } as TurnEvent);
      mgr.emitEvent("test-session", {
        type: "turn:text-delta",
        delta: "final answer",
      } as TurnEvent);
      mgr.emitEvent("test-session", { type: "turn:idle" } as TurnEvent);
    });

    const result = await mgr.sendAndCollect("test", 5000);
    // The pre-retry "partial-fail" must not leak into the retried result.
    expect(result).toEqual({ kind: "ok", text: "final answer" });
  });

  it("forwards every TurnEvent to the onEvent observer (regression: narrator context)", async () => {
    // Pins the `onEvent(evt)` line in doSendAndCollect above the switch.
    // Progress observers rely on text-delta, tool-completed,
    // reasoning-updated, and tools-updated all reaching them.
    const { mgr, access } = await createManagerWithSession();
    access.currentSessionId = "test-session";
    access.sessions = new Map([["test-session", { id: "test-session", name: "Test" }]]);

    const observed: TurnEvent[] = [];
    const observer = (evt: TurnEvent) => observed.push(evt);

    vi.spyOn(mgr, "sendMessage").mockImplementation(async () => {
      await Promise.resolve();
      mgr.emitEvent("test-session", {
        type: "turn:reasoning-updated",
        reasoning: { text: "thinking", durationSeconds: 0 },
      } as TurnEvent);
      mgr.emitEvent("test-session", {
        type: "turn:tools-updated",
        toolCalls: [
          { id: "tc-1", name: "read_file", description: "Reading foo.ts", running: true },
        ],
        startedToolId: "tc-1",
      } as TurnEvent);
      mgr.emitEvent("test-session", {
        type: "turn:tool-completed",
        toolCallId: "tc-1",
        output: "done",
        success: true,
      } as TurnEvent);
      mgr.emitEvent("test-session", {
        type: "turn:text-delta",
        delta: "Hello",
      } as TurnEvent);
      mgr.emitEvent("test-session", { type: "turn:idle" } as TurnEvent);
    });

    await mgr.sendAndCollect("test", 5000, observer);

    const types = observed.map((e) => e.type);
    expect(types).toEqual([
      "turn:reasoning-updated",
      "turn:tools-updated",
      "turn:tool-completed",
      "turn:text-delta",
      "turn:idle",
    ]);
  });

  it("a throwing onEvent observer does not break the collector", async () => {
    // Pins the try/catch around the onEvent invocation in doSendAndCollect.
    const { mgr, access } = await createManagerWithSession();
    access.currentSessionId = "test-session";
    access.sessions = new Map([["test-session", { id: "test-session", name: "Test" }]]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const brokenObserver = (_evt: TurnEvent) => {
      throw new Error("observer blew up");
    };

    vi.spyOn(mgr, "sendMessage").mockImplementation(async () => {
      await Promise.resolve();
      mgr.emitEvent("test-session", {
        type: "turn:text-delta",
        delta: "Hello",
      } as TurnEvent);
      mgr.emitEvent("test-session", { type: "turn:idle" } as TurnEvent);
    });

    const result = await mgr.sendAndCollect("test", 5000, brokenObserver);
    expect(result).toEqual({ kind: "ok", text: "Hello" });
    expect(warnSpy).toHaveBeenCalled();
  });

  it("resumes paused session instead of throwing when targetSessionId is not active", async () => {
    const { mgr, access } = await createManagerWithSession();
    access.currentSessionId = "test-session";
    access.sessions = new Map([["test-session", { id: "test-session", name: "Test" }]]);

    // Remove session from activeSessions to simulate a paused/expired session
    access.activeSessions.delete("test-session");

    // sendMessage (noSwitch) will be called — mock it to simulate resume + response
    vi.spyOn(mgr, "sendMessage").mockImplementation(async () => {
      // Simulate that sendMessage resumed the session and produced events
      await new Promise((r) => setTimeout(r, 5));
      mgr.emitEvent("test-session", {
        type: "turn:text-delta",
        delta: "resumed response",
      } as TurnEvent);
      mgr.emitEvent("test-session", { type: "turn:idle" } as TurnEvent);
    });

    // Should NOT throw "Target session is not active"
    const result = await mgr.sendAndCollect("test", 5000, undefined, "test-session");
    expect(result).toEqual({ kind: "ok", text: "resumed response" });
  });

  it("forwards attachments through the background send path", async () => {
    const { mgr, access } = await createManagerWithSession();
    access.currentSessionId = "test-session";
    access.sessions = new Map([["test-session", { id: "test-session", name: "Test" }]]);

    const attachments = [
      { type: "file" as const, path: "/tmp/photo.png", displayName: "photo.png" },
    ];
    const sendSpy = vi.spyOn(mgr, "sendMessage").mockImplementation(async (sessionId: string) => {
      await Promise.resolve();
      mgr.emitEvent(sessionId, { type: "turn:text-delta", delta: "seen" } as TurnEvent);
      mgr.emitEvent(sessionId, { type: "turn:idle" } as TurnEvent);
    });

    const result = await mgr.sendAndCollect("test", 5000, undefined, "test-session", attachments);

    expect(result).toEqual({ kind: "ok", text: "seen" });
    expect(sendSpy).toHaveBeenCalledWith("test-session", "test", attachments, {
      noSwitch: true,
    });
  });

  // Timeout test moved to "sendAndCollect timeout (fake timers)" describe block (Item 8)

  it("does not queue when sendAndCollect is called on different sessions concurrently", async () => {
    const { mgr, access } = await createManagerWithSession("session-a");
    access.currentSessionId = "session-a";

    // Set up a second session in activeSessions
    access.activeSessions.set("session-b", { id: "session-b" });

    const callOrder: string[] = [];
    vi.spyOn(mgr, "sendMessage").mockImplementation(async (sessionId: string) => {
      callOrder.push(`start-${sessionId}`);
      await new Promise((r) => setTimeout(r, 5));
      mgr.emitEvent(sessionId, {
        type: "turn:text-delta",
        delta: `reply-${sessionId}`,
      } as TurnEvent);
      mgr.emitEvent(sessionId, { type: "turn:idle" } as TurnEvent);
      callOrder.push(`end-${sessionId}`);
    });

    await Promise.all([
      mgr.sendAndCollect("msg-a", 5000, undefined, "session-a"),
      mgr.sendAndCollect("msg-b", 5000, undefined, "session-b"),
    ]);

    // Both sendMessage calls should start before either finishes,
    // proving they run concurrently (not serialized by a global queue).
    expect(callOrder.indexOf("start-session-b")).toBeLessThan(callOrder.indexOf("end-session-a"));
  });

  it("waits for the durable backend-delivery callback when idle arrives first", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    access.currentSessionId = "test-session";
    access.sessions = new Map([["test-session", { id: "test-session", name: "Test" }]]);
    let releaseBackendSend!: () => void;
    const backendSendGate = new Promise<void>((resolve) => {
      releaseBackendSend = resolve;
    });
    const onBackendDispatchStarting = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const onBackendDelivered = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const observer = vi.fn<(event: TurnEvent) => void>();
    vi.spyOn(mgr, "sendMessage").mockImplementation(
      async (_sessionId, _content, _attachments, options) => {
        mgr.emitEvent("test-session", { type: "turn:idle" } as TurnEvent);
        mgr.emitEvent("test-session", {
          type: "turn:text-delta",
          delta: "unrelated previous turn",
        });
        mgr.emitEvent("test-session", {
          type: "turn:message-committed",
          message: {
            id: "agent-message-1",
            role: "user",
            content: "agent delivery",
            timestamp: new Date().toISOString(),
          },
        } as TurnEvent);
        await options?.onBackendDispatchStarting?.();
        mgr.emitEvent("test-session", { type: "turn:text-delta", delta: "done" } as TurnEvent);
        mgr.emitEvent("test-session", { type: "turn:idle" } as TurnEvent);
        mgr.emitEvent("test-session", {
          type: "turn:message-committed",
          message: {
            id: "goal-pause",
            role: "user",
            content: "",
            timestamp: new Date().toISOString(),
          },
        } as TurnEvent);
        mgr.emitEvent("test-session", {
          type: "turn:message-committed",
          message: {
            id: "later-turn",
            role: "assistant",
            content: "wrong later turn",
            timestamp: new Date().toISOString(),
          },
        } as TurnEvent);
        await backendSendGate;
        await options?.onBackendDelivered?.();
      },
    );

    let settled = false;
    const collected = mgr.sendAndCollect(
      "agent delivery",
      5_000,
      observer,
      "test-session",
      undefined,
      {
        clientMessageId: "agent-message-1",
        onBackendDispatchStarting,
        onBackendDelivered,
      },
    );
    void collected.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(onBackendDelivered).not.toHaveBeenCalled());
    await Promise.resolve();

    expect(settled).toBe(false);
    releaseBackendSend();

    await expect(collected).resolves.toEqual({ kind: "ok", text: "done" });
    expect(onBackendDispatchStarting).toHaveBeenCalledOnce();
    expect(onBackendDelivered).toHaveBeenCalledOnce();
    expect(observer.mock.calls.map(([event]) => event)).toEqual([
      { type: "turn:text-delta", delta: "done" },
      { type: "turn:idle" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// sendAndCollect prefers turn:message-committed over streamed text-deltas.
//
// Regression: long agent runs in gateway mode emit the final assistant text
// only via turn-complete (no preceding text-deltas), or via text-snapshot
// corrections that silently drop diffs. Without this preference, callers
// received empty or stale/truncated text on idle. The committed message
// carries the canonical assistant text from the backend, so we prefer it
// over the delta accumulator and fall back to the accumulator only when no
// committed message arrives (pure copilot-backend path).
// ---------------------------------------------------------------------------

describe("sendAndCollect prefers committed message over deltas", () => {
  it("returns turn:message-committed content when no text-deltas were emitted", async () => {
    // Gateway chat.final path: a single committed message with no
    // preceding text-deltas. Defer to the next microtask so the listener
    // inside doSendAndCollect is registered before we emit.
    const { mgr, access } = await createManagerWithSession();
    access.currentSessionId = "test-session";
    access.sessions = new Map([["test-session", { id: "test-session", name: "Test" }]]);

    vi.spyOn(mgr, "sendMessage").mockImplementation(async () => {
      await Promise.resolve();
      mgr.emitEvent("test-session", {
        type: "turn:message-committed",
        message: {
          id: "msg-1",
          role: "assistant",
          content: "Refactor complete: 12 files updated.",
          timestamp: new Date().toISOString(),
        },
      } as TurnEvent);
      mgr.emitEvent("test-session", { type: "turn:idle" } as TurnEvent);
    });

    const result = await mgr.sendAndCollect("do a long refactor", 5000);
    expect(result).toEqual({ kind: "ok", text: "Refactor complete: 12 files updated." });
  });

  it("prefers committed content over accumulated deltas (snapshot-correction case)", async () => {
    // Models can self-correct mid-stream; in gateway snapshot mode this
    // causes diffs to be silently dropped, leaving `accumulated` stale
    // (and non-empty, so it bypasses the empty-text fallback). The
    // committed message carries the canonical text and must win.
    const { mgr, access } = await createManagerWithSession();
    access.currentSessionId = "test-session";
    access.sessions = new Map([["test-session", { id: "test-session", name: "Test" }]]);

    vi.spyOn(mgr, "sendMessage").mockImplementation(async () => {
      await Promise.resolve();
      mgr.emitEvent("test-session", {
        type: "turn:text-delta",
        delta: "Refactor complete: 11 fil",
      } as TurnEvent);
      // Snapshot correction would have dropped a delta here; the committed
      // message arrives with the corrected, canonical content.
      mgr.emitEvent("test-session", {
        type: "turn:message-committed",
        message: {
          id: "msg-1",
          role: "assistant",
          content: "Refactor complete: 12 files updated.",
          timestamp: new Date().toISOString(),
        },
      } as TurnEvent);
      mgr.emitEvent("test-session", { type: "turn:idle" } as TurnEvent);
    });

    const result = await mgr.sendAndCollect("do a long refactor", 5000);
    expect(result).toEqual({ kind: "ok", text: "Refactor complete: 12 files updated." });
  });

  it("ignores empty intermediate committed messages between tool rounds", async () => {
    // Multi-tool flows can produce empty assistant turn-completes between
    // rounds. Those must not overwrite a previously-captured final message.
    const { mgr, access } = await createManagerWithSession();
    access.currentSessionId = "test-session";
    access.sessions = new Map([["test-session", { id: "test-session", name: "Test" }]]);

    vi.spyOn(mgr, "sendMessage").mockImplementation(async () => {
      await Promise.resolve();
      mgr.emitEvent("test-session", {
        type: "turn:message-committed",
        message: {
          id: "msg-1",
          role: "assistant",
          content: "All done.",
          timestamp: new Date().toISOString(),
        },
      } as TurnEvent);
      // An empty committed message arrives after — must not clobber.
      mgr.emitEvent("test-session", {
        type: "turn:message-committed",
        message: {
          id: "msg-2",
          role: "assistant",
          content: "",
          timestamp: new Date().toISOString(),
        },
      } as TurnEvent);
      mgr.emitEvent("test-session", { type: "turn:idle" } as TurnEvent);
    });

    const result = await mgr.sendAndCollect("test", 5000);
    expect(result).toEqual({ kind: "ok", text: "All done." });
  });

  it("falls back to accumulated deltas when no message-committed arrives", async () => {
    // Pure copilot-backend path: streaming deltas only, no committed event
    // before idle. Behavior must remain backwards compatible.
    const { mgr, access } = await createManagerWithSession();
    access.currentSessionId = "test-session";
    access.sessions = new Map([["test-session", { id: "test-session", name: "Test" }]]);

    vi.spyOn(mgr, "sendMessage").mockImplementation(async () => {
      await Promise.resolve();
      mgr.emitEvent("test-session", { type: "turn:text-delta", delta: "Hello, " } as TurnEvent);
      mgr.emitEvent("test-session", { type: "turn:text-delta", delta: "world!" } as TurnEvent);
      mgr.emitEvent("test-session", { type: "turn:idle" } as TurnEvent);
    });

    const result = await mgr.sendAndCollect("test", 5000);
    expect(result).toEqual({ kind: "ok", text: "Hello, world!" });
  });
});

// ---------------------------------------------------------------------------
// Auth error handling in hooks
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Item 5: sendAndCollect timer resets on non-standard events (e.g., turn:status)
// ---------------------------------------------------------------------------

describe("sendAndCollect timer resets on any event activity", () => {
  it("resets timer on turn:status events", async () => {
    vi.useFakeTimers();
    const { mgr, access } = await createManagerWithSession();
    access.currentSessionId = "test-session";
    access.sessions = new Map([["test-session", { id: "test-session", name: "Test" }]]);

    vi.spyOn(mgr, "sendMessage").mockImplementation(async () => {
      // Fire a text-delta first (so accumulated has content), then a status event,
      // then after more time passes, fire idle.
      // The status event should reset the timer and keep the session alive.
    });

    const collectPromise = mgr.sendAndCollect("test", 200);

    // Flush microtasks so the listener inside doSendAndCollect is registered
    await vi.advanceTimersByTimeAsync(0);

    // Emit a text-delta so there's accumulated content
    mgr.emitEvent("test-session", { type: "turn:text-delta", delta: "hello" } as TurnEvent);

    // Advance close to timeout
    await vi.advanceTimersByTimeAsync(180);

    // Emit a turn:status event — this should reset the timer
    mgr.emitEvent("test-session", { type: "turn:status", status: "thinking" } as TurnEvent);

    // Advance another 180ms — would have timed out if status didn't reset the timer
    await vi.advanceTimersByTimeAsync(180);

    // Emit a turn:token-usage event — this should also reset the timer
    mgr.emitEvent("test-session", {
      type: "turn:token-usage",
      currentTokens: 100,
      tokenLimit: 4000,
    } as TurnEvent);

    // Advance another 180ms
    await vi.advanceTimersByTimeAsync(180);

    // Now fire idle to complete
    mgr.emitEvent("test-session", { type: "turn:idle" } as TurnEvent);

    const result = await collectPromise;
    expect(result).toEqual({ kind: "ok", text: "hello" });

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Item 12: appendMessage failure in sdkSession.on doesn't block emitEvent
// ---------------------------------------------------------------------------

describe("Persistence failure resilience", () => {
  it("emitEvent still fires when appendMessage throws on message-committed", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();
    const events: any[] = [];
    mgr.addEventListener((_sid: string, event: any) => events.push(event));

    // Make appendMessage throw
    vi.spyOn(mgr, "appendMessage").mockImplementation(() => {
      throw new Error("disk full");
    });

    // Fire assistant.message — should NOT throw, emitEvent should still fire
    eventHandler({
      type: "assistant.message",
      data: { content: "Hello", messageId: "msg-1" },
    });

    // The renderer should still get the event
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("turn:message-committed");
  });

  it("emitEvent still fires when markUnread throws on background session", async () => {
    const { mgr, access, eventHandler } = await createManagerWithSession();
    access.currentSessionId = "other-session"; // different from test-session

    const events: any[] = [];
    mgr.addEventListener((_sid: string, event: any) => events.push(event));

    vi.spyOn(mgr, "appendMessage").mockImplementation(() => true); // succeed
    vi.spyOn(mgr, "markUnread").mockImplementation(() => {
      throw new Error("index corrupt");
    });

    eventHandler({
      type: "assistant.message",
      data: { content: "Background reply", messageId: "msg-bg" },
    });

    // Event should still reach the renderer despite markUnread failure
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("turn:message-committed");
  });

  it("emitEvent still fires when appendMessage throws on idle pending save", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();
    const events: any[] = [];
    mgr.addEventListener((_sid: string, event: any) => events.push(event));

    // Stream some deltas first
    eventHandler({ type: "assistant.message_delta", data: { deltaContent: "partial" } });

    // Now make appendMessage throw
    vi.spyOn(mgr, "appendMessage").mockImplementation(() => {
      throw new Error("disk full");
    });

    // Fire session.idle — safety net save will fail but event should still emit
    eventHandler({ type: "session.idle", data: {} });

    const idleEvents = events.filter((e: any) => e.type === "turn:idle");
    expect(idleEvents).toHaveLength(1);
  });

  it("emitEvent still fires when appendMessage throws on error partial save", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();
    const events: any[] = [];
    mgr.addEventListener((_sid: string, event: any) => events.push(event));

    // Stream some deltas first
    eventHandler({ type: "assistant.message_delta", data: { deltaContent: "partial" } });

    // Now make appendMessage throw
    vi.spyOn(mgr, "appendMessage").mockImplementation(() => {
      throw new Error("disk full");
    });

    // Fire error — partial save will fail but event should still emit
    eventHandler({ type: "session.error", data: { message: "timeout" } });

    const errorEvents = events.filter((e: any) => e.type === "turn:error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].error).toBe("timeout");
  });

  it("busySessions still clears when appendMessage throws on idle", async () => {
    const { mgr, access, eventHandler } = await createManagerWithSession();

    access.busyTracker.setBusy("test-session");

    vi.spyOn(mgr, "appendMessage").mockImplementation(() => {
      throw new Error("disk full");
    });

    // Fire delta then idle
    eventHandler({ type: "assistant.message_delta", data: { deltaContent: "partial" } });
    eventHandler({ type: "session.idle", data: {} });

    expect(access.busyTracker.isBusy("test-session")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Item 19: Accumulator resets between turns — no cross-turn text bleed
// ---------------------------------------------------------------------------

describe("Accumulator reset between turns", () => {
  it("does not bleed text from turn 1 into turn 2", async () => {
    const { mgr, eventHandler } = await createManagerWithSession();
    const committedMessages: any[] = [];
    mgr.addEventListener((_sid: string, event: any) => {
      if (event.type === "turn:message-committed") committedMessages.push(event.message);
    });

    // Spy on appendMessage to also capture what's persisted
    const appendSpy = vi.spyOn(mgr, "appendMessage").mockImplementation(() => true);

    // --- Turn 1: stream "first", then idle (no assistant.message, so safety net saves) ---
    eventHandler({ type: "assistant.message_delta", data: { deltaContent: "first" } });
    eventHandler({ type: "session.idle", data: {} });

    // Safety net should have saved "first"
    expect(appendSpy).toHaveBeenCalledWith(
      "test-session",
      expect.objectContaining({ content: "first" }),
      expect.any(Object),
    );
    appendSpy.mockClear();
    committedMessages.length = 0;

    // --- Turn 2: stream "second", then assistant.message commits "second" ---
    eventHandler({ type: "assistant.message_delta", data: { deltaContent: "second" } });
    eventHandler({
      type: "assistant.message",
      data: { content: "second", messageId: "msg-2" },
    });

    // The committed message should be "second", NOT "firstsecond"
    expect(committedMessages).toHaveLength(1);
    expect(committedMessages[0].content).toBe("second");

    // The persisted message from turn 2 should also be "second"
    expect(appendSpy).toHaveBeenCalledWith(
      "test-session",
      expect.objectContaining({ content: "second" }),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// Item 8: sendAndCollect timeout test with fake timers
// ---------------------------------------------------------------------------

describe("sendAndCollect timeout (fake timers)", () => {
  it("resolves with accumulated text when timeout fires", async () => {
    vi.useFakeTimers();
    const { mgr, access } = await createManagerWithSession();
    access.currentSessionId = "test-session";
    access.sessions = new Map([["test-session", { id: "test-session", name: "Test" }]]);

    vi.spyOn(mgr, "sendMessage").mockImplementation(async () => {
      // sendMessage resolves immediately; we'll emit events manually
    });

    const collectPromise = mgr.sendAndCollect("test", 500);

    // Let the sendMessage microtask settle
    await vi.advanceTimersByTimeAsync(0);

    // Emit a partial delta
    mgr.emitEvent("test-session", { type: "turn:text-delta", delta: "partial" } as TurnEvent);

    // Advance past the timeout — no idle event sent
    await vi.advanceTimersByTimeAsync(600);

    const result = await collectPromise;
    expect(result).toEqual({ kind: "timeout", text: "partial" });

    vi.useRealTimers();
  });

  it("resolves with a timeout kind and empty text when timeout fires with no content", async () => {
    vi.useFakeTimers();
    const { mgr, access } = await createManagerWithSession();
    access.currentSessionId = "test-session";
    access.sessions = new Map([["test-session", { id: "test-session", name: "Test" }]]);

    vi.spyOn(mgr, "sendMessage").mockImplementation(async () => {});

    const collectPromise = mgr.sendAndCollect("test", 500);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600);

    const result = await collectPromise;
    expect(result).toEqual({ kind: "timeout", text: "" });

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Item 9: Round-trip persistence test using real appendMessage + mocked fs
// ---------------------------------------------------------------------------

describe("Round-trip persistence (real appendMessage, mocked fs)", () => {
  const mockedSafeStorage = vi.mocked(safeStorage);

  it("assistant.message reaches disk via writeEncryptedFileSync", async () => {
    const { access, eventHandler } = await createManagerWithSession();
    access.currentSessionId = "test-session";

    // Set up the mocked fs to return valid session data when loadSessionData is called
    const sessionData = {
      id: "test-session",
      name: "Test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockedSafeStorage.readEncryptedFileSync.mockReturnValue(JSON.stringify(sessionData));
    mockedSafeStorage.writeEncryptedFileSync.mockImplementation(() => {}); // no-op

    // Do NOT spy on appendMessage — let the real implementation run
    // Fire assistant.message event
    eventHandler({
      type: "assistant.message",
      data: { content: "Persisted reply", messageId: "msg-persist" },
    });

    // The real appendMessage should have called writeEncryptedFileSync.
    // Under the chunked-v1 format the message content is persisted into a CHUNK
    // file (a JSON array of messages), while the `{id}.json` header carries only
    // metadata (its `messages` field is the fail-closed sentinel string). Find
    // the chunk write that contains the persisted assistant message.
    expect(mockedSafeStorage.writeEncryptedFileSync).toHaveBeenCalled();
    const sessionWrite = mockedSafeStorage.writeEncryptedFileSync.mock.calls.find(
      (call: [string, string]) => {
        try {
          const parsed: unknown = JSON.parse(call[1]);
          return Array.isArray(parsed) && parsed.some(isPersistedAssistantMessage);
        } catch {
          return false;
        }
      },
    );
    expect(sessionWrite).toBeDefined();
    if (!sessionWrite) throw new Error("Expected the persisted session chunk write");
    const parsed: unknown = JSON.parse(sessionWrite[1]);
    if (!Array.isArray(parsed)) throw new Error("Expected the session chunk to be an array");
    const persisted = parsed.find(isPersistedAssistantMessage);
    expect(persisted).toBeDefined();
    if (!persisted) throw new Error("Expected the persisted assistant message");
    expect(persisted.role).toBe("assistant");
  });

  it("idle safety-net save reaches disk via writeEncryptedFileSync", async () => {
    const { access, eventHandler } = await createManagerWithSession();
    access.currentSessionId = "test-session";

    const sessionData = {
      id: "test-session",
      name: "Test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockedSafeStorage.readEncryptedFileSync.mockReturnValue(JSON.stringify(sessionData));
    mockedSafeStorage.writeEncryptedFileSync.mockImplementation(() => {});

    // Stream deltas then idle (no assistant.message)
    eventHandler({ type: "assistant.message_delta", data: { deltaContent: "safety net text" } });
    eventHandler({ type: "session.idle", data: {} });

    // Verify at least one chunk write contains the pending content (messages are
    // persisted as a JSON array in a chunk file under the chunked-v1 format).
    const writeCallWithMessage = mockedSafeStorage.writeEncryptedFileSync.mock.calls.find(
      (call) => {
        try {
          const parsed = JSON.parse(call[1]);
          return (
            Array.isArray(parsed) && parsed.some((msg: any) => msg?.content === "safety net text")
          );
        } catch {
          return false;
        }
      },
    );
    expect(writeCallWithMessage).toBeDefined();
  });

  it("error partial save reaches disk via writeEncryptedFileSync", async () => {
    const { access, eventHandler } = await createManagerWithSession();
    access.currentSessionId = "test-session";

    const sessionData = {
      id: "test-session",
      name: "Test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockedSafeStorage.readEncryptedFileSync.mockReturnValue(JSON.stringify(sessionData));
    mockedSafeStorage.writeEncryptedFileSync.mockImplementation(() => {});

    // Stream deltas then error
    eventHandler({ type: "assistant.message_delta", data: { deltaContent: "error partial" } });
    eventHandler({ type: "session.error", data: { message: "connection lost" } });

    // Verify at least one chunk write contains the partial content.
    const writeCallWithMessage = mockedSafeStorage.writeEncryptedFileSync.mock.calls.find(
      (call) => {
        try {
          const parsed = JSON.parse(call[1]);
          return (
            Array.isArray(parsed) && parsed.some((msg: any) => msg?.content === "error partial")
          );
        } catch {
          return false;
        }
      },
    );
    expect(writeCallWithMessage).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Auth error handling in hooks
// ---------------------------------------------------------------------------

describe("Auth error handling via hooks", () => {
  it("fires authErrorCallback on auth error in onErrorOccurred hook", async () => {
    const { access, mockCreateSession } = await createManagerWithSession();

    const authErrors: string[] = [];
    access.authErrorCallback = (err: string) => authErrors.push(err);

    // Get the hooks from the SDK session creation
    const hooks = mockCreateSession.mock.calls[0][0].hooks;
    await hooks.onErrorOccurred({
      error: "HTTP 401 Unauthorized",
      errorContext: "model_call",
      recoverable: false,
      timestamp: Date.now(),
      cwd: "/tmp",
    });

    expect(authErrors).toHaveLength(1);
    expect(authErrors[0]).toContain("401");
  });

  it("does not fire authErrorCallback for non-auth errors", async () => {
    const { access, mockCreateSession } = await createManagerWithSession();

    const authErrors: string[] = [];
    access.authErrorCallback = (err: string) => authErrors.push(err);

    const hooks = mockCreateSession.mock.calls[0][0].hooks;
    await hooks.onErrorOccurred({
      error: "Network timeout",
      errorContext: "system",
      recoverable: true,
      timestamp: Date.now(),
      cwd: "/tmp",
    });

    expect(authErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MCP toolCallId lookup — SDK fires tool.execution_start (with toolCallId)
// before the permission handler, so we can resolve missing IDs.
// ---------------------------------------------------------------------------

describe("MCP toolCallId lookup from tool.execution_start", () => {
  it("populates toolCallId on permission request when SDK omits it", async () => {
    const { mgr, eventHandler, mockCreateSession } = await createManagerWithSession();

    // Capture the PermissionRequest that the permission callback receives
    const capturedRequests: any[] = [];
    mgr.setPermissionCallback(async (req: any) => {
      capturedRequests.push(req);
      return "approved";
    });

    // 1. SDK fires tool.execution_start with the real toolCallId
    eventHandler({
      type: "tool.execution_start",
      data: {
        toolCallId: "toolu_vrtx_01ABC",
        toolName: "playwright-browser_navigate",
      },
    });

    // 2. SDK calls the permission handler WITHOUT toolCallId (MCP bug)
    const permissionHandler = mockCreateSession.mock.calls[0][0].onPermissionRequest;
    await permissionHandler({
      kind: "mcp",
      toolName: "playwright-browser_navigate",
      // toolCallId intentionally missing
    });

    // 3. The permission callback should have received the resolved toolCallId
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].toolCallId).toBe("toolu_vrtx_01ABC");
  });

  // Regression guard: verifies SDK-provided toolCallId takes precedence over the queue
  it("uses SDK-provided toolCallId when present (no lookup needed)", async () => {
    const { mgr, eventHandler, mockCreateSession } = await createManagerWithSession();

    const capturedRequests: any[] = [];
    mgr.setPermissionCallback(async (req: any) => {
      capturedRequests.push(req);
      return "approved";
    });

    eventHandler({
      type: "tool.execution_start",
      data: { toolCallId: "toolu_from_event", toolName: "some_tool" },
    });

    const permissionHandler = mockCreateSession.mock.calls[0][0].onPermissionRequest;
    await permissionHandler({
      kind: "mcp",
      toolCallId: "toolu_from_sdk",
      toolName: "some_tool",
    });

    // SDK-provided toolCallId should be used, not the one from the event
    expect(capturedRequests[0].toolCallId).toBe("toolu_from_sdk");
  });

  it("handles same tool called twice with FIFO queue", async () => {
    const { mgr, eventHandler, mockCreateSession } = await createManagerWithSession();

    const capturedRequests: any[] = [];
    mgr.setPermissionCallback(async (req: any) => {
      capturedRequests.push(req);
      return "approved";
    });

    // Two tool.execution_start events for the same tool name
    eventHandler({
      type: "tool.execution_start",
      data: { toolCallId: "toolu_FIRST", toolName: "playwright-browser_navigate" },
    });
    eventHandler({
      type: "tool.execution_start",
      data: { toolCallId: "toolu_SECOND", toolName: "playwright-browser_navigate" },
    });

    const permissionHandler = mockCreateSession.mock.calls[0][0].onPermissionRequest;

    // First permission request should get the first toolCallId
    await permissionHandler({ kind: "mcp", toolName: "playwright-browser_navigate" });
    // Second permission request should get the second toolCallId
    await permissionHandler({ kind: "mcp", toolName: "playwright-browser_navigate" });

    expect(capturedRequests[0].toolCallId).toBe("toolu_FIRST");
    expect(capturedRequests[1].toolCallId).toBe("toolu_SECOND");
  });

  it("does not leak toolCallId across different tool names", async () => {
    const { mgr, eventHandler, mockCreateSession } = await createManagerWithSession();

    const capturedRequests: any[] = [];
    mgr.setPermissionCallback(async (req: any) => {
      capturedRequests.push(req);
      return "approved";
    });

    // tool.execution_start fires for tool X
    eventHandler({
      type: "tool.execution_start",
      data: { toolCallId: "toolu_for_X", toolName: "playwright-browser_navigate" },
    });

    // Permission handler called for tool Y (different name) — should NOT get X's ID
    const permissionHandler = mockCreateSession.mock.calls[0][0].onPermissionRequest;
    await permissionHandler({ kind: "mcp", toolName: "filesystem-move_file" });

    expect(capturedRequests[0].toolCallId).toBeUndefined();
  });

  it("evicts oldest half when queue exceeds cap, keeps recent IDs", async () => {
    const { mgr, eventHandler, mockCreateSession } = await createManagerWithSession();

    const capturedRequests: any[] = [];
    mgr.setPermissionCallback(async (req: any) => {
      capturedRequests.push(req);
      return "approved";
    });

    // Fill queue to cap (500 entries)
    for (let i = 0; i < 500; i++) {
      eventHandler({
        type: "tool.execution_start",
        data: { toolCallId: `toolu_old_${i}`, toolName: "mcp_tool" },
      });
    }

    // Push one more — triggers eviction of oldest 250
    eventHandler({
      type: "tool.execution_start",
      data: { toolCallId: "toolu_recent", toolName: "mcp_tool" },
    });

    // First permission request should get toolu_old_250 (first survivor after eviction)
    const permissionHandler = mockCreateSession.mock.calls[0][0].onPermissionRequest;
    await permissionHandler({ kind: "mcp", toolName: "mcp_tool" });

    // FIFO: oldest survivor after eviction of first 250 (indices 0-249 removed)
    expect(capturedRequests[0].toolCallId).toBe("toolu_old_250");
  });
});
