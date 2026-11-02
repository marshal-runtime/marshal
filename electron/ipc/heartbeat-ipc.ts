import type { HeartbeatSettings } from "../../common/marshal-ipc-contract";
import type { HeartbeatManager } from "../heartbeat";
import type { TenantPolicyProvider } from "../tenant-policy";
import type { IpcDeps } from "./types";

/**
 * After the Phase 3a-1 IPC rewire, the only manager surface still consumed
 * here is `getLogs` — marshal exposes no log RPC, so the gateway path runs
 * without one. Narrowing the dep to a log-provider port makes the no-log
 * branch obvious and easier to stub.
 */
type IHeartbeatLogProvider = Pick<HeartbeatManager, "getLogs">;

export function registerHeartbeatHandlers({
  heartbeatManager,
  sessionManager,
  ipcHandle,
  tenantPolicyProvider,
}: Pick<IpcDeps, "sessionManager" | "ipcHandle"> & {
  heartbeatManager?: IHeartbeatLogProvider;
  // Optional: open-by-default so dev/test works without tenant wiring.
  // If omitted in production (wiring bug), enforcement is silently skipped.
  tenantPolicyProvider?: Pick<TenantPolicyProvider, "get">;
}) {
  const backend = () => sessionManager.getBackendProvider();

  ipcHandle("heartbeat:status", async () => {
    try {
      const envelope = await backend().automation.getHeartbeatStatus();
      // Envelope already matches the IPC contract shape
      return { success: true, status: envelope };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("heartbeat:toggle", async (_event, enable: boolean) => {
    try {
      if (enable && tenantPolicyProvider?.get()?.disableHeartbeat) {
        return { success: false, error: "Heartbeat is disabled by your organization's policy" };
      }
      const result = await backend().automation.updateHeartbeatConfig({ enabled: enable });
      if (!result.ok) {
        return { success: false, error: result.message || "Failed to toggle heartbeat" };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("heartbeat:getSettings", async () => {
    try {
      const envelope = await backend().automation.getHeartbeatConfig();
      // Envelope already matches the IPC contract shape
      return { success: true, settings: envelope };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("heartbeat:saveSettings", async (_event, updates: Partial<HeartbeatSettings>) => {
    try {
      const result = await backend().automation.updateHeartbeatConfig(updates);
      if (!result.ok) {
        return { success: false, error: result.message || "Failed to save settings" };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("heartbeat:getLogs", async (_event, lines: number = 100) => {
    try {
      if (!heartbeatManager) {
        return { success: false, error: "Heartbeat logging not available" };
      }
      const logs = heartbeatManager.getLogs(lines);
      return { success: true, logs };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcHandle("heartbeat:runNow", async () => {
    try {
      if (tenantPolicyProvider?.get()?.disableHeartbeat) {
        return { success: false, error: "Heartbeat is disabled by your organization's policy" };
      }
      const result = await backend().automation.triggerHeartbeatNow();
      if (!result.ok) {
        return { success: false, error: result.message || "Failed to trigger heartbeat" };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}
