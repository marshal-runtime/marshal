// electron/ipc/workflows-ipc.ts
//
// Renderer-facing IPC handlers for the Dynamic Workflows V1 panel.
// Mirrors `workflowsAPI` in `electron/preload.cjs` and the
// `workflows:*` invoke contract in `common/marshal-ipc-contract.ts`.
//
// All handlers return the `{ success, ...payload, error? }` envelope
// the renderer expects. Errors are caught locally so they never bubble
// up to electron and crash the renderer query.

import { dialog } from "electron";

import { createLogger } from "../../common/marshal-logger";
import type { WorkflowSummary } from "../../common/workflows-contract";
import type { PermissionCardManager } from "../permission-card-manager";
import type { WorkflowRunManager } from "../workflows/workflow-run-manager";
import type { IpcDeps } from "./types";

const log = createLogger("WorkflowsIpc");

export interface WorkflowsIpcDeps {
  ipcHandle: IpcDeps["ipcHandle"];
  getWindow: IpcDeps["getWindow"];
  workflowManager: WorkflowRunManager;
  permissionCardManager?: PermissionCardManager;
}

export function registerWorkflowsHandlers({
  ipcHandle,
  getWindow,
  workflowManager,
  permissionCardManager,
}: WorkflowsIpcDeps): void {
  // Fan persisted engine events out to the renderer.
  workflowManager.attachBroadcaster((channel, payload) => {
    const win = getWindow();
    win?.webContents.send(channel, payload);
  });

  ipcHandle("workflows:list", async (_event, repoPath, workspaceName) => {
    try {
      const installed = await workflowManager.listWorkflows({
        repoPath: repoPath ?? undefined,
        workspaceName,
      });
      const workflows: WorkflowSummary[] = installed.map((wf) => ({
        key: wf.key,
        id: wf.id,
        displayName: wf.displayName,
        description: wf.description,
        source: wf.source,
        version: wf.version,
        schemaVersion: wf.schemaVersion,
        installedAt: wf.installedAt,
        hasRenderer: workflowManager.hasRenderer(wf.id, wf.repoPath),
        repoPath: wf.repoPath ?? null,
        workspaceName: wf.workspaceName,
        projectName: wf.projectName,
        defaultSchedule: wf.defaultSchedule,
        schedule: wf.schedule,
        inputSchema: wf.inputSchema,
        extensions: wf.extensions,
        lastRun: wf.lastRun,
      }));
      return { success: true, workflows };
    } catch (err) {
      log.warn("workflows:list failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:listRuns", async (_event, workflowId, repoPath) => {
    try {
      const all = workflowManager.listRuns();
      const filtered = all.filter((r) => {
        if (workflowId && r.workflowId !== workflowId) return false;
        if (repoPath && r.workflowRepoPath !== repoPath) return false;
        return true;
      });
      const runs = filtered.map((r) => ({
        runId: r.runId,
        runFamilyId: r.runFamilyId,
        workflowId: r.workflowId,
        repoPath: r.workflowRepoPath ?? null,
        workspaceName: r.workflowWorkspaceName,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.endedAt ?? null,
        ...(r.parentRunId !== undefined ? { parentRunId: r.parentRunId } : {}),
        ...(r.initiatorSessionId !== undefined ? { initiatorSessionId: r.initiatorSessionId } : {}),
      }));
      return { success: true, runs };
    } catch (err) {
      log.warn("workflows:listRuns failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:getRunForHostSession", async (_event, hostSessionId) => {
    try {
      const runId = workflowManager.getRunIdForHostSession(hostSessionId);
      if (!runId) {
        return {
          success: false,
          error: `Workflow run for host session ${hostSessionId} not found`,
        };
      }
      return { success: true, runId };
    } catch (err) {
      log.warn("workflows:getRunForHostSession failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:getRun", async (_event, runId) => {
    try {
      const snapshot = await workflowManager.getRun({ runId });
      if (!snapshot) {
        return { success: false, error: `Run ${runId} not found` };
      }
      return { success: true, snapshot };
    } catch (err) {
      log.warn("workflows:getRun failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:getEvents", async (_event, runId, fromSeq) => {
    try {
      const events = workflowManager.getEvents({
        runId,
        ...(fromSeq !== undefined ? { fromSeq } : {}),
      });
      return { success: true, events };
    } catch (err) {
      log.warn("workflows:getEvents failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:run", async (_event, workflowId, input, repoPath) => {
    try {
      const result = await workflowManager.runWorkflow({ workflowId, input, repoPath });
      return { success: true, runId: result.runId, runFamilyId: result.runFamilyId };
    } catch (err) {
      log.warn(`workflows:run(${workflowId}) failed:`, err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:cancel", async (_event, runId, reason) => {
    try {
      const result = await workflowManager.cancelRun({
        runId,
        ...(reason !== undefined ? { reason } : {}),
      });
      if (!result.ok) {
        return { success: false, error: result.error ?? "cancel failed" };
      }
      return { success: true };
    } catch (err) {
      log.warn("workflows:cancel failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:retryFromStep", async (_event, runId, stepId) => {
    try {
      const result = await workflowManager.retryFromStep({ runId, stepId });
      return { success: true, newRunId: result.newRunId, runFamilyId: result.runFamilyId };
    } catch (err) {
      log.warn("workflows:retryFromStep failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:installLocal", async (_event, sourceDir, overwrite) => {
    try {
      const result = await workflowManager.installLocal({
        sourceDir,
        ...(overwrite !== undefined ? { overwrite } : {}),
      });
      return {
        success: true,
        workflowId: result.workflowId,
        warnings: result.warnings.length > 0 ? [...result.warnings] : undefined,
      };
    } catch (err) {
      log.warn("workflows:installLocal failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:pickInstallDir", async () => {
    try {
      const win = getWindow();
      const result = win
        ? await dialog.showOpenDialog(win, {
            properties: ["openDirectory"],
            title: "Pick a standalone workflow folder",
            buttonLabel: "Install to library",
          })
        : await dialog.showOpenDialog({
            properties: ["openDirectory"],
            title: "Pick a standalone workflow folder",
            buttonLabel: "Install to library",
          });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: true, cancelled: true };
      }
      return { success: true, sourceDir: result.filePaths[0] };
    } catch (err) {
      log.warn("workflows:pickInstallDir failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:updateSchedule", async (_event, workflowId, schedule, input, repoPath) => {
    try {
      const updated = workflowManager.updateScheduleForWorkflow({
        workflowId,
        schedule,
        input,
        repoPath: repoPath ?? undefined,
      });
      return { success: true, schedule: updated };
    } catch (err) {
      log.warn("workflows:updateSchedule failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:disableSchedule", async (_event, workflowId, repoPath) => {
    try {
      const schedule = workflowManager.disableScheduleForWorkflow({
        workflowId,
        repoPath: repoPath ?? undefined,
      });
      return { success: true, schedule };
    } catch (err) {
      log.warn("workflows:disableSchedule failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:getRenderer", async (_event, workflowId, repoPath) => {
    try {
      const renderer = await workflowManager.getRendererBundle({
        workflowId,
        repoPath: repoPath ?? undefined,
      });
      return { success: true, renderer };
    } catch (err) {
      log.warn("workflows:getRenderer failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:getCommandCenter", async (_event, workflowId, repoPath) => {
    try {
      const commandCenter = await workflowManager.getCommandCenterBundle({
        workflowId,
        repoPath: repoPath ?? undefined,
      });
      return { success: true, commandCenter };
    } catch (err) {
      log.warn("workflows:getCommandCenter failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:readArtifact", async (_event, runId, storageKey) => {
    try {
      const artifact = workflowManager.readArtifact({ runId, storageKey });
      if (!artifact) return { success: false, error: "Artifact not found" };
      return { success: true, ...artifact };
    } catch (err) {
      log.warn("workflows:readArtifact failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:listArtifacts", async (_event, workflowId, repoPath, prefix, limit) => {
    try {
      const artifacts = workflowManager.listArtifacts({
        workflowId,
        repoPath: repoPath ?? undefined,
        prefix,
        limit,
      });
      return { success: true, artifacts };
    } catch (err) {
      log.warn("workflows:listArtifacts failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:readArtifactByKey", async (_event, runId, key) => {
    try {
      const artifact = workflowManager.readArtifactByKey({ runId, key });
      if (!artifact) return { success: false, error: "Artifact not found" };
      return { success: true, ...artifact };
    } catch (err) {
      log.warn("workflows:readArtifactByKey failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:listState", async (_event, workflowId, repoPath, prefix) => {
    try {
      const entries = workflowManager.listState({
        workflowId,
        repoPath: repoPath ?? undefined,
        prefix,
      });
      return { success: true, entries };
    } catch (err) {
      log.warn("workflows:listState failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:getStateValue", async (_event, workflowId, key) => {
    try {
      const state = workflowManager.getWorkflowStateValue({ workflowId, key });
      return { success: true, state };
    } catch (err) {
      log.warn("workflows:getStateValue failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:readState", async (_event, workflowId, key, repoPath) => {
    try {
      const entry = workflowManager.readState({
        workflowId,
        key,
        repoPath: repoPath ?? undefined,
      });
      return { success: true, entry };
    } catch (err) {
      log.warn("workflows:readState failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:listStateKeys", async (_event, workflowId, prefix) => {
    try {
      const keys = [...workflowManager.listWorkflowStateKeys({ workflowId, prefix })];
      return { success: true, keys };
    } catch (err) {
      log.warn("workflows:listStateKeys failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:putConfigValue", async (_event, workflowId, key, value, repoPath) => {
    try {
      await workflowManager.putWorkflowConfigValue({
        workflowId,
        key,
        value,
        repoPath: repoPath ?? undefined,
      });
      return { success: true };
    } catch (err) {
      log.warn("workflows:putConfigValue failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:dispatchAction", async (_event, request) => {
    try {
      const result = await workflowManager.dispatchWorkflowAction(request);
      return { success: true, result };
    } catch (err) {
      log.warn("workflows:dispatchAction failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle(
    "workflows:getActionItem",
    async (_event, workflowId, itemId, repoPath, workspaceName) => {
      try {
        const item = await workflowManager.getWorkflowActionItem({
          workflowId,
          itemId,
          repoPath: repoPath ?? undefined,
          workspaceName,
        });
        return { success: true, item };
      } catch (err) {
        log.warn("workflows:getActionItem failed:", err);
        return { success: false, error: errMessage(err) };
      }
    },
  );

  ipcHandle("workflows:approveNotification", async (_event, request) => {
    try {
      const result = await workflowManager.approveWorkflowNotification(request);
      return { success: true, result };
    } catch (err) {
      log.warn("workflows:approveNotification failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle(
    "workflows:compactState",
    async (_event, workflowId, repoPath, prefix, olderThanMs, limit) => {
      try {
        const result = await workflowManager.compactState({
          workflowId,
          repoPath: repoPath ?? undefined,
          prefix,
          olderThanMs,
          limit,
        });
        return { success: true, result };
      } catch (err) {
        log.warn("workflows:compactState failed:", err);
        return { success: false, error: errMessage(err) };
      }
    },
  );

  ipcHandle("workflows:clearState", async (_event, request) => {
    try {
      const result = await workflowManager.clearWorkflowState(request);
      return { success: true, result };
    } catch (err) {
      log.warn("workflows:clearState failed:", err);
      return { success: false, error: errMessage(err) };
    }
  });

  ipcHandle("workflows:permissionResponse", async (_event, _response) => {
    if (!permissionCardManager) return { success: true };
    const result = permissionCardManager.resolve(
      _response.cardId,
      _response.allow ? "allow" : "deny",
      _response.overridePattern,
    );
    return result.success ? { success: true } : { success: false, error: "Permission not pending" };
  });
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
