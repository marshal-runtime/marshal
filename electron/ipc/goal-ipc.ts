import type {
  GoalContextPatch,
  GoalDefinitionPatch,
  GoalFence,
  GoalRuntimeSnapshot,
} from "../../common/goal-contract";
import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import { createLogger } from "../../common/marshal-logger";
import type { GoalEngine } from "../goal/goal-engine";
import type { GoalManager } from "../goal/goal-manager";

const log = createLogger("GoalIpc");

export interface GoalIpcCreateState {
  created: GoalRuntimeSnapshot["goal"];
  existing: GoalRuntimeSnapshot["goal"];
  idempotent?: boolean;
}

export interface GoalIpcDeps {
  ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
  goalManager: GoalManager;
  goalEngine: GoalEngine;
}

export function registerGoalHandlers({ ipcHandle, goalManager, goalEngine }: GoalIpcDeps): void {
  ipcHandle("goal:get", async (_event, sessionId) => {
    assertSessionId(sessionId);
    return { success: true, snapshot: goalManager.getRuntimeSnapshot(sessionId) };
  });

  ipcHandle("goal:set", async (_event, sessionId, input) =>
    mutate("set", sessionId, () => {
      assertSessionId(sessionId);
      assertObjective(input.objective);
      goalEngine.stop(sessionId);
      goalManager.replaceGoal(sessionId, input.objective, { criteria: input.criteria });
      goalEngine.start(sessionId);
      return goalManager.getRuntimeSnapshot(sessionId);
    }),
  );

  ipcHandle("goal:updateDefinition", async (_event, sessionId, input) =>
    mutate("updateDefinition", sessionId, () => {
      assertSessionId(sessionId);
      assertFence(input.expectedFence);
      assertDefinitionPatch(input.patch);
      if (!goalManager.updateDefinition(sessionId, input.patch, input.expectedFence)) {
        throw new Error("Goal changed before the definition update was applied");
      }
      goalEngine.start(sessionId);
      return goalManager.getRuntimeSnapshot(sessionId);
    }),
  );

  ipcHandle("goal:updateContext", async (_event, sessionId, input) =>
    mutate("updateContext", sessionId, () => {
      assertSessionId(sessionId);
      assertFence(input.expectedFence);
      assertContextPatch(input.patch);
      if (!goalManager.updateContext(sessionId, input.patch, input.expectedFence)) {
        throw new Error("Goal changed before the context update was applied");
      }
      return goalManager.getRuntimeSnapshot(sessionId);
    }),
  );

  ipcHandle("goal:pause", async (_event, sessionId, expectedFence) =>
    mutate("pause", sessionId, () => {
      assertSessionId(sessionId);
      assertFence(expectedFence);
      if (!goalManager.pause(sessionId, expectedFence)) {
        throw new Error("Goal changed before it could be paused");
      }
      goalEngine.pause(sessionId);
      return goalManager.getRuntimeSnapshot(sessionId);
    }),
  );

  ipcHandle("goal:resume", async (_event, sessionId, expectedFence) =>
    mutate("resume", sessionId, () => {
      assertSessionId(sessionId);
      assertFence(expectedFence);
      if (!goalManager.resume(sessionId, expectedFence)) {
        throw new Error("Goal changed before it could be resumed");
      }
      goalEngine.start(sessionId);
      return goalManager.getRuntimeSnapshot(sessionId);
    }),
  );

  ipcHandle("goal:steer", async (_event, sessionId, input) =>
    mutate("steer", sessionId, () => {
      assertSessionId(sessionId);
      assertFence(input.expectedFence);
      assertObjective(input.instruction);
      if (!goalManager.steer(sessionId, input.instruction, input.expectedFence)) {
        throw new Error("Goal changed before steering was applied");
      }
      goalEngine.start(sessionId);
      return goalManager.getRuntimeSnapshot(sessionId);
    }),
  );

  ipcHandle("goal:stop", async (_event, sessionId, expectedFence) =>
    mutate("stop", sessionId, () => {
      assertSessionId(sessionId);
      assertFence(expectedFence);
      if (!goalManager.stop(sessionId, expectedFence)) {
        throw new Error("Goal changed before it could be stopped");
      }
      goalEngine.stop(sessionId);
      return goalManager.getRuntimeSnapshot(sessionId);
    }),
  );
}

async function mutate(
  operation: string,
  sessionId: string,
  action: () => GoalRuntimeSnapshot,
): Promise<{ success: boolean; snapshot?: GoalRuntimeSnapshot; error?: string }> {
  try {
    const snapshot = action();
    log.with({ sessionId }).info(`Goal ${operation} handled via IPC`);
    return { success: true, snapshot };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.with({ sessionId }).warn(`Goal ${operation} rejected: ${message}`);
    return { success: false, error: message };
  }
}

function assertSessionId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Session ID is required");
}

function assertObjective(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Goal text is required");
}

function assertFence(value: unknown): asserts value is GoalFence {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.goalId !== "string" ||
    !value.goalId.trim() ||
    typeof value.epoch !== "number" ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch <= 0
  ) {
    throw new Error("A current goal ID and epoch are required");
  }
}

function assertDefinitionPatch(value: unknown): asserts value is GoalDefinitionPatch {
  if (!isRecord(value)) throw new Error("Goal definition patch is required");
  if (value.objective !== undefined) assertObjective(value.objective);
  if (
    value.criteria !== undefined &&
    (!Array.isArray(value.criteria) || !value.criteria.every((item) => typeof item === "string"))
  ) {
    throw new Error("Goal criteria must be strings");
  }
}

function assertContextPatch(value: unknown): asserts value is GoalContextPatch {
  if (!isRecord(value)) throw new Error("Goal context patch is required");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
