import { describe, it, expect, vi, beforeEach } from "vitest";

import type { MSettings } from "../common/marshal-ipc-contract";
import { applyKeepAwakeSettings } from "./apply-keep-awake-settings";

function createDeps(
  overrides: {
    relayConnected?: boolean;
    heartbeatEnabled?: boolean;
    isWindows?: boolean;
  } = {},
) {
  return {
    isRelayConnected: () => overrides.relayConnected ?? false,
    isHeartbeatEnabled: () => overrides.heartbeatEnabled ?? false,
    powerManager: {
      preventSleep: vi.fn<(reason: string) => void>(),
      allowSleep: vi.fn<(reason: string) => void>(),
    },
    keepAwake: {
      acquire: vi.fn<(reason: string) => void>(),
      release: vi.fn<(reason: string) => void>(),
    },
    isWindows: overrides.isWindows ?? true,
  };
}

const BASE_SETTINGS: MSettings = {
  autoApprove: { global: false, perServer: {} },
};

describe("applyKeepAwakeSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── preventSleepEnabled ──────────────────────────────────────

  it("acquires preventSleep for relay when enabled and relay connected", () => {
    const deps = createDeps({ relayConnected: true });
    applyKeepAwakeSettings({ ...BASE_SETTINGS, preventSleepEnabled: true }, deps);
    expect(deps.powerManager.preventSleep).toHaveBeenCalledWith("relay");
    expect(deps.powerManager.preventSleep).not.toHaveBeenCalledWith("heartbeat");
  });

  it("acquires preventSleep for heartbeat when enabled and heartbeat running", () => {
    const deps = createDeps({ heartbeatEnabled: true });
    applyKeepAwakeSettings({ ...BASE_SETTINGS, preventSleepEnabled: true }, deps);
    expect(deps.powerManager.preventSleep).toHaveBeenCalledWith("heartbeat");
    expect(deps.powerManager.preventSleep).not.toHaveBeenCalledWith("relay");
  });

  it("acquires preventSleep for both when both are active", () => {
    const deps = createDeps({ relayConnected: true, heartbeatEnabled: true });
    applyKeepAwakeSettings({ ...BASE_SETTINGS, preventSleepEnabled: true }, deps);
    expect(deps.powerManager.preventSleep).toHaveBeenCalledWith("relay");
    expect(deps.powerManager.preventSleep).toHaveBeenCalledWith("heartbeat");
  });

  it("releases both when preventSleep is disabled", () => {
    const deps = createDeps({ relayConnected: true, heartbeatEnabled: true });
    applyKeepAwakeSettings({ ...BASE_SETTINGS, preventSleepEnabled: false }, deps);
    expect(deps.powerManager.allowSleep).toHaveBeenCalledWith("relay");
    expect(deps.powerManager.allowSleep).toHaveBeenCalledWith("heartbeat");
    expect(deps.powerManager.preventSleep).not.toHaveBeenCalled();
  });

  it("defaults preventSleepEnabled to true when undefined", () => {
    const deps = createDeps({ relayConnected: true });
    applyKeepAwakeSettings({ ...BASE_SETTINGS }, deps);
    expect(deps.powerManager.preventSleep).toHaveBeenCalledWith("relay");
  });

  // ── mouseWiggleEnabled (Windows) ─────────────────────────────

  it("acquires keepAwake for relay when enabled and relay connected", () => {
    const deps = createDeps({ relayConnected: true, isWindows: true });
    applyKeepAwakeSettings({ ...BASE_SETTINGS, mouseWiggleEnabled: true }, deps);
    expect(deps.keepAwake.acquire).toHaveBeenCalledWith("relay");
    expect(deps.keepAwake.acquire).not.toHaveBeenCalledWith("heartbeat");
  });

  it("acquires keepAwake for heartbeat when enabled and heartbeat running", () => {
    const deps = createDeps({ heartbeatEnabled: true, isWindows: true });
    applyKeepAwakeSettings({ ...BASE_SETTINGS, mouseWiggleEnabled: true }, deps);
    expect(deps.keepAwake.acquire).toHaveBeenCalledWith("heartbeat");
  });

  it("releases both when mouseWiggle is disabled", () => {
    const deps = createDeps({ relayConnected: true, heartbeatEnabled: true, isWindows: true });
    applyKeepAwakeSettings({ ...BASE_SETTINGS, mouseWiggleEnabled: false }, deps);
    expect(deps.keepAwake.release).toHaveBeenCalledWith("relay");
    expect(deps.keepAwake.release).toHaveBeenCalledWith("heartbeat");
    expect(deps.keepAwake.acquire).not.toHaveBeenCalled();
  });

  it("skips keepAwake entirely on non-Windows", () => {
    const deps = createDeps({ relayConnected: true, heartbeatEnabled: true, isWindows: false });
    applyKeepAwakeSettings({ ...BASE_SETTINGS, mouseWiggleEnabled: true }, deps);
    expect(deps.keepAwake.acquire).not.toHaveBeenCalled();
    expect(deps.keepAwake.release).not.toHaveBeenCalled();
  });

  it("defaults mouseWiggleEnabled to true when undefined", () => {
    const deps = createDeps({ relayConnected: true, isWindows: true });
    applyKeepAwakeSettings({ ...BASE_SETTINGS }, deps);
    expect(deps.keepAwake.acquire).toHaveBeenCalledWith("relay");
  });

  // ── alwaysKeepAwakeEnabled ──────────────────────────────────

  it("acquires always-on holds when enabled", () => {
    const deps = createDeps({ isWindows: true });
    applyKeepAwakeSettings({ ...BASE_SETTINGS, alwaysKeepAwakeEnabled: true }, deps);
    expect(deps.powerManager.preventSleep).toHaveBeenCalledWith("always");
    expect(deps.keepAwake.acquire).toHaveBeenCalledWith("always");
  });

  it("releases always-on holds when disabled", () => {
    const deps = createDeps({ isWindows: true });
    applyKeepAwakeSettings({ ...BASE_SETTINGS, alwaysKeepAwakeEnabled: false }, deps);
    expect(deps.powerManager.allowSleep).toHaveBeenCalledWith("always");
    expect(deps.keepAwake.release).toHaveBeenCalledWith("always");
  });

  it("keeps always-on independent from active feature holds", () => {
    const deps = createDeps({ relayConnected: true, heartbeatEnabled: true, isWindows: true });
    applyKeepAwakeSettings(
      {
        ...BASE_SETTINGS,
        alwaysKeepAwakeEnabled: true,
        preventSleepEnabled: false,
        mouseWiggleEnabled: false,
      },
      deps,
    );

    expect(deps.powerManager.preventSleep).toHaveBeenCalledWith("always");
    expect(deps.powerManager.allowSleep).toHaveBeenCalledWith("relay");
    expect(deps.powerManager.allowSleep).toHaveBeenCalledWith("heartbeat");
    expect(deps.keepAwake.acquire).toHaveBeenCalledWith("always");
    expect(deps.keepAwake.release).toHaveBeenCalledWith("relay");
    expect(deps.keepAwake.release).toHaveBeenCalledWith("heartbeat");
  });

  it("does not run always-on mouse wiggle on non-Windows", () => {
    const deps = createDeps({ isWindows: false });
    applyKeepAwakeSettings({ ...BASE_SETTINGS, alwaysKeepAwakeEnabled: true }, deps);
    expect(deps.powerManager.preventSleep).toHaveBeenCalledWith("always");
    expect(deps.keepAwake.acquire).not.toHaveBeenCalledWith("always");
  });

  // ── Independence ─────────────────────────────────────────────

  it("allows disabling preventSleep while keeping mouseWiggle", () => {
    const deps = createDeps({ relayConnected: true, heartbeatEnabled: true, isWindows: true });
    applyKeepAwakeSettings(
      { ...BASE_SETTINGS, preventSleepEnabled: false, mouseWiggleEnabled: true },
      deps,
    );
    expect(deps.powerManager.allowSleep).toHaveBeenCalledWith("relay");
    expect(deps.powerManager.allowSleep).toHaveBeenCalledWith("heartbeat");
    expect(deps.keepAwake.acquire).toHaveBeenCalledWith("relay");
    expect(deps.keepAwake.acquire).toHaveBeenCalledWith("heartbeat");
  });

  it("allows disabling mouseWiggle while keeping preventSleep", () => {
    const deps = createDeps({ relayConnected: true, heartbeatEnabled: true, isWindows: true });
    applyKeepAwakeSettings(
      { ...BASE_SETTINGS, preventSleepEnabled: true, mouseWiggleEnabled: false },
      deps,
    );
    expect(deps.powerManager.preventSleep).toHaveBeenCalledWith("relay");
    expect(deps.powerManager.preventSleep).toHaveBeenCalledWith("heartbeat");
    expect(deps.keepAwake.release).toHaveBeenCalledWith("relay");
    expect(deps.keepAwake.release).toHaveBeenCalledWith("heartbeat");
  });
});
