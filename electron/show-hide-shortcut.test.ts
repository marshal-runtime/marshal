import { beforeEach, describe, expect, it, vi } from "vitest";

const { appStub, globalShortcutStub } = vi.hoisted(() => ({
  appStub: {
    isReady: vi.fn<() => boolean>(() => true),
  },
  globalShortcutStub: {
    register: vi.fn<(accelerator: string, callback: () => void) => boolean>(() => true),
    unregister: vi.fn<(accelerator: string) => void>(),
  },
}));

vi.mock("electron", () => ({
  app: appStub,
  globalShortcut: globalShortcutStub,
}));

import type { BrowserWindow } from "electron";

import type { SettingsManager } from "./settings-manager";
import { SHOW_HIDE_SHORTCUT, ShowHideShortcutController } from "./show-hide-shortcut";
import { testDouble } from "./testing/harness";

function createWindowStub(overrides: Record<string, unknown> = {}) {
  return {
    isMinimized: vi.fn<() => boolean>(() => false),
    isVisible: vi.fn<() => boolean>(() => true),
    isFocused: vi.fn<() => boolean>(() => true),
    ...overrides,
  };
}

function getRegisteredHandler() {
  expect(globalShortcutStub.register).toHaveBeenCalledTimes(1);
  const registerCall = globalShortcutStub.register.mock.calls[0];
  expect(registerCall).toBeDefined();
  return registerCall[1];
}

describe("ShowHideShortcutController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appStub.isReady.mockReturnValue(true);
    globalShortcutStub.register.mockReturnValue(true);
  });

  it("does nothing until the app is ready", () => {
    appStub.isReady.mockReturnValue(false);
    const controller = new ShowHideShortcutController({
      getWindow: () => null,
      onHideRequested: vi.fn<() => void>(),
      onShowRequested: vi.fn<() => void>(),
      settingsManager: testDouble<SettingsManager>({
        get: vi.fn<() => { showHideShortcutEnabled: boolean }>(() => ({
          showHideShortcutEnabled: true,
        })),
      }),
    });

    controller.sync();

    expect(globalShortcutStub.unregister).not.toHaveBeenCalled();
    expect(globalShortcutStub.register).not.toHaveBeenCalled();
  });

  it("initializes status with the persisted shortcut before sync runs", () => {
    const controller = new ShowHideShortcutController({
      getWindow: () => null,
      onHideRequested: vi.fn<() => void>(),
      onShowRequested: vi.fn<() => void>(),
      settingsManager: testDouble<SettingsManager>({
        get: vi.fn<() => { showHideShortcut: string }>(() => ({
          showHideShortcut: "CommandOrControl+Shift+K",
        })),
      }),
    });

    expect(controller.getStatus()).toEqual({
      enabled: false,
      accelerator: "CommandOrControl+Shift+K",
      registered: false,
      error: null,
    });
  });

  it("unregisters the shortcut and stops when the setting is disabled", () => {
    const controller = new ShowHideShortcutController({
      getWindow: () => null,
      onHideRequested: vi.fn<() => void>(),
      onShowRequested: vi.fn<() => void>(),
      settingsManager: testDouble<SettingsManager>({
        get: vi.fn<() => { showHideShortcutEnabled: boolean }>(() => ({
          showHideShortcutEnabled: false,
        })),
      }),
    });

    controller.sync();

    expect(globalShortcutStub.unregister).toHaveBeenCalledWith(SHOW_HIDE_SHORTCUT);
    expect(globalShortcutStub.register).not.toHaveBeenCalled();
  });

  it("registers the configured shortcut instead of the default", () => {
    const controller = new ShowHideShortcutController({
      getWindow: () => null,
      onHideRequested: vi.fn<() => void>(),
      onShowRequested: vi.fn<() => void>(),
      settingsManager: testDouble<SettingsManager>({
        get: vi.fn<() => { showHideShortcutEnabled: boolean; showHideShortcut: string }>(() => ({
          showHideShortcutEnabled: true,
          showHideShortcut: "CommandOrControl+Shift+K",
        })),
      }),
    });

    controller.sync();

    expect(globalShortcutStub.unregister).toHaveBeenCalledWith(SHOW_HIDE_SHORTCUT);
    expect(globalShortcutStub.register).toHaveBeenCalledWith(
      "CommandOrControl+Shift+K",
      expect.any(Function),
    );
    expect(globalShortcutStub.register).not.toHaveBeenCalledWith(
      SHOW_HIDE_SHORTCUT,
      expect.any(Function),
    );
    expect(controller.getStatus()).toEqual({
      enabled: true,
      accelerator: "CommandOrControl+Shift+K",
      registered: true,
      error: null,
    });
  });

  it("unregisters the previous configured shortcut when it changes", () => {
    let currentShortcut = "CommandOrControl+Shift+K";
    const controller = new ShowHideShortcutController({
      getWindow: () => null,
      onHideRequested: vi.fn<() => void>(),
      onShowRequested: vi.fn<() => void>(),
      settingsManager: testDouble<SettingsManager>({
        get: vi.fn<() => { showHideShortcutEnabled: boolean; showHideShortcut: string }>(() => ({
          showHideShortcutEnabled: true,
          showHideShortcut: currentShortcut,
        })),
      }),
    });

    controller.sync();
    currentShortcut = "CommandOrControl+Shift+L";
    controller.sync();

    expect(globalShortcutStub.unregister).toHaveBeenNthCalledWith(1, SHOW_HIDE_SHORTCUT);
    expect(globalShortcutStub.unregister).toHaveBeenNthCalledWith(2, "CommandOrControl+Shift+K");
    expect(globalShortcutStub.register).toHaveBeenNthCalledWith(
      1,
      "CommandOrControl+Shift+K",
      expect.any(Function),
    );
    expect(globalShortcutStub.register).toHaveBeenNthCalledWith(
      2,
      "CommandOrControl+Shift+L",
      expect.any(Function),
    );
  });

  it("reports registration failure in status", () => {
    globalShortcutStub.register.mockReturnValue(false);
    const controller = new ShowHideShortcutController({
      getWindow: () => null,
      onHideRequested: vi.fn<() => void>(),
      onShowRequested: vi.fn<() => void>(),
      settingsManager: testDouble<SettingsManager>({
        get: vi.fn<() => { showHideShortcutEnabled: boolean; showHideShortcut: string }>(() => ({
          showHideShortcutEnabled: true,
          showHideShortcut: "CommandOrControl+Shift+K",
        })),
      }),
    });

    controller.sync();

    expect(controller.getStatus()).toEqual({
      enabled: true,
      accelerator: "CommandOrControl+Shift+K",
      registered: false,
      error: "Failed to register CommandOrControl+Shift+K",
    });
  });

  it("hides the main window when the shortcut fires while visible", () => {
    const onHideRequested = vi.fn<() => void>();
    const onShowRequested = vi.fn<() => void>();
    const win = createWindowStub();
    const controller = new ShowHideShortcutController({
      getWindow: () => testDouble<BrowserWindow>(win),
      onHideRequested,
      onShowRequested,
      settingsManager: testDouble<SettingsManager>({
        get: vi.fn<() => { showHideShortcutEnabled: boolean }>(() => ({
          showHideShortcutEnabled: true,
        })),
      }),
    });

    controller.sync();
    const handler = getRegisteredHandler();
    handler();

    expect(onHideRequested).toHaveBeenCalledOnce();
    expect(onShowRequested).not.toHaveBeenCalled();
  });

  it("shows the main window when the shortcut fires while hidden", () => {
    const onHideRequested = vi.fn<() => void>();
    const onShowRequested = vi.fn<() => void>();
    const win = createWindowStub({
      isVisible: vi.fn<() => boolean>(() => false),
    });
    const controller = new ShowHideShortcutController({
      getWindow: () => testDouble<BrowserWindow>(win),
      onHideRequested,
      onShowRequested,
      settingsManager: testDouble<SettingsManager>({
        get: vi.fn<() => { showHideShortcutEnabled: boolean }>(() => ({
          showHideShortcutEnabled: true,
        })),
      }),
    });

    controller.sync();
    const handler = getRegisteredHandler();
    handler();

    expect(onShowRequested).toHaveBeenCalledOnce();
    expect(onHideRequested).not.toHaveBeenCalled();
  });

  it("brings the window to the front when visible but not focused", () => {
    const onHideRequested = vi.fn<() => void>();
    const onShowRequested = vi.fn<() => void>();
    const win = createWindowStub({
      isVisible: vi.fn<() => boolean>(() => true),
      isMinimized: vi.fn<() => boolean>(() => false),
      isFocused: vi.fn<() => boolean>(() => false),
    });
    const controller = new ShowHideShortcutController({
      getWindow: () => testDouble<BrowserWindow>(win),
      onHideRequested,
      onShowRequested,
      settingsManager: testDouble<SettingsManager>({
        get: vi.fn<() => { showHideShortcutEnabled: boolean }>(() => ({
          showHideShortcutEnabled: true,
        })),
      }),
    });

    controller.sync();
    const handler = getRegisteredHandler();
    handler();

    expect(onShowRequested).toHaveBeenCalledOnce();
    expect(onHideRequested).not.toHaveBeenCalled();
  });
});
