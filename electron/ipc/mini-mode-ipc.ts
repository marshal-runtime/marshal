import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";

import type { PermissionAction } from "../../common/marshal-constants";
import { createLogger } from "../../common/marshal-logger";
import { isDevMode } from "../app-paths";
import type { MiniModeManager } from "../mini-mode";
import { openExternalSafe } from "../open-external";
import type { PermissionCardManager } from "../permission-card-manager";
import type { NotificationRouter } from "../platform/notification-router";
import type { MiniModeStatus } from "../platform/windowing/mini-mode/contracts";
import { sharedIpcHandle } from "../remote-access/shared-handlers";
import type { TrayManager } from "../tray";
import type { IpcDeps } from "./types";

const log = createLogger("MiniModeIpc");

interface MiniModeIpcDeps {
  getWindow: () => BrowserWindow | null;
  ipcHandle: IpcDeps["ipcHandle"];
  miniModeManager: MiniModeManager;
  trayManager: TrayManager;
  notificationRouter?: NotificationRouter;
  permissionCardManager?: PermissionCardManager;
}

function resolveMiniModeStatus(status: string): MiniModeStatus {
  if (
    status === "thinking" ||
    status === "monocle" ||
    status === "party" ||
    status === "crying" ||
    status === "heartbeat" ||
    status === "broken-heart"
  ) {
    return status;
  }

  return "sleeping";
}

export function registerMiniModeHandlers({
  getWindow,
  ipcHandle,
  miniModeManager,
  trayManager,
  notificationRouter,
  permissionCardManager,
}: MiniModeIpcDeps): void {
  // Low-latency one-way handler for mouse-forwarding click-through toggle.
  // Uses send/on (not invoke/handle) since no response is needed.
  // Wrapped in try/catch to prevent unhandled exceptions from crashing the main process.
  ipcMain.on("mini-mode:setInteractive", (_event, interactive: boolean) => {
    try {
      miniModeManager.setInteractive(interactive);
    } catch (err) {
      log.error("[mini-mode] setInteractive failed:", err instanceof Error ? err.message : err);
    }
  });

  ipcHandle("mini-mode:getState", () => {
    return { success: true, ...miniModeManager.getSnapshot() };
  });

  ipcHandle("mini-mode:getAsset", (_event, status: string) => {
    const resolvedStatus = resolveMiniModeStatus(status);
    return { success: true, asset: miniModeManager.getAsset(resolvedStatus) };
  });

  ipcHandle("mini-mode:showMainWindow", (_event, sessionId?: string) => {
    trayManager.showWindow();
    if (sessionId && typeof sessionId === "string") {
      const mainWin = getWindow();
      if (mainWin && !mainWin.isDestroyed()) {
        if (!mainWin.isVisible()) {
          mainWin.once("show", () => mainWin.webContents.send("sessions:switch-to", sessionId));
        } else {
          mainWin.webContents.send("sessions:switch-to", sessionId);
        }
      }
    }
    return { success: true };
  });

  sharedIpcHandle(ipcHandle)(
    "copilot:resolvePermission",
    (requestId: string, action: PermissionAction, overridePattern?: string) => {
      if (typeof requestId !== "string" || typeof action !== "string") {
        return { success: false, error: "Invalid parameters" };
      }
      // Renderer may pass an overridePattern when the user clicks the
      // secondary "Allow broader pattern" action. Reject non-string shapes
      // defensively — main-process re-validation happens inside resolve().
      const safeOverride =
        typeof overridePattern === "string" && overridePattern.length > 0
          ? overridePattern
          : undefined;
      getWindow()?.flashFrame(false);
      if (!permissionCardManager) {
        log.error("permissionCardManager not available");
        return { success: false, error: "Permission manager not initialized" };
      }
      return permissionCardManager.resolve(requestId, action, safeOverride);
    },
  );

  ipcHandle("mini-mode:dismissApproval", (_event, requestId: string) => {
    if (typeof requestId !== "string") return { success: false, error: "Invalid requestId" };
    // Deny the permission so the LLM isn't blocked forever, then hide from mini-mode
    if (!permissionCardManager) {
      log.error("permissionCardManager not available");
      return { success: false, error: "Permission manager not initialized" };
    }
    permissionCardManager.resolve(requestId, "deny");
    miniModeManager.dismissApprovalFromMiniMode(requestId);
    return { success: true };
  });

  ipcHandle("mini-mode:dismissNotification", () => {
    miniModeManager.hideNotification();
    return { success: true };
  });

  ipcHandle("mini-mode:openUrl", (_event, url: string) => {
    if (url && typeof url === "string") {
      openExternalSafe(url);
    }
    return { success: true };
  });

  // Test notification trigger — registered via ipcHandle so E2E stubs work,
  // but the real handler only executes in dev mode.
  ipcHandle("dev:testMiniModeNotification", (_event, type: string, delayMs: number) => {
    if (!isDevMode()) return { success: false, error: "Only available in dev mode" };
    setTimeout(() => {
      if (type === "heartbeat-urgent") {
        if (notificationRouter) {
          notificationRouter.notify({
            title: "Heartbeat: GitHub PR #42",
            body: "Merge conflict detected in feature branch",
            url: "https://github.com/example/pr/42",
            miniModeType: "heartbeat-urgent",
            miniModeStatusOverride: "heartbeat",
          });
        }
      } else if (type === "heartbeat-error") {
        if (notificationRouter) {
          notificationRouter.notify({
            title: "Heartbeat Error",
            body: "Heartbeat failed — tool calls were blocked. Enable auto-approve in Heartbeat settings.",
            miniModeType: "heartbeat-error",
            miniModeStatusOverride: "broken-heart",
          });
        }
      } else if (type === "automation-complete") {
        if (notificationRouter) {
          notificationRouter.notify({
            title: "Daily Report",
            body: "5 PRs reviewed, 2 issues created, 1 deployment triggered",
            miniModeType: "automation-complete",
            miniModeStatusOverride: "party",
          });
        }
      } else if (type === "heartbeat-ok") {
        miniModeManager.setHeartbeatRunning(true);
        setTimeout(() => miniModeManager.setHeartbeatRunning(false, true), 500);
      } else if (type === "automation-failed") {
        if (notificationRouter) {
          notificationRouter.notify({
            title: "Daily Report",
            body: "Step 3 failed: connection timeout after 30s",
            miniModeType: "automation-failed",
            miniModeStatusOverride: "crying",
          });
        }
      } else if (type === "approval") {
        miniModeManager.showPermission({
          id: `test-perm-${Date.now()}`,
          kind: "shell",
          title: "Run terminal command",
          message: "Marshal wants to execute a deployment script",
          detail: "npm run deploy --prod --region=us-east-1",
          buttons: ["Allow", "Allow for session", "Always allow", "Deny"],
        });
      }
    }, delayMs);
    return { success: true };
  });
}
