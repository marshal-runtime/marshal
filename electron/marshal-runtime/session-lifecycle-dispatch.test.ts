import { describe, expect, it, vi } from "vitest";

import { LIFECYCLE_PIN_METADATA_KEY, LifecycleWorkspacePins } from "./lifecycle-workspace-pins";
import {
  SessionLifecycleDispatcher,
  type RuntimeSessionLifecyclePort,
} from "./session-lifecycle-dispatch";

function setup(overrides: Partial<RuntimeSessionLifecyclePort> = {}) {
  const port = {
    startRuntimeSession: vi.fn<RuntimeSessionLifecyclePort["startRuntimeSession"]>(
      async () => ({}),
    ),
    endRuntimeSession: vi.fn<RuntimeSessionLifecyclePort["endRuntimeSession"]>(async () => ({})),
    ...overrides,
  };
  const log = { warn: vi.fn<(message: string, meta: unknown) => void>() };
  const resolveWorkspaceName = vi.fn<(sessionId: string) => Promise<string | null>>(
    async () => "marshal",
  );
  const dispatcher = new SessionLifecycleDispatcher({ port, resolveWorkspaceName, log });
  return { port, log, resolveWorkspaceName, dispatcher };
}

describe("SessionLifecycleDispatcher", () => {
  it("starts each session once per app run, for create and resume alike", async () => {
    const { port, dispatcher } = setup();

    await Promise.all([
      dispatcher.sessionStarted({ sessionId: "s1", parentSessionId: "p1" }),
      dispatcher.sessionStarted({ sessionId: "s1" }),
    ]);
    await dispatcher.sessionStarted({ sessionId: "s1" });

    expect(port.startRuntimeSession).toHaveBeenCalledTimes(1);
    expect(port.startRuntimeSession).toHaveBeenCalledWith({
      sessionId: "s1",
      workspaceName: "marshal",
      parentSessionId: "p1",
    });
  });

  it("returns before the runtime call settles, so session start never waits on it", () => {
    let release: () => void = () => undefined;
    const { dispatcher } = setup({
      startRuntimeSession: () =>
        new Promise((resolve) => {
          release = () => resolve({});
        }),
    });
    let settled = false;

    void dispatcher.sessionStarted({ sessionId: "s1" }).then(() => {
      settled = true;
    });

    expect(settled).toBe(false);
    release();
  });

  it("logs a failed start with metadata only and never rejects", async () => {
    const failure = Object.assign(new Error("secret session content"), { code: "invalid_scope" });
    const { log, dispatcher } = setup({
      startRuntimeSession: vi.fn<RuntimeSessionLifecyclePort["startRuntimeSession"]>(async () =>
        Promise.reject(failure),
      ),
    });

    await expect(dispatcher.sessionStarted({ sessionId: "s1" })).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith("Runtime startSession failed", {
      sessionId: "s1",
      error: "Error",
      code: "invalid_scope",
    });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("secret session content");
  });

  it("ends a started session once, after its start settles, with the start's parent", async () => {
    const { port, dispatcher } = setup();
    void dispatcher.sessionStarted({ sessionId: "s1", parentSessionId: "p1" });

    await dispatcher.sessionEnded({ sessionId: "s1", outcome: "deleted:user-ipc" });
    await dispatcher.sessionEnded({ sessionId: "s1" });

    expect(port.endRuntimeSession).toHaveBeenCalledTimes(1);
    expect(port.endRuntimeSession).toHaveBeenCalledWith({
      sessionId: "s1",
      parentSessionId: "p1",
      outcome: "deleted:user-ipc",
    });
  });

  it("skips end for sessions never started this run or whose start failed", async () => {
    const { port, resolveWorkspaceName, dispatcher } = setup();
    resolveWorkspaceName.mockResolvedValueOnce(null);
    await dispatcher.sessionStarted({ sessionId: "unscoped" });

    await dispatcher.sessionEnded({ sessionId: "never-started" });
    await dispatcher.sessionEnded({ sessionId: "unscoped" });

    expect(port.startRuntimeSession).not.toHaveBeenCalled();
    expect(port.endRuntimeSession).not.toHaveBeenCalled();
  });

  it("logs a failed end without rejecting", async () => {
    const { log, dispatcher } = setup({
      endRuntimeSession: vi.fn<RuntimeSessionLifecyclePort["endRuntimeSession"]>(async () =>
        Promise.reject(new TypeError("boom")),
      ),
    });
    await dispatcher.sessionStarted({ sessionId: "s1" });

    await expect(dispatcher.sessionEnded({ sessionId: "s1" })).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith("Runtime endSession failed", {
      sessionId: "s1",
      error: "TypeError",
      code: undefined,
    });
  });
});

describe("LifecycleWorkspacePins", () => {
  it("resolves a pin only for its own session while the call is in flight", async () => {
    const pins = new LifecycleWorkspacePins<string>();
    pins.remember("s1", "workspace-scope");
    const scope = pins.take("s1");
    let token = "";

    await pins.withPin("s1", scope!, async (issued) => {
      token = issued;
      expect(pins.resolve("s1", { [LIFECYCLE_PIN_METADATA_KEY]: issued })).toBe("workspace-scope");
      expect(pins.resolve("s2", { [LIFECYCLE_PIN_METADATA_KEY]: issued })).toBeUndefined();
    });

    expect(pins.resolve("s1", { [LIFECYCLE_PIN_METADATA_KEY]: token })).toBeUndefined();
    expect(pins.take("s1")).toBeUndefined();
  });
});
