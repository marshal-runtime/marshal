import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IpcInvokeMap } from "../../common/marshal-ipc-contract";

// Capture ipcMain.handle wrappers so tests can invoke them directly.
const capturedWrappers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const isMockModeMock = vi.hoisted(() => vi.fn<() => boolean>(() => false));
const shouldUseRealE2EHandlerMock = vi.hoisted(() =>
  vi.fn<(channel: string) => boolean>(() => false),
);
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn<(ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void>(
      (ch, fn) => {
        capturedWrappers.set(ch, fn);
      },
    ),
  },
}));

vi.mock("../mock-mode", () => ({
  isMockMode: isMockModeMock,
}));

vi.mock("../e2e-stub-routing", () => ({
  shouldUseRealE2EHandler: shouldUseRealE2EHandlerMock,
}));

vi.mock("../process-lifecycle-diagnostics", () => ({
  writeProcessLifecycleEventSync: vi.fn<() => void>(),
}));

vi.mock("../e2e-stubs", () => ({
  E2E_DYNAMIC_STUBS: {},
  E2E_STUBS: {
    "sessions:list": { success: true, sessions: [], results: undefined },
    "goal:get": { success: false, error: "goal stub should be bypassed" },
    "goal:set": { success: false, error: "goal stub should be bypassed" },
    "goal:pause": { success: false, error: "goal stub should be bypassed" },
    "workspace:listWorkspaces": {
      success: true,
      workspaces: ["Scratchpad"],
      externalWorkspaces: [],
    },
  },
}));

import { authErrors, makeAuthError } from "../../common/telemetry/errors/marshal-auth";
import { ipcErrors, makeIpcError } from "../../common/telemetry/errors/marshal-ipc";
import { writeProcessLifecycleEventSync } from "../process-lifecycle-diagnostics";
// Use the REAL telemetry-errors module so the marker round-trip
// (sendErrorTelemetry → WeakSet → hasTelemetryMarker) is exercised end-to-end
// instead of faked with a hardcoded property. A hardcoded mock previously
// decoupled these two files: renaming the internal marker could pass both
// test suites while breaking the dedup in production.
import { sendErrorTelemetry, setTelemetryWindow } from "../telemetry-errors";
import {
  assertMainFrame,
  authorizeIpcWebContents,
  createIpcHandle,
  listRegisteredIpcChannels,
  UnauthorizedSenderError,
} from "./ipc-handle";

// eslint-disable-next-line vitest/require-mock-type-parameters
const sendSpy = vi.fn();

function attachStubWindow() {
  setTelemetryWindow({
    isDestroyed: () => false,
    webContents: { send: sendSpy },
  });
}

/**
 * Test helper: register a handler whose runtime signature doesn't match the
 * channel's compile-time IpcInvokeMap entry. Real handlers always match —
 * tests inject simpler bodies (e.g. `throw boom`) just to exercise the
 * wrapper's catch path. Centralizes the handful of type-level escapes the
 * generic dispatch needs.
 */
type AnyHandler = (event: unknown, ...args: unknown[]) => unknown;
function registerTestHandler(channel: keyof IpcInvokeMap, impl: AnyHandler): void {
  const ipcHandle = createIpcHandle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
  ipcHandle(channel as any, impl as any);
}

function makeInvokeEvent(webContentsId: number, childFrame = false): unknown {
  const mainFrame = {};
  const senderFrame = childFrame ? {} : mainFrame;
  return {
    sender: { id: webContentsId, mainFrame },
    senderFrame,
  };
}

async function withAuthorizedWebContents<T>(
  webContentsId: number,
  callback: () => Promise<T>,
): Promise<T> {
  const deauthorize = authorizeIpcWebContents(webContentsId);
  try {
    return await callback();
  } finally {
    deauthorize();
  }
}

describe("createIpcHandle — sender validation", () => {
  beforeEach(() => {
    capturedWrappers.clear();
    isMockModeMock.mockReturnValue(false);
    shouldUseRealE2EHandlerMock.mockReturnValue(false);
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it("rejects an unregistered webContents before invoking the handler", async () => {
    const handler = vi.fn<AnyHandler>(() => ({ success: true, sessions: [], results: undefined }));
    registerTestHandler("sessions:list", handler);

    const wrapped = capturedWrappers.get("sessions:list")!;
    await expect(wrapped(makeInvokeEvent(101))).rejects.toThrow(UnauthorizedSenderError);
    expect(handler).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it("allows a registered top-level webContents to invoke the handler", async () => {
    const response = { success: true, sessions: [], results: undefined };
    const handler = vi.fn<AnyHandler>(() => response);
    registerTestHandler("sessions:list", handler);

    const wrapped = capturedWrappers.get("sessions:list")!;
    await withAuthorizedWebContents(202, async () => {
      await expect(wrapped(makeInvokeEvent(202))).resolves.toBe(response);
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects a registered child frame before invoking the handler", async () => {
    const handler = vi.fn<AnyHandler>(() => ({ success: true, sessions: [], results: undefined }));
    registerTestHandler("sessions:list", handler);

    const wrapped = capturedWrappers.get("sessions:list")!;
    await withAuthorizedWebContents(303, async () => {
      await expect(wrapped(makeInvokeEvent(303, true))).rejects.toThrow(UnauthorizedSenderError);
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects an authorized event with a missing sender frame before invoking the handler", async () => {
    const handler = vi.fn<AnyHandler>(() => ({ success: true, sessions: [], results: undefined }));
    registerTestHandler("sessions:list", handler);

    const wrapped = capturedWrappers.get("sessions:list")!;
    await withAuthorizedWebContents(304, async () => {
      await expect(
        wrapped({ sender: { id: 304, mainFrame: {} }, senderFrame: undefined }),
      ).rejects.toThrow(UnauthorizedSenderError);
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("deauthorizes the webContents when the disposer is called", async () => {
    const handler = vi.fn<AnyHandler>(() => ({ success: true, sessions: [], results: undefined }));
    registerTestHandler("sessions:list", handler);
    const wrapped = capturedWrappers.get("sessions:list")!;
    const event = makeInvokeEvent(404);

    const deauthorize = authorizeIpcWebContents(404);
    await expect(wrapped(event)).resolves.toMatchObject({ success: true });
    deauthorize();

    await expect(wrapped(event)).rejects.toThrow(UnauthorizedSenderError);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("keeps mock mode stubs available for registered top-level webContents", async () => {
    isMockModeMock.mockReturnValue(true);
    const handler = vi.fn<AnyHandler>(() => ({
      success: false,
      error: "real handler should not run",
    }));
    registerTestHandler("sessions:list", handler);

    const wrapped = capturedWrappers.get("sessions:list")!;
    await withAuthorizedWebContents(405, async () => {
      await expect(wrapped(makeInvokeEvent(405))).resolves.toEqual({
        success: true,
        sessions: [],
        results: undefined,
      });
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("routes goal get, set, and lifecycle IPC to real handlers for the goal harness", async () => {
    isMockModeMock.mockReturnValue(true);
    shouldUseRealE2EHandlerMock.mockImplementation((channel) => channel.startsWith("goal:"));
    const getResponse = { success: true, snapshot: null };
    const setResponse = { success: true, snapshot: null };
    const pauseResponse = { success: true, snapshot: null };
    const getHandler = vi.fn<AnyHandler>(() => getResponse);
    const setHandler = vi.fn<AnyHandler>(() => setResponse);
    const pauseHandler = vi.fn<AnyHandler>(() => pauseResponse);
    registerTestHandler("goal:get", getHandler);
    registerTestHandler("goal:set", setHandler);
    registerTestHandler("goal:pause", pauseHandler);

    await withAuthorizedWebContents(406, async () => {
      await Promise.all([
        expect(capturedWrappers.get("goal:get")!(makeInvokeEvent(406))).resolves.toBe(getResponse),
        expect(capturedWrappers.get("goal:set")!(makeInvokeEvent(406))).resolves.toBe(setResponse),
        expect(capturedWrappers.get("goal:pause")!(makeInvokeEvent(406))).resolves.toBe(
          pauseResponse,
        ),
      ]);
    });
    expect(getHandler).toHaveBeenCalledOnce();
    expect(setHandler).toHaveBeenCalledOnce();
    expect(pauseHandler).toHaveBeenCalledOnce();
  });

  it("routes workspace IPC to real handlers for the fixture harness", async () => {
    isMockModeMock.mockReturnValue(true);
    shouldUseRealE2EHandlerMock.mockImplementation((channel) => channel.startsWith("workspace:"));
    const response = {
      success: true,
      workspaces: ["Scratchpad", "Project"],
      externalWorkspaces: ["Project"],
    };
    const handler = vi.fn<AnyHandler>(() => response);
    registerTestHandler("workspace:listWorkspaces", handler);

    await withAuthorizedWebContents(407, async () => {
      await expect(
        capturedWrappers.get("workspace:listWorkspaces")!(makeInvokeEvent(407)),
      ).resolves.toBe(response);
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("records channel attribution when an IPC handler blocks for at least 250ms", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(375.5);
    registerTestHandler("sessions:list", async () => ({
      success: true,
      sessions: [],
      results: undefined,
    }));

    const wrapped = capturedWrappers.get("sessions:list")!;
    await withAuthorizedWebContents(406, async () => {
      await wrapped(makeInvokeEvent(406), "query");
    });

    expect(writeProcessLifecycleEventSync).toHaveBeenCalledWith("ipc.handler.slow", {
      channel: "sessions:list",
      durationMs: 275.5,
      outcome: "success",
      argumentCount: 1,
      webContentsId: 406,
    });
    now.mockRestore();
  });

  it("exposes a sorted unique passive inventory of registered channels", () => {
    registerTestHandler("workspace:listWorkspaces", () => ({
      success: true,
      workspaces: [],
      externalWorkspaces: [],
    }));
    registerTestHandler("sessions:list", () => ({
      success: true,
      sessions: [],
      results: undefined,
    }));
    registerTestHandler("sessions:list", () => ({
      success: true,
      sessions: [],
      results: undefined,
    }));

    const inventory = listRegisteredIpcChannels();
    expect(inventory).toContain("sessions:list");
    expect(inventory).toContain("workspace:listWorkspaces");
    expect(inventory).toEqual(
      [...new Set(inventory)].sort((left, right) => left.localeCompare(right)),
    );
  });
});

describe("createIpcHandle — error telemetry", () => {
  beforeEach(() => {
    capturedWrappers.clear();
    isMockModeMock.mockReturnValue(false);
    sendSpy.mockReset();
    attachStubWindow();
  });

  afterEach(() => {
    setTelemetryWindow(null);
  });

  it("fires HANDLER_UNCAUGHT telemetry and re-throws when a handler throws", async () => {
    const boom = new Error("handler failure");
    registerTestHandler("sessions:list", async () => {
      throw boom;
    });

    const wrapped = capturedWrappers.get("sessions:list")!;
    await withAuthorizedWebContents(501, async () => {
      await expect(wrapped(makeInvokeEvent(501))).rejects.toThrow("handler failure");
    });
    expect(sendSpy).toHaveBeenCalledWith(
      "telemetry:logError",
      makeIpcError(ipcErrors.HANDLER_UNCAUGHT),
    );
  });

  it("does not fire telemetry when handler succeeds", async () => {
    registerTestHandler("sessions:list", async () => ({
      success: true,
      sessions: [],
      results: undefined,
    }));

    const wrapped = capturedWrappers.get("sessions:list")!;
    await withAuthorizedWebContents(502, async () => {
      await wrapped(makeInvokeEvent(502));
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("skips HANDLER_UNCAUGHT when the thrown error is already telemetered", async () => {
    // Mark the error via the REAL sendErrorTelemetry — this is the contract
    // we rely on in production. If sendErrorTelemetry stops marking (or
    // hasTelemetryMarker stops detecting), this test fails.
    const alreadyFired = new Error("instrumented deeper in the stack");
    sendErrorTelemetry(makeAuthError(authErrors.AUTH_SILENT_ACQUIRE_FAILED), alreadyFired);
    // Reset the spy so we only observe what happens inside the IPC catch.
    sendSpy.mockClear();

    registerTestHandler("sessions:list", async () => {
      throw alreadyFired;
    });

    const wrapped = capturedWrappers.get("sessions:list")!;
    await withAuthorizedWebContents(503, async () => {
      await expect(wrapped(makeInvokeEvent(503))).rejects.toThrow(
        "instrumented deeper in the stack",
      );
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("rejects sub-frame callers via wrapper before the handler body runs", async () => {
    let bodyRan = false;
    registerTestHandler("sessions:list", async () => {
      bodyRan = true;
      return { success: true, sessions: [], results: undefined };
    });

    const wrapped = capturedWrappers.get("sessions:list")!;
    await withAuthorizedWebContents(504, async () => {
      await expect(wrapped(makeInvokeEvent(504, true))).rejects.toThrow(/unauthorized sender/);
    });
    expect(bodyRan).toBe(false);
    // Two telemetry emits: UNAUTHORIZED_SENDER fault + structured event with
    // channel name. The fault's marker prevents the wrapper's catch from
    // ALSO firing HANDLER_UNCAUGHT (would be a third emit).
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy).toHaveBeenCalledWith(
      "telemetry:logError",
      makeIpcError(ipcErrors.UNAUTHORIZED_SENDER),
    );
    expect(sendSpy).toHaveBeenCalledWith("telemetry:logEvent", {
      scenario: "ipc.unauthorized_sender",
      fields: { channel: "sessions:list" },
    });
  });
});

describe("assertMainFrame", () => {
  beforeEach(() => {
    sendSpy.mockReset();
    attachStubWindow();
  });

  afterEach(() => {
    setTelemetryWindow(null);
  });

  function makeEvent(senderFrame: object | null, mainFrame: object | null) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal IpcMainInvokeEvent stub; assertMainFrame only reads senderFrame and sender.mainFrame
    return { senderFrame, sender: { mainFrame } } as unknown as Parameters<
      typeof assertMainFrame
    >[0];
  }

  it("returns normally when senderFrame is the main frame", () => {
    const frame = {};
    expect(() => assertMainFrame(makeEvent(frame, frame), "update:check")).not.toThrow();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("throws UnauthorizedSenderError when senderFrame is a sub-frame", () => {
    const mainFrame = {};
    const subFrame = {};
    expect(() => assertMainFrame(makeEvent(subFrame, mainFrame), "update:download")).toThrow(
      UnauthorizedSenderError,
    );
  });

  it("error carries the channel name and a non-PII message", () => {
    const mainFrame = {};
    const subFrame = {};
    let captured: unknown = null;
    try {
      assertMainFrame(makeEvent(subFrame, mainFrame), "update:install");
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(UnauthorizedSenderError);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed via toBeInstanceOf above; needed to read .channel/.code
    const e = captured as UnauthorizedSenderError;
    expect(e.channel).toBe("update:install");
    expect(e.message).toBe("unauthorized sender");
    expect(e.code).toBe("unauthorized_sender");
  });

  it("rejects a disposed sender frame (senderFrame null)", () => {
    // `senderFrame: WebFrameMain | null` per Electron's typings — null when
    // the sending frame was disposed before the handler dispatched.
    const mainFrame = {};
    expect(() => assertMainFrame(makeEvent(null, mainFrame), "update:restart")).toThrow(
      UnauthorizedSenderError,
    );
  });

  it("emits UNAUTHORIZED_SENDER fault and structured event with channel", () => {
    const mainFrame = {};
    const subFrame = {};
    expect(() => assertMainFrame(makeEvent(subFrame, mainFrame), "update:auth")).toThrow(
      "unauthorized sender",
    );
    expect(sendSpy).toHaveBeenCalledWith(
      "telemetry:logError",
      makeIpcError(ipcErrors.UNAUTHORIZED_SENDER),
    );
    expect(sendSpy).toHaveBeenCalledWith("telemetry:logEvent", {
      scenario: "ipc.unauthorized_sender",
      fields: { channel: "update:auth" },
    });
  });

  it("marks the thrown error so ipcHandle's catch skips HANDLER_UNCAUGHT", async () => {
    registerTestHandler("sessions:list", async () => ({
      success: true,
      sessions: [],
      results: undefined,
    }));

    sendSpy.mockClear();
    const wrapped = capturedWrappers.get("sessions:list")!;
    await withAuthorizedWebContents(909, async () => {
      await expect(wrapped(makeInvokeEvent(909, true))).rejects.toBeInstanceOf(
        UnauthorizedSenderError,
      );
    });
    // Two emits (fault + event); no third HANDLER_UNCAUGHT because the marker
    // round-trip is what this test pins.
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy).toHaveBeenCalledWith(
      "telemetry:logError",
      makeIpcError(ipcErrors.UNAUTHORIZED_SENDER),
    );
  });
});
