import { app } from "electron";

import { clearLegacyUpdateToken } from "../github-token";
import { UpdaterError, installUpdate, verifyAndLaunch } from "../updater";
import { selectUpdateProvider } from "../updater/select";
import type { IpcDeps } from "./types";

export function registerUpdateHandlers({
  getWindow,
  ipcHandle,
  settingsManager,
}: Pick<IpcDeps, "getWindow" | "ipcHandle" | "settingsManager">) {
  ipcHandle("update:auth", async () => {
    try {
      const provider = selectUpdateProvider();
      const { ok } = await provider.authenticate({
        onDeviceCode: ({ userCode, verificationUri }) => {
          getWindow()?.webContents.send("update:device-flow", { userCode, verificationUri });
        },
      });
      return { success: true, authenticated: ok };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcHandle("update:clear-token", async () => {
    clearLegacyUpdateToken();
    return { success: true };
  });

  ipcHandle("update:check", async () => {
    try {
      const provider = selectUpdateProvider();
      // Pass the user-preference channel uniformly; each provider applies its own policy
      // (EndpointUpdateProvider forces "stable" internally).
      const channel = settingsManager.get().updateChannelBeta ? "beta" : "stable";
      const result = await provider.checkForUpdate({ currentVersion: app.getVersion(), channel });
      if (!result.upToDate && !result.downloadUrl) {
        return { success: true, ...result, error: `No matching asset found for this platform` };
      }
      return { success: true, ...result };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: msg,
        ssoUrl: error instanceof UpdaterError ? error.ssoUrl : undefined,
      };
    }
  });

  ipcHandle("update:download", async (_event, url: string, assetName: string) => {
    try {
      const provider = selectUpdateProvider();
      const filePath = await provider.downloadUpdate({
        url,
        assetName,
        onProgress: (percent) => getWindow()?.webContents.send("update:progress", percent),
      });
      return { success: true, filePath };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: msg,
        ssoUrl: error instanceof UpdaterError ? error.ssoUrl : undefined,
      };
    }
  });

  ipcHandle("update:install", async (_event, filePath: string) => {
    try {
      await installUpdate(filePath);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcHandle("update:check-minimum", async () => {
    try {
      // The provider fails open internally; the envelope below is a second net.
      const result = await selectUpdateProvider().checkMinimumVersion(app.getVersion());
      return { success: true, ...result };
    } catch (error) {
      // Fail-open: never block the app on transient errors (network/API).
      return {
        success: true,
        blocked: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcHandle("update:restart", async (_event, installerPath?: string) => {
    if (process.platform === "win32" && installerPath) {
      try {
        await verifyAndLaunch(installerPath, app.getPath("exe"));
        app.exit(0);
        // Unreachable in production — app.exit() terminates the process
        // synchronously before the IPC response is sent.
        return { success: true };
      } catch (error) {
        // Signature verification or path validation failed. Return error to
        // the renderer; do NOT exit.
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    app.relaunch();
    app.exit(0);
    return { success: true };
  });
}
