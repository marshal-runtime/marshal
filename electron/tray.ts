import path from "node:path";

import { Tray, Menu, app, nativeImage } from "electron";
import type { BrowserWindow } from "electron";

import { getAppModeAssetMode } from "../common/app-mode-presentation";
import { createLogger } from "../common/marshal-logger";
import type { AppMode } from "./app-badge";
import { shouldSkipTaskbarForHiddenWindow } from "./window-taskbar";

const log = createLogger("Tray");

export type TrayStatus = "idle" | "running";

/**
 * Manages the system tray icon for background mode.
 *
 * Windows best practices implemented:
 * - Single-click on tray icon toggles window visibility
 * - Tooltip reflects current task status
 * - Context menu provides Show, Hide, and Quit actions
 * - Hidden windows leave the taskbar on Windows while macOS retains its Dock presence
 */
export class TrayManager {
  private tray: Tray | null = null;
  private win: BrowserWindow | null = null;
  private status: TrayStatus = "idle";
  private statusLabel = "Idle";
  private onQuit: (() => void) | null = null;
  private onBeforeShow: (() => void) | null = null;
  private onHideRequested: (() => void) | null = null;

  /** Initialize the tray icon. Call inside createWindow() after win is assigned. */
  init(
    win: BrowserWindow,
    publicDir: string,
    onQuit: () => void,
    onBeforeShow?: () => void,
    onHideRequested?: () => void,
  ): void {
    this.win = win;
    this.onQuit = onQuit;
    this.onBeforeShow = onBeforeShow ?? null;
    this.onHideRequested = onHideRequested ?? null;

    // Destroy any existing tray to prevent duplicate menu bar icons
    // (e.g. when the window is closed and re-created via Dock click).
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }

    let trayIcon: Tray;
    if (process.platform === "darwin") {
      // macOS menu bar: use a monochrome "Template" image so the OS
      // automatically tints it for light/dark mode.  Electron picks up
      // the @2x variant for Retina displays when both files exist.
      const img = nativeImage.createFromPath(path.join(publicDir, "marshal-tray-template.png"));
      img.setTemplateImage(true);
      trayIcon = new Tray(img);
    } else {
      // Windows: prefer .ico for correct rendering at all DPI scales
      const iconFile = "marshal-app-icon.ico";
      const iconPath = path.join(publicDir, iconFile);
      try {
        trayIcon = new Tray(iconPath);
      } catch {
        trayIcon = new Tray(path.join(publicDir, "marshal-app-icon.png"));
      }
    }
    this.tray = trayIcon;

    this.tray.setToolTip("Marshal — AI Assistant");

    // Windows: single-click toggles window (macOS uses right-click menu by default)
    if (process.platform === "win32") {
      this.tray.on("click", () => this.toggleWindow());
    }

    this.updateMenu();
    log.info("System tray icon initialized");
  }

  /** Update the status indicator in the tray tooltip and context menu. */
  setStatus(status: TrayStatus, label: string): void {
    this.status = status;
    this.statusLabel = label;
    this.tray?.setToolTip(`Marshal — ${label}`);
    this.updateMenu();
  }

  /** Swap the tray icon and tooltip to reflect the current app mode. */
  updateIcon(publicDir: string, mode: AppMode, tooltip: string): void {
    if (!this.tray) return;

    const assetMode = getAppModeAssetMode(mode);
    if (process.platform === "darwin") {
      const isRelease = assetMode === "release";
      const file = isRelease
        ? "marshal-tray-template.png"
        : `marshal-tray-template-${assetMode}.png`;
      const img = nativeImage.createFromPath(path.join(publicDir, file));
      if (img.isEmpty()) {
        log.warn(`Badge icon ${file} not found, keeping current tray icon`);
        this.tray.setToolTip(tooltip);
        return;
      }
      // Only mark as template for release — badged variants use actual colors
      // so the badge is visible (template images are monochrome).
      img.setTemplateImage(isRelease);
      this.tray.setImage(img);
    } else {
      const file =
        assetMode !== "release" ? `marshal-tray-icon-${assetMode}.png` : "marshal-app-icon.ico";
      const iconPath = path.join(publicDir, file);
      try {
        this.tray.setImage(iconPath);
      } catch {
        this.tray.setImage(path.join(publicDir, "marshal-app-icon.png"));
      }
    }

    this.tray.setToolTip(tooltip);
  }

  /** Bring the window to the foreground. */
  showWindow(): void {
    if (!this.win) return;
    this.onBeforeShow?.();
    if (this.win.isMinimized()) this.win.restore();
    // Re-register in the taskbar before showing — Windows won't grant focus to a
    // window that still has skipTaskbar=true (it treats it as a tooltip surface).
    this.win.setSkipTaskbar(false);
    if (process.platform === "win32") {
      // app.focus({ steal: true }) uses AttachThreadInput to claim foreground rights
      // from whatever window currently holds them. Without this, the OS grant issued
      // at notification-click time is often consumed before our JS callback runs,
      // causing SetForegroundWindow to silently fail (taskbar flash instead of focus).
      app.focus({ steal: true });
      this.win.setAlwaysOnTop(true);
      this.win.show();
      this.win.focus();
      this.win.setAlwaysOnTop(false);
    } else {
      this.win.show();
      this.win.focus();
    }
  }

  private toggleWindow(): void {
    if (!this.win) return;
    if (this.win.isVisible() && !this.win.isMinimized()) {
      if (this.onHideRequested) {
        this.onHideRequested();
      } else {
        this.win.hide();
        this.win.setSkipTaskbar(shouldSkipTaskbarForHiddenWindow());
      }
    } else {
      this.showWindow();
    }
  }

  private updateMenu(): void {
    if (!this.tray) return;
    const isRunning = this.status === "running";
    const menu = Menu.buildFromTemplate([
      {
        label: isRunning ? `● ${this.statusLabel}` : `○ ${this.statusLabel}`,
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Show Marshal",
        click: () => this.showWindow(),
      },
      {
        label: "Hide",
        click: () => {
          if (this.onHideRequested) {
            this.onHideRequested();
          } else {
            this.win?.hide();
            this.win?.setSkipTaskbar(shouldSkipTaskbarForHiddenWindow());
          }
        },
      },
      { type: "separator" },
      {
        label: "Quit Marshal",
        click: () => this.onQuit?.(),
      },
    ]);
    this.tray.setContextMenu(menu);
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
      log.info("Tray icon destroyed");
    }
  }
}
