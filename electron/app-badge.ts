import path from "node:path";

import { app, nativeImage } from "electron";
import type { BrowserWindow } from "electron";

import { getAppModeAssetMode, getAppModeLabel } from "../common/app-mode-presentation";
import { APP_NAME } from "../common/marshal-constants";
import type { AppMode } from "../common/marshal-constants";
import { createLogger } from "../common/marshal-logger";
import { isDevMode } from "./app-paths";
import type { TrayManager } from "./tray";

const log = createLogger("AppBadge");

export type { AppMode };

const pendingOverlay = new WeakSet<BrowserWindow>();

/**
 * Determine the current app mode:
 *
 * - **dev**: unpackaged Electron (`pnpm dev` / `pnpm electron:dev`)
 * - **beta**: running version is in the supplied `betaVersions` list
 * - **release**: packaged build whose version is not in the beta list
 *
 * No release feed publishes a beta list today, so callers pass an empty list.
 */
export function getAppMode(currentVersion: string, betaVersions: string[]): AppMode {
  if (isDevMode()) return "dev";
  if (betaVersions.includes(currentVersion)) return "beta";
  return "release";
}

export function getAppModeTitle(mode: AppMode): string {
  const label = getAppModeLabel(mode);
  return label ? `${APP_NAME} (${label})` : APP_NAME;
}

export function applyWindowTitle(mode: AppMode, win: BrowserWindow): void {
  win.setTitle(getAppModeTitle(mode));
}

export function applyWindowIconBadge(mode: AppMode, win: BrowserWindow, publicDir: string): void {
  if (process.platform !== "win32") return;

  const label = getAppModeLabel(mode);
  const assetMode = getAppModeAssetMode(mode);
  win.setIcon(nativeImage.createFromPath(path.join(publicDir, "marshal-app-icon.ico")));

  if (assetMode !== "release") {
    const overlayIcon = nativeImage.createFromPath(
      path.join(publicDir, `marshal-app-icon-${assetMode}-overlay.png`),
    );
    const applyOverlay = () => {
      // Popouts can be closed during the 500ms show-defer; setOverlayIcon on a
      // destroyed window throws "Object has been destroyed".
      if (!win.isDestroyed()) win.setOverlayIcon(overlayIcon, `${label} Build`);
    };
    if (win.isVisible()) {
      applyOverlay();
    } else if (!pendingOverlay.has(win)) {
      pendingOverlay.add(win);
      // Windows registers the taskbar button asynchronously after show; early
      // overlay calls can silently no-op before the button exists.
      win.once("show", () => {
        pendingOverlay.delete(win);
        setTimeout(applyOverlay, 500);
      });
    }
  } else {
    pendingOverlay.delete(win);
    win.setOverlayIcon(null, "");
  }
}

/**
 * Apply the mode-appropriate badge to all icon surfaces:
 * dock, window, taskbar overlay, tray, tooltip, and window title.
 *
 * On Windows, `setIcon()` keeps the window/taskbar identity on the canonical
 * application ICO. `setOverlayIcon()` adds a mode badge on the taskbar button
 * (deferred until the window is visible so the taskbar button exists).
 */
export function applyAppBadge(
  mode: AppMode,
  win: BrowserWindow,
  trayManager: TrayManager,
  publicDir: string,
): void {
  const label = getAppModeLabel(mode);
  const assetMode = getAppModeAssetMode(mode);
  const tooltip = label ? `${APP_NAME} (${label}) — AI Assistant` : `${APP_NAME} — AI Assistant`;

  // ── Window title ──────────────────────────────────────────────────────
  applyWindowTitle(mode, win);

  // ── macOS dock icon ───────────────────────────────────────────────────
  if (process.platform === "darwin" && app.dock) {
    if (assetMode !== "release") {
      const dockIcon = nativeImage.createFromPath(
        path.join(publicDir, `marshal-app-icon-${assetMode}.png`),
      );
      app.dock.setIcon(dockIcon);
    } else {
      // Restore the stock icon. Electron's dock.setIcon doesn't accept null,
      // so we set it to marshal-app-icon.png (same artwork as the bundled .icns).
      app.dock.setIcon(nativeImage.createFromPath(path.join(publicDir, "marshal-app-icon.png")));
    }
  }

  // ── Windows preview/Alt+Tab icon + taskbar overlay ────────────────────
  applyWindowIconBadge(mode, win, publicDir);

  // ── Tray icon + tooltip ───────────────────────────────────────────────
  trayManager.updateIcon(publicDir, mode, tooltip);

  log.info(`Badge applied: mode=${mode}`);
}
