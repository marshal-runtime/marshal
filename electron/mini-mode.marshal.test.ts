// Marshal-owned test
import path from "node:path";

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

const {
  createdWindows,
  BrowserWindowMock,
  screenStub,
  appStub,
  nativeThemeStub,
  authorizeIpcWebContentsMock,
} = vi.hoisted(() => {
  // eslint-disable-next-line no-shadow -- vi.hoisted() pattern returns same-named vars
  const createdWindows: Array<{
    options: Record<string, unknown>;
    show: ReturnType<typeof vi.fn<() => void>>;
    showInactive: ReturnType<typeof vi.fn<() => void>>;
    hide: ReturnType<typeof vi.fn<() => void>>;
    destroy: ReturnType<typeof vi.fn<() => void>>;
    setBounds: ReturnType<typeof vi.fn<() => void>>;
    setOpacity: ReturnType<typeof vi.fn<() => void>>;
    setIgnoreMouseEvents: ReturnType<typeof vi.fn<() => void>>;
    setMenuBarVisibility: ReturnType<typeof vi.fn<() => void>>;
    setAlwaysOnTop: ReturnType<typeof vi.fn<() => void>>;
    setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn<() => void>>;
    loadURL: ReturnType<typeof vi.fn<() => void>>;
    on: ReturnType<typeof vi.fn<(event: string, handler: () => void) => void>>;
    once: ReturnType<typeof vi.fn<(event: string, handler: () => void) => void>>;
    isDestroyed: ReturnType<typeof vi.fn<() => boolean>>;
    webContents: {
      id: number;
      send: ReturnType<typeof vi.fn<() => void>>;
      on: ReturnType<typeof vi.fn<(event: string, handler: () => void) => void>>;
      emit: (event: string) => void;
    };
    emit: (event: string) => void;
  }> = [];

  // eslint-disable-next-line no-shadow -- vi.hoisted() pattern returns same-named vars
  const BrowserWindowMock = vi.fn<
    (options?: Record<string, unknown>) => (typeof createdWindows)[number]
  >(function (options: Record<string, unknown> = {}) {
    let destroyed = false;
    const listeners = new Map<string, Array<{ handler: () => void; once: boolean }>>();
    const webContentsListeners = new Map<string, Array<{ handler: () => void; once: boolean }>>();
    const addListener = (
      map: Map<string, Array<{ handler: () => void; once: boolean }>>,
      event: string,
      handler: () => void,
      once: boolean,
    ) => {
      const entries = map.get(event) ?? [];
      entries.push({ handler, once });
      map.set(event, entries);
    };
    const emit = (
      map: Map<string, Array<{ handler: () => void; once: boolean }>>,
      event: string,
    ) => {
      const entries = map.get(event) ?? [];
      if (entries.length === 0) {
        return;
      }
      map.set(
        event,
        entries.filter((entry) => !entry.once),
      );
      for (const entry of entries) {
        entry.handler();
      }
    };
    const stub = {
      options,
      show: vi.fn<() => void>(),
      showInactive: vi.fn<() => void>(),
      hide: vi.fn<() => void>(),
      destroy: vi.fn<() => void>(() => {
        destroyed = true;
        emit(listeners, "closed");
      }),
      setBounds: vi.fn<() => void>(),
      setOpacity: vi.fn<() => void>(),
      setIgnoreMouseEvents: vi.fn<() => void>(),
      setMenuBarVisibility: vi.fn<() => void>(),
      setAlwaysOnTop: vi.fn<() => void>(),
      setVisibleOnAllWorkspaces: vi.fn<() => void>(),
      loadURL: vi.fn<() => void>(),
      on: vi.fn<(event: string, handler: () => void) => void>(
        (event: string, handler: () => void) => {
          addListener(listeners, event, handler, false);
        },
      ),
      once: vi.fn<(event: string, handler: () => void) => void>(
        (event: string, handler: () => void) => {
          addListener(listeners, event, handler, true);
        },
      ),
      isDestroyed: vi.fn<() => boolean>(() => destroyed),
      emit: (event: string) => emit(listeners, event),
      webContents: {
        id: createdWindows.length + 100,
        send: vi.fn<() => void>(),
        on: vi.fn<(event: string, handler: () => void) => void>(
          (event: string, handler: () => void) => {
            addListener(webContentsListeners, event, handler, false);
          },
        ),
        emit: (event: string) => emit(webContentsListeners, event),
      },
    };
    createdWindows.push(stub);
    return stub;
  });

  return {
    createdWindows,
    BrowserWindowMock,
    appStub: {
      isReady: vi.fn<() => boolean>(() => true),
    },
    nativeThemeStub: {
      shouldUseDarkColors: true,
    },
    authorizeIpcWebContentsMock: vi.fn<(id: number) => () => void>(() => vi.fn<() => void>()),
    screenStub: {
      on: vi.fn<() => void>(),
      removeListener: vi.fn<() => void>(),
      getPrimaryDisplay: vi.fn<
        () => { workArea: { x: number; y: number; width: number; height: number } }
      >(() => ({
        workArea: {
          x: 0,
          y: 0,
          width: 1920,
          height: 1080,
        },
      })),
    },
  };
});

vi.mock("electron", () => ({
  app: appStub,
  BrowserWindow: BrowserWindowMock,
  nativeTheme: nativeThemeStub,
  screen: screenStub,
}));

vi.mock("./ipc/ipc-handle", () => ({
  authorizeIpcWebContents: authorizeIpcWebContentsMock,
}));

import { MiniModeManager } from "./mini-mode";

function expectIndicatorShown(windowStub: (typeof createdWindows)[number]) {
  expect(windowStub.showInactive).toHaveBeenCalled();
}

function getIndicatorShowCount(windowStub: (typeof createdWindows)[number]) {
  return windowStub.showInactive.mock.calls.length;
}

function finishWindowLoad(windowStub: (typeof createdWindows)[number]) {
  windowStub.emit("ready-to-show");
  windowStub.webContents.emit("did-finish-load");
}

function createManager() {
  return new MiniModeManager({
    publicDir: path.join(process.cwd(), "public"),
    getPreloadPath: () => path.join(process.cwd(), "dist-electron", "mini-mode-preload.cjs"),
    getPagePath: () => path.join(process.cwd(), "dist-electron", "mini-mode-page", "index.html"),
  });
}

function enableHiddenMiniMode(manager: MiniModeManager) {
  manager.setBackgroundEnabled(true);
  manager.setMiniModeEnabled(true);
  manager.setMainWindowVisible(false);
}

beforeEach(() => {
  createdWindows.length = 0;
  BrowserWindowMock.mockClear();
  appStub.isReady.mockClear();
  screenStub.on.mockClear();
  screenStub.removeListener.mockClear();
  screenStub.getPrimaryDisplay.mockClear();
  authorizeIpcWebContentsMock.mockClear();
  authorizeIpcWebContentsMock.mockImplementation(() => vi.fn<() => void>());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MiniModeManager", () => {
  it("shows the indicator only when the app is hidden in background mode", () => {
    const manager = createManager();

    manager.setBackgroundEnabled(true);
    manager.setMiniModeEnabled(true);
    expect(BrowserWindowMock).not.toHaveBeenCalled();

    manager.setMainWindowVisible(false);

    expect(BrowserWindowMock).toHaveBeenCalledTimes(1);
    finishWindowLoad(createdWindows[0]);
    expectIndicatorShown(createdWindows[0]);
    expect(createdWindows[0].setOpacity).toHaveBeenLastCalledWith(1);

    manager.setMainWindowVisible(true);

    expect(createdWindows[0].hide).not.toHaveBeenCalled();
    expect(createdWindows[0].setOpacity).toHaveBeenLastCalledWith(0);
    manager.destroy();
  });

  it("authorizes indicator IPC while the window is alive", () => {
    const deauthorizeIpc = vi.fn<() => void>();
    authorizeIpcWebContentsMock.mockReturnValueOnce(deauthorizeIpc);
    const manager = createManager();

    manager.setMiniModeEnabled(true);
    manager.setMainWindowVisible(false);

    expect(authorizeIpcWebContentsMock).toHaveBeenCalledWith(createdWindows[0].webContents.id);
    expect(deauthorizeIpc).not.toHaveBeenCalled();

    manager.destroy();

    expect(deauthorizeIpc).toHaveBeenCalledTimes(1);
  });

  it("shows the indicator when the main window is hidden without background mode", () => {
    const manager = createManager();

    manager.setMiniModeEnabled(true);
    manager.setMainWindowVisible(false);

    expect(BrowserWindowMock).toHaveBeenCalledTimes(1);
    finishWindowLoad(createdWindows[0]);
    expectIndicatorShown(createdWindows[0]);
    expect(createdWindows[0].setOpacity).toHaveBeenLastCalledWith(1);

    manager.destroy();
  });

  it("does not show the indicator when mini mode is disabled", () => {
    const manager = createManager();

    manager.setBackgroundEnabled(true);
    manager.setMainWindowVisible(false);

    expect(BrowserWindowMock).not.toHaveBeenCalled();

    manager.destroy();
  });

  it("ignores duplicate hidden visibility updates so the indicator only shows once", () => {
    const manager = createManager();

    manager.setMiniModeEnabled(true);
    manager.setMainWindowVisible(false);

    expect(BrowserWindowMock).toHaveBeenCalledTimes(1);
    finishWindowLoad(createdWindows[0]);
    expect(getIndicatorShowCount(createdWindows[0])).toBe(1);

    manager.setMainWindowVisible(false);

    expect(BrowserWindowMock).toHaveBeenCalledTimes(1);
    expect(getIndicatorShowCount(createdWindows[0])).toBe(1);

    manager.destroy();
  });

  it("keeps the indicator window mapped between collapses", () => {
    const manager = createManager();

    manager.setMiniModeEnabled(true);
    manager.setMainWindowVisible(false);
    finishWindowLoad(createdWindows[0]);

    expect(getIndicatorShowCount(createdWindows[0])).toBe(1);
    expect(createdWindows[0].setOpacity).toHaveBeenLastCalledWith(1);

    manager.setMainWindowVisible(true);
    expect(createdWindows[0].setOpacity).toHaveBeenLastCalledWith(0);

    manager.setMainWindowVisible(false);
    expect(getIndicatorShowCount(createdWindows[0])).toBe(1);
    expect(createdWindows[0].setOpacity).toHaveBeenLastCalledWith(1);

    manager.destroy();
  });

  it("positions the mini indicator in the fixed mini-mode corner", () => {
    const manager = createManager();

    manager.setMiniModeEnabled(true);
    manager.setMainWindowVisible(false);

    expect(BrowserWindowMock).toHaveBeenCalledTimes(1);
    finishWindowLoad(createdWindows[0]);
    expect(createdWindows[0].options).toMatchObject({
      width: 432,
      height: 420,
      transparent: true,
      skipTaskbar: process.platform !== "darwin",
      backgroundColor: "#00000000",
    });
    expect(createdWindows[0].setBounds).toHaveBeenCalledWith({
      x: 1472,
      y: 644,
      width: 432,
      height: 420,
    });

    manager.destroy();
  });

  it("shows an approval bubble and reports monocle state when a permission is pending", () => {
    const manager = createManager();
    enableHiddenMiniMode(manager);

    manager.showPermission({
      id: "perm-1",
      kind: "shell",
      title: "Run command",
      message: "Allow this command?",
      detail: "rg foo src",
      buttons: ["Allow", "Deny"],
    });

    expect(BrowserWindowMock).toHaveBeenCalledTimes(1);
    finishWindowLoad(createdWindows[0]);
    expect(getIndicatorShowCount(createdWindows[0])).toBe(1);
    expect(createdWindows[0].setBounds).toHaveBeenCalledWith({
      x: 1472,
      y: 644,
      width: 432,
      height: 420,
    });
    expect(manager.getSnapshot()).toMatchObject({
      status: "monocle",
      pendingPermissionCount: 1,
      permissionIndex: 1,
      permission: {
        id: "perm-1",
      },
    });

    manager.destroy();
  });

  it("does not read assets during construction and caches them on first access", () => {
    const manager = createManager();
    const assetCache = Reflect.get(manager, "assets") as Map<string, string>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- accessing private property for test

    expect(assetCache.size).toBe(0);

    const firstAsset = manager.getAsset("sleeping");
    const secondAsset = manager.getAsset("sleeping");

    expect(firstAsset).toMatch(/^data:image\/png;base64,/);
    expect(secondAsset).toBe(firstAsset);
    expect(assetCache.size).toBe(1);

    manager.destroy();
  });

  it("keeps the party state until the app is reopened", () => {
    vi.useFakeTimers();
    const manager = createManager();
    enableHiddenMiniMode(manager);

    manager.markSessionBusy("session-1");
    finishWindowLoad(createdWindows[0]);
    expect(manager.getSnapshot().status).toBe("thinking");

    manager.markSessionIdle("session-1");
    expect(manager.getSnapshot().status).toBe("party");

    vi.advanceTimersByTime(10_000);
    expect(manager.getSnapshot().status).toBe("party");

    manager.setMainWindowVisible(true);
    expect(manager.getSnapshot().status).toBe("sleeping");

    manager.destroy();
  });

  it("shows the crying state after a failed session until attention shifts", () => {
    const manager = createManager();
    enableHiddenMiniMode(manager);

    manager.markSessionBusy("session-1");
    finishWindowLoad(createdWindows[0]);
    manager.markSessionIdle("session-1", false);

    expect(manager.getSnapshot().status).toBe("crying");

    manager.showPermission({
      id: "perm-1",
      kind: "shell",
      title: "Run command",
      message: "Allow this command?",
      detail: "rg foo src",
      buttons: ["Allow", "Deny"],
    });
    expect(manager.getSnapshot().status).toBe("monocle");

    manager.hidePermission("perm-1");
    manager.setMainWindowVisible(true);
    expect(manager.getSnapshot().status).toBe("sleeping");

    manager.destroy();
  });

  it("clears a session without triggering party or crying state", () => {
    const manager = createManager();
    enableHiddenMiniMode(manager);

    manager.markSessionBusy("session-1");
    finishWindowLoad(createdWindows[0]);
    expect(manager.getSnapshot().status).toBe("thinking");

    manager.clearSession("session-1");
    expect(manager.getSnapshot().status).toBe("sleeping");

    manager.destroy();
  });

  it("falls back to the previous pending permission when the latest one is resolved", () => {
    const manager = createManager();
    enableHiddenMiniMode(manager);

    manager.showPermission({
      id: "perm-1",
      kind: "shell",
      title: "First",
      message: "First permission",
      detail: "first",
      buttons: ["Allow", "Deny"],
    });
    manager.showPermission({
      id: "perm-2",
      kind: "write",
      title: "Second",
      message: "Second permission",
      detail: "second",
      buttons: ["Allow", "Deny"],
    });

    expect(manager.getSnapshot()).toMatchObject({
      pendingPermissionCount: 2,
      permissionIndex: 2,
      permission: { id: "perm-2" },
    });
    finishWindowLoad(createdWindows[0]);

    manager.hidePermission("perm-2");

    expect(manager.getSnapshot()).toMatchObject({
      pendingPermissionCount: 1,
      permissionIndex: 1,
      permission: { id: "perm-1" },
    });

    manager.destroy();
  });

  it("holds the approval shell briefly before collapsing after the last approval resolves", () => {
    vi.useFakeTimers();
    const manager = createManager();
    enableHiddenMiniMode(manager);

    manager.showPermission({
      id: "perm-1",
      kind: "shell",
      title: "Run command",
      message: "Allow this command?",
      detail: "rg foo src",
      buttons: ["Allow", "Deny"],
    });

    expect(BrowserWindowMock).toHaveBeenCalledTimes(1);
    finishWindowLoad(createdWindows[0]);
    createdWindows[0].setBounds.mockClear();

    manager.hidePermission("perm-1");

    expect(manager.getSnapshot()).toMatchObject({
      status: "sleeping",
      pendingPermissionCount: 0,
      permissionIndex: 0,
      permission: null,
    });
    expect(createdWindows[0].setBounds).toHaveBeenLastCalledWith({
      x: 1472,
      y: 644,
      width: 432,
      height: 420,
    });

    vi.advanceTimersByTime(199);
    expect(createdWindows[0].setBounds).toHaveBeenLastCalledWith({
      x: 1472,
      y: 644,
      width: 432,
      height: 420,
    });

    vi.advanceTimersByTime(1);
    expect(createdWindows[0].setBounds).toHaveBeenLastCalledWith({
      x: 1472,
      y: 644,
      width: 432,
      height: 420,
    });

    manager.destroy();
  });

  it("does not show the indicator twice when load lifecycle events both fire", () => {
    const manager = createManager();

    manager.setMiniModeEnabled(true);
    manager.setMainWindowVisible(false);

    expect(BrowserWindowMock).toHaveBeenCalledTimes(1);
    finishWindowLoad(createdWindows[0]);

    expect(getIndicatorShowCount(createdWindows[0])).toBe(1);

    manager.destroy();
  });

  it("updates theme in place without recreating the indicator window", () => {
    const manager = createManager();
    enableHiddenMiniMode(manager);

    finishWindowLoad(createdWindows[0]);
    const indicatorWindow = createdWindows[0];
    indicatorWindow.destroy.mockClear();
    indicatorWindow.webContents.send.mockClear();

    manager.setTheme("light");

    expect(BrowserWindowMock).toHaveBeenCalledTimes(1);
    expect(indicatorWindow.destroy).not.toHaveBeenCalled();
    expect(indicatorWindow.webContents.send).toHaveBeenCalledWith(
      "mini-mode:theme",
      expect.objectContaining({ theme: "light" }),
    );

    manager.destroy();
  });

  it("keeps a single indicator window while approval progress changes", () => {
    const manager = createManager();
    enableHiddenMiniMode(manager);

    manager.showPermission({
      id: "perm-1",
      kind: "shell",
      title: "Run command",
      message: "Allow this command?",
      detail: "rg foo src",
      buttons: ["Allow", "Deny"],
    });

    expect(BrowserWindowMock).toHaveBeenCalledTimes(1);
    finishWindowLoad(createdWindows[0]);
    expect(getIndicatorShowCount(createdWindows[0])).toBe(1);

    manager.showPermission({
      id: "perm-2",
      kind: "write",
      title: "Write file",
      message: "Allow this write?",
      detail: "src\\test.ts",
      buttons: ["Allow", "Deny"],
    });

    expect(BrowserWindowMock).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot()).toMatchObject({
      pendingPermissionCount: 2,
      permissionIndex: 2,
      permission: { id: "perm-2" },
    });
    expect(createdWindows[0].setBounds).toHaveBeenCalledWith({
      x: 1472,
      y: 644,
      width: 432,
      height: 420,
    });

    manager.destroy();
  });

  it("showNotification sets activeNotification and includes it in snapshot", () => {
    const manager = createManager();
    enableHiddenMiniMode(manager);
    finishWindowLoad(createdWindows[0]);

    manager.showNotification({
      id: "n-1",
      type: "heartbeat-urgent",
      title: "Heartbeat check",
      body: "2 urgent items found",
    });

    expect(manager.getSnapshot()).toMatchObject({
      notification: {
        id: "n-1",
        type: "heartbeat-urgent",
        title: "Heartbeat check",
        body: "2 urgent items found",
      },
    });

    // Window should expand to notification size (64 + 12 + 80 = 156)
    expect(createdWindows[0].setBounds).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 432,
        height: 420,
      }),
    );

    manager.destroy();
  });

  it("hideNotification clears activeNotification from snapshot", () => {
    const manager = createManager();
    enableHiddenMiniMode(manager);
    finishWindowLoad(createdWindows[0]);

    manager.showNotification({
      id: "n-1",
      type: "heartbeat-urgent",
      title: "Heartbeat check",
      body: "Urgent items found",
    });

    expect(manager.getSnapshot().notification).not.toBeNull();

    manager.hideNotification();

    expect(manager.getSnapshot().notification).toBeNull();
    // Window should collapse back to indicator size
    expect(createdWindows[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({
        width: 432,
        height: 420,
      }),
    );

    manager.destroy();
  });

  it("suppresses notification when an approval is active", () => {
    const manager = createManager();
    enableHiddenMiniMode(manager);
    finishWindowLoad(createdWindows[0]);

    manager.showPermission({
      id: "perm-1",
      kind: "shell",
      title: "Run command",
      message: "Allow?",
      detail: "ls",
      buttons: ["Allow", "Deny"],
    });

    manager.showNotification({
      id: "n-1",
      type: "heartbeat-urgent",
      title: "Heartbeat check",
      body: "Urgent items found",
    });

    // Notification should not show because approval takes priority
    expect(manager.getSnapshot().notification).toBeNull();

    manager.destroy();
  });

  it("dismissApprovalFromMiniMode hides the approval bubble", () => {
    const manager = createManager();
    enableHiddenMiniMode(manager);
    finishWindowLoad(createdWindows[0]);

    manager.showPermission({
      id: "perm-1",
      kind: "shell",
      title: "Run command",
      message: "Allow?",
      detail: "ls",
      buttons: ["Allow", "Deny"],
    });

    // Initially approval is visible — window is approval sized
    expect(createdWindows[0].setBounds).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 432,
        height: 420,
      }),
    );

    manager.dismissApprovalFromMiniMode("perm-1");

    // After dismissal, window should collapse to indicator size
    expect(createdWindows[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({
        width: 432,
        height: 420,
      }),
    );

    manager.destroy();
  });

  it("new approval replaces dismissed state and shows again", () => {
    const manager = createManager();
    enableHiddenMiniMode(manager);
    finishWindowLoad(createdWindows[0]);

    manager.showPermission({
      id: "perm-1",
      kind: "shell",
      title: "First",
      message: "Allow?",
      detail: "ls",
      buttons: ["Allow", "Deny"],
    });

    manager.dismissApprovalFromMiniMode("perm-1");

    // Window collapsed
    expect(createdWindows[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 432, height: 420 }),
    );

    // New approval should show
    manager.showPermission({
      id: "perm-2",
      kind: "write",
      title: "Second",
      message: "Allow write?",
      detail: "file.txt",
      buttons: ["Allow", "Deny"],
    });

    expect(createdWindows[0].setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 432, height: 420 }),
    );
    expect(manager.getSnapshot().permission).toMatchObject({ id: "perm-2" });

    manager.destroy();
  });

  it("notification persists until explicitly dismissed", () => {
    vi.useFakeTimers();
    const manager = createManager();
    enableHiddenMiniMode(manager);
    finishWindowLoad(createdWindows[0]);

    manager.showNotification({
      id: "n-1",
      type: "automation-complete",
      title: "Done",
      body: "All good",
    });

    expect(manager.getSnapshot().notification).not.toBeNull();

    // Notification should persist — no auto-dismiss
    vi.advanceTimersByTime(60_000);
    expect(manager.getSnapshot().notification).not.toBeNull();

    // Only dismissed when explicitly hidden
    manager.hideNotification();
    expect(manager.getSnapshot().notification).toBeNull();

    manager.destroy();
  });
});
