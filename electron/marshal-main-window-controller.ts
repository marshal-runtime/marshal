// Owns the main application window lifecycle.

import type { BrowserWindow } from "electron";

import { createLogger } from "../common/marshal-logger";
import type { BackgroundServiceManager } from "./background-service-manager";
import type { MiniModeManager } from "./mini-mode";
import type { SettingsManager } from "./settings-manager";
import { shouldSkipTaskbarForHiddenWindow } from "./window-taskbar";

const log = createLogger("MainWindow");

export interface MainWindowLaunchState {
  backgroundHideOnLaunch: boolean;
  startHidden: boolean;
  startInMiniMode: boolean;
}

interface MainWindowControllerOptions {
  backgroundService: BackgroundServiceManager;
  isQuitting: () => boolean;
  miniModeManager: MiniModeManager;
  settingsManager: SettingsManager;
}

export class MainWindowController {
  private win: BrowserWindow | null = null;
  private hiddenToTray = false;
  private allowNextMainWindowShow = false;

  constructor(private readonly options: MainWindowControllerOptions) {}

  getLaunchState(): MainWindowLaunchState {
    const backgroundHideOnLaunch = this.options.backgroundService.shouldHideOnLaunch();
    const startInMiniMode = this.shouldStartInMiniModeOnLaunch();
    return {
      backgroundHideOnLaunch,
      startInMiniMode,
      startHidden: backgroundHideOnLaunch || startInMiniMode,
    };
  }

  attach(win: BrowserWindow, startHidden: boolean): void {
    this.win = win;
    this.hiddenToTray = startHidden;
    this.allowNextMainWindowShow = !startHidden;

    win.on("close", this.handleClose);
    win.on("minimize", this.handleMinimize);
    win.on("show", this.handleShow);
    win.on("restore", this.handleRestore);
    win.on("hide", this.handleHide);
    win.on("closed", this.handleClosed);
  }

  detach(): void {
    if (this.win) {
      this.win.removeListener("close", this.handleClose);
      this.win.removeListener("minimize", this.handleMinimize);
      this.win.removeListener("show", this.handleShow);
      this.win.removeListener("restore", this.handleRestore);
      this.win.removeListener("hide", this.handleHide);
      this.win.removeListener("closed", this.handleClosed);
    }
    this.win = null;
    this.hiddenToTray = false;
    this.allowNextMainWindowShow = false;
  }

  isHiddenToTray(): boolean {
    return this.hiddenToTray;
  }

  allowShow(reason: string): void {
    this.hiddenToTray = false;
    this.allowNextMainWindowShow = true;
    log.info("Allowing show", JSON.stringify({ reason }));
  }

  hideToTray(): void {
    if (!this.win) {
      return;
    }
    this.hiddenToTray = true;
    this.allowNextMainWindowShow = false;
    log.info("Hiding to tray");
    this.win.hide();
    this.win.setSkipTaskbar(shouldSkipTaskbarForHiddenWindow());
  }

  private shouldHideWindowOnMinimize(): boolean {
    const settings = this.options.settingsManager.get();
    return !!settings.miniModeEnabled || this.options.backgroundService.isEnabled();
  }

  private shouldStartInMiniModeOnLaunch(): boolean {
    const settings = this.options.settingsManager.get();
    return !!settings.miniModeEnabled && !!settings.startInMiniModeEnabled;
  }

  private readonly handleClose = (event: Electron.Event): void => {
    if (!this.options.isQuitting() && this.shouldHideWindowOnMinimize()) {
      event.preventDefault();
      this.hideToTray();
    }
  };

  private readonly handleMinimize = (): void => {
    if (!this.options.isQuitting() && this.shouldHideWindowOnMinimize()) {
      log.info(
        "Minimize event -> scheduling hide",
        JSON.stringify({
          miniModeEnabled: !!this.options.settingsManager.get().miniModeEnabled,
          backgroundEnabled: this.options.backgroundService.isEnabled(),
        }),
      );
      setTimeout(() => {
        if (
          !this.win ||
          this.win.isDestroyed() ||
          this.options.isQuitting() ||
          !this.shouldHideWindowOnMinimize() ||
          !this.win.isMinimized()
        ) {
          return;
        }
        this.hideToTray();
      }, 0);
    }
  };

  private readonly handleShow = (): void => {
    const minimized = !!this.win?.isMinimized();
    const visible = !!this.win?.isVisible();
    log.info(
      "Show event",
      JSON.stringify({
        hiddenToTray: this.hiddenToTray,
        allowNextMainWindowShow: this.allowNextMainWindowShow,
        minimized,
        visible,
      }),
    );
    if (this.hiddenToTray && !this.allowNextMainWindowShow) {
      log.info("Re-hiding unexpected show while hidden to tray");
      setTimeout(() => {
        if (
          !this.win ||
          this.win.isDestroyed() ||
          this.options.isQuitting() ||
          !this.hiddenToTray
        ) {
          return;
        }
        this.hideToTray();
      }, 0);
      return;
    }
    this.allowNextMainWindowShow = false;
    this.hiddenToTray = false;
    this.options.miniModeManager.setMainWindowVisible(true);
  };

  private readonly handleRestore = (): void => {
    this.hiddenToTray = false;
    log.info(
      "Restore event",
      JSON.stringify({ minimized: !!this.win?.isMinimized(), visible: !!this.win?.isVisible() }),
    );
    this.options.miniModeManager.setMainWindowVisible(true);
  };

  private readonly handleHide = (): void => {
    log.info(
      "Hide event",
      JSON.stringify({
        hiddenToTray: this.hiddenToTray,
        minimized: !!this.win?.isMinimized(),
        visible: !!this.win?.isVisible(),
      }),
    );
    this.options.miniModeManager.setMainWindowVisible(false);
  };

  private readonly handleClosed = (): void => {
    this.options.miniModeManager.setMainWindowVisible(false);
    this.detach();
  };
}
