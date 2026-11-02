/**
 * Chat Window Manager — "Open in New Window" for chats.
 *
 * Tracks popout BrowserWindows (one per session) and provides a broadcast
 * helper so session events (session:view, metadata-changed, list-changed)
 * reach every renderer instance, keeping all open windows in sync.
 *
 * Each popout loads the same renderer bundle with `?popout=<sessionId>` in
 * the URL; the renderer reads this and renders a session-locked view with
 * no left nav.
 */
import { BrowserWindow, screen } from "electron";

import { createLogger } from "../common/marshal-logger";
import { authorizeIpcWebContents } from "./ipc/ipc-handle";
import { openExternalSafe } from "./open-external";
import { broadcastRemote } from "./remote-access/controller";
import { isDevServerNavigation } from "./runtime-env";
import type { SessionViewIpcTarget } from "./session-view-ipc-broker";
import { resolveThemeBg, useMacVibrancy } from "./theme";

const log = createLogger("ChatWindowManager");

const POPOUT_WIDTH = 720;
const POPOUT_HEIGHT = 800;
// Offset so the window's top-left lands near (not under) the cursor's release point.
const CURSOR_OFFSET_X = 40;
const CURSOR_OFFSET_Y = 20;

/**
 * Compute on-screen coords for a popout near the given drop point, clamped
 * to the containing display's workArea so the window can't be created off
 * the edge of any monitor.
 */
function computePopoutPosition(bounds: { x: number; y: number }): { x: number; y: number } {
  const display = screen.getDisplayMatching({
    x: bounds.x,
    y: bounds.y,
    width: POPOUT_WIDTH,
    height: POPOUT_HEIGHT,
  });
  const wa = display.workArea;
  const x = Math.max(wa.x, Math.min(bounds.x - CURSOR_OFFSET_X, wa.x + wa.width - POPOUT_WIDTH));
  const y = Math.max(wa.y, Math.min(bounds.y - CURSOR_OFFSET_Y, wa.y + wa.height - POPOUT_HEIGHT));
  return { x, y };
}

export interface ChatWindowManagerOptions {
  preloadPath: string;
  /** Dev server URL (e.g. http://localhost:5173) when running `pnpm dev`. */
  devServerUrl: string | undefined;
  /** Absolute path to the renderer dist folder for packaged builds. */
  rendererDist: string;
  /** Returns the main app window so we can broadcast to it too. */
  getMainWindow: () => BrowserWindow | null;
  applyWindowBranding?: (win: BrowserWindow) => void;
  applyWindowTitle?: (win: BrowserWindow) => void;
}

export class ChatWindowManager {
  private readonly popouts = new Map<string, BrowserWindow>();
  private onRendererClosed: (webContentsId: number) => void = () => {};

  constructor(private readonly opts: ChatWindowManagerOptions) {}

  /**
   * Open (or focus) a popout window for the given session.
   * Returns `alreadyOpen: true` if a popout for this session already exists.
   *
   * When `bounds` is provided (drag-to-popout's drop point in screen coords),
   * the new window opens near the drop. Omit for non-spatial triggers such as
   * the overflow menu — OS-default placement is more appropriate there.
   */
  open(
    sessionId: string,
    bounds?: { x: number; y: number },
  ): { success: true; alreadyOpen: boolean } {
    const existing = this.popouts.get(sessionId);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return { success: true, alreadyOpen: true };
    }

    const position = bounds ? computePopoutPosition(bounds) : null;

    const popoutWin = new BrowserWindow({
      width: POPOUT_WIDTH,
      height: POPOUT_HEIGHT,
      minWidth: 480,
      show: false,
      ...(position ?? {}),
      // Frameless on Windows / hiddenInset on macOS, matching the main window.
      // The renderer reuses the mainline `Header` component (with
      // HeaderWindowControls) to provide the chrome, so chat popouts share the
      // exact same titlebar UI as the main app — no duplication.
      ...(process.platform === "win32"
        ? { frame: false, thickFrame: true }
        : {
            titleBarStyle: "hiddenInset" as const,
            trafficLightPosition: { x: 16, y: 17 },
          }),
      // Match the main window's opaque surface for reliable resize/full-screen.
      transparent: false,
      backgroundColor: resolveThemeBg(),
      // Native vibrancy decorates the window without making its surface transparent.
      // CSS in index.css handles clearing wrapper backgrounds reactively via
      // [data-vibrancy] selectors. See docs/architecture/14-marshal-macos-vibrancy.md.
      ...(useMacVibrancy
        ? {
            vibrancy: "under-window" as const,
            visualEffectState: "followWindow" as const,
          }
        : {}),
      webPreferences: {
        preload: this.opts.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    const deauthorizeIpc = authorizeIpcWebContents(popoutWin.webContents.id);

    popoutWin.setMenuBarVisibility(false);
    // Popouts are separate BrowserWindows, so main-window native branding does not
    // cover their title, taskbar overlay, or Alt+Tab icon.
    this.opts.applyWindowBranding?.(popoutWin);

    // Navigation guards mirror the main window: a markdown link in a chat
    // message must NOT replace the popout's renderer (will-navigate) and must
    // NOT open an uncontrolled child window (setWindowOpenHandler). Both go
    // through `openExternalSafe`, which protocol-restricts the URL before
    // handing it to the OS. Vite HMR full-reloads to the dev server URL are
    // allowed through.
    popoutWin.webContents.setWindowOpenHandler(({ url }) => {
      openExternalSafe(url);
      return { action: "deny" };
    });
    popoutWin.webContents.on("will-navigate", (event, url) => {
      if (isDevServerNavigation(this.opts.devServerUrl, url)) return;
      event.preventDefault();
      openExternalSafe(url);
    });
    // Popout native titles now carry app-mode branding; prevent the renderer's
    // static <title> from overwriting them back to plain "Marshal".
    popoutWin.on("page-title-updated", (event) => {
      event.preventDefault();
      this.opts.applyWindowTitle?.(popoutWin);
    });

    // Per-window maximize/fullscreen broadcasts so HeaderWindowControls in the
    // popout reflects this window's state (not the main window's).
    const emitMaximized = () => {
      if (!popoutWin.isDestroyed()) {
        popoutWin.webContents.send("window-controls:maximized-changed", popoutWin.isMaximized());
      }
    };
    const emitFullScreen = () => {
      if (!popoutWin.isDestroyed()) {
        popoutWin.webContents.send("window-controls:fullscreen-changed", popoutWin.isFullScreen());
      }
    };
    popoutWin.on("maximize", emitMaximized);
    popoutWin.on("unmaximize", emitMaximized);
    popoutWin.on("enter-full-screen", emitFullScreen);
    popoutWin.on("leave-full-screen", emitFullScreen);

    const query = `popout=${encodeURIComponent(sessionId)}`;
    if (this.opts.devServerUrl) {
      popoutWin.loadURL(`${this.opts.devServerUrl}/?${query}`).catch((err) => {
        log.error("Failed to load popout (dev):", err);
      });
    } else {
      popoutWin.loadURL(`marshal://app/index.html?${query}`).catch((err) => {
        log.error("Failed to load popout (prod):", err);
      });
    }

    popoutWin.once("ready-to-show", () => popoutWin.show());
    popoutWin.on("closed", () => {
      this.onRendererClosed(popoutWin.webContents.id);
      deauthorizeIpc();
      this.popouts.delete(sessionId);
    });

    this.popouts.set(sessionId, popoutWin);
    log.info(`Opened popout for session ${sessionId}`);
    return { success: true, alreadyOpen: false };
  }

  /**
   * Send an IPC event to every renderer (main window + all popouts).
   * Used to keep session state in sync across windows.
   */
  broadcast(channel: string, ...args: unknown[]): void {
    broadcastRemote(channel, ...args);
    const main = this.opts.getMainWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send(channel, ...args);
    }
    for (const [, win] of this.popouts) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args);
      }
    }
  }

  getRendererTargets(): SessionViewIpcTarget[] {
    const targets: SessionViewIpcTarget[] = [];
    const main = this.opts.getMainWindow();
    if (main && !main.isDestroyed()) targets.push(main.webContents);
    for (const win of this.popouts.values()) {
      if (!win.isDestroyed()) targets.push(win.webContents);
    }
    return targets;
  }

  setRendererClosedHandler(handler: (webContentsId: number) => void): void {
    this.onRendererClosed = handler;
  }

  applyWindowBrandingToPopouts(): void {
    for (const [, win] of this.popouts) {
      if (!win.isDestroyed()) {
        this.opts.applyWindowBranding?.(win);
      }
    }
  }

  /** Close all popouts (called on app quit). */
  closeAll(): void {
    for (const [, win] of this.popouts) {
      if (!win.isDestroyed()) win.close();
    }
    this.popouts.clear();
  }
}
