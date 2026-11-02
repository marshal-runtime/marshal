import { afterEach, describe, expect, it, vi } from "vitest";

import { callIpc, testDouble, type TestIpcHandlers } from "../testing/harness";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  shell: { openExternal: vi.fn<() => void>() },
}));

import { registerCopilotHandlers } from "./copilot-ipc";

type Handler = (...args: unknown[]) => unknown;

function collectHandlers(deps: Record<string, unknown>): TestIpcHandlers {
  const handlers: TestIpcHandlers = new Map();
  const ipcHandle = (channel: string, handler: Handler) => {
    handlers.set(channel, handler);
  };
  registerCopilotHandlers(
    testDouble<Parameters<typeof registerCopilotHandlers>[0]>({ ...deps, ipcHandle }),
  );
  return handlers;
}

function createHandlers(overrides?: {
  sendMessage?: () => Promise<void>;
  steerMessage?: () => Promise<void>;
  stopSession?: (sessionId: string) => Promise<void>;
  onSessionSendFailed?: (sessionId: string) => void;
}) {
  const sessionManager = {
    initClient: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getCurrentSessionId: vi.fn<() => string>(() => "s1"),
    sendMessage: vi.fn<() => Promise<void>>(overrides?.sendMessage ?? (() => Promise.resolve())),
    steerMessage: vi.fn<() => Promise<void>>(overrides?.steerMessage ?? (() => Promise.resolve())),
    addEventListener: vi.fn<() => () => void>(() => vi.fn<() => void>()),
    resumeAfterUserStop: vi.fn<(sessionId: string) => void>(),
    stopSession: vi
      .fn<(sessionId: string) => Promise<void>>()
      .mockImplementation(overrides?.stopSession ?? (() => Promise.resolve())),
    cancelTurn: vi.fn<(sessionId: string) => Promise<void>>().mockResolvedValue(undefined),
    abortSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  const powerManager = {
    markBusy: vi.fn<(sessionId: string) => void>(),
    markIdle: vi.fn<(sessionId: string) => void>(),
  };
  const onSessionSendFailed = vi.fn<(sessionId: string) => void>(
    overrides?.onSessionSendFailed ?? (() => {}),
  );
  const handlers = collectHandlers({
    sessionManager,
    powerManager,
    getWindow: () => null,
    identityController: {},
    onSessionSendFailed,
  });
  return { handlers, sessionManager, powerManager, onSessionSendFailed };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("copilot:send", () => {
  it("does not cancel a valid long-running silent turn", async () => {
    vi.useFakeTimers();
    let complete: (() => void) | undefined;
    const { handlers, sessionManager } = createHandlers({
      sendMessage: () => new Promise<void>((resolve) => (complete = resolve)),
    });

    const resultPromise = callIpc(handlers, "copilot:send", "hello", "s1");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(sessionManager.cancelTurn).not.toHaveBeenCalled();
    expect(sessionManager.resumeAfterUserStop).toHaveBeenCalledExactlyOnceWith("s1");
    complete?.();
    await expect(resultPromise).resolves.toEqual({ success: true });
  });
});

describe("copilot:abort", () => {
  it("uses the user-stop boundary instead of turn-only cancellation", async () => {
    const { handlers, sessionManager, powerManager } = createHandlers();

    const result = await callIpc(handlers, "copilot:abort", "s1");

    expect(result.success).toBe(true);
    expect(sessionManager.stopSession).toHaveBeenCalledExactlyOnceWith("s1");
    expect(sessionManager.cancelTurn).not.toHaveBeenCalled();
    expect(sessionManager.abortSession).not.toHaveBeenCalled();
    expect(powerManager.markIdle).toHaveBeenCalledExactlyOnceWith("s1");
  });

  it("returns a retryable cancellation error and still releases power state", async () => {
    const { handlers, sessionManager, powerManager } = createHandlers({
      stopSession: () =>
        Promise.reject(
          new Error("Cancellation timed out. The response was isolated; send again to retry."),
        ),
    });

    const result = await callIpc(handlers, "copilot:abort", "s1");

    expect(result).toEqual({
      success: false,
      error: "Cancellation timed out. The response was isolated; send again to retry.",
    });
    expect(sessionManager.stopSession).toHaveBeenCalledExactlyOnceWith("s1");
    expect(powerManager.markIdle).toHaveBeenCalledExactlyOnceWith("s1");
  });
});

describe("copilot:steer", () => {
  it("cancels and dispatches the replacement through one SessionManager transaction", async () => {
    const { handlers, sessionManager, powerManager } = createHandlers();
    const attachments = [{ type: "file" as const, path: "/tmp/test", displayName: "test" }];

    const result = await callIpc(
      handlers,
      "copilot:steer",
      "redirect",
      "s1",
      attachments,
      "message-1",
    );

    expect(result.success).toBe(true);
    expect(sessionManager.steerMessage).toHaveBeenCalledExactlyOnceWith(
      "s1",
      "redirect",
      attachments,
      { clientMessageId: "message-1" },
    );
    expect(sessionManager.resumeAfterUserStop).toHaveBeenCalledExactlyOnceWith("s1");
    expect(sessionManager.cancelTurn).not.toHaveBeenCalled();
    expect(sessionManager.sendMessage).not.toHaveBeenCalled();
    expect(powerManager.markBusy).toHaveBeenCalledExactlyOnceWith("s1");
  });
});
