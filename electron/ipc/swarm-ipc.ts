import type { SwarmRunCreateInput } from "@marshal/swarm";

import {
  DEFAULT_SWARM_WORKER_MODEL,
  DEFAULT_SWARM_WORKER_REASONING_EFFORT,
} from "../../common/marshal-default-settings";
import type {
  IpcHandler,
  IpcInvokeMap,
  MSettings,
  ReasoningEffort,
} from "../../common/marshal-ipc-contract";
import { buildGoalConversationContext } from "../goal/goal-context";
import {
  MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
  type MarshalRuntimeScope,
} from "../marshal-runtime/contracts";
import { createSwarmRunId, type SwarmDriver } from "../marshal-runtime/swarm-driver";
import type { MarshalSwarmWorktreeLifecycle } from "../marshal-runtime/swarm-worktree-lifecycle";
import type { SessionManager } from "../sessions";

export const SWARM_CONVERSATION_CONTEXT_HEADING = "Prior conversation in this session:";

/** Prepend prior session turns to a run objective unless the caller asked for a fresh start. */
export function composeRunObjective(
  objective: string,
  conversationContext: string | undefined,
): string {
  const conversation = conversationContext?.trim();
  if (!conversation) return objective;
  return `${objective}\n\n${SWARM_CONVERSATION_CONTEXT_HEADING}\n${conversation}`;
}

export function registerSwarmHandlers(options: {
  readonly ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
  readonly driver: SwarmDriver;
  readonly sessions: SessionManager;
  readonly worktreeLifecycle: MarshalSwarmWorktreeLifecycle;
  readonly getSettings?: () => MSettings;
}): void {
  options.ipcHandle("swarm:create", async (_event, request) => {
    try {
      const objective = requiredText(request.objective, "Swarm objective");
      const ownerScope = await resolveOwnerScope(options, request.sessionId);
      const resources = validateResourceIds(
        request.resourceIds,
        ownerScope.workspaceName,
        options.sessions.listWorkspacesForSelfTools(),
      );
      const targets = await Promise.all(
        resources.map((resource) =>
          options.worktreeLifecycle.captureTarget(resource.name, resource.path),
        ),
      );
      const owner = targets[0];
      if (!owner) throw new TypeError("At least one swarm workspace resource ID is required.");
      const runId = createSwarmRunId(ownerScope.sessionId);
      await options.worktreeLifecycle.initializeIntegration(runId, targets);
      const conversationContext = request.fresh
        ? undefined
        : snapshotOwnerConversation(await options.sessions.getSessionAsync(ownerScope.sessionId));
      const input: SwarmRunCreateInput = {
        runId,
        objective: composeRunObjective(objective, conversationContext),
        scope: ownerScope.workspaceName,
        targetRef: owner.ref,
        targetHead: owner.head,
        ...(request.roleModels === undefined ? {} : { roleModels: request.roleModels }),
        ...(request.workerModel === undefined
          ? {}
          : { workerModel: resolveWorkerModel(request.workerModel, undefined) }),
        ...(request.workerReasoningEffort === undefined
          ? {}
          : {
              workerReasoningEffort: resolveWorkerReasoningEffort(
                request.workerReasoningEffort,
                undefined,
              ),
            }),
      };
      const configuration = {
        workerModel: resolveWorkerModel(
          request.workerModel,
          options.getSettings?.().swarmWorkerModel,
        ),
        workerReasoningEffort: resolveWorkerReasoningEffort(
          request.workerReasoningEffort,
          options.getSettings?.().swarmWorkerReasoningEffort,
        ),
      };
      options.worktreeLifecycle.stageRunCreation?.(runId, {
        targets,
        configuration,
      });
      const run = await options.driver.start(ownerScope, input);
      return { success: true, runId: run.runId, state: run.state };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  options.ipcHandle("swarm:get", async (_event, sessionId, runId) => {
    try {
      const run = await options.driver.read(
        await resolveOwnerScope(options, sessionId),
        requiredText(runId, "Swarm run"),
      );
      return { success: true, runId: run.runId, state: run.state };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  options.ipcHandle("swarm:pause", async (_event, sessionId, runId, reason) => {
    try {
      const run = await options.driver.pause(
        await resolveOwnerScope(options, sessionId),
        requiredText(runId, "Swarm run"),
        requiredText(reason ?? "Paused by user.", "Pause reason"),
      );
      return { success: true, runId: run.runId, state: run.state };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  options.ipcHandle("swarm:resume", async (_event, sessionId, runId) => {
    try {
      const run = await options.driver.resume(
        await resolveOwnerScope(options, sessionId),
        requiredText(runId, "Swarm run"),
      );
      return { success: true, runId: run.runId, state: run.state };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function resolveWorkerModel(override: string | undefined, setting: string | undefined): string {
  return normalizedModel(override) ?? normalizedModel(setting) ?? DEFAULT_SWARM_WORKER_MODEL;
}

function resolveWorkerReasoningEffort(
  override: ReasoningEffort | undefined,
  setting: ReasoningEffort | undefined,
): ReasoningEffort {
  return isReasoningEffort(override)
    ? override
    : isReasoningEffort(setting)
      ? setting
      : DEFAULT_SWARM_WORKER_REASONING_EFFORT;
}

function normalizedModel(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

function validateResourceIds(
  requested: readonly string[] | undefined,
  ownerWorkspaceName: string,
  registeredWorkspaces: readonly { readonly name: string; readonly path: string }[],
): readonly { readonly name: string; readonly path: string }[] {
  const resourceIds = requested ?? [ownerWorkspaceName];
  if (!Array.isArray(resourceIds)) {
    throw new TypeError("Swarm workspace resource IDs must be an array.");
  }
  if (resourceIds.length === 0) {
    throw new TypeError("At least one swarm workspace resource ID is required.");
  }

  const validated: { readonly name: string; readonly path: string }[] = [];
  for (const resourceId of resourceIds) {
    if (typeof resourceId !== "string" || !resourceId.trim()) {
      throw new TypeError("Invalid swarm workspace resource ID.");
    }
    if (validated.some((workspace) => workspace.name === resourceId)) {
      throw new TypeError(`Duplicate swarm workspace resource ID: "${resourceId}".`);
    }
    const matches = registeredWorkspaces.filter((workspace) => workspace.name === resourceId);
    if (matches.length === 0) {
      throw new TypeError(`Unknown swarm workspace resource ID: "${resourceId}".`);
    }
    if (matches.length > 1) {
      throw new TypeError(`Ambiguous swarm workspace resource ID: "${resourceId}".`);
    }
    validated.push(matches[0]);
  }
  const ownerIndex = validated.findIndex((workspace) => workspace.name === ownerWorkspaceName);
  if (ownerIndex < 0) {
    throw new TypeError(
      `Swarm workspace resources must include the owner workspace "${ownerWorkspaceName}".`,
    );
  }
  // The owner repository leads so it stays the run's legacy singleton target.
  return [validated[ownerIndex], ...validated.filter((_, index) => index !== ownerIndex)];
}

async function resolveOwnerScope(
  options: { readonly sessions: SessionManager },
  sessionId: string,
): Promise<MarshalRuntimeScope> {
  const owner = await options.sessions.getSessionAsync(requiredText(sessionId, "Session"));
  if (!owner) throw new Error("Swarm owner session was not found.");
  return {
    sessionId: owner.id,
    workspaceName:
      owner.workspaceName?.trim() ||
      owner.originWorkspaceName?.trim() ||
      MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
  };
}

function snapshotOwnerConversation(
  session: Parameters<typeof buildGoalConversationContext>[0] | null,
): string | undefined {
  if (!session) return undefined;
  const snapshot = buildGoalConversationContext(session);
  return snapshot.trim() || undefined;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} is required.`);
  return normalized;
}
