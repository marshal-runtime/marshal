import { describe, expect, test, vi } from "vitest";

import type { GoalFence, GoalRecord } from "../../common/goal-contract";
import type { PersistedSession } from "../session-store";
import { GoalEngine } from "./goal-engine";
import type { GoalEngineDeps } from "./goal-engine-support";
import { HARD_MAX_ACTIVE_MS, HARD_MAX_CONTINUATIONS } from "./goal-limits";
import { GoalManager, type IGoalSessionStore } from "./goal-manager";

/**
 * Regression for the TLC counterexample to formal/tla/GoalEngine.tla
 * `LiveReviewTracked` / `NoOrphanedProposal`: review R1 is in flight, the
 * fence moves on (goal:set, or pause + resume), the agent proposes R2, then
 * R1's stale verdict arrives. clearPendingReview(sessionId) used to delete
 * R2's map entry, so R2 ran untracked (a second review and continuation turns
 * could start alongside it) or, if parked, was dropped although propose()
 * had returned true. Also covers the hard continuation ceiling
 * (`ContinuationCapIsHard`).
 */

const SESSION = "session-1";

class MemoryStore implements IGoalSessionStore {
  private sessions = new Map<string, PersistedSession>();
  constructor() {
    const minimal = {
      id: SESSION,
      name: SESSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal seed; the manager only touches goal/messages
    this.sessions.set(SESSION, minimal as unknown as PersistedSession);
  }
  loadSessionData(id: string): PersistedSession | null {
    return this.sessions.get(id) ?? null;
  }
  saveSessionData(session: PersistedSession): void {
    this.sessions.set(session.id, session);
  }
}

type Trigger = "goal:set" | "pause-resume";

function fenceOf(goal: GoalRecord | null): GoalFence {
  if (!goal) throw new Error("no goal");
  return { goalId: goal.id, epoch: goal.epoch };
}

function harness() {
  const manager = new GoalManager({
    store: new MemoryStore(),
    emit: vi.fn<(sessionId: string, goal: GoalRecord | null) => void>(),
  });
  manager.createGoal(SESSION, "Ship feature A");
  const gates: Array<() => void> = [];
  let reviewsInFlight = 0;
  let busy = true;
  let dispatchReady = true;
  let busyAfterTurn = true;
  const dispatchedDuringReview: number[] = [];
  const engine = new GoalEngine({
    goalManager: manager,
    isBusy: () => busy,
    isDispatchReady: () => dispatchReady,
    getConversationContext: () => "context",
    composeContinuation: async () => "continue",
    sendContinuation: vi.fn<GoalEngineDeps["sendContinuation"]>(async () => {
      if (reviewsInFlight > 0) dispatchedDuringReview.push(reviewsInFlight);
      busy = busyAfterTurn;
      return { kind: "ok", text: "ok" };
    }),
    reviewTransition: async () => {
      reviewsInFlight += 1;
      await new Promise<void>((resolve) => gates.push(resolve));
      reviewsInFlight -= 1;
      return { decision: "reject", feedback: "keep going" };
    },
    deliverCompletion: async () => {},
  });

  const changeFence = (trigger: Trigger) => {
    if (trigger === "goal:set") {
      engine.stop(SESSION);
      manager.replaceGoal(SESSION, "Ship feature B");
      engine.start(SESSION);
    } else {
      manager.pause(SESSION, fenceOf(manager.getGoal(SESSION)));
      engine.pause(SESSION);
      manager.resume(SESSION, fenceOf(manager.getGoal(SESSION)));
      engine.start(SESSION);
    }
  };
  const propose = () =>
    engine.proposeTransition(
      SESSION,
      { target: "completed", reason: "done", finalMessage: "done" },
      fenceOf(manager.getGoal(SESSION)),
    );
  const waitForGate = (count: number) =>
    vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(count), { timeout: 2_000 });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  return {
    engine,
    manager,
    gates,
    changeFence,
    propose,
    waitForGate,
    settle,
    setBusy: (value: boolean) => {
      busy = value;
    },
    setDispatchReady: (value: boolean) => {
      dispatchReady = value;
    },
    stayIdleAfterTurns: () => {
      busy = false;
      busyAfterTurn = false;
    },
    dispatchedDuringReview,
    reviewsInFlight: () => reviewsInFlight,
  };
}

async function staleVerdictDuringLiveReview(trigger: Trigger) {
  const h = harness();
  expect(h.propose()).toBe(true);
  await h.waitForGate(1);
  h.changeFence(trigger);
  expect(h.propose()).toBe(true);
  await h.waitForGate(2);
  h.gates[0]();
  await h.settle();
  expect(h.reviewsInFlight()).toBe(1);
  return h;
}

describe.each<Trigger>(["goal:set", "pause-resume"])(
  "stale review verdict vs. a newer pending review (%s)",
  (trigger) => {
    test("the live review stays tracked as pending", async () => {
      const h = await staleVerdictDuringLiveReview(trigger);
      expect(await h.engine.retryPendingReview(SESSION)).toBe(true);
    });

    test("a second proposal is refused while the live review runs", async () => {
      const h = await staleVerdictDuringLiveReview(trigger);
      expect(h.propose()).toBe(false);
      await h.settle();
      expect(h.reviewsInFlight()).toBe(1);
    });

    test("no continuation turn is dispatched while the live review runs", async () => {
      const h = await staleVerdictDuringLiveReview(trigger);
      h.setBusy(false);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(h.dispatchedDuringReview).toEqual([]);
    });
  },
);

describe.each<Trigger>(["goal:set", "pause-resume"])(
  "stale review verdict vs. a parked proposal (%s)",
  (trigger) => {
    test("the parked proposal is reviewed once dispatch is ready again", async () => {
      const h = harness();
      expect(h.propose()).toBe(true);
      await h.waitForGate(1);
      h.changeFence(trigger);
      h.setDispatchReady(false);
      expect(h.propose()).toBe(true);
      await h.settle();
      expect(h.gates.length).toBe(1);
      h.gates[0]();
      await h.settle();
      h.setDispatchReady(true);
      h.engine.signalResumeTrigger(SESSION);
      await h.waitForGate(2);
    });
  },
);

describe("hard continuation ceiling", () => {
  function atCount(count: number) {
    const h = harness();
    const fence = fenceOf(h.manager.getGoal(SESSION));
    for (let i = 0; i < count; i += 1) {
      h.manager.finishContinuationTurn(SESSION, {}, fence);
    }
    return h;
  }

  test("reaching the hard ceiling blocks without review", async () => {
    const h = atCount(HARD_MAX_CONTINUATIONS);
    h.setBusy(false);
    h.engine.start(SESSION);
    await vi.waitFor(() => expect(h.manager.getGoal(SESSION)?.status).toBe("blocked"));
    expect(h.gates).toHaveLength(0);
    expect(h.manager.getGoal(SESSION)?.blockedReason).toMatch(/hard maximum/);
  });

  test("the hard active-time ceiling blocks without review", async () => {
    const h = harness();
    const fence = fenceOf(h.manager.getGoal(SESSION));
    h.manager.finishContinuationTurn(SESSION, { activeMsDelta: HARD_MAX_ACTIVE_MS }, fence);
    h.setBusy(false);
    h.engine.start(SESSION);
    await vi.waitFor(() => expect(h.manager.getGoal(SESSION)?.status).toBe("blocked"));
    expect(h.gates).toHaveLength(0);
  });

  test("a reviewer rejection past the soft limit buys one turn, then the hard ceiling holds", async () => {
    const h = atCount(HARD_MAX_CONTINUATIONS - 1);
    h.stayIdleAfterTurns();
    h.engine.start(SESSION);
    await h.waitForGate(1);
    h.gates[0]();
    await vi.waitFor(() => expect(h.manager.getGoal(SESSION)?.status).toBe("blocked"), {
      timeout: 5_000,
    });
    expect(h.manager.getGoal(SESSION)?.continuationCount).toBe(HARD_MAX_CONTINUATIONS);
    expect(h.gates).toHaveLength(1);
  });
});

test("control: a pending review blocks proposals and continuations", async () => {
  const h = harness();
  expect(h.propose()).toBe(true);
  await h.waitForGate(1);
  expect(h.propose()).toBe(false);
  h.engine.start(SESSION);
  h.setBusy(false);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(h.dispatchedDuringReview).toEqual([]);
  expect(await h.engine.retryPendingReview(SESSION)).toBe(true);
});
