import { app } from "electron";

import { openExternalSafe } from "../../../open-external";
import type { IpcDeps } from "../../types";

export function registerShellHandlers({ ipcHandle }: Pick<IpcDeps, "ipcHandle">): void {
  ipcHandle("shell:openExternal", (_event, url: string) => {
    try {
      if (url && typeof url === "string") {
        openExternalSafe(url);
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("shell:quitApp", () => {
    try {
      app.quit();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}
