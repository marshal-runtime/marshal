import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./open-external", () => ({
  openExternalSafe: vi.fn<() => void>(),
}));

vi.mock("./platform/notifications", () => ({
  sendOSNotification: vi.fn<typeof import("./platform/notifications").sendOSNotification>(),
}));

import type { MiniModeManager } from "./mini-mode";
import { openExternalSafe } from "./open-external";
import { NotificationRouter, type NotifyOptions } from "./platform/notification-router";
import { sendOSNotification } from "./platform/notifications";
import type { MiniModeNotification } from "./platform/windowing/mini-mode/contracts";
import type { SettingsManager } from "./settings-manager";
import { testDouble } from "./testing/harness";
import type { TrayManager } from "./tray";

function createMocks() {
  const win = {
    isVisible: vi.fn<() => boolean>(() => true),
    isDestroyed: vi.fn<() => boolean>(() => false),
    once: vi.fn<() => void>(),
    webContents: { send: vi.fn<() => void>() },
  };
  const miniModeManager = {
    showNotification: vi.fn<(notification: MiniModeNotification) => void>(),
  };
  const settingsManager = {
    get: vi.fn<() => { miniModeEnabled: boolean }>(() => ({ miniModeEnabled: false })),
  };
  const trayManager = {
    showWindow: vi.fn<() => void>(),
  };
  return { win, miniModeManager, settingsManager, trayManager };
}

function makeRouter(mocks: ReturnType<typeof createMocks>) {
  return new NotificationRouter(
    () => testDouble<import("electron").BrowserWindow>(mocks.win),
    testDouble<MiniModeManager>(mocks.miniModeManager),
    testDouble<SettingsManager>(mocks.settingsManager),
    testDouble<TrayManager>(mocks.trayManager),
  );
}

const baseOpts: NotifyOptions = {
  title: "Test Title",
  body: "Test Body",
  miniModeType: "automation-complete",
};

describe("NotificationRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes to mini-mode when mini-mode is visible (enabled + window hidden)", () => {
    const mocks = createMocks();
    mocks.settingsManager.get.mockReturnValue({ miniModeEnabled: true });
    mocks.win.isVisible.mockReturnValue(false);
    const router = makeRouter(mocks);

    router.notify(baseOpts);

    expect(mocks.miniModeManager.showNotification).toHaveBeenCalledTimes(1);
    const arg = mocks.miniModeManager.showNotification.mock.calls[0][0];
    expect(arg.type).toBe("automation-complete");
    expect(arg.title).toBe("Test Title");
    expect(arg.body).toBe("Test Body");
    expect(sendOSNotification).not.toHaveBeenCalled();
  });

  it("routes to OS when main window is visible", () => {
    const mocks = createMocks();
    mocks.settingsManager.get.mockReturnValue({ miniModeEnabled: false });
    mocks.win.isVisible.mockReturnValue(true);
    const router = makeRouter(mocks);

    router.notify(baseOpts);

    expect(sendOSNotification).toHaveBeenCalledTimes(1);
    expect(mocks.miniModeManager.showNotification).not.toHaveBeenCalled();
  });

  it("routes to OS when mini-mode is enabled but window is visible", () => {
    const mocks = createMocks();
    mocks.settingsManager.get.mockReturnValue({ miniModeEnabled: true });
    mocks.win.isVisible.mockReturnValue(true);
    const router = makeRouter(mocks);

    router.notify(baseOpts);

    expect(sendOSNotification).toHaveBeenCalledTimes(1);
    expect(mocks.miniModeManager.showNotification).not.toHaveBeenCalled();
  });

  it("routes to OS when mini-mode is disabled", () => {
    const mocks = createMocks();
    mocks.settingsManager.get.mockReturnValue({ miniModeEnabled: false });
    mocks.win.isVisible.mockReturnValue(false);
    const router = makeRouter(mocks);

    router.notify(baseOpts);

    expect(sendOSNotification).toHaveBeenCalledTimes(1);
    expect(mocks.miniModeManager.showNotification).not.toHaveBeenCalled();
  });

  it("URL notifications open in browser on OS click", () => {
    const mocks = createMocks();
    mocks.settingsManager.get.mockReturnValue({ miniModeEnabled: false });
    const router = makeRouter(mocks);

    router.notify({
      ...baseOpts,
      url: "https://example.com",
    });

    expect(sendOSNotification).toHaveBeenCalledTimes(1);
    // Simulate the click callback
    const onClick = vi.mocked(sendOSNotification).mock.calls[0][2];
    onClick!();
    expect(openExternalSafe).toHaveBeenCalledWith("https://example.com");
    // Should NOT show the main window for URL notifications
    expect(mocks.trayManager.showWindow).not.toHaveBeenCalled();
  });

  it("session notifications switch to session on OS click", () => {
    const mocks = createMocks();
    mocks.settingsManager.get.mockReturnValue({ miniModeEnabled: false });
    mocks.win.isVisible.mockReturnValue(true);
    const router = makeRouter(mocks);

    router.notify({
      ...baseOpts,
      sessionId: "session-123",
    });

    expect(sendOSNotification).toHaveBeenCalledTimes(1);
    const onClick = vi.mocked(sendOSNotification).mock.calls[0][2];
    onClick!();
    expect(mocks.win.webContents.send).toHaveBeenCalledWith("sessions:switch-to", "session-123");
    expect(mocks.trayManager.showWindow).toHaveBeenCalled();
  });

  it("passes statusOverride and sessionId to mini-mode notification", () => {
    const mocks = createMocks();
    mocks.settingsManager.get.mockReturnValue({ miniModeEnabled: true });
    mocks.win.isVisible.mockReturnValue(false);
    const router = makeRouter(mocks);

    router.notify({
      ...baseOpts,
      sessionId: "sess-1",
      miniModeStatusOverride: "party",
    });

    const arg = mocks.miniModeManager.showNotification.mock.calls[0][0];
    expect(arg.sessionId).toBe("sess-1");
    expect(arg.statusOverride).toBe("party");
  });

  it("routes to OS when no window exists and mini-mode is disabled", () => {
    const mocks = createMocks();
    mocks.settingsManager.get.mockReturnValue({ miniModeEnabled: false });
    const router = new NotificationRouter(
      () => null,
      testDouble<MiniModeManager>(mocks.miniModeManager),
      testDouble<SettingsManager>(mocks.settingsManager),
      testDouble<TrayManager>(mocks.trayManager),
    );

    router.notify(baseOpts);
    expect(sendOSNotification).toHaveBeenCalledTimes(1);
  });

  it("routes to mini-mode when no window exists and mini-mode is enabled", () => {
    const mocks = createMocks();
    mocks.settingsManager.get.mockReturnValue({ miniModeEnabled: true });
    const router = new NotificationRouter(
      () => null,
      testDouble<MiniModeManager>(mocks.miniModeManager),
      testDouble<SettingsManager>(mocks.settingsManager),
      testDouble<TrayManager>(mocks.trayManager),
    );

    router.notify(baseOpts);
    expect(mocks.miniModeManager.showNotification).toHaveBeenCalledTimes(1);
  });

  it("skips notification when onlyWhenUnfocused is true and window is focused", () => {
    const mocks = createMocks();
    mocks.settingsManager.get.mockReturnValue({ miniModeEnabled: false });
    mocks.win.isVisible.mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion -- partial test double
    (mocks.win as any).isFocused = vi.fn<() => boolean>(() => true);
    const router = makeRouter(mocks);

    router.notify({ ...baseOpts, onlyWhenUnfocused: true });
    expect(sendOSNotification).not.toHaveBeenCalled();
    expect(mocks.miniModeManager.showNotification).not.toHaveBeenCalled();
  });

  it("suppresses silently when suppressWhenMiniMode is true and mini-mode is visible", () => {
    const mocks = createMocks();
    mocks.settingsManager.get.mockReturnValue({ miniModeEnabled: true });
    mocks.win.isVisible.mockReturnValue(false);
    const router = makeRouter(mocks);

    router.notify({
      title: "Background",
      body: "Running in background",
      miniModeType: undefined,
      suppressWhenMiniMode: true,
    });
    expect(sendOSNotification).not.toHaveBeenCalled();
    expect(mocks.miniModeManager.showNotification).not.toHaveBeenCalled();
  });

  it("falls through to OS when mini-mode is visible but no miniModeType and no suppress", () => {
    const mocks = createMocks();
    mocks.settingsManager.get.mockReturnValue({ miniModeEnabled: true });
    mocks.win.isVisible.mockReturnValue(false);
    const router = makeRouter(mocks);

    router.notify({
      title: "Info",
      body: "Something happened",
      // no miniModeType, no suppressWhenMiniMode
    });
    expect(sendOSNotification).toHaveBeenCalledTimes(1);
    expect(mocks.miniModeManager.showNotification).not.toHaveBeenCalled();
  });
});
