import type { GoalJsonValue, GoalRuntimeSnapshot, GoalStatus } from "@common/goal-contract";

const MAX_STATE_PREVIEW_NODES = 64;
const MAX_STATE_PREVIEW_DEPTH = 4;
const MAX_STATE_PREVIEW_STRING_LENGTH = 256;
const MAX_STATE_PREVIEW_JSON_LENGTH = 8_192;

export interface GoalSnapshotView {
  objective: string;
  criteria: string[];
  lifecycle: GoalStatus;
  progress: string[];
  questions: string[];
  assumptions: string[];
  decisions: string[];
  stateJson: string | null;
  blockedReason: string | null;
  tokensUsed: number;
  activeMs: number;
  continuationCount: number;
  startedPursuingAt: string | null;
}

export function getGoalSnapshotView(snapshot: GoalRuntimeSnapshot): GoalSnapshotView {
  if (!snapshot.goal || !snapshot.fence) {
    throw new Error("Malformed GoalRuntimeSnapshot: goal authority is missing");
  }
  const goal = snapshot.goal;
  return {
    objective: goal.objective,
    criteria: [...goal.criteria],
    lifecycle: goal.status,
    progress: [...goal.progress],
    questions: [...goal.openQuestions],
    assumptions: [...goal.assumptions],
    decisions: [...goal.decisions],
    stateJson: formatGoalState(goal.state),
    blockedReason: goal.blockedReason ?? null,
    tokensUsed: goal.tokensUsed,
    activeMs: goal.activeMs,
    continuationCount: goal.continuationCount,
    startedPursuingAt: goal.startedPursuingAt ?? null,
  };
}

export function formatGoalState(state: Record<string, GoalJsonValue>): string | null {
  if (Object.keys(state).length === 0) return null;

  const budget = { remaining: MAX_STATE_PREVIEW_NODES };
  const bounded = boundJsonValue(state, 0, budget);
  const json = JSON.stringify(bounded, null, 2);
  if (json.length <= MAX_STATE_PREVIEW_JSON_LENGTH) return json;

  return JSON.stringify(
    {
      preview: `${json.slice(0, Math.floor((MAX_STATE_PREVIEW_JSON_LENGTH - 128) / 2))}…`,
      truncated: true,
    },
    null,
    2,
  );
}

function boundJsonValue(
  value: GoalJsonValue,
  depth: number,
  budget: { remaining: number },
): GoalJsonValue {
  if (budget.remaining <= 0) return "[truncated]";
  budget.remaining -= 1;

  if (typeof value === "string") {
    return value.length <= MAX_STATE_PREVIEW_STRING_LENGTH
      ? value
      : `${value.slice(0, MAX_STATE_PREVIEW_STRING_LENGTH - 1)}…`;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_STATE_PREVIEW_DEPTH) return "[truncated]";

  if (Array.isArray(value)) {
    const bounded: GoalJsonValue[] = [];
    for (const item of value) {
      if (budget.remaining <= 0) {
        bounded.push("[truncated]");
        break;
      }
      bounded.push(boundJsonValue(item, depth + 1, budget));
    }
    return bounded;
  }

  const bounded: Record<string, GoalJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (budget.remaining <= 0) {
      bounded.__truncated__ = true;
      break;
    }
    bounded[key] = boundJsonValue(item, depth + 1, budget);
  }
  return bounded;
}
