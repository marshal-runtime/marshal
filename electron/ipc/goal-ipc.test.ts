import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GoalRecord, GoalRuntimeSnapshot } from "../../common/goal-contract";
import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import type { GoalEngine } from "../goal/goal-engine";
import type { GoalManager } from "../goal/goal-manager";
import { testDouble } from "../testing/harness";
import { registerGoalHandlers } from "./goal-ipc";

const handlers = new Map<keyof IpcInvokeMap, IpcHandler<keyof IpcInvokeMap>>();
const fence = { goalId: "goal-1", epoch: 1 } as const;

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    schemaVersion: 3,
    id: fence.goalId,
    epoch: fence.epoch,
    objective: "Ship it",
    criteria: [],
    status: "pursuing",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    startedPursuingAt: "2026-08-21T00:00:00.000Z",
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

function snapshot(record: GoalRecord | null = goal()): GoalRuntimeSnapshot {
  return {
    sessionId: "session-1",
    goal: record,
    fence: record ? { goalId: record.id, epoch: record.epoch } : null,
  };
}

describe("goal IPC", () => {
  const goalManager = testDouble<GoalManager>({
    getGoal: vi.fn<GoalManager["getGoal"]>(() => goal()),
    getRuntimeSnapshot: vi.fn<GoalManager["getRuntimeSnapshot"]>(() => snapshot()),
    createGoal: vi.fn<GoalManager["createGoal"]>(() => goal()),
    replaceGoal: vi.fn<GoalManager["replaceGoal"]>(() => goal()),
    updateDefinition: vi.fn<GoalManager["updateDefinition"]>(() => goal()),
    updateContext: vi.fn<GoalManager["updateContext"]>(() => goal()),
    pause: vi.fn<GoalManager["pause"]>(() => goal({ status: "paused" })),
    resume: vi.fn<GoalManager["resume"]>(() => goal()),
    steer: vi.fn<GoalManager["steer"]>(() => goal()),
    stop: vi.fn<GoalManager["stop"]>(() => goal({ status: "stopped" })),
  });
  const goalEngine = testDouble<GoalEngine>({
    start: vi.fn<GoalEngine["start"]>(),
    pause: vi.fn<GoalEngine["pause"]>(),
    stop: vi.fn<GoalEngine["stop"]>(),
  });

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerGoalHandlers({
      ipcHandle: (channel, handler) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the channel key retains the handler's correlated generic type in this test registry
        handlers.set(channel, handler as IpcHandler<keyof IpcInvokeMap>);
      },
      goalManager,
      goalEngine,
    });
  });

  it("registers only the current minimal goal API", () => {
    expect([...handlers.keys()]).toEqual([
      "goal:get",
      "goal:set",
      "goal:updateDefinition",
      "goal:updateContext",
      "goal:pause",
      "goal:resume",
      "goal:steer",
      "goal:stop",
    ]);
  });

  it("returns the current runtime snapshot", async () => {
    await expect(call("goal:get", "session-1")).resolves.toEqual({
      success: true,
      snapshot: snapshot(),
    });
  });

  it("replaces the current goal and starts a fresh pursuit", async () => {
    await expect(
      call("goal:set", "session-1", {
        objective: "Ship it",
        criteria: ["Tests pass"],
      }),
    ).resolves.toMatchObject({ success: true, snapshot: { fence } });
    expect(goalEngine.stop).toHaveBeenCalledWith("session-1");
    expect(goalManager.replaceGoal).toHaveBeenCalledWith("session-1", "Ship it", {
      criteria: ["Tests pass"],
    });
    expect(goalEngine.start).toHaveBeenCalledWith("session-1");
  });

  it("routes fenced definition, context, and lifecycle mutations", async () => {
    await call("goal:updateDefinition", "session-1", {
      expectedFence: fence,
      patch: { objective: "Sharper goal" },
    });
    await call("goal:updateContext", "session-1", {
      expectedFence: fence,
      patch: { progress: ["Implemented boundary repair"] },
    });
    await call("goal:pause", "session-1", fence);
    await call("goal:resume", "session-1", fence);
    await call("goal:steer", "session-1", {
      expectedFence: fence,
      instruction: "Run focused tests",
    });
    await call("goal:stop", "session-1", fence);

    expect(goalManager.updateDefinition).toHaveBeenCalledWith(
      "session-1",
      { objective: "Sharper goal" },
      fence,
    );
    expect(goalManager.updateContext).toHaveBeenCalledWith(
      "session-1",
      { progress: ["Implemented boundary repair"] },
      fence,
    );
    expect(goalManager.pause).toHaveBeenCalledWith("session-1", fence);
    expect(goalManager.resume).toHaveBeenCalledWith("session-1", fence);
    expect(goalManager.steer).toHaveBeenCalledWith("session-1", "Run focused tests", fence);
    expect(goalManager.stop).toHaveBeenCalledWith("session-1", fence);
  });

  it("rejects malformed or stale fences without compatibility fields", async () => {
    const malformedFence = {
      goalId: "goal-1",
      epoch: 1,
      specificationDigest: "removed",
    };
    await expect(call("goal:pause", "session-1", malformedFence)).resolves.toEqual({
      success: false,
      error: "A current goal ID and epoch are required",
    });

    vi.mocked(goalManager.pause).mockReturnValueOnce(null);
    await expect(call("goal:pause", "session-1", fence)).resolves.toEqual({
      success: false,
      error: "Goal changed before it could be paused",
    });
  });
});

async function call<C extends keyof IpcInvokeMap>(
  channel: C,
  ...args: Parameters<IpcInvokeMap[C]>
): Promise<Awaited<ReturnType<IpcInvokeMap[C]>>> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- lookup restores the channel/handler correlation established during registration
  const handler = handlers.get(channel) as IpcHandler<C> | undefined;
  if (!handler) throw new Error(`Missing handler for ${channel}`);
  const event = testDouble<Electron.IpcMainInvokeEvent>({});
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- IpcHandler's correlated conditional return is wider after generic invocation
  return (await handler(event, ...args)) as Awaited<ReturnType<IpcInvokeMap[C]>>;
}
