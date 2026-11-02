import { DEFAULT_PERMISSIONS } from "../../common/marshal-default-settings";
import type { PermissionsConfig } from "../../common/marshal-ipc-contract";
import { createLogger } from "../../common/marshal-logger";
import type { WorkServiceProviderSettings } from "../../common/provider-config";
import type { PermissionCardManager } from "../permission-card-manager";
import { sharedIpcHandle } from "../remote-access/shared-handlers";
import {
  buildStaticCategories,
  buildMcpCategory,
  type WorkServiceToolAvailability,
} from "../tool-discovery";
import type { IpcDeps } from "./types";

const log = createLogger("PermissionsIpc");

export function registerPermissionsHandlers({
  ipcHandle,
  sessionManager,
  permissionCardManager,
  mcpStore,
  auditLogger,
  settingsManager,
  workServiceProviderSelection,
  getWorkServiceToolAvailability,
}: Pick<IpcDeps, "ipcHandle" | "sessionManager" | "mcpStore" | "auditLogger"> & {
  permissionCardManager: PermissionCardManager;
  settingsManager: IpcDeps["settingsManager"];
  workServiceProviderSelection: WorkServiceProviderSettings;
  getWorkServiceToolAvailability?: () => WorkServiceToolAvailability | undefined;
}) {
  const backend = () => sessionManager.getBackendProvider();
  sharedIpcHandle(ipcHandle)("permissions:get-cards", (sessionId: string) => {
    permissionCardManager.loadFromDisk(sessionId);
    return { success: true, cards: permissionCardManager.getCards(sessionId) };
  });

  sharedIpcHandle(ipcHandle)("permissions:clear-cards", (sessionId: string) => {
    permissionCardManager.clearSession(sessionId);
    return { success: true };
  });

  ipcHandle("permissions:list-tools", () => {
    try {
      const statics = buildStaticCategories(
        workServiceProviderSelection,
        getWorkServiceToolAvailability?.(),
      );
      const storeData = mcpStore.getAll();
      const serverConfigs: Record<string, unknown> = {};
      const mcpToolLists: Record<string, Array<{ name: string; description?: string }>> = {};
      for (const [key, entry] of Object.entries(storeData.servers)) {
        serverConfigs[key] = entry.config ?? {};
        if (entry.tools?.length) {
          mcpToolLists[key] = entry.tools;
        }
      }
      const mcp = buildMcpCategory(serverConfigs, mcpToolLists, {
        discoveryErrors: mcpStore.getDiscoveryErrors(),
        discoveryInProgress: mcpStore.isDiscoveryInProgress(),
      });
      return { success: true, categories: [mcp, ...statics] };
    } catch (error) {
      log.error("Failed to list tools:", error);
      return { success: false, categories: [] };
    }
  });

  sharedIpcHandle(ipcHandle)("permissions:get-config", async () => {
    try {
      const envelope = await backend().permissions.getPermissions();
      return {
        success: true as const,
        envelope: {
          ...envelope,
          permissions: {
            ...envelope.permissions,
            autopilotMode: settingsManager.get().permissions?.autopilotMode ?? false,
          },
        },
      };
    } catch (err) {
      log.error("permissions:get-config failed:", err);
      return { success: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcHandle("permissions:save-config", async (_event, patch: Partial<PermissionsConfig>) => {
    try {
      const { autopilotMode, ...backendPatch } = patch;
      if (patch.allowModelPermissionsChange === true) {
        auditLogger.log({
          sessionId: "",
          kind: "settings",
          toolName: "allowModelPermissionsChange",
          serverName: "",
          commandText: "",
          decision: "approved",
          source: "user-interactive",
          sdkResult: "allow",
        });
      }
      if (typeof autopilotMode === "boolean") {
        const current = settingsManager.get();
        settingsManager.update({
          permissions: {
            ...(current.permissions ?? DEFAULT_PERMISSIONS),
            autopilotMode,
          },
        });
        if (autopilotMode) {
          permissionCardManager.resolvePolicyApprovedPending();
        }
      }
      if (Object.keys(backendPatch).length === 0) {
        return { success: true as const };
      }
      const result = await backend().permissions.updatePermissions(backendPatch);
      if (result.ok) {
        return result.rejectedShellPatterns
          ? { success: true as const, rejectedShellPatterns: result.rejectedShellPatterns }
          : { success: true as const };
      }
      if (result.reason === "cas-conflict") {
        return {
          success: false as const,
          error: "permissions-changed-externally",
          conflict: result.latest,
        };
      }
      if (result.reason === "validation-error") {
        return { success: false as const, error: result.message };
      }
      return { success: false as const, error: result.reason };
    } catch (err) {
      log.error("permissions:save-config failed:", err);
      return { success: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
