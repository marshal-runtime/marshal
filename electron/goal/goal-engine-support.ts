import type {
  GoalFence,
  GoalRecord,
  GoalTransitionProposal,
  GoalTransitionReviewInput,
  GoalTransitionReviewVerdict,
} from "../../common/goal-contract";
import type { GoalTimelineEvent, TurnEvent } from "../../common/marshal-ipc-contract";
import type { SendAndCollectResult } from "../sessions";
import type { GoalContinuationContext } from "./goal-context";
import type { GoalManager } from "./goal-manager";

export const MAX_CONSECUTIVE_ERRORS = 3;
export const CONTINUATION_TIMEOUT_MS = 30 * 60 * 1000;
export const COMPOSE_TIMEOUT_MS = 60_000;
export const REVIEW_TIMEOUT_MS = 5 * 60_000;
export const CONTINUATION_DEBOUNCE_MS = 500;
export const REVIEW_RETRY_MS = 2_000;
export const MAX_REVIEW_ATTEMPTS = 5;
export const MAX_SYSTEM_REVIEW_REJECTIONS = 3;
export const DELIVERY_RETRY_MS = 2_000;
/** Wait when a runtime reports its usage limit without a reset time. */
export const USAGE_LIMIT_FALLBACK_WAIT_MS = 30 * 60_000;
/** Margin after the reported reset so the first resumed turn is not refused again. */
export const USAGE_LIMIT_RESUME_GRACE_MS = 30_000;
/** Retry interval for a goal whose runtime sign-in failed, absent an earlier resume trigger. */
export const AUTH_FAILURE_RETRY_WAIT_MS = 30 * 60_000;

export interface GoalEngineDeps {
  goalManager: GoalManager;
  sendContinuation: (
    sessionId: string,
    prompt: string,
    onEvent: (event: TurnEvent) => void,
    timelineEvent: GoalTimelineEvent,
  ) => Promise<SendAndCollectResult>;
  isBusy: (sessionId: string) => boolean;
  /** An external controller owns automatic continuation until it explicitly releases it. */
  isControllerOwned?: (sessionId: string) => boolean;
  /** Current run/delegation identity for the session (undefined for plain,
   *  non-delegated runs). Captured with every pending review and revalidated
   *  at BOTH apply paths: a proposal raised by a run that has since been
   *  REPLACED (same goal authority — goalId and epoch unchanged — but a new
   *  runtimeDelegationId adopted mid-review) must never block or complete the
   *  replacement run's pursuit. de6d7f4c1 residual. */
  getRunIdentity?: (sessionId: string) => string | undefined;
  /** False while dispatch is temporarily impossible (session on an inactive
   *  runtime, auth transition in progress). The engine parks without touching
   *  durable state or the error budget; resume triggers restart it. */
  isDispatchReady?: (sessionId: string) => boolean;
  getConversationContext: (sessionId: string) => Promise<string> | string;
  composeContinuation: (
    context: GoalContinuationContext,
    sourceSessionId: string,
  ) => Promise<string>;
  reviewTransition: (
    input: GoalTransitionReviewInput,
    sourceSessionId: string,
  ) => Promise<GoalTransitionReviewVerdict>;
  deliverCompletion: (input: {
    sessionId: string;
    fence: GoalFence;
    message: string;
  }) => Promise<void>;
  cancelActiveTurn?: (sessionId: string) => Promise<void>;
  onPursuitStopped?: (sessionId: string) => void;
}

export interface PendingReview {
  fence: GoalFence;
  proposal: GoalTransitionProposal;
  /** Run/delegation identity at proposal time (undefined = non-delegated). */
  runIdentity: string | undefined;
  running: boolean;
  attempts: number;
  /** True for engine-originated failure reports (prep/dispatch errors, driver
   *  death) — bounded by MAX_SYSTEM_REVIEW_REJECTIONS so a reviewer that keeps
   *  rejecting a genuine persistent failure cannot buy an unbounded paid
   *  retry loop. Model proposals and designed limits are never system. */
  system: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
}

export function buildTimelineEvent(goal: GoalRecord): GoalTimelineEvent {
  return {
    type: "goal.continuation",
    fence: { goalId: goal.id, epoch: goal.epoch },
    sequence: goal.continuationCount + 1,
    verification: false,
    resumeTrigger: {
      kind: goal.continuationCount === 0 ? "initial-pursuit" : "continuation-completed",
      reason:
        goal.continuationCount === 0
          ? "Autonomous pursuit started."
          : "The previous continuation completed.",
      occurredAt: new Date().toISOString(),
    },
    durableMilestone: {
      latestProgress: goal.progress.at(-1),
      latestDecision: goal.decisions.at(-1),
      openQuestion: goal.openQuestions.at(-1),
    },
    agent: { sessionId: "", source: "assistant" },
  };
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Length bound only — error text is rendered as-is, not scrubbed. */
export function boundedErrorMessage(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim();
  return message.slice(0, 500) || "Unknown internal error";
}
