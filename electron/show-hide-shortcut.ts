import { app, globalShortcut } from "electron";
import type { BrowserWindow } from "electron";

import { createLogger } from "../common/marshal-logger";
import { DEFAULT_SHOW_HIDE_SHORTCUT } from "../common/marshal/show-hide-shortcut";
import type { SettingsManager } from "./settings-manager";

const log = createLogger("ShowHide");

export const SHOW_HIDE_SHORTCUT = DEFAULT_SHOW_HIDE_SHORTCUT;

export interface ShowHideShortcutStatus {
  enabled: boolean;
  accelerator: string;
  registered: boolean;
  error: string | null;
}

interface ShowHideShortcutControllerOptions {
  getWindow: () => BrowserWindow | null;
  onHideRequested: () => void;
  onShowRequested: () => void;
  settingsManager: SettingsManager;
}

export class ShowHideShortcutController {
  private registeredAccelerator: string | null = null;
  private status: ShowHideShortcutStatus;

  constructor(private readonly options: ShowHideShortcutControllerOptions) {
    const settings = this.options.settingsManager.get();
    this.status = {
      enabled: false,
      accelerator: settings.showHideShortcut || SHOW_HIDE_SHORTCUT,
      registered: false,
      error: null,
    };
  }

  getStatus(): ShowHideShortcutStatus {
    return { ...this.status };
  }

  sync(): void {
    if (!app.isReady()) {
      return;
    }

    const settings = this.options.settingsManager.get();
    const accelerator = settings.showHideShortcut || SHOW_HIDE_SHORTCUT;

    globalShortcut.unregister(this.registeredAccelerator ?? SHOW_HIDE_SHORTCUT);
    this.registeredAccelerator = null;

    if (!settings.showHideShortcutEnabled) {
      this.status = { enabled: false, accelerator, registered: false, error: null };
      return;
    }

    const registered = globalShortcut.register(accelerator, () => {
      const win = this.options.getWindow();
      if (!win) {
        return;
      }

      // Only hide when the window is actually in the foreground. If it's
      // visible but another app owns focus, the user is summoning the window,
      // not dismissing it — otherwise the hotkey ends up hiding the app when
      // the user wanted to bring it to the front, and they have to press it
      // twice to get focus.
      const isInForeground = win.isVisible() && !win.isMinimized() && win.isFocused();
      if (isInForeground) {
        this.options.onHideRequested();
        return;
      }

      this.options.onShowRequested();
    });

    if (!registered) {
      const error = `Failed to register ${accelerator}`;
      log.warn(error);
      this.status = { enabled: true, accelerator, registered: false, error };
      return;
    }

    this.registeredAccelerator = accelerator;
    this.status = { enabled: true, accelerator, registered: true, error: null };
  }
}
