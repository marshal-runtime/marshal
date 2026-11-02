import { pathToFileURL } from "node:url";

import { BrowserWindow } from "electron";

import { authorizeIpcWebContents } from "../ipc/ipc-handle";
import type { MiniModeWindowBounds } from "../platform/windowing/mini-mode/contracts";
import { shouldSkipTaskbarForHiddenWindow } from "../window-taskbar";

interface EnsureIndicatorWindowOptions {
  bounds: MiniModeWindowBounds;
  pagePath: string;
  onDidFinishLoad: () => void;
  preloadPath: string;
}

export class MiniModeIndicatorWindowController {
  private window: BrowserWindow | null = null;
  private loaded = false;
  private mapped = false;
  private visible = false;

  ensure({ bounds, pagePath, onDidFinishLoad, preloadPath }: EnsureIndicatorWindowOptions): void {
    if (this.window && !this.window.isDestroyed()) {
      return;
    }

    this.loaded = false;
    this.mapped = false;
    this.visible = false;
    this.window = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      show: false,
      skipTaskbar: shouldSkipTaskbarForHiddenWindow(),
      focusable: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      hasShadow: false,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const deauthorizeIpc = authorizeIpcWebContents(this.window.webContents.id);

    this.window.setMenuBarVisibility(false);
    this.window.setAlwaysOnTop(true, "screen-saver");
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.on("show", () => {
      this.mapped = true;
    });
    this.window.on("hide", () => {
      this.mapped = false;
      this.visible = false;
    });
    this.window.on("closed", () => {
      deauthorizeIpc();
      this.loaded = false;
      this.mapped = false;
      this.visible = false;
      this.window = null;
    });
    this.window.webContents.on("did-finish-load", () => {
      this.loaded = true;
      onDidFinishLoad();
    });
    void this.window.loadURL(pathToFileURL(pagePath).href);
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  isVisible(): boolean {
    return this.visible;
  }

  setBounds(bounds: MiniModeWindowBounds): void {
    this.window?.setBounds(bounds);
  }

  send(channel: string, payload: unknown): void {
    this.window?.webContents.send(channel, payload);
  }

  show(): void {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }
    if (!this.loaded) {
      return;
    }
    this.prime();
    if (this.visible) {
      return;
    }
    this.visible = true;
    // Click-through with forwarding: clicks pass through transparent areas,
    // but mouse movement is forwarded so the renderer can detect mouseenter
    // on interactive elements and toggle to accept clicks via setInteractive().
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.window.setOpacity(1);
  }

  hide(): void {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }
    this.visible = false;
    if (!this.mapped) {
      return;
    }
    // Reset to fully ignoring (no forwarding needed for a hidden window)
    this.window.setIgnoreMouseEvents(true);
    this.window.setOpacity(0);
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = null;
    this.loaded = false;
    this.mapped = false;
    this.visible = false;
  }

  /** Toggle click-through: true = accept clicks, false = click-through with forwarding. */
  setInteractive(interactive: boolean): void {
    if (!this.window || this.window.isDestroyed() || !this.visible) {
      return;
    }
    if (interactive) {
      this.window.setIgnoreMouseEvents(false);
    } else {
      this.window.setIgnoreMouseEvents(true, { forward: true });
    }
  }

  private prime(): void {
    if (!this.window || this.window.isDestroyed() || this.mapped) {
      return;
    }

    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.window.setOpacity(0);
    this.mapped = true;
    this.window.showInactive();
  }
}
