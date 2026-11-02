import type { GoalRecord, GoalRuntimeSnapshot } from "@common/goal-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockGoalAPI } from "@/test-utils";
import type { GoalAPI } from "@/types/electron";

import {
  fetchGoalSnapshot,
  goalQueryKey,
  requireGoalFence,
  setGoal,
  useGoalMutation,
  useGoalState,
} from "./useGoalState";

const fence = { goalId: "g1", epoch: 2 } as const;

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    schemaVersion: 3,
    id: "g1",
    epoch: 2,
    objective: "Ship it",
    criteria: [],
    status: "pursuing",
    createdAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T12:01:00.000Z",
    progress: [],
    openQuestions: [],
    assumptions: [],
    decisions: [],
    state: {},
    continuationCount: 0,
    activeMs: 0,
    tokensUsed: 0,
    ...overrides,
  };
}

function makeSnapshot(goalOverrides: Partial<GoalRecord> = {}): GoalRuntimeSnapshot {
  return {
    sessionId: "s1",
    goal: makeGoal(goalOverrides),
    fence,
  };
}

function wrapperFor(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("goal state", () => {
  const original = window.goalAPI;

  afterEach(() => {
    window.goalAPI = original;
  });

  it("fetches and exposes the minimal runtime snapshot", async () => {
    const snapshot = makeSnapshot();
    window.goalAPI = createMockGoalAPI({
      get: vi.fn<GoalAPI["get"]>().mockResolvedValue({ success: true, snapshot }),
    });
    const queryClient = new QueryClient();
    const view = renderHook(() => useGoalState("s1"), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => expect(view.result.current).toEqual(snapshot));
    expect(window.goalAPI.get).toHaveBeenCalledWith("s1");
  });

  it("sets a goal directly without preparation", async () => {
    const snapshot = makeSnapshot();
    const set = vi.fn<GoalAPI["set"]>().mockResolvedValue({ success: true, snapshot });
    window.goalAPI = createMockGoalAPI({ set });

    await expect(
      setGoal("s1", { objective: "Ship it", criteria: ["Tests pass"] }),
    ).resolves.toEqual(snapshot);
    expect(set).toHaveBeenCalledWith("s1", {
      objective: "Ship it",
      criteria: ["Tests pass"],
    });
  });

  it("surfaces goal fetch and set failures", async () => {
    window.goalAPI = createMockGoalAPI({
      get: vi.fn<GoalAPI["get"]>().mockResolvedValue({ success: false, error: "Read failed" }),
      set: vi.fn<GoalAPI["set"]>().mockResolvedValue({ success: false, error: "Write failed" }),
    });

    await expect(fetchGoalSnapshot("s1")).resolves.toEqual({
      result: { success: false, error: "Read failed" },
      snapshot: null,
    });
    await expect(setGoal("s1", { objective: "Ship it" })).rejects.toThrow("Write failed");
  });

  it("routes all minimal mutations and refreshes the runtime cache", async () => {
    const snapshot = makeSnapshot();
    const response = { success: true as const, snapshot };
    const updateDefinition = vi.fn<GoalAPI["updateDefinition"]>().mockResolvedValue(response);
    const updateContext = vi.fn<GoalAPI["updateContext"]>().mockResolvedValue(response);
    const pause = vi.fn<GoalAPI["pause"]>().mockResolvedValue(response);
    const resume = vi.fn<GoalAPI["resume"]>().mockResolvedValue(response);
    const steer = vi.fn<GoalAPI["steer"]>().mockResolvedValue(response);
    const stop = vi.fn<GoalAPI["stop"]>().mockResolvedValue(response);
    window.goalAPI = createMockGoalAPI({
      updateDefinition,
      updateContext,
      pause,
      resume,
      steer,
      stop,
    });
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const view = renderHook(() => useGoalMutation("s1"), {
      wrapper: wrapperFor(queryClient),
    });

    await act(async () => {
      await view.result.current.mutateAsync({
        method: "updateDefinition",
        expectedFence: fence,
        patch: { objective: "Updated" },
      });
      await view.result.current.mutateAsync({
        method: "updateContext",
        expectedFence: fence,
        patch: { progress: ["Done"] },
      });
      await view.result.current.mutateAsync({ method: "pause", expectedFence: fence });
      await view.result.current.mutateAsync({ method: "resume", expectedFence: fence });
      await view.result.current.mutateAsync({
        method: "steer",
        expectedFence: fence,
        instruction: "Prioritize tests",
      });
      await view.result.current.mutateAsync({ method: "stop", expectedFence: fence });
    });

    expect(updateDefinition).toHaveBeenCalledWith("s1", {
      expectedFence: fence,
      patch: { objective: "Updated" },
    });
    expect(updateContext).toHaveBeenCalledWith("s1", {
      expectedFence: fence,
      patch: { progress: ["Done"] },
    });
    expect(pause).toHaveBeenCalledWith("s1", fence);
    expect(resume).toHaveBeenCalledWith("s1", fence);
    expect(steer).toHaveBeenCalledWith("s1", {
      expectedFence: fence,
      instruction: "Prioritize tests",
    });
    expect(stop).toHaveBeenCalledWith("s1", fence);
    expect(queryClient.getQueryData(goalQueryKey("s1"))).toEqual(snapshot);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: goalQueryKey("s1") });
  });

  it("rejects failed mutations and snapshots without a fence", async () => {
    window.goalAPI = createMockGoalAPI({
      pause: vi.fn<GoalAPI["pause"]>().mockResolvedValue({ success: false, error: "Pause failed" }),
    });
    const queryClient = new QueryClient();
    const view = renderHook(() => useGoalMutation("s1"), {
      wrapper: wrapperFor(queryClient),
    });

    await expect(
      act(() => view.result.current.mutateAsync({ method: "pause", expectedFence: fence })),
    ).rejects.toThrow("Pause failed");
    expect(() =>
      requireGoalFence({ sessionId: "s1", goal: null, fence: null }),
    ).toThrow("No goal is available");
  });
});
