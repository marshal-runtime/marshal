import { beforeEach, describe, expect, it, vi } from "vitest";

import { testDouble } from "../../../testing/harness";
import { registerWindowControlsHandlers } from "./register";

// `BrowserWindow.fromWebContents` is used to resolve the sender's window so
// popout chats control themselves rather than the main window. Tests mock it
// per-case: by default it returns null, so handlers fall back to `getWindow()`
// (the legacy main-window-only behaviour these tests originally exercised).
const fromWebContentsMock = vi.fn<(wc: unknown) => unknown>(() => null);
vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: (wc: unknown) => fromWebContentsMock(wc),
  },
}));

type RegisteredHandler = (...args: unknown[]) => unknown;

// Tests pass a minimal event shape; the handler only reads `event.sender`.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double for IpcMainInvokeEvent
const fakeEvent = { sender: {} } as unknown as Electron.IpcMainInvokeEvent;

function createWindow(isInitiallyMaximized = false) {
  let isMaximized = isInitiallyMaximized;

  return {
    isDestroyed: vi.fn<() => boolean>(() => false),
    isMaximized: vi.fn<() => boolean>(() => isMaximized),
    isFullScreen: vi.fn<() => boolean>(() => false),
    minimize: vi.fn<() => void>(),
    maximize: vi.fn<() => void>(() => {
      isMaximized = true;
    }),
    unmaximize: vi.fn<() => void>(() => {
      isMaximized = false;
    }),
    close: vi.fn<() => void>(),
    getSize: vi.fn<() => [number, number]>(() => [800, 600]),
    setSize: vi.fn<(w: number, h: number, animate?: boolean) => void>(),
  };
}

function registerHandlers(windowRef: ReturnType<typeof createWindow> | null) {
  const handlers = new Map<string, RegisteredHandler>();
  const ipcHandle = vi.fn<(channel: string, handler: RegisteredHandler) => void>(
    (channel: string, handler: RegisteredHandler) => {
      handlers.set(channel, handler);
    },
  );

  registerWindowControlsHandlers({
    getWindow: () => (windowRef ? testDouble<import("electron").BrowserWindow>(windowRef) : null),
    ipcHandle: testDouble<import("../../types").IpcDeps["ipcHandle"]>(ipcHandle),
  });

  return handlers;
}

describe("registerWindowControlsHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fromWebContentsMock.mockReturnValue(null);
  });

  it("registers all expected window control channels", () => {
    const handlers = registerHandlers(createWindow());

    expect([...handlers.keys()].sort()).toEqual([
      "window-controls:close",
      "window-controls:getState",
      "window-controls:minimize",
      "window-controls:setWidth",
      "window-controls:toggleMaximize",
    ]);
  });

  it("returns an error when no window is available", () => {
    const handlers = registerHandlers(null);

    expect(handlers.get("window-controls:getState")?.(fakeEvent)).toEqual({
      success: false,
      error: "Window is unavailable",
    });
  });

  it("returns the maximized and fullscreen state", () => {
    const handlers = registerHandlers(createWindow(true));

    expect(handlers.get("window-controls:getState")?.(fakeEvent)).toEqual({
      success: true,
      isMaximized: true,
      isFullScreen: false,
    });
  });

  it("minimizes the main window", () => {
    const windowRef = createWindow();
    const handlers = registerHandlers(windowRef);

    expect(handlers.get("window-controls:minimize")?.(fakeEvent)).toEqual({ success: true });
    expect(windowRef.minimize).toHaveBeenCalledOnce();
  });

  it("toggles maximize on when the window is restored", () => {
    const windowRef = createWindow(false);
    const handlers = registerHandlers(windowRef);

    expect(handlers.get("window-controls:toggleMaximize")?.(fakeEvent)).toEqual({
      success: true,
      isMaximized: true,
    });
    expect(windowRef.maximize).toHaveBeenCalledOnce();
    expect(windowRef.unmaximize).not.toHaveBeenCalled();
  });

  it("toggles maximize off when the window is maximized", () => {
    const windowRef = createWindow(true);
    const handlers = registerHandlers(windowRef);

    expect(handlers.get("window-controls:toggleMaximize")?.(fakeEvent)).toEqual({
      success: true,
      isMaximized: false,
    });
    expect(windowRef.unmaximize).toHaveBeenCalledOnce();
    expect(windowRef.maximize).not.toHaveBeenCalled();
  });

  it("closes the main window", () => {
    const windowRef = createWindow();
    const handlers = registerHandlers(windowRef);

    expect(handlers.get("window-controls:close")?.(fakeEvent)).toEqual({ success: true });
    expect(windowRef.close).toHaveBeenCalledOnce();
  });

  it("targets the sender's window when present (popout chat windows)", () => {
    // chat popouts share the main IPC channels but must control
    // themselves, not the main window. The handler resolves the sender via
    // BrowserWindow.fromWebContents and prefers it over the main window.
    const mainWindow = createWindow();
    const popoutWindow = createWindow();
    fromWebContentsMock.mockReturnValue(popoutWindow);

    const handlers = registerHandlers(mainWindow);

    expect(handlers.get("window-controls:close")?.(fakeEvent)).toEqual({ success: true });
    expect(popoutWindow.close).toHaveBeenCalledOnce();
    expect(mainWindow.close).not.toHaveBeenCalled();
  });

  it("setWidth resizes the sender's window, not the main window (popout width slider)", () => {
    // The popout's HeaderWindowControls calls window-controls:setWidth on its
    // own window; routing it to the main window instead would silently resize
    // the wrong window. Mirror the close-handler regression test.
    const mainWindow = createWindow();
    const popoutWindow = createWindow();
    fromWebContentsMock.mockReturnValue(popoutWindow);

    const handlers = registerHandlers(mainWindow);

    expect(handlers.get("window-controls:setWidth")?.(fakeEvent, 900)).toEqual({ success: true });
    expect(popoutWindow.setSize).toHaveBeenCalledWith(900, 600, true);
    expect(mainWindow.setSize).not.toHaveBeenCalled();
  });
});
