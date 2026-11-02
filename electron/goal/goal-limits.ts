import type { GoalRecord } from "../../common/goal-contract";

export const MAX_CONTINUATIONS = 100;
export const MAX_ACTIVE_MS = 24 * 60 * 60 * 1000;

/** Past the soft limits each reviewer rejection buys one more turn. These
 *  hard ceilings bound that: the engine then blocks without review, so a
 *  reviewer that keeps rejecting can never keep a goal running forever
 *  (formal/tla GoalEngine ContinuationCapIsHard). */
export const HARD_MAX_CONTINUATIONS = 2 * MAX_CONTINUATIONS;
export const HARD_MAX_ACTIVE_MS = 2 * MAX_ACTIVE_MS;

export function hardLimitReason(
  goal: Pick<GoalRecord, "continuationCount" | "activeMs">,
): string | null {
  if (goal.continuationCount >= HARD_MAX_CONTINUATIONS) {
    return `Reached the hard maximum of ${HARD_MAX_CONTINUATIONS} continuation turns.`;
  }
  if (goal.activeMs >= HARD_MAX_ACTIVE_MS) {
    return "Reached the hard active-work time limit.";
  }
  return null;
}
