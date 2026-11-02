import type { GoalFence, GoalTransitionProposal } from "../../common/goal-contract";

export interface SwarmTerminalGoalHandoffDeps {
  loadSessionOwnership: (
    sessionId: string,
  ) => { runtimeTaskController?: string; runtimeDelegationId?: string } | null;
  getGoalStatus: (sessionId: string) => string | undefined;
  captureGoalFence: (sessionId: string) => GoalFence | null;
  proposeGoalTransition: (
    sessionId: string,
    proposal: GoalTransitionProposal,
    expectedFence: GoalFence,
  ) => boolean;
}

export interface SwarmTerminalFailureInput {
  sessionId: string;
  runId: string;
  delegationId: string;
  reason: string;
  /** Explicit cancel: the matching controller is released right after this handoff, so the goal is resumable. */
  abandoned: boolean;
}

/**
 * Surface a terminally failed (or cancelled) adopted swarm run on the goal it
 * is suppressing, via the existing reviewed blocked transition. Ownership is
 * never released here: an ordinary failure retains the controller so
 * `swarm.runs.recoverSystemFailure` can recover a transport-misclassified
 * failure in place; an explicit cancel's release happens in the production
 * settlement AFTER this handoff, via the existing compare-and-delete.
 *
 * The handoff fires only when the failed run's root delegation matches the
 * session's CURRENT controller ownership — a historical failure must never
 * block a goal driven by a newer controller, or one not controller-owned at
 * all (the engine drives those itself).
 *
 * Staleness across the asynchronous review: the eventual apply is fence-
 * guarded, so any goal mutation (user resume bumps the epoch) voids a pending
 * proposal. The remaining window — ownership replaced with no goal mutation
 * while a review is in flight — has no automatic path: release only happens on
 * completion or explicit cancel (both of which either never fire this handoff
 * or fire it deliberately), and operator recovery runs on human timescales.
 */
export function createSwarmTerminalGoalHandoff(
  deps: SwarmTerminalGoalHandoffDeps,
): (input: SwarmTerminalFailureInput) => void {
  return ({ sessionId, runId, delegationId, reason, abandoned }) => {
    const ownership = deps.loadSessionOwnership(sessionId);
    if (!ownership?.runtimeTaskController) return;
    if (ownership.runtimeDelegationId !== delegationId) return;
    if (deps.getGoalStatus(sessionId) !== "pursuing") return;
    const fence = deps.captureGoalFence(sessionId);
    if (!fence) return;
    const resolution = abandoned
      ? "The run was cancelled and its controller ownership released; resume the goal to continue."
      : "Controller ownership is retained (swarm.runs.recoverSystemFailure can recover a transport-misclassified failure in place); cancel the run to release ownership, then resume the goal.";
    deps.proposeGoalTransition(
      sessionId,
      {
        target: "blocked",
        reason: `The swarm run driving this goal ended without completing: ${reason} (run ${runId}). ${resolution}`,
      },
      fence,
    );
  };
}
