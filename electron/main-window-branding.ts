import type { BrowserWindow } from "electron";

import type { AppMode } from "../common/marshal-constants";
import { applyWindowTitle } from "./app-badge";

// Electron lets the renderer's static <title>Marshal</title> overwrite the
// native title set by applyAppBadge(), which breaks taskbar/Alt+Tab branding
// for Beta. Intercept page-title-updated and reapply.
export function installNativeTitleSync(
  win: BrowserWindow,
  getEffectiveAppMode: () => AppMode,
): void {
  win.on("page-title-updated", (event) => {
    event.preventDefault();
    applyWindowTitle(getEffectiveAppMode(), win);
  });
}
