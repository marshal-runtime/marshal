import { expect, it, vi } from "vitest";

import { createInitialGoalDocument } from "../schemas/goal-schema";
import { GoalManager, type GoalManagerDeps, type IGoalSessionStore } from "./goal-manager";

it("polls goal state and indexes idle chats without reading their message history", () => {
  const goal = createInitialGoalDocument({ objective: "Complete the repair" });
  const loadSessionData = vi.fn<IGoalSessionStore["loadSessionData"]>(() => {
    throw new Error("Transcript reconstruction must not run during goal polling");
  });
  const loadSessionMetadata = vi.fn<NonNullable<IGoalSessionStore["loadSessionMetadata"]>>((id) =>
    id === "goal-chat" ? { goal } : null,
  );
  const manager = new GoalManager({
    store: {
      loadSessionMetadata,
      loadSessionData,
      saveSessionData: vi.fn<IGoalSessionStore["saveSessionData"]>(),
    },
    emit: vi.fn<GoalManagerDeps["emit"]>(),
  });
  const fence = { goalId: goal.id, epoch: goal.epoch };
  expect(manager.getRuntimeSnapshot("goal-chat")).toEqual({ sessionId: "goal-chat", goal, fence });
  expect(manager.isFenceCurrent("goal-chat", fence)).toBe(true);
  for (let i = 0; i < 1000; i++) expect(manager.getGoal(`idle-chat-${i}`)).toBeNull();
  expect(manager.getRuntimeSnapshot("missing")).toEqual({
    sessionId: "missing",
    goal: null,
    fence: null,
  });
  expect(loadSessionData).not.toHaveBeenCalled();
});

it("retains recovery notices on the metadata read path", () => {
  const recovery = {
    reason: "invalid-document" as const,
    quarantinedAt: "2026-10-04T08:00:00.000Z",
    raw: '{"goal":"unreadable"}',
  };
  const manager = new GoalManager({
    store: {
      loadSessionData: vi.fn<IGoalSessionStore["loadSessionData"]>(),
      loadSessionMetadata: () => ({ goalRecovery: recovery }),
      saveSessionData: vi.fn<IGoalSessionStore["saveSessionData"]>(),
    },
    emit: vi.fn<GoalManagerDeps["emit"]>(),
  });
  expect(manager.getRuntimeSnapshot("recovered-chat")).toEqual({
    sessionId: "recovered-chat",
    goal: null,
    fence: null,
    recovery: {
      reason: recovery.reason,
      quarantinedAt: recovery.quarantinedAt,
      rawBytes: Buffer.byteLength(recovery.raw, "utf8"),
    },
  });
});
