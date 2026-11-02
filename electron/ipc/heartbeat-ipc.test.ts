import { describe, it, expect, vi, beforeEach } from "vitest";

import type {
  HeartbeatSettings,
  HeartbeatSettingsEnvelope,
  HeartbeatStatusEnvelope,
  IpcInvokeMap,
} from "../../common/marshal-ipc-contract";
import type { HeartbeatOperationResult } from "../backend/types";
import { callIpc, testDouble } from "../testing/harness";
import { registerHeartbeatHandlers } from "./heartbeat-ipc";
import type { IpcDeps } from "./types";

// ── Typed factory helpers ──────────────────────────────────────────
// Avoid the `ReturnType<typeof vi.fn>` annotation pattern that resolves to
// `MockInstance<any, any>` and erases the per-method generics. Each factory
// returns a mock typed against its real method signature, so a future shape
// change in `IAutomationBackend` fails the build at the fixture instead of
// at the assertion.

type FakeAutomation = {
  getHeartbeatStatus: ReturnType<typeof vi.fn<() => Promise<HeartbeatStatusEnvelope>>>;
  getHeartbeatConfig: ReturnType<typeof vi.fn<() => Promise<HeartbeatSettingsEnvelope>>>;
  updateHeartbeatConfig: ReturnType<
    typeof vi.fn<(patch: Partial<HeartbeatSettings>) => Promise<HeartbeatOperationResult>>
  >;
  triggerHeartbeatNow: ReturnType<typeof vi.fn<() => Promise<HeartbeatOperationResult>>>;
};

function makeFakeAutomation(): FakeAutomation {
  return {
    getHeartbeatStatus: vi.fn<() => Promise<HeartbeatStatusEnvelope>>(async () => ({
      supported: true,
      enabled: true,
      lastRun: null,
      nextRun: null,
      running: false,
    })),
    getHeartbeatConfig: vi.fn<() => Promise<HeartbeatSettingsEnvelope>>(async () => ({
      supported: true,
      // `enabled` is intentionally not on the envelope (read from status).
      intervalMinutes: 60,
      schedule: "always",
      prompt: "",
      workDays: [1, 2, 3, 4, 5],
      workStartHour: 9,
      workEndHour: 17,
      controllable: {
        enabled: true,
        intervalMinutes: false,
        schedule: false,
        prompt: false,
        permissions: false,
        workDays: false,
        workStartHour: false,
        workEndHour: false,
      },
    })),
    updateHeartbeatConfig: vi.fn<
      (patch: Partial<HeartbeatSettings>) => Promise<HeartbeatOperationResult>
    >(async () => ({ ok: true })),
    triggerHeartbeatNow: vi.fn<() => Promise<HeartbeatOperationResult>>(async () => ({
      ok: false,
      reason: "not-supported",
      message: "Run-now isn't exposed by marshal yet",
    })),
  };
}

type FakeBackend = { automation: FakeAutomation };
type FakeSessionManager = {
  getBackendProvider: ReturnType<typeof vi.fn<() => FakeBackend>>;
  addEventListener: ReturnType<typeof vi.fn<() => () => void>>;
};

function makeFakeSessionManager(backend: FakeBackend): FakeSessionManager {
  return {
    getBackendProvider: vi.fn<() => FakeBackend>(() => backend),
    addEventListener: vi.fn<() => () => void>(() => () => {}),
  };
}

describe("registerHeartbeatHandlers — tenant policy IPC guards", () => {
  let ipcHandle: ReturnType<typeof vi.fn>;
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let fakeBackend: FakeBackend;
  let sessionManager: FakeSessionManager;

  beforeEach(() => {
    handlers = new Map();
    ipcHandle = vi.fn<(channel: string, handler: (...args: unknown[]) => unknown) => void>(
      (channel, handler) => {
        handlers.set(channel, handler);
      },
    );
    fakeBackend = { automation: makeFakeAutomation() };
    // The tenant-policy guards short-circuit before ever calling
    // triggerHeartbeatNow, so the default ok:true is fine here even though
    // the cross-suite default is the "not-supported" sentinel.
    fakeBackend.automation.triggerHeartbeatNow.mockResolvedValue({ ok: true });
    fakeBackend.automation.getHeartbeatStatus.mockResolvedValue({
      supported: true,
      enabled: false,
      lastRun: null,
      nextRun: null,
      running: false,
    });
    sessionManager = makeFakeSessionManager(fakeBackend);
  });

  // Thin wrapper over the typed callIpc helper. Args + return narrow from
  // IpcInvokeMap, so per-call-site `as { success: boolean; ... }` casts at
  // the test sites become unnecessary.
  function callHandler<K extends keyof IpcInvokeMap>(
    channel: K,
    ...args: Parameters<IpcInvokeMap[K]>
  ): Promise<Awaited<ReturnType<IpcInvokeMap[K]>>> {
    return callIpc(handlers, channel, ...args);
  }

  function register(opts?: { tenantPolicyProvider?: { get: () => Record<string, unknown> } }) {
    registerHeartbeatHandlers({
      sessionManager: testDouble(sessionManager),
      ipcHandle: testDouble<IpcDeps["ipcHandle"]>(ipcHandle),
      ...opts,
    });
  }

  it("heartbeat:toggle rejects enable when disableHeartbeat is true", async () => {
    register({ tenantPolicyProvider: { get: () => ({ disableHeartbeat: true }) } });
    const result = await callHandler("heartbeat:toggle", true);
    expect(result.success).toBe(false);
    expect(result.error).toContain("disabled");
    expect(fakeBackend.automation.updateHeartbeatConfig).not.toHaveBeenCalled();
  });

  it("heartbeat:toggle allows disable even when disableHeartbeat is true", async () => {
    register({ tenantPolicyProvider: { get: () => ({ disableHeartbeat: true }) } });
    const result = await callHandler("heartbeat:toggle", false);
    expect(result.success).toBe(true);
    expect(fakeBackend.automation.updateHeartbeatConfig).toHaveBeenCalledWith({ enabled: false });
  });

  it("heartbeat:runNow rejects when disableHeartbeat is true", async () => {
    register({ tenantPolicyProvider: { get: () => ({ disableHeartbeat: true }) } });
    const result = await callHandler("heartbeat:runNow");
    expect(result.success).toBe(false);
    expect(result.error).toContain("disabled");
    expect(fakeBackend.automation.triggerHeartbeatNow).not.toHaveBeenCalled();
  });

  it("heartbeat:toggle allows enable when no tenant policy", async () => {
    register();
    const result = await callHandler("heartbeat:toggle", true);
    expect(result.success).toBe(true);
    expect(fakeBackend.automation.updateHeartbeatConfig).toHaveBeenCalledWith({ enabled: true });
  });
});

describe("heartbeat-ipc routes through backend.automation", () => {
  let ipcHandle: ReturnType<typeof vi.fn>;
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let fakeBackend: FakeBackend;
  let fakeSessionManager: FakeSessionManager;

  beforeEach(() => {
    handlers = new Map();
    ipcHandle = vi.fn<(channel: string, handler: (...args: unknown[]) => unknown) => void>(
      (channel, handler) => {
        handlers.set(channel, handler);
      },
    );
    fakeBackend = { automation: makeFakeAutomation() };
    fakeSessionManager = makeFakeSessionManager(fakeBackend);
  });

  function callHandler<K extends keyof IpcInvokeMap>(
    channel: K,
    ...args: Parameters<IpcInvokeMap[K]>
  ): Promise<Awaited<ReturnType<IpcInvokeMap[K]>>> {
    return callIpc(handlers, channel, ...args);
  }

  function register() {
    registerHeartbeatHandlers({
      sessionManager: testDouble(fakeSessionManager),
      ipcHandle: testDouble<IpcDeps["ipcHandle"]>(ipcHandle),
    });
  }

  it("heartbeat:status delegates to backend.automation.getHeartbeatStatus", async () => {
    register();
    const result = await callHandler("heartbeat:status");
    expect(fakeBackend.automation.getHeartbeatStatus).toHaveBeenCalled();
    expect(result.success).toBe(true);
    if (!result.status?.supported) throw new Error("expected status.supported=true");
    expect(result.status.enabled).toBe(true);
  });

  it("heartbeat:getSettings delegates to backend.automation.getHeartbeatConfig", async () => {
    register();
    const result = await callHandler("heartbeat:getSettings");
    expect(fakeBackend.automation.getHeartbeatConfig).toHaveBeenCalled();
    expect(result.success).toBe(true);
    if (!result.settings?.supported) throw new Error("expected settings.supported=true");
    // `enabled` is read from status, not settings (see ipc-contract).
    expect(result.settings.intervalMinutes).toBe(60);
    // Assert the controllable map shape reaches the renderer intact.
    expect(result.settings.controllable).toMatchObject({
      enabled: true,
      intervalMinutes: false,
      permissions: false,
    });
  });

  it("heartbeat:toggle delegates to backend.automation.updateHeartbeatConfig with enabled flag", async () => {
    register();
    const result = await callHandler("heartbeat:toggle", true);
    expect(fakeBackend.automation.updateHeartbeatConfig).toHaveBeenCalledWith({ enabled: true });
    expect(result.success).toBe(true);
  });

  it("heartbeat:saveSettings delegates to backend.automation.updateHeartbeatConfig with patch", async () => {
    register();
    const result = await callHandler("heartbeat:saveSettings", { prompt: "x" });
    expect(fakeBackend.automation.updateHeartbeatConfig).toHaveBeenCalledWith({ prompt: "x" });
    expect(result.success).toBe(true);
  });

  it("heartbeat:runNow delegates to backend.automation.triggerHeartbeatNow", async () => {
    register();
    const result = await callHandler("heartbeat:runNow");
    expect(fakeBackend.automation.triggerHeartbeatNow).toHaveBeenCalled();
    // gateway returns not-supported, so the IPC surfaces success: false with
    // the runtime's message — proves the call reached triggerHeartbeatNow and
    // wasn't short-circuited by the tenant-policy guard or a stub.
    expect(result.success).toBe(false);
  });

  it("heartbeat:getLogs returns success: false when heartbeatManager is absent", async () => {
    // The gateway path registers without a heartbeatManager (marshal exposes
    // no log RPC). Old code would have called heartbeatManager.getLogs(...)
    // and crashed on the missing manager — the null-guard in the handler
    // returns a clean envelope instead.
    register();
    const result = await callHandler("heartbeat:getLogs", 50);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not available/i);
  });

  it("heartbeat:saveSettings propagates result.message on { ok: false } from backend", async () => {
    // Tightens the IPC's { success: false, error: result.message } branch.
    // Without this, a regression that flipped `if (!result.ok)` would silently
    // swallow config-conflict errors at the IPC surface.
    fakeBackend.automation.updateHeartbeatConfig.mockResolvedValueOnce({
      ok: false,
      reason: "config-conflict",
      message: "Settings changed externally; please refresh and try again.",
    });
    register();
    const result = await callHandler("heartbeat:saveSettings", { prompt: "x" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/changed externally/i);
  });

  it("heartbeat:toggle propagates result.message on { ok: false } from backend", async () => {
    fakeBackend.automation.updateHeartbeatConfig.mockResolvedValueOnce({
      ok: false,
      reason: "unknown-error",
      message: "set-heartbeats unavailable",
    });
    register();
    const result = await callHandler("heartbeat:toggle", true);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/set-heartbeats unavailable/);
  });
});
