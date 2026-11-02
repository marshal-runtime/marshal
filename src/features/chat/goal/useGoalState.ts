import type {
  GoalContextPatch,
  GoalDefinitionPatch,
  GoalFence,
  GoalRuntimeSnapshot,
} from "@common/goal-contract";
import type { GoalAPI, IpcInvokeMap } from "@common/marshal-ipc-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export const goalQueryKey = (sessionId: string) => ["goal-state", sessionId] as const;

export type GoalMutationVariables =
  | { method: "updateDefinition"; expectedFence: GoalFence; patch: GoalDefinitionPatch }
  | { method: "updateContext"; expectedFence: GoalFence; patch: GoalContextPatch }
  | { method: "pause" | "resume" | "stop"; expectedFence: GoalFence }
  | { method: "steer"; expectedFence: GoalFence; instruction: string };

export type GoalMutationInput = GoalMutationVariables extends infer Variables
  ? Variables extends GoalMutationVariables
    ? Omit<Variables, "expectedFence">
    : never
  : never;

function goalApi(): GoalAPI | null {
  return window.goalAPI ?? null;
}

export function requireGoalFence(snapshot: GoalRuntimeSnapshot): GoalFence {
  if (!snapshot.fence) throw new Error("No goal is available");
  return snapshot.fence;
}

export async function setGoal(
  sessionId: string,
  input: { objective: string; criteria?: string[] },
): Promise<GoalRuntimeSnapshot> {
  const api = goalApi();
  if (!api) throw new Error("Goal feature is unavailable");
  const response = await api.set(sessionId, input);
  if (!response.success || !response.snapshot) {
    throw new Error(response.error ?? "Goal creation failed");
  }
  return response.snapshot;
}

export async function fetchGoalSnapshot(sessionId: string): Promise<{
  result: Awaited<ReturnType<IpcInvokeMap["goal:get"]>>;
  snapshot: GoalRuntimeSnapshot | null;
}> {
  const api = goalApi();
  if (!api) {
    return {
      result: { success: false, error: "Goal feature is unavailable" },
      snapshot: null,
    };
  }
  const result = await api.get(sessionId);
  return { result, snapshot: result.snapshot ?? null };
}

export function useGoalState(sessionId: string | null): GoalRuntimeSnapshot | null {
  const { data: snapshot } = useQuery<GoalRuntimeSnapshot | null>({
    queryKey: sessionId ? goalQueryKey(sessionId) : ["goal-state", null],
    queryFn: async () => {
      if (!sessionId) return null;
      const { result, snapshot: current } = await fetchGoalSnapshot(sessionId);
      return result.success ? current : null;
    },
    enabled: !!sessionId && !!window.goalAPI,
    staleTime: 0,
  });

  return snapshot ?? null;
}

export function useGoalMutation(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: GoalMutationVariables): Promise<GoalRuntimeSnapshot> => {
      const api = goalApi();
      if (!api) throw new Error("Goal feature is unavailable");
      let response:
        | Awaited<ReturnType<GoalAPI["updateDefinition"]>>
        | Awaited<ReturnType<GoalAPI["updateContext"]>>
        | Awaited<ReturnType<GoalAPI["pause"]>>
        | Awaited<ReturnType<GoalAPI["resume"]>>
        | Awaited<ReturnType<GoalAPI["steer"]>>
        | Awaited<ReturnType<GoalAPI["stop"]>>;
      switch (variables.method) {
        case "updateDefinition":
          response = await api.updateDefinition(sessionId, {
            expectedFence: variables.expectedFence,
            patch: variables.patch,
          });
          break;
        case "updateContext":
          response = await api.updateContext(sessionId, {
            expectedFence: variables.expectedFence,
            patch: variables.patch,
          });
          break;
        case "pause":
          response = await api.pause(sessionId, variables.expectedFence);
          break;
        case "resume":
          response = await api.resume(sessionId, variables.expectedFence);
          break;
        case "steer":
          response = await api.steer(sessionId, {
            expectedFence: variables.expectedFence,
            instruction: variables.instruction,
          });
          break;
        case "stop":
          response = await api.stop(sessionId, variables.expectedFence);
          break;
      }
      if (!response.success || !response.snapshot) {
        throw new Error(response.error ?? "Goal action failed");
      }
      return response.snapshot;
    },
    onSuccess: (snapshot) => {
      queryClient.setQueryData<GoalRuntimeSnapshot | null>(goalQueryKey(sessionId), snapshot);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: goalQueryKey(sessionId) });
    },
  });
}
