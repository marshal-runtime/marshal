import { describe, expect, it, vi } from "vitest";

import type { GoalFence } from "../../common/goal-contract";
import { GoalEngine } from "../goal/goal-engine";
import type { GoalEngineDeps } from "../goal/goal-engine-support";
import { GoalManager, type IGoalSessionStore } from "../goal/goal-manager";
import type { PersistedSession } from "../session-store";
import {
  createSwarmTerminalGoalHandoff,
  type SwarmTerminalGoalHandoffDeps,
} from "./swarm-goal-handoff";

const fence: GoalFence = { goalId: "goal-1", epoch: 3 };
const failure = {
  sessionId: "owner-1",
  runId: "owner.b3duZXItMQ.failed",
  delegationId: "root-delegation",
  reason: "root worker crashed",
  abandoned: false,
};

function makeDeps(
  overrides?: Partial<Omit<SwarmTerminalGoalHandoffDeps, "proposeGoalTransition">>,
) {
  const proposeGoalTransition = vi.fn<SwarmTerminalGoalHandoffDeps["proposeGoalTransition"]>(
    () => true,
  );
  return {
    loadSessionOwnership: () => ({
      runtimeTaskController: "marshal.swarm",
      runtimeDelegationId: "root-delegation",
    }),
    getGoalStatus: () => "pursuing" as string | undefined,
    captureGoalFence: () => fence,
    ...overrides,
    proposeGoalTransition,
  } satisfies SwarmTerminalGoalHandoffDeps;
}

describe("createSwarmTerminalGoalHandoff", () => {
  it("proposes a blocked transition when the failed run still owns the session", () => {
    const deps = makeDeps();
    createSwarmTerminalGoalHandoff(deps)(failure);
    expect(deps.proposeGoalTransition).toHaveBeenCalledExactlyOnceWith(
      "owner-1",
      {
        target: "blocked",
        reason: expect.stringContaining("root worker crashed"),
      },
      fence,
    );
    const reason = deps.proposeGoalTransition.mock.calls[0]?.[1].reason;
    expect(reason).toContain(failure.runId);
    expect(reason).toContain("recoverSystemFailure");
    expect(reason).toContain("cancel the run to release ownership");
  });

  it("states the resumable resolution for an explicitly abandoned run", () => {
    const deps = makeDeps();
    createSwarmTerminalGoalHandoff(deps)({ ...failure, abandoned: true });
    const reason = deps.proposeGoalTransition.mock.calls[0]?.[1].reason;
    expect(reason).toContain("cancelled and its controller ownership released");
    expect(reason).toContain("resume the goal to continue");
  });

  it("leaves the goal untouched when a newer controller owns the session (stale failed run)", () => {
    const deps = makeDeps({
      loadSessionOwnership: () => ({
        runtimeTaskController: "marshal.swarm",
        runtimeDelegationId: "newer-delegation",
      }),
    });
    createSwarmTerminalGoalHandoff(deps)(failure);
    expect(deps.proposeGoalTransition).not.toHaveBeenCalled();
  });

  it("leaves the goal untouched when the session is not controller-owned (historical failure)", () => {
    const deps = makeDeps({
      loadSessionOwnership: () => ({ runtimeDelegationId: "root-delegation" }),
    });
    createSwarmTerminalGoalHandoff(deps)(failure);
    expect(deps.proposeGoalTransition).not.toHaveBeenCalled();
  });

  it("leaves the goal untouched when the session is unknown", () => {
    const deps = makeDeps({ loadSessionOwnership: () => null });
    createSwarmTerminalGoalHandoff(deps)(failure);
    expect(deps.proposeGoalTransition).not.toHaveBeenCalled();
  });

  it("leaves non-pursuing goals and goalless sessions untouched", () => {
    for (const status of ["paused", "blocked", "completed", "stopped", undefined]) {
      const deps = makeDeps({ getGoalStatus: () => status });
      createSwarmTerminalGoalHandoff(deps)(failure);
      expect(deps.proposeGoalTransition).not.toHaveBeenCalled();
    }
  });

  it("does nothing when no goal fence can be captured", () => {
    const deps = makeDeps({ captureGoalFence: () => null });
    createSwarmTerminalGoalHandoff(deps)(failure);
    expect(deps.proposeGoalTransition).not.toHaveBeenCalled();
  });
});

describe("abandon-then-resume against the real goal engine", () => {
  class Store implements IGoalSessionStore {
    value: PersistedSession = {
      id: "owner-1",
      name: "owner-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasUnread: false,
      isActive: false,
      messages: [],
    };
    loadSessionData(id: string) {
      return id === "owner-1" ? structuredClone(this.value) : null;
    }
    saveSessionData(session: PersistedSession) {
      this.value = structuredClone(session);
    }
  }

  it("cancel handoff blocks the goal, release lifts suppression, and user resume dispatches again", async () => {
    const store = new Store();
    const manager = new GoalManager({
      store,
      emit: vi.fn<(sessionId: string, goal: unknown) => void>(),
    });
    manager.createGoal("owner-1", "Ship the feature via a swarm");
    let controllerOwned = true;
    let pauseEngine = (_sessionId: string): void => {};
    const sendContinuation = vi.fn<GoalEngineDeps["sendContinuation"]>(async () => {
      pauseEngine("owner-1");
      return { kind: "ok", text: "continued" };
    });
    const engine: GoalEngine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      isControllerOwned: () => controllerOwned,
      getConversationContext: () => "",
      composeContinuation: async () => "Continue",
      reviewTransition: async () => ({ decision: "approve" }),
      sendContinuation,
      deliverCompletion: async () => {},
    });
    pauseEngine = (sessionId) => engine.pause(sessionId);
    const handoff = createSwarmTerminalGoalHandoff({
      loadSessionOwnership: () =>
        controllerOwned
          ? { runtimeTaskController: "marshal.swarm", runtimeDelegationId: "root-delegation" }
          : {},
      getGoalStatus: (sessionId) => manager.getGoal(sessionId)?.status,
      captureGoalFence: (sessionId) => manager.captureFence(sessionId),
      proposeGoalTransition: (sessionId, proposal, expectedFence) =>
        engine.proposeTransition(sessionId, proposal, expectedFence),
    });

    // Explicit cancel of the failed adopted run: handoff first…
    handoff({
      sessionId: "owner-1",
      runId: "owner.b3duZXItMQ.failed",
      delegationId: "root-delegation",
      reason: "cancelled by user",
      abandoned: true,
    });
    await vi.waitFor(() => expect(manager.getGoal("owner-1")?.status).toBe("blocked"), {
      timeout: 5_000,
    });
    expect(manager.getGoal("owner-1")?.blockedReason).toContain("resume the goal to continue");

    // …then the matched controller release lifts suppression (sessions
    // releaseRuntimeTaskController also signals the engine; a no-op here
    // because the goal is blocked, exactly as in production).
    controllerOwned = false;
    engine.signalResumeTrigger("owner-1");
    expect(sendContinuation).not.toHaveBeenCalled();

    // The user resumes the goal; pursuit dispatches for real again.
    expect(manager.resume("owner-1")?.status).toBe("pursuing");
    engine.start("owner-1");
    await vi.waitFor(() => expect(sendContinuation).toHaveBeenCalledOnce(), { timeout: 5_000 });
  });

  // Previously the pinned REACHABLE STALE WINDOW: a blocked proposal already
  // in review was applied by fence alone (goalId+epoch), so a replacement run
  // adopted mid-review (user relaunch, no definition/status change) got
  // blocked by the dead run's proposal. CLOSED by the engine's run-identity
  // guard: PendingReview captures the delegation identity at propose time and
  // both apply paths revalidate it. This test now pins the CLOSED behavior —
  // with getRunIdentity wired to the live delegation, the stale proposal is
  // dropped and the replacement keeps pursuing.
  it("CLOSED: a mid-review replacement adoption without a goal mutation drops the pending blocked proposal", async () => {
    const store = new Store();
    const manager = new GoalManager({
      store,
      emit: vi.fn<(sessionId: string, goal: unknown) => void>(),
    });
    manager.createGoal("owner-1", "Ship the feature via a swarm");
    let resolveReview: (verdict: { decision: "approve" }) => void = () => {};
    const reviewTransition = vi.fn<GoalEngineDeps["reviewTransition"]>(
      () =>
        new Promise((resolve) => {
          resolveReview = resolve;
        }),
    );
    let currentDelegation = "delegation-A";
    const engine: GoalEngine = new GoalEngine({
      // Wired to the live delegation exactly like production (main.ts reads
      // session.runtimeDelegationId): this test must never pass by omitting
      // the dep and masking the fixed defect.
      getRunIdentity: () => currentDelegation,
      goalManager: manager,
      isBusy: () => false,
      isControllerOwned: () => true,
      getConversationContext: () => "",
      composeContinuation: async () => "unused",
      reviewTransition,
      sendContinuation: async () => ({ kind: "ok", text: "unused" }),
      deliverCompletion: async () => {},
    });
    const handoff = createSwarmTerminalGoalHandoff({
      loadSessionOwnership: () => ({
        runtimeTaskController: "marshal.swarm",
        runtimeDelegationId: currentDelegation,
      }),
      getGoalStatus: (sessionId) => manager.getGoal(sessionId)?.status,
      captureGoalFence: (sessionId) => manager.captureFence(sessionId),
      proposeGoalTransition: (sessionId, proposal, expectedFence) =>
        engine.proposeTransition(sessionId, proposal, expectedFence),
    });

    // Run A fails; ownership matches at propose time; review is now in flight.
    handoff({
      sessionId: "owner-1",
      runId: "owner.b3duZXItMQ.run-a",
      delegationId: "delegation-A",
      reason: "root worker crashed",
      abandoned: false,
    });
    await vi.waitFor(() => expect(reviewTransition).toHaveBeenCalledOnce(), { timeout: 5_000 });
    const epochAtProposal = manager.getGoal("owner-1")?.epoch;

    // Mid-review, the user relaunches: replacement run B adopts the session
    // (new delegation), and the agent records progress — which does NOT
    // advance the epoch, so the captured fence stays current.
    currentDelegation = "delegation-B";
    manager.updateContext("owner-1", { progress: ["Relaunched as run B"] });
    expect(manager.getGoal("owner-1")?.epoch).toBe(epochAtProposal);

    // The approval lands on the unchanged fence, but the run-identity guard
    // sees delegation-B ≠ delegation-A and DROPS the dead run's proposal: the
    // healthy replacement keeps pursuing.
    resolveReview({ decision: "approve" });
    await vi.waitFor(async () => expect(await engine.retryPendingReview("owner-1")).toBe(false), {
      timeout: 5_000,
    });
    expect(manager.getGoal("owner-1")?.status).toBe("pursuing");
    expect(manager.getGoal("owner-1")?.blockedReason).toBeUndefined();
  });

  // F3 ordering pin, based on ACTUAL release behavior: releaseRuntimeTaskController
  // deletes session.runtimeTaskController but RETAINS runtimeDelegationId — so a
  // legit blocked proposal from the SAME run whose review resolves AFTER the
  // controller release must still apply; the guard must not self-drop on release.
  it("a blocked review resolving after controller release (same delegation retained) still applies", async () => {
    const store = new Store();
    const manager = new GoalManager({
      store,
      emit: vi.fn<(sessionId: string, goal: unknown) => void>(),
    });
    manager.createGoal("owner-1", "Ship the feature via a swarm");
    let resolveReview: (verdict: { decision: "approve" }) => void = () => {};
    const reviewTransition = vi.fn<GoalEngineDeps["reviewTransition"]>(
      () =>
        new Promise((resolve) => {
          resolveReview = resolve;
        }),
    );
    let controllerOwned = true;
    // Mirrors release semantics: the controller flag clears; the delegation id stays.
    const delegationId = "delegation-A";
    const engine: GoalEngine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      isControllerOwned: () => controllerOwned,
      getRunIdentity: () => delegationId,
      getConversationContext: () => "",
      composeContinuation: async () => "unused",
      reviewTransition,
      sendContinuation: async () => ({ kind: "ok", text: "unused" }),
      deliverCompletion: async () => {},
    });
    const handoff = createSwarmTerminalGoalHandoff({
      loadSessionOwnership: () => ({
        runtimeTaskController: controllerOwned ? "marshal.swarm" : undefined,
        runtimeDelegationId: delegationId,
      }),
      getGoalStatus: (sessionId) => manager.getGoal(sessionId)?.status,
      captureGoalFence: (sessionId) => manager.captureFence(sessionId),
      proposeGoalTransition: (sessionId, proposal, expectedFence) =>
        engine.proposeTransition(sessionId, proposal, expectedFence),
    });
    handoff({
      sessionId: "owner-1",
      runId: "owner.b3duZXItMQ.run-a",
      delegationId,
      reason: "root worker crashed",
      abandoned: false,
    });
    await vi.waitFor(() => expect(reviewTransition).toHaveBeenCalledOnce(), { timeout: 5_000 });
    // Controller releases BEFORE the verdict lands; the delegation identity is retained.
    controllerOwned = false;
    resolveReview({ decision: "approve" });
    await vi.waitFor(() => expect(manager.getGoal("owner-1")?.status).toBe("blocked"), {
      timeout: 5_000,
    });
    expect(manager.getGoal("owner-1")?.blockedReason).toContain("root worker crashed");
  });

  it("a goal-authority change mid-review (user steer) DOES void the pending blocked proposal", async () => {
    const store = new Store();
    const manager = new GoalManager({
      store,
      emit: vi.fn<(sessionId: string, goal: unknown) => void>(),
    });
    manager.createGoal("owner-1", "Ship the feature via a swarm");
    let resolveReview: (verdict: { decision: "approve" }) => void = () => {};
    const reviewTransition = vi.fn<GoalEngineDeps["reviewTransition"]>(
      () =>
        new Promise((resolve) => {
          resolveReview = resolve;
        }),
    );
    const engine: GoalEngine = new GoalEngine({
      goalManager: manager,
      isBusy: () => false,
      isControllerOwned: () => true,
      getConversationContext: () => "",
      composeContinuation: async () => "unused",
      reviewTransition,
      sendContinuation: async () => ({ kind: "ok", text: "unused" }),
      deliverCompletion: async () => {},
    });
    const proposalFence = manager.captureFence("owner-1");
    if (!proposalFence) throw new Error("expected a capturable goal fence");
    expect(
      engine.proposeTransition(
        "owner-1",
        { target: "blocked", reason: "run A failed" },
        proposalFence,
      ),
    ).toBe(true);

    // The user steers the goal for the relaunch: epoch advances, fence changes.
    await vi.waitFor(() => expect(reviewTransition).toHaveBeenCalledOnce(), { timeout: 5_000 });
    manager.steer("owner-1", "Retry with the replacement swarm");
    resolveReview({ decision: "approve" });

    // The stale approval must not land; the goal keeps pursuing.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(manager.getGoal("owner-1")?.status).toBe("pursuing");
    expect(manager.getGoal("owner-1")?.blockedReason).toBeUndefined();
  });
});
