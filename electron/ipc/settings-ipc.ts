import path from "node:path";

import { dialog, shell } from "electron";

import { getAppDataDir } from "../app-paths";
import type { BackgroundServiceSettings } from "../background-service-manager";
import { resolveWorktreesDir } from "../persisted-paths";
import { sharedIpcHandle } from "../remote-access/shared-handlers";
import { checkStringSize, IPC_LIMITS } from "./ipc-limits";
import type { IpcDeps, MSettings } from "./types";

export function registerSettingsHandlers({
  settingsManager,
  getRuntimeSelection,
  switchRuntime,
  getWindow,
  backgroundService,
  showHideShortcutController,
  resolveThemeBg,
  ipcHandle,
}: Pick<
  IpcDeps,
  | "settingsManager"
  | "getRuntimeSelection"
  | "switchRuntime"
  | "getWindow"
  | "backgroundService"
  | "showHideShortcutController"
  | "resolveThemeBg"
  | "ipcHandle"
>) {
  sharedIpcHandle(ipcHandle)("settings:get", () => {
    return {
      success: true,
      settings: settingsManager.get(),
    };
  });

  ipcHandle("settings:getRuntimeSelection", () => {
    return { success: true, selection: getRuntimeSelection() };
  });

  ipcHandle("settings:switchRuntime", async (_event, runtimeId: string) => {
    try {
      return { success: true, result: await switchRuntime(runtimeId) };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("settings:save", (_event, settings: MSettings) => {
    try {
      // SF-4: serialize once to measure size; settings object is small (<10 KB) so the
      // cost of re-serializing downstream in settingsManager.save is negligible.
      const serialized = JSON.stringify(settings);
      const sizeCheck = checkStringSize(serialized, IPC_LIMITS.JSON_IMPORT_BYTES, "Settings");
      if (sizeCheck) return sizeCheck;
      settingsManager.save(settings);
      // Keep the native window background in sync so resize/reflow never shows white
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.setBackgroundColor(resolveThemeBg(settings.theme));
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("settings:getShowHideShortcutStatus", () => {
    try {
      return { success: true, status: showHideShortcutController.getStatus() };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Background service IPC — settings for minimize-to-tray and startup registration
  ipcHandle("background:getSettings", () => {
    return { success: true, settings: backgroundService.get() };
  });

  ipcHandle("background:saveSettings", (_e, updates: Partial<BackgroundServiceSettings>) => {
    try {
      const settings = backgroundService.save(updates);
      return { success: true, settings };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("settings:openFile", async () => {
    try {
      const fs = await import("node:fs");
      const settingsPath = path.join(getAppDataDir(), "marshal-settings.json");
      if (!fs.existsSync(settingsPath)) {
        return { success: false, error: `Settings file not found at ${settingsPath}` };
      }
      const result = await shell.openPath(settingsPath);
      if (result) return { success: false, error: result };
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("settings:pickWorkspaceDir", async (_event, defaultPath?: string) => {
    try {
      const result = await dialog.showOpenDialog({
        title: "Select Workspace Directory",
        message: "Select a folder to use as your Marshal workspace",
        properties: ["openDirectory"],
        defaultPath,
      });
      if (result.canceled || !result.filePaths[0]) {
        return { success: false, error: "Folder selection cancelled" };
      }
      return { success: true, folderPath: result.filePaths[0] };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("settings:pickWorktreeDir", async (_event, defaultPath?: string) => {
    try {
      const result = await dialog.showOpenDialog({
        title: "Select Worktree Directory",
        message: "Select the root folder for new subagent git worktrees",
        properties: ["openDirectory", "createDirectory"],
        defaultPath: defaultPath ?? resolveWorktreesDir(getAppDataDir()),
      });
      if (result.canceled || !result.filePaths[0]) {
        return { success: false, error: "Folder selection cancelled" };
      }
      return { success: true, folderPath: result.filePaths[0] };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}
