import type {
  ConditionStatusRecord,
  HeartbeatSettings,
  HeartbeatStatus,
} from "../../common/marshal-ipc-contract";
import type { HeartbeatManager } from "../heartbeat";
import type { IpcDeps } from "./types";

/** Same narrowing as heartbeat-ipc: only `getLogs` is consumed here, and only
 *  in copilot mode (marshal exposes no log RPC). */
type IHeartbeatLogProvider = Pick<HeartbeatManager, "getLogs">;

export function registerActivitiesHandlers({
  heartbeatManager,
  sessionManager,
  automationManager,
  ipcHandle,
}: Pick<IpcDeps, "sessionManager" | "automationManager" | "ipcHandle"> & {
  heartbeatManager?: IHeartbeatLogProvider;
}) {
  const backend = () => sessionManager.getBackendProvider();

  ipcHandle("activities:getAll", async (_event, logLines: number = 100) => {
    try {
      // Phase 3a-1: route status / settings through `backend.automation` so
      // gateway mode reports its real state (or `{ supported: false }`)
      // instead of falling back to the in-process `HeartbeatManager` which
      // is copilot-only. Logs stay on the local manager — marshal exposes
      // no log RPC, so the gateway path returns no logs.
      const [statusEnvelope, settingsEnvelope] = await Promise.all([
        backend().automation.getHeartbeatStatus(),
        backend().automation.getHeartbeatConfig(),
      ]);
      const heartbeatStatus: HeartbeatStatus | undefined = statusEnvelope.supported
        ? {
            enabled: statusEnvelope.enabled,
            lastRun: statusEnvelope.lastRun,
            nextRun: statusEnvelope.nextRun,
            running: statusEnvelope.running,
          }
        : undefined;
      const heartbeatSettings: HeartbeatSettings | undefined = settingsEnvelope.supported
        ? {
            // `enabled` is not on the envelope (see ipc-contract: it's
            // persistence-only, gateway has no truth for it). The
            // ActivitiesPanel reads the live state from `heartbeatStatus`
            // anyway — we surface the same value here for legacy callers.
            enabled: heartbeatStatus?.enabled ?? false,
            intervalMinutes: settingsEnvelope.intervalMinutes,
            schedule: settingsEnvelope.schedule,
            prompt: settingsEnvelope.prompt,
            ...(settingsEnvelope.permissions !== undefined
              ? { permissions: settingsEnvelope.permissions }
              : {}),
            ...(settingsEnvelope.workDays !== undefined
              ? { workDays: settingsEnvelope.workDays }
              : {}),
            ...(settingsEnvelope.workStartHour !== undefined
              ? { workStartHour: settingsEnvelope.workStartHour }
              : {}),
            ...(settingsEnvelope.workEndHour !== undefined
              ? { workEndHour: settingsEnvelope.workEndHour }
              : {}),
          }
        : undefined;
      const heartbeatLogs = heartbeatManager?.getLogs(logLines) ?? [];

      const automations = automationManager.list();
      const runs = automationManager.getAllHistory();

      const conditionAutomations = automations.filter(
        (wf) => wf.triggerType === "condition" && wf.enabled,
      );

      const conditionStatuses: Record<string, ConditionStatusRecord> = {};
      for (const wf of conditionAutomations) {
        conditionStatuses[wf.id] = automationManager.getConditionStatus(wf.id);
      }

      return {
        success: true,
        heartbeatStatus,
        heartbeatSettings,
        heartbeatLogs,
        automations,
        allAutomationRuns: runs,
        conditionStatuses,
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}
