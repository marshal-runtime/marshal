import fs from "node:fs/promises";
import path from "node:path";

import { dialog, type BrowserWindow } from "electron";

import type { IpcHandler, IpcInvokeMap } from "../../../../common/marshal-ipc-contract";
import { checkStringSize, IPC_LIMITS } from "../../ipc-limits";

interface FileExportDeps {
  ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
  getWindow: () => BrowserWindow | null;
}

export function registerSaveJsonHandler({ ipcHandle, getWindow }: FileExportDeps): void {
  ipcHandle("file:saveJson", async (_event, content: string, defaultFilename: string) => {
    const sizeCheck = checkStringSize(content, IPC_LIMITS.JSON_IMPORT_BYTES, "JSON export");
    if (sizeCheck) return sizeCheck;
    try {
      const win = getWindow();
      const dialogOpts = {
        defaultPath: path.basename(defaultFilename),
        filters: [{ name: "JSON", extensions: ["json"] }],
      };
      const result = win
        ? await dialog.showSaveDialog(win, dialogOpts)
        : await dialog.showSaveDialog(dialogOpts);
      if (result.canceled || !result.filePath) {
        return { success: true, canceled: true };
      }
      await fs.writeFile(result.filePath, content, "utf-8");
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}
