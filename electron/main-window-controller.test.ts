import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BackgroundServiceManager } from "./background-service-manager";
import { MainWindowController } from "./marshal-main-window-controller";
import type { MiniModeManager } from "./mini-mode";
import type { SettingsManager } from "./settings-manager";
import { mockCallArg, testDouble, withPlatform } from "./testing/harness";

function createSettingsManager(
  overrides: Partial<{
    miniModeEnabled: boolean;
    startInMiniModeEnabled: boolean;
  }> = {},
) {
  return testDouble<SettingsManager>({
    get: vi.fn<() => { miniModeEnabled: boolean; startInMiniModeEnabled: boolean }>(() => ({
      miniModeEnabled: false,
      startInMiniModeEnabled: false,
      ...overrides,
    })),
  });
}

function createBackgroundService(
  overrides: Partial<{
    isEnabled: boolean;
    shouldHideOnLaunch: boolean;
  }> = {},
) {
  return testDouble<BackgroundServiceManager>({
    isEnabled: vi.fn<() => boolean>(() => overrides.isEnabled ?? false),
    shouldHideOnLaunch: vi.fn<() => boolean>(() => overrides.shouldHideOnLaunch ?? false),
  });
}

function createMiniModeManager() {
  return testDouble<MiniModeManager>({
    setMainWindowVisible: vi.fn<() => void>(),
  });
}

function createWindowStub(overrides: Record<string, unknown> = {}) {
  let destroyed = false;
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const addListener = (event: string, handler: (...args: unknown[]) => void) => {
    const current = listeners.get(event) ?? [];
    current.push(handler);
    listeners.set(event, current);
  };

  const stub = {
    hide: vi.fn<() => void>(),
    isDestroyed: vi.fn<() => boolean>(() => destroyed),
    isMinimized: vi.fn<() => boolean>(() => false),
    isVisible: vi.fn<() => boolean>(() => true),
    on: vi.fn<(event: string, handler: (...args: unknown[]) => void) => void>(
      (event: string, handler: (...args: unknown[]) => void) => {
        addListener(event, handler);
      },
    ),
    setSkipTaskbar: vi.fn<(skip: boolean) => void>(),
    emit: (event: string, ...args: unknown[]) => {
      for (const handler of listeners.get(event) ?? []) {
        handler(...args);
      }
      if (event === "closed") {
        destroyed = true;
      }
    },
    ...overrides,
  };

  return stub;
}

describe("MainWindowController", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn<typeof console, "log">(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleLogSpy.mockRestore();
  });

  it("starts hidden only when mini mode startup is enabled behind mini mode", () => {
    const controller = new MainWindowController({
      backgroundService: createBackgroundService(),
      isQuitting: () => false,
      miniModeManager: createMiniModeManager(),
      settingsManager: createSettingsManager({
        miniModeEnabled: true,
        startInMiniModeEnabled: true,
      }),
    });

    expect(controller.getLaunchState()).toEqual({
      backgroundHideOnLaunch: false,
      startInMiniMode: true,
      startHidden: true,
    });

    const disabledMiniController = new MainWindowController({
      backgroundService: createBackgroundService(),
      isQuitting: () => false,
      miniModeManager: createMiniModeManager(),
      settingsManager: createSettingsManager({
        miniModeEnabled: false,
        startInMiniModeEnabled: true,
      }),
    });

    expect(disabledMiniController.getLaunchState()).toEqual({
      backgroundHideOnLaunch: false,
      startInMiniMode: false,
      startHidden: false,
    });
  });

  it("hides to tray on close when background service is enabled", () => {
    const miniModeManager = createMiniModeManager();
    const controller = new MainWindowController({
      backgroundService: createBackgroundService({ isEnabled: true }),
      isQuitting: () => false,
      miniModeManager,
      settingsManager: createSettingsManager(),
    });
    const win = createWindowStub();
    const closeEvent = testDouble<Electron.Event>({ preventDefault: vi.fn<() => void>() });

    controller.attach(testDouble<BrowserWindow>(win), false);
    win.emit("close", closeEvent);

    expect(closeEvent.preventDefault).toHaveBeenCalled();
    expect(win.hide).toHaveBeenCalled();
    expect(win.setSkipTaskbar).toHaveBeenCalledWith(process.platform !== "darwin");
    expect(vi.mocked(miniModeManager.setMainWindowVisible)).not.toHaveBeenCalledWith(true);
  });

  it("keeps the macOS app in the Dock when hiding its main window", () => {
    withPlatform("darwin", () => {
      const controller = new MainWindowController({
        backgroundService: createBackgroundService({ isEnabled: true }),
        isQuitting: () => false,
        miniModeManager: createMiniModeManager(),
        settingsManager: createSettingsManager(),
      });
      const win = createWindowStub();

      controller.attach(testDouble<BrowserWindow>(win), false);
      controller.hideToTray();

      expect(win.hide).toHaveBeenCalled();
      expect(win.setSkipTaskbar).toHaveBeenCalledWith(false);
    });
  });

  it("minimizes to tray when mini mode is enabled even without background service", () => {
    vi.useFakeTimers();
    const controller = new MainWindowController({
      backgroundService: createBackgroundService({ isEnabled: false }),
      isQuitting: () => false,
      miniModeManager: createMiniModeManager(),
      settingsManager: createSettingsManager({ miniModeEnabled: true }),
    });
    const win = createWindowStub({ isMinimized: vi.fn<() => boolean>(() => true) });

    controller.attach(testDouble<BrowserWindow>(win), false);
    win.emit("minimize");
    vi.runAllTimers();

    expect(win.hide).toHaveBeenCalled();
    expect(win.setSkipTaskbar).toHaveBeenCalledWith(process.platform !== "darwin");
  });

  it("leaves minimize behavior untouched when mini mode settings are disabled", () => {
    vi.useFakeTimers();
    const controller = new MainWindowController({
      backgroundService: createBackgroundService({ isEnabled: false }),
      isQuitting: () => false,
      miniModeManager: createMiniModeManager(),
      settingsManager: createSettingsManager({ miniModeEnabled: false }),
    });
    const win = createWindowStub();

    controller.attach(testDouble<BrowserWindow>(win), false);
    win.emit("minimize");
    vi.runAllTimers();

    expect(win.hide).not.toHaveBeenCalled();
    expect(win.setSkipTaskbar).not.toHaveBeenCalled();
  });

  it("does not hide a restored window when minimize→restore happens before the timer fires", () => {
    vi.useFakeTimers();
    const controller = new MainWindowController({
      backgroundService: createBackgroundService({ isEnabled: false }),
      isQuitting: () => false,
      miniModeManager: createMiniModeManager(),
      settingsManager: createSettingsManager({ miniModeEnabled: true }),
    });
    let minimized = true;
    const win = createWindowStub({ isMinimized: vi.fn<() => boolean>(() => minimized) });

    controller.attach(testDouble<BrowserWindow>(win), false);
    win.emit("minimize");
    // User restores before the timer fires
    minimized = false;
    win.emit("restore");
    vi.runAllTimers();

    expect(win.hide).not.toHaveBeenCalled();
    expect(win.setSkipTaskbar).not.toHaveBeenCalled();
  });

  it("leaves close behavior untouched when background service is disabled", () => {
    const controller = new MainWindowController({
      backgroundService: createBackgroundService({ isEnabled: false }),
      isQuitting: () => false,
      miniModeManager: createMiniModeManager(),
      settingsManager: createSettingsManager({ miniModeEnabled: false }),
    });
    const win = createWindowStub();
    const closeEvent = testDouble<Electron.Event>({ preventDefault: vi.fn<() => void>() });

    controller.attach(testDouble<BrowserWindow>(win), false);
    win.emit("close", closeEvent);

    expect(closeEvent.preventDefault).not.toHaveBeenCalled();
    expect(win.hide).not.toHaveBeenCalled();
    expect(win.setSkipTaskbar).not.toHaveBeenCalled();
  });

  it("hides to tray on close when mini mode is enabled but background service is disabled", () => {
    const controller = new MainWindowController({
      backgroundService: createBackgroundService({ isEnabled: false }),
      isQuitting: () => false,
      miniModeManager: createMiniModeManager(),
      settingsManager: createSettingsManager({ miniModeEnabled: true }),
    });
    const win = createWindowStub();
    const closeEvent = testDouble<Electron.Event>({ preventDefault: vi.fn<() => void>() });

    controller.attach(testDouble<BrowserWindow>(win), false);
    win.emit("close", closeEvent);

    expect(closeEvent.preventDefault).toHaveBeenCalled();
    expect(win.hide).toHaveBeenCalled();
    expect(win.setSkipTaskbar).toHaveBeenCalledWith(process.platform !== "darwin");
  });

  it("removes all event listeners on detach", () => {
    const controller = new MainWindowController({
      backgroundService: createBackgroundService(),
      isQuitting: () => false,
      miniModeManager: createMiniModeManager(),
      settingsManager: createSettingsManager(),
    });
    const win = createWindowStub();
    const removeListener = vi.fn<() => void>();
    (win as unknown as { removeListener: typeof removeListener }).removeListener = removeListener; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- partial test double

    controller.attach(testDouble<BrowserWindow>(win), false);
    controller.detach();

    const removedEvents = removeListener.mock.calls.map((_, i) =>
      mockCallArg<string>(removeListener, i, 0),
    );
    expect(removedEvents.sort()).toEqual([
      "close",
      "closed",
      "hide",
      "minimize",
      "restore",
      "show",
    ]);
  });

  it("re-hides unexpected show events while the window is hidden to tray", () => {
    vi.useFakeTimers();
    const controller = new MainWindowController({
      backgroundService: createBackgroundService({ isEnabled: true }),
      isQuitting: () => false,
      miniModeManager: createMiniModeManager(),
      settingsManager: createSettingsManager(),
    });
    const win = createWindowStub();

    controller.attach(testDouble<BrowserWindow>(win), true);
    win.emit("show");
    vi.runAllTimers();

    expect(win.hide).toHaveBeenCalled();
    expect(win.setSkipTaskbar).toHaveBeenCalledWith(process.platform !== "darwin");
  });

  it("allows expected show events after allowShow is called", () => {
    const miniModeManager = createMiniModeManager();
    const controller = new MainWindowController({
      backgroundService: createBackgroundService({ isEnabled: true }),
      isQuitting: () => false,
      miniModeManager,
      settingsManager: createSettingsManager(),
    });
    const win = createWindowStub();

    controller.attach(testDouble<BrowserWindow>(win), true);
    controller.allowShow("shortcut");
    win.emit("show");

    expect(vi.mocked(miniModeManager.setMainWindowVisible)).toHaveBeenCalledWith(true);
  });

  it("updates mini mode visibility on hide and restore", () => {
    const miniModeManager = createMiniModeManager();
    const controller = new MainWindowController({
      backgroundService: createBackgroundService(),
      isQuitting: () => false,
      miniModeManager,
      settingsManager: createSettingsManager(),
    });
    const win = createWindowStub();

    controller.attach(testDouble<BrowserWindow>(win), false);
    win.emit("hide");
    win.emit("restore");

    expect(vi.mocked(miniModeManager.setMainWindowVisible)).toHaveBeenNthCalledWith(1, false);
    expect(vi.mocked(miniModeManager.setMainWindowVisible)).toHaveBeenNthCalledWith(2, true);
  });
});
