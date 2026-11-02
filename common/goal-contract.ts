export const GOAL_DOCUMENT_SCHEMA_VERSION = 3 as const;
export const GOAL_INITIAL_EPOCH = 1 as const;

export type GoalStatus = "pursuing" | "paused" | "blocked" | "completed" | "stopped";
export type GoalReviewTarget = Extract<GoalStatus, "paused" | "blocked" | "completed">;

export type GoalJsonPrimitive = string | number | boolean | null;
export type GoalJsonValue = GoalJsonPrimitive | GoalJsonValue[] | { [key: string]: GoalJsonValue };

/**
 * Pointer to the user's actual instruction message that created this goal.
 * Extraction into objective/criteria can itself drop a requirement; reviewers
 * and continuations compare claims against the user's words via this pointer
 * (the excerpt is bounded — the full message lives in the session transcript).
 */
export interface GoalSourceInstruction {
  messageId: string;
  excerpt: string;
}

/** The sole durable goal authority embedded in a persisted session. */
export interface GoalRecord {
  schemaVersion: typeof GOAL_DOCUMENT_SCHEMA_VERSION;
  id: string;
  epoch: number;
  objective: string;
  criteria: string[];
  sourceInstruction?: GoalSourceInstruction;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  startedPursuingAt?: string;
  completedAt?: string;
  blockedReason?: string;
  progress: string[];
  openQuestions: string[];
  assumptions: string[];
  decisions: string[];
  state: Record<string, GoalJsonValue>;
  continuationCount: number;
  activeMs: number;
  tokensUsed: number;
}

export type GoalDocumentV2 = GoalRecord;
export type GoalState = GoalRecord;

/** The complete authority token for stale asynchronous goal work. */
export interface GoalFence {
  readonly goalId: string;
  readonly epoch: number;
}

/**
 * Renderer-facing notice that a persisted goal document was unreadable and has
 * been quarantined. The retained copy (a value-faithful JSON re-serialization)
 * stays in the session file (`goalRecovery.raw`) and is never sent over IPC;
 * recovery means the user sets a new goal — the app never invents an objective
 * from unreadable data, and the retained copy survives the new goal.
 */
export interface GoalRecoveryNotice {
  reason: "invalid-document";
  quarantinedAt: string;
  rawBytes: number;
}

export interface GoalRuntimeSnapshot {
  sessionId: string;
  goal: GoalRecord | null;
  fence: GoalFence | null;
  recovery?: GoalRecoveryNotice;
}

export interface GoalChangedEventPayload {
  sessionId: string;
  snapshot: GoalRuntimeSnapshot;
}

export interface GoalDefinitionPatch {
  objective?: string;
  criteria?: string[];
}

export interface GoalStatePatch {
  set?: Record<string, GoalJsonValue>;
  delete?: string[];
}

export interface GoalContextPatch {
  progress?: string[];
  openQuestions?: string[];
  assumptions?: string[];
  decisions?: string[];
  state?: GoalStatePatch;
}

export interface GoalTransitionProposal {
  target: GoalReviewTarget;
  reason: string;
  finalMessage?: string;
}

export interface GoalTransitionReviewInput {
  goal: GoalRecord;
  proposal: GoalTransitionProposal;
  conversationContext: string;
}

export type GoalTransitionReviewVerdict =
  | { decision: "approve"; feedback?: string }
  | { decision: "reject"; feedback: string };

export function goalFenceFor(goal: GoalRecord): GoalFence {
  return { goalId: goal.id, epoch: goal.epoch };
}

export function matchesGoalFence(
  left: GoalFence | null | undefined,
  right: GoalFence | null | undefined,
): boolean {
  return (
    !!left &&
    !!right &&
    left.goalId === right.goalId &&
    authorityEpoch(left) === authorityEpoch(right)
  );
}

export function isInitialGoalFence(fence: GoalFence): boolean {
  return authorityEpoch(fence) === GOAL_INITIAL_EPOCH;
}

export function authorityEpoch(fence: GoalFence): number {
  return fence.epoch;
}

export type GoalLifecycleStatus = GoalStatus;
export type GoalRuntimeState = GoalRuntimeSnapshot;
