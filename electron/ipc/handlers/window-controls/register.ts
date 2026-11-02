import type { IpcDeps } from "../../types";
import { getTargetWindow } from "./target-window";

/**
 * Resolve the window that should receive a window-control action.
 *
 * Prefer the sender's own window so popout chat windows control
 * themselves rather than the main window. Falls back to the main window for
 * legacy/edge cases where the sender is gone (e.g. detached webContents).
 */
export function registerWindowControlsHandlers({
  getWindow,
  ipcHandle,
}: Pick<IpcDeps, "getWindow" | "ipcHandle">) {
  ipcHandle("window-controls:getState", (event) => {
    const win = getTargetWindow(event, getWindow);
    if (!win) {
      return { success: false, error: "Window is unavailable" };
    }

    return { success: true, isMaximized: win.isMaximized(), isFullScreen: win.isFullScreen() };
  });

  ipcHandle("window-controls:minimize", (event) => {
    const win = getTargetWindow(event, getWindow);
    if (!win) {
      return { success: false, error: "Window is unavailable" };
    }

    win.minimize();
    return { success: true };
  });

  ipcHandle("window-controls:toggleMaximize", (event) => {
    const win = getTargetWindow(event, getWindow);
    if (!win) {
      return { success: false, error: "Window is unavailable" };
    }

    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }

    return { success: true, isMaximized: win.isMaximized() };
  });

  ipcHandle("window-controls:close", (event) => {
    const win = getTargetWindow(event, getWindow);
    if (!win) {
      return { success: false, error: "Window is unavailable" };
    }

    win.close();
    return { success: true };
  });

  ipcHandle("window-controls:setWidth", (event, width: number) => {
    const win = getTargetWindow(event, getWindow);
    if (!win) return { success: false, error: "Window is unavailable" };
    const [, height] = win.getSize();
    win.setSize(Math.max(width, 480), height, true);
    return { success: true };
  });
}
