import type { BrowserWindow } from "electron";

import type { MiniModeManager } from "../mini-mode";
import { openExternalSafe } from "../open-external";
import type { SettingsManager } from "../settings-manager";
import type { TrayManager } from "../tray";
import { sendOSNotification } from "./notifications";
import type { MiniModeNotification, MiniModeStatus } from "./windowing/mini-mode/contracts";

export interface NotifyOptions {
  title: string;
  body: string;
  sessionId?: string;
  url?: string;
  /** Mini-mode notification type. If omitted, an OS notification is sent instead. */
  miniModeType?: MiniModeNotification["type"];
  miniModeStatusOverride?: MiniModeStatus;
  /** When true, only send if the main window is not focused. */
  onlyWhenUnfocused?: boolean;
  /** When true, suppress entirely when mini-mode is visible (no OS fallback). */
  suppressWhenMiniMode?: boolean;
}

export class NotificationRouter {
  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly miniModeManager: MiniModeManager,
    private readonly settingsManager: SettingsManager,
    private readonly trayManager: TrayManager,
  ) {}

  private isMiniModeVisible(): boolean {
    const window = this.getWindow();
    return !!this.settingsManager.get().miniModeEnabled && (!window || !window.isVisible());
  }

  notify(opts: NotifyOptions): void {
    // A null window is treated as unfocused because the user cannot be viewing it.
    if (opts.onlyWhenUnfocused) {
      const window = this.getWindow();
      if (window && window.isFocused()) return;
    }

    if (!this.isMiniModeVisible()) {
      this.sendOS(opts);
      return;
    }

    if (opts.miniModeType) {
      this.miniModeManager.showNotification({
        id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: opts.miniModeType,
        title: opts.title,
        body: opts.body,
        sessionId: opts.sessionId,
        url: opts.url,
        statusOverride: opts.miniModeStatusOverride,
      });
    } else if (!opts.suppressWhenMiniMode) {
      this.sendOS(opts);
    }
  }

  private sendOS(opts: NotifyOptions): void {
    sendOSNotification(opts.title, opts.body, () => {
      if (opts.url) {
        openExternalSafe(opts.url);
        return;
      }

      // showWindow() restores and shows synchronously before the session-switch IPC.
      this.trayManager.showWindow();
      const window = this.getWindow();
      if (window && !window.isDestroyed() && opts.sessionId) {
        window.webContents.send("sessions:switch-to", opts.sessionId);
      }
    });
  }
}
