// Owns background-service settings and startup registration.
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";

import { app } from "electron";

import type { BackgroundServiceSettings } from "../common/marshal-ipc-contract";
import { createLogger } from "../common/marshal-logger";

export type { BackgroundServiceSettings };

/** Thrown when the OS rejects a login item registration change. */
export class LoginItemError extends Error {
  override readonly name = "LoginItemError";
}

type BackgroundServiceListener = (settings: BackgroundServiceSettings) => void;

const DEFAULT: BackgroundServiceSettings = {
  enabled: false,
  runOnStartup: false,
  hideOnLaunch: false,
};

const log = createLogger("BackgroundService");

/**
 * Manages background service settings (minimize-to-tray, startup registration).
 *
 * Settings are persisted to userData/background-service.json.
 * Call load() before createWindow() so the window can be created in the
 * correct initial state.
 */
export class BackgroundServiceManager extends EventEmitter {
  private settings: BackgroundServiceSettings = { ...DEFAULT };

  override on(eventName: "changed", listener: BackgroundServiceListener): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(eventName: string | symbol, listener: (...args: any[]) => void): this;
  override on(
    eventName: string | symbol,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener: BackgroundServiceListener | ((...args: any[]) => void),
  ): this {
    return super.on(eventName, listener);
  }

  override emit(eventName: "changed", settings: BackgroundServiceSettings): boolean;
  override emit(eventName: string | symbol, ...args: unknown[]): boolean;
  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    return super.emit(eventName, ...args);
  }

  private getSettingsPath(): string {
    return path.join(app.getPath("userData"), "background-service.json");
  }

  /** Load settings from disk. Call once during app.whenReady(). */
  load(): BackgroundServiceSettings {
    try {
      const raw = fs.readFileSync(this.getSettingsPath(), "utf-8");
      this.settings = { ...DEFAULT, ...JSON.parse(raw) }; // SF-4: trusted — app-written local file with 3 boolean fields; spread over known-shape DEFAULT
    } catch {
      this.settings = { ...DEFAULT };
    }
    log.info("Loaded settings:", JSON.stringify(this.settings));

    // Re-apply startup registration on every load so the registry stays in sync
    // with the saved setting (handles reinstalls, registry cleanups, updates).
    // Skip in dev mode: process.execPath is the Electron binary, not the packaged app.
    if (app.isPackaged) {
      try {
        const openAtLogin = this.settings.runOnStartup;
        app.setLoginItemSettings({ openAtLogin });
        try {
          const confirmed = app.getLoginItemSettings();
          log.info(
            `Login item synced on load: openAtLogin=${openAtLogin}; confirmed:`,
            confirmed.openAtLogin,
          );
        } catch {
          log.info(`Login item synced on load: openAtLogin=${openAtLogin} (could not read back)`);
        }
      } catch (err) {
        log.error("Failed to sync login item on load:", err);
      }
    } else if (this.settings.runOnStartup) {
      log.warn(
        "runOnStartup=true but app is not packaged — skipping setLoginItemSettings (dev mode; also prevents registering macOS login item helper)",
      );
    }

    this.emitChanged();
    return { ...this.settings };
  }

  /**
   * Persist updated settings and apply side effects.
   * Setting runOnStartup registers/unregisters the Windows/macOS login item.
   */
  save(updates: Partial<BackgroundServiceSettings>): BackgroundServiceSettings {
    // Explicitly pick and coerce known boolean keys — ignore any extra IPC noise
    const sanitized: Partial<BackgroundServiceSettings> = {};
    if ("enabled" in updates) sanitized.enabled = Boolean(updates.enabled);
    if ("runOnStartup" in updates) sanitized.runOnStartup = Boolean(updates.runOnStartup);
    if ("hideOnLaunch" in updates) sanitized.hideOnLaunch = Boolean(updates.hideOnLaunch);
    const priorRunOnStartup = this.settings.runOnStartup;
    this.settings = { ...this.settings, ...sanitized };
    try {
      fs.writeFileSync(this.getSettingsPath(), JSON.stringify(this.settings, null, 2), "utf-8");
    } catch (err) {
      log.error("Failed to save settings:", err);
    }

    // Apply Windows / macOS login item registration immediately.
    // Skip in dev mode: process.execPath is the Electron binary, not the packaged app,
    // so registering it would corrupt the login item with the wrong executable.
    if ("runOnStartup" in sanitized) {
      if (app.isPackaged) {
        try {
          const openAtLogin = !!sanitized.runOnStartup;
          app.setLoginItemSettings({ openAtLogin });
          // Verify the OS actually accepted the registration
          try {
            const confirmed = app.getLoginItemSettings();
            if (confirmed.openAtLogin !== openAtLogin) {
              log.error(
                `Login item verification failed: requested=${openAtLogin}, actual=${confirmed.openAtLogin}`,
              );
              // Revert to match what the OS actually has
              this.settings.runOnStartup = confirmed.openAtLogin;
              fs.writeFileSync(
                this.getSettingsPath(),
                JSON.stringify(this.settings, null, 2),
                "utf-8",
              );
              throw new LoginItemError(
                "Could not register startup item. Your OS may have blocked it — check your startup app settings.",
              );
            }
          } catch (verifyErr) {
            // Re-throw our own verification errors; swallow getLoginItemSettings read failures
            if (verifyErr instanceof LoginItemError) {
              throw verifyErr;
            }
            // getLoginItemSettings() itself failed — not fatal, log and continue
            log.warn("Could not verify login item state:", verifyErr);
          }
          log.info(`Login item set: openAtLogin=${openAtLogin}`);
        } catch (err) {
          if (err instanceof LoginItemError) {
            throw err;
          }
          log.error("Failed to set login item:", err);
          // Revert to prior value so persisted setting stays in sync with OS state
          this.settings.runOnStartup = priorRunOnStartup;
          try {
            fs.writeFileSync(
              this.getSettingsPath(),
              JSON.stringify(this.settings, null, 2),
              "utf-8",
            );
          } catch {
            // best-effort revert
          }
          throw new LoginItemError("Failed to update startup registration. Please try again.", {
            cause: err,
          });
        }
      } else {
        log.warn(
          `runOnStartup=${sanitized.runOnStartup} — skipping setLoginItemSettings (dev mode; also prevents registering macOS login item helper)`,
        );
      }
    }

    this.emitChanged();
    return { ...this.settings };
  }

  get(): BackgroundServiceSettings {
    return { ...this.settings };
  }

  /** Returns true when background mode is active (close hides to tray). */
  isEnabled(): boolean {
    return this.settings.enabled;
  }

  /** Returns true when the window should start hidden on launch. */
  shouldHideOnLaunch(): boolean {
    return this.settings.enabled && this.settings.hideOnLaunch;
  }

  private emitChanged(): void {
    this.emit("changed", { ...this.settings });
  }
}
