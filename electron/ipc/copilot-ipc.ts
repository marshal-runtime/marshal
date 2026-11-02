import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { app, shell } from "electron";

import { createLogger } from "../../common/marshal-logger";
import { setSessionClientViewport, viewportForSenderId } from "../client-viewport";
import { sharedIpcHandle, sharedIpcHandleWithSender } from "../remote-access/shared-handlers";
import { checkStringSize, IPC_LIMITS } from "./ipc-limits";
import type { IpcDeps } from "./types";

const log = createLogger("CopilotIpc");

const execFileAsync = promisify(execFile);

const HEIC_MIMES = new Set(["image/heic", "image/heif"]);

/**
 * Convert a HEIC/HEIF file to JPEG using macOS `sips`. Returns the path to
 * the converted JPEG. The original HEIC file is deleted on success.
 * Throws on non-darwin platforms or if `sips` fails.
 */
async function convertHeicToJpeg(heicPath: string): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("HEIC conversion is only supported on macOS");
  }
  const jpegPath = heicPath.replace(/\.(heic|heif)$/i, "") + ".jpg";
  await execFileAsync("sips", ["-s", "format", "jpeg", heicPath, "--out", jpegPath]);
  await fs.promises.unlink(heicPath).catch(() => {
    // Best-effort cleanup; not fatal if it fails.
  });
  return jpegPath;
}

export function registerCopilotHandlers({
  sessionManager,
  powerManager,
  ipcHandle,
  identityController,
  onSessionSendStart,
  onSessionSendFailed,
}: Pick<IpcDeps, "sessionManager" | "powerManager" | "ipcHandle" | "identityController"> & {
  onSessionSendStart?: (sessionId: string) => void;
  onSessionSendFailed?: (sessionId: string) => void;
}) {
  // Legacy copilot handlers - now route through session manager
  sharedIpcHandle(ipcHandle)("copilot:init", async () => {
    try {
      // Just initialize the client, sessions are managed by sessions:* handlers
      await sessionManager.initClient();
      return { success: true };
    } catch (error) {
      log.error("Failed to init Copilot:", error);
      return { success: false, error: String(error) };
    }
  });

  // Sender-aware: the dispatching surface (renderer vs remote socket) marks
  // the session's client viewport so per-turn prompt context can tell the
  // agent it serves a phone (see client-viewport.ts / system-message.ts).
  sharedIpcHandleWithSender(ipcHandle)(
    "copilot:send",
    async (
      // Test harnesses invoke handlers without an event; only real dispatches
      // (renderer IPC or remote socket) mark the session's client viewport.
      event: Electron.IpcMainInvokeEvent | undefined,
      message: string,
      sessionId?: string,
      attachments?: Array<{ type: string; path: string; displayName?: string }>,
      clientMessageId?: string,
    ) => {
      let targetId: string | null = null;
      try {
        const sizeCheck = checkStringSize(message, IPC_LIMITS.TEXT_MESSAGE_BYTES, "Message");
        if (sizeCheck) return sizeCheck;
        targetId = sessionId || sessionManager.getCurrentSessionId();
        if (!targetId) {
          return { success: false, error: "No active session" };
        }
        sessionManager.resumeAfterUserStop(targetId);
        if (event) setSessionClientViewport(targetId, viewportForSenderId(event.sender.id));
        powerManager.markBusy(targetId);
        onSessionSendStart?.(targetId);
        // A valid shell/browser tool can be silent for many minutes. Do not turn
        // transport inactivity into cancellation; the user-facing Stop action and
        // backend cancellation paths remain the authority for ending a turn.
        await sessionManager.sendMessage(targetId, message, attachments, { clientMessageId });
        return { success: true };
      } catch (error) {
        if (targetId) {
          powerManager.markIdle(targetId);
          onSessionSendFailed?.(targetId);
        }
        log.error("Failed to send message:", error);
        return { success: false, error: String(error) };
      }
    },
  );

  sharedIpcHandleWithSender(ipcHandle)(
    "copilot:steer",
    async (
      event: Electron.IpcMainInvokeEvent | undefined,
      message: string,
      sessionId?: string,
      attachments?: Array<{ type: string; path: string; displayName?: string }>,
      clientMessageId?: string,
    ) => {
      let targetId: string | null = null;
      try {
        const sizeCheck = checkStringSize(message, IPC_LIMITS.TEXT_MESSAGE_BYTES, "Message");
        if (sizeCheck) return sizeCheck;
        targetId = sessionId || sessionManager.getCurrentSessionId();
        if (!targetId) {
          return { success: false, error: "No active session" };
        }
        sessionManager.resumeAfterUserStop(targetId);
        if (event) setSessionClientViewport(targetId, viewportForSenderId(event.sender.id));
        powerManager.markBusy(targetId);
        onSessionSendStart?.(targetId);
        await sessionManager.steerMessage(targetId, message, attachments, { clientMessageId });
        return { success: true };
      } catch (error) {
        if (targetId) {
          powerManager.markIdle(targetId);
          onSessionSendFailed?.(targetId);
        }
        log.error("Failed to steer message:", error);
        return { success: false, error: String(error) };
      }
    },
  );

  sharedIpcHandle(ipcHandle)("copilot:abort", async (sessionId?: string) => {
    const targetId = sessionId || sessionManager.getCurrentSessionId();
    try {
      if (!targetId) {
        return { success: false, error: "No active session" };
      }
      await sessionManager.stopSession(targetId);
      return { success: true };
    } catch (error) {
      log.error("Failed to abort:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (targetId) powerManager.markIdle(targetId);
    }
  });

  ipcHandle("copilot:destroy", async () => {
    // No-op for now, sessions are managed by session manager
    return { success: true };
  });

  // Save image data to temp file and return path
  sharedIpcHandle(ipcHandle)("copilot:saveImage", async (base64Data: string, mimeType: string) => {
    try {
      if (!IPC_LIMITS.ALLOWED_IMAGE_MIMES.has(mimeType)) {
        return { success: false, error: `Unsupported image type: ${mimeType.slice(0, 64)}` };
      }
      // HEIC/HEIF rely on macOS `sips` for conversion. Reject early on other
      // platforms instead of writing a file that we can't process.
      if (HEIC_MIMES.has(mimeType) && process.platform !== "darwin") {
        return {
          success: false,
          error:
            "HEIC/HEIF images are only supported on macOS. Please convert to JPEG or PNG first.",
        };
      }
      const sizeCheck = checkStringSize(base64Data, IPC_LIMITS.IMAGE_BASE64_BYTES, "Image data");
      if (sizeCheck) return sizeCheck;

      const tempDir = path.join(app.getPath("temp"), "copilot-images");
      await fs.promises.mkdir(tempDir, { recursive: true });

      const ext = mimeType.split("/")[1] || "png";
      const filename = `image-${Date.now()}.${ext}`;
      const filePath = path.join(tempDir, filename);

      const buffer = Buffer.from(base64Data, "base64");
      await fs.promises.writeFile(filePath, buffer);

      if (HEIC_MIMES.has(mimeType)) {
        try {
          const jpegPath = await convertHeicToJpeg(filePath);
          return { success: true, path: jpegPath };
        } catch (error) {
          log.error("HEIC conversion failed:", error);
          const jpegPath = filePath.replace(/\.(heic|heif)$/i, "") + ".jpg";
          await fs.promises.unlink(filePath).catch(() => {});
          await fs.promises.unlink(jpegPath).catch(() => {});
          return {
            success: false,
            error: `HEIC conversion failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      return { success: true, path: filePath };
    } catch (error) {
      log.error("Failed to save image:", error);
      return { success: false, error: String(error) };
    }
  });

  // App version
  sharedIpcHandle(ipcHandle)("copilot:getVersion", () => {
    return { success: true, version: app.getVersion() };
  });

  // System info for feedback emails
  ipcHandle("copilot:getSystemInfo", () => {
    return {
      success: true,
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      osVersion: process.getSystemVersion?.() ?? os.release(),
    };
  });

  // AuthScreen polls this during device flow; AuthGate uses identityAPI instead.
  sharedIpcHandle(ipcHandle)("copilot:checkAuth", async () => {
    try {
      const status = await sessionManager.checkAuthStatus();
      void identityController?.refresh();
      return { success: true, ...status };
    } catch (error) {
      log.error("Failed to check auth:", error);
      return { success: false, isAuthenticated: false, error: String(error) };
    }
  });

  // Start device flow login - returns device code for display
  ipcHandle("copilot:startDeviceFlow", async () => {
    try {
      // First check if already authenticated
      await sessionManager.initClient();
      const status = await sessionManager.checkAuthStatus();
      if (status.isAuthenticated) {
        return { success: true, ...status };
      }

      // Not authenticated — run `copilot login` to trigger device flow
      log.info("Not authenticated, running copilot login...");
      await sessionManager.resetClient();
      const loginResult = await sessionManager.login();

      if (loginResult.deviceCode) {
        return {
          success: false,
          needsDeviceFlow: true,
          deviceCode: loginResult.deviceCode,
          verificationUri: loginResult.verificationUri || "https://github.com/login/device",
        };
      }

      // Login completed without device code (already authed?)
      await sessionManager.initClient();
      const newStatus = await sessionManager.checkAuthStatus();
      void identityController?.refresh();
      return { success: true, ...newStatus };
    } catch (error) {
      const errorStr = String(error);
      log.error("Device flow error:", errorStr);

      // Try to parse device code from error message
      // The CLI outputs something like: "Please visit https://github.com/login/device and enter code: XXXX-XXXX"
      const codeMatch = errorStr.match(/enter (?:code|the code)[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})/i);
      const uriMatch = errorStr.match(/(https:\/\/github\.com\/login\/device)/i);

      if (codeMatch) {
        return {
          success: false,
          needsDeviceFlow: true,
          deviceCode: codeMatch[1],
          verificationUri: uriMatch ? uriMatch[1] : "https://github.com/login/device",
          error: errorStr,
        };
      }

      return { success: false, error: errorStr };
    }
  });

  // Open browser to GitHub device flow page
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ipcHandle("copilot:openDeviceFlowPage", async (_event, _code?: string) => {
    try {
      // GitHub doesn't support pre-filling the code in URL, but we open the page
      await shell.openExternal("https://github.com/login/device");
      return { success: true };
    } catch (error) {
      log.error("Failed to open login:", error);
      return { success: false, error: String(error) };
    }
  });

  // Legacy login handler - redirects to device flow
  ipcHandle("copilot:login", async () => {
    try {
      await shell.openExternal("https://github.com/login/device");
      return { success: true };
    } catch (error) {
      log.error("Failed to open login:", error);
      return { success: false, error: String(error) };
    }
  });

  // Sign out — clear cached auth and force re-authentication
  ipcHandle("copilot:signOut", async () => {
    try {
      await sessionManager.signOut();
      void identityController?.refresh();
      return { success: true };
    } catch (error) {
      log.error("Failed to sign out:", error);
      return { success: false, error: String(error) };
    }
  });
}
