import { describe, expect, test, vi } from "vitest";

import type { GoalRecord } from "../../common/goal-contract";
import type { PersistedSession } from "../session-store";
import { GoalEngine } from "./goal-engine";
import type { GoalEngineDeps } from "./goal-engine-support";
import { GoalManager, type IGoalSessionStore } from "./goal-manager";

/**
 * de6d7f4c1 residual (R4): a pending transition proposal belongs to the RUN
 * that raised it. A replacement run/delegation adopted into the SAME goal
 * mid-review keeps the goal authority unchanged (same goalId and epoch — the
 * fence still matches), so before this guard the dead run's blocked/completed
 * proposal could apply against the replacement run's pursuit through BOTH
 * apply paths — reviewer approve, and the attempts-exhausted unreviewed
 * system-block fallback — each reproduced below with a negative control and a
 * same-run positive control. Deterministic, no providers.
 */

class MemoryStore implements IGoalSessionStore {
  private sessions = new Map<string, PersistedSession>();
  seed(id: string): void {
    const minimal = {
      id,
      name: id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal seed; the manager only touches goal/messages
    this.sessions.set(id, minimal as unknown as PersistedSession);
  }
  loadSessionData(id: string): PersistedSession | null {
    return this.sessions.get(id) ?? null;
  }
  saveSessionData(session: PersistedSession): void {
    this.sessions.set(session.id, session);
  }
}

function makeManager(store: MemoryStore): GoalManager {
  return new GoalManager({
    store,
    emit: vi.fn<(sessionId: string, goal: GoalRecord | null) => void>(),
  });
}

function makeHarness(reviewDecision: GoalEngineDeps["reviewTransition"]) {
  const store = new MemoryStore();
  store.seed("session-1");
  const manager = makeManager(store);
  const goal = manager.createGoal("session-1", "Finish the migration");
  let runIdentity: string | undefined = "delegation-A";
  const engine = new GoalEngine({
    goalManager: manager,
    isBusy: () => false,
    getRunIdentity: () => runIdentity,
    getConversationContext: () => "context",
    composeContinuation: async () => "continue",
    sendContinuation: vi.fn<GoalEngineDeps["sendContinuation"]>(async () => ({
      kind: "ok",
      text: "ok",
    })),
    reviewTransition: reviewDecision,
    deliverCompletion: async () => {},
  });
  return {
    manager,
    engine,
    goal,
    setRun: (id: string | undefined) => {
      runIdentity = id;
    },
  };
}

describe("run-identity guard on pending goal reviews", () => {
  test("a replaced run's approved blocked proposal never applies to the replacement", async () => {
    let releaseReview: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    const { manager, engine, goal, setRun } = makeHarness(async () => {
      await gate;
      return { decision: "approve" };
    });

    expect(
      engine.proposeTransition(
        "session-1",
        { target: "blocked", reason: "Old run lost its worker" },
        { goalId: goal.id, epoch: goal.epoch },
      ),
    ).toBe(true);

    // Replacement delegation adopted mid-review: goal authority UNCHANGED.
    setRun("delegation-B");
    releaseReview?.();

    // retryPendingReview returns false once no review is pending — a REAL
    // wait for the in-flight review to resolve and the guard to clear it.
    await vi.waitFor(async () => expect(await engine.retryPendingReview("session-1")).toBe(false), {
      timeout: 2_000,
    });
    // The stale proposal was dropped, not applied: the goal keeps pursuing.
    expect(manager.getGoal("session-1")?.status).toBe("pursuing");
  });

  test("attempts-exhausted system fallback is dropped for a replaced run (same goalId/epoch)", async () => {
    vi.useFakeTimers();
    try {
      const { manager, engine, goal, setRun } = makeHarness(async () => {
        throw new Error("reviewer transport down");
      });
      expect(
        engine.proposeTransition(
          "session-1",
          { target: "blocked", reason: "Old run lost its worker" },
          { goalId: goal.id, epoch: goal.epoch },
        ),
      ).toBe(true);
      // Replacement adopted while the reviewer keeps failing; the goal
      // authority (goalId/epoch) never changes.
      setRun("delegation-B");
      // Drive through all retry backoffs to MAX_REVIEW_ATTEMPTS exhaustion.
      // oxlint-disable-next-line no-await-in-loop -- timers must advance sequentially; each step schedules the next retry
      for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(2_100);
      // Negative control: the exhausted fallback must NOT block the
      // replacement run's pursuit — the stale-run proposal is dropped.
      expect(manager.getGoal("session-1")?.status).toBe("pursuing");
      expect(manager.getGoal("session-1")?.blockedReason).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("attempts-exhausted system fallback still blocks for the SAME run", async () => {
    vi.useFakeTimers();
    try {
      const { manager, engine, goal } = makeHarness(async () => {
        throw new Error("reviewer transport down");
      });
      expect(
        engine.proposeTransition(
          "session-1",
          { target: "blocked", reason: "Genuinely stuck" },
          { goalId: goal.id, epoch: goal.epoch },
        ),
      ).toBe(true);
      // oxlint-disable-next-line no-await-in-loop -- timers must advance sequentially; each step schedules the next retry
      for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(2_100);
      // Positive control: unchanged run identity → the designed terminal
      // fallback still lands.
      expect(manager.getGoal("session-1")?.status).toBe("blocked");
      expect(manager.getGoal("session-1")?.blockedReason).toContain("Genuinely stuck");
    } finally {
      vi.useRealTimers();
    }
  });

  test("the same-run proposal still applies normally (guard is not a blanket block)", async () => {
    const { manager, engine, goal } = makeHarness(async () => ({ decision: "approve" }));
    expect(
      engine.proposeTransition(
        "session-1",
        { target: "blocked", reason: "Genuinely blocked" },
        { goalId: goal.id, epoch: goal.epoch },
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(manager.getGoal("session-1")?.status).toBe("blocked"), {
      timeout: 2_000,
    });
    expect(manager.getGoal("session-1")?.blockedReason).toContain("Genuinely blocked");
  });
});
