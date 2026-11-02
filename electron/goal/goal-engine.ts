import { isRuntimeAuthError } from "../../common/foundation/auth/auth-errors";
/* eslint-disable no-await-in-loop -- each goal continuation must observe the prior turn's durable state */
import type { GoalFence, GoalRecord, GoalTransitionProposal } from "../../common/goal-contract";
import { goalFenceFor, matchesGoalFence } from "../../common/goal-contract";
import type { TurnEvent } from "../../common/marshal-ipc-contract";
import { createLogger } from "../../common/marshal-logger";
import { isRuntimeUsageLimitError } from "../../common/runtime-usage-limit";
import type { SendAndCollectResult } from "../sessions";
import { buildContinuationContext } from "./goal-context";
import {
  boundedErrorMessage,
  buildTimelineEvent,
  COMPOSE_TIMEOUT_MS,
  CONTINUATION_DEBOUNCE_MS,
  delay,
  DELIVERY_RETRY_MS,
  MAX_CONSECUTIVE_ERRORS,
  MAX_REVIEW_ATTEMPTS,
  MAX_SYSTEM_REVIEW_REJECTIONS,
  REVIEW_RETRY_MS,
  REVIEW_TIMEOUT_MS,
  AUTH_FAILURE_RETRY_WAIT_MS,
  USAGE_LIMIT_FALLBACK_WAIT_MS,
  USAGE_LIMIT_RESUME_GRACE_MS,
  withTimeout,
  type GoalEngineDeps,
  type PendingReview,
} from "./goal-engine-support";
import { hardLimitReason, MAX_ACTIVE_MS, MAX_CONTINUATIONS } from "./goal-limits";

const log = createLogger("GoalEngine");
/** setTimeout's ceiling (~24.8 days); weekly usage windows fit well within it. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type GoalParkReason = "usage-limit" | "auth";

export class GoalEngine {
  private readonly running = new Map<string, GoalFence>();
  private readonly pendingReviews = new Map<string, PendingReview>();
  private readonly reviewContinuationAllowances = new Map<string, GoalFence>();
  private readonly completionRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly systemRejections = new Map<string, number>();
  /** Goals waiting out a runtime usage limit or a failed sign-in; the timer restarts them. */
  private readonly parks = new Map<
    string,
    { reason: GoalParkReason; resumeAt: number; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(private readonly deps: GoalEngineDeps) {}

  /** Epoch ms when a goal parked on a runtime usage limit resumes, if it is parked. */
  usageLimitResumeAt(sessionId: string): number | undefined {
    const park = this.parks.get(sessionId);
    return park?.reason === "usage-limit" ? park.resumeAt : undefined;
  }

  /** Epoch ms when a goal parked on a failed runtime sign-in retries, if it is parked. */
  authRetryAt(sessionId: string): number | undefined {
    const park = this.parks.get(sessionId);
    return park?.reason === "auth" ? park.resumeAt : undefined;
  }

  start(sessionId: string): void {
    const goal = this.deps.goalManager.getGoal(sessionId);
    if (!goal) return;
    if (goal.status === "completed") {
      void this.deliverCompletedGoal(sessionId, goal);
      return;
    }
    if (goal.status !== "pursuing" || this.deps.isControllerOwned?.(sessionId)) return;
    if (this.parks.has(sessionId)) return;
    if (this.deps.isDispatchReady?.(sessionId) === false) return;
    const fence = this.deps.goalManager.captureFence(sessionId);
    if (!fence || matchesGoalFence(this.running.get(sessionId), fence)) return;
    this.running.set(sessionId, fence);
    void this.loop(sessionId, fence).catch((error) => {
      log.with({ sessionId }).error("Goal loop failed", error);
      if (matchesGoalFence(this.running.get(sessionId), fence)) this.running.delete(sessionId);
      // A driver that dies on an unexpected error must leave a durable,
      // visible reason instead of a silently idle `pursuing` goal. Ordinary
      // exits (pause, stop, stale fence, controller adoption) return normally
      // and never reach this handler.
      const crashed = this.deps.goalManager.getGoal(sessionId);
      if (
        crashed?.status === "pursuing" &&
        this.deps.goalManager.isFenceCurrent(sessionId, fence) &&
        !this.deps.isControllerOwned?.(sessionId)
      ) {
        this.proposeSystemTransition(
          sessionId,
          {
            target: "blocked",
            reason: `Autonomous pursuit stopped on an internal error: ${boundedErrorMessage(error)}`,
          },
          fence,
        );
      }
    });
  }

  signalResumeTrigger(sessionId: string): void {
    // Sign-in, a runtime switch, or opening the session may have fixed a
    // failed sign-in, so retry now. A usage limit only lifts at its reset.
    if (this.parks.get(sessionId)?.reason === "auth") this.clearPark(sessionId);
    // A pending review parked during an auth/runtime transition resumes on
    // the same wake that resumes the loop; the loop itself waits while the
    // review is pending, so start() alone would leave the review stalled.
    if (this.pendingReviews.has(sessionId) && this.deps.isDispatchReady?.(sessionId) !== false) {
      void this.runPendingReview(sessionId);
    }
    this.start(sessionId);
  }

  pause(sessionId: string): void {
    this.running.delete(sessionId);
    this.clearPendingReview(sessionId);
    this.reviewContinuationAllowances.delete(sessionId);
    this.systemRejections.delete(sessionId);
    this.clearCompletionRetry(sessionId);
    this.clearPark(sessionId);
    void this.deps.cancelActiveTurn?.(sessionId);
  }

  stop(sessionId: string): void {
    this.pause(sessionId);
    this.deps.onPursuitStopped?.(sessionId);
  }

  isRunning(sessionId: string): boolean {
    const fence = this.running.get(sessionId);
    return !!fence && this.deps.goalManager.isFenceCurrent(sessionId, fence);
  }

  proposeTransition(
    sessionId: string,
    proposal: GoalTransitionProposal,
    expectedFence: GoalFence,
  ): boolean {
    return this.propose(sessionId, proposal, expectedFence, false);
  }

  private proposeSystemTransition(
    sessionId: string,
    proposal: GoalTransitionProposal,
    expectedFence: GoalFence,
  ): boolean {
    return this.propose(sessionId, proposal, expectedFence, true);
  }

  private propose(
    sessionId: string,
    proposal: GoalTransitionProposal,
    expectedFence: GoalFence,
    system: boolean,
  ): boolean {
    if (!this.deps.goalManager.isFenceCurrent(sessionId, expectedFence)) return false;
    const goal = this.deps.goalManager.getGoal(sessionId);
    if (!goal || goal.status !== "pursuing") return false;
    if (this.pendingReviews.has(sessionId)) return false;
    this.pendingReviews.set(sessionId, {
      fence: { ...expectedFence },
      proposal: structuredClone(proposal),
      runIdentity: this.deps.getRunIdentity?.(sessionId),
      running: false,
      attempts: 0,
      system,
    });
    void this.runPendingReview(sessionId);
    return true;
  }

  async retryPendingReview(sessionId: string): Promise<boolean> {
    if (!this.pendingReviews.has(sessionId)) return false;
    await this.runPendingReview(sessionId);
    return true;
  }

  async retryTerminalDelivery(sessionId: string): Promise<boolean> {
    const goal = this.deps.goalManager.getGoal(sessionId);
    if (!goal || goal.status !== "completed") return false;
    await this.deliverCompletedGoal(sessionId, goal);
    return true;
  }

  private async loop(sessionId: string, fence: GoalFence): Promise<void> {
    let consecutiveErrors = 0;
    try {
      while (this.isCurrent(sessionId, fence)) {
        const goal = this.deps.goalManager.getGoal(sessionId);
        if (!goal || goal.status !== "pursuing") break;
        if (this.deps.isControllerOwned?.(sessionId)) break;
        if (this.deps.isDispatchReady?.(sessionId) === false) break;
        if (this.pendingReviews.has(sessionId) || this.deps.isBusy(sessionId)) {
          await delay(CONTINUATION_DEBOUNCE_MS);
          continue;
        }
        const hardLimit = hardLimitReason(goal);
        if (hardLimit) {
          this.deps.goalManager.applyReviewedTransition(
            sessionId,
            { target: "blocked", reason: hardLimit },
            fence,
          );
          break;
        }
        const reviewerRequestedContinuation = matchesGoalFence(
          this.reviewContinuationAllowances.get(sessionId),
          fence,
        );
        if (!reviewerRequestedContinuation && goal.continuationCount >= MAX_CONTINUATIONS) {
          this.proposeTransition(
            sessionId,
            {
              target: "blocked",
              reason: `Reached the maximum of ${MAX_CONTINUATIONS} continuation turns.`,
            },
            fence,
          );
          continue;
        }
        if (!reviewerRequestedContinuation && goal.activeMs >= MAX_ACTIVE_MS) {
          this.proposeTransition(
            sessionId,
            { target: "blocked", reason: "Reached the active-work time limit." },
            fence,
          );
          continue;
        }
        // Preparation failures share the dispatch error budget: an error here
        // must never silently drop the driver while the durable goal stays
        // `pursuing`. Legitimate exits (stale fence, status change, controller
        // adoption) break out of the try and are not counted as errors.
        let current: GoalRecord;
        let prompt: string;
        try {
          const conversationContext = await this.deps.getConversationContext(sessionId);
          if (!this.isCurrent(sessionId, fence)) break;
          const latest = this.deps.goalManager.getGoal(sessionId);
          if (!latest || latest.status !== "pursuing") break;
          current = latest;
          const context = buildContinuationContext(current, conversationContext);
          prompt = await withTimeout(
            this.deps.composeContinuation(context, sessionId),
            COMPOSE_TIMEOUT_MS,
            "Goal continuation composer timed out",
          );
          if (!prompt.trim()) {
            throw new Error("Goal continuation composer returned an empty prompt");
          }
        } catch (error) {
          if (!this.isCurrent(sessionId, fence)) break;
          // Ownership transferred mid-preparation: the controller now drives
          // the goal, so a shutdown/takeover-shaped failure is not an error
          // and must not count toward a blocked transition.
          if (this.deps.isControllerOwned?.(sessionId)) break;
          log.with({ sessionId }).warn("Goal continuation preparation failed", error);
          consecutiveErrors += 1;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            this.proposeSystemTransition(
              sessionId,
              {
                target: "blocked",
                reason: `Goal continuation preparation failed ${MAX_CONSECUTIVE_ERRORS} consecutive times: ${boundedErrorMessage(error)}`,
              },
              fence,
            );
          }
          await delay(CONTINUATION_DEBOUNCE_MS);
          continue;
        }
        if (!this.isCurrent(sessionId, fence)) break;
        if (this.deps.isControllerOwned?.(sessionId)) break;
        if (this.deps.isBusy(sessionId)) {
          await delay(CONTINUATION_DEBOUNCE_MS);
          continue;
        }

        let turnTokens = 0;
        let blockReason: string | null = null;
        const onEvent = (event: TurnEvent): void => {
          if (!this.deps.goalManager.isFenceCurrent(sessionId, fence)) return;
          if (event.type === "turn:usage") {
            turnTokens += Math.max(0, event.inputTokens) + Math.max(0, event.outputTokens);
          } else if (
            event.type === "turn:message-committed" &&
            event.message.question &&
            !blockReason
          ) {
            blockReason =
              event.message.question.question || "The agent needs user input to continue.";
          }
        };
        if (!this.deps.goalManager.stageContinuationDispatch(sessionId, fence)) break;
        if (reviewerRequestedContinuation) {
          this.reviewContinuationAllowances.delete(sessionId);
        }
        const startedAt = Date.now();
        let result: SendAndCollectResult;
        try {
          result = await this.deps.sendContinuation(
            sessionId,
            prompt.trim(),
            onEvent,
            buildTimelineEvent(current),
          );
        } catch (error) {
          if (!this.isCurrent(sessionId, fence)) break;
          if (isRuntimeUsageLimitError(error)) {
            // Not a failure of the goal: the account is out of quota until the
            // reset. Waiting costs nothing; retrying would only burn the error
            // budget and block an overnight run that can finish after the reset.
            this.parkForUsageLimit(sessionId, error.retryAt);
            break;
          }
          if (isRuntimeAuthError(error)) {
            // Retrying cannot succeed until someone signs in again; parking
            // keeps the error budget for real failures.
            this.park(sessionId, "auth", Date.now() + AUTH_FAILURE_RETRY_WAIT_MS);
            break;
          }
          log.with({ sessionId }).warn("Goal continuation failed", error);
          consecutiveErrors += 1;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            this.proposeSystemTransition(
              sessionId,
              {
                target: "blocked",
                reason: `Repeated errors while pursuing the goal: ${boundedErrorMessage(error)}`,
              },
              fence,
            );
          }
          await delay(CONTINUATION_DEBOUNCE_MS);
          continue;
        } finally {
          this.deps.goalManager.clearContinuationDispatch(sessionId, fence);
        }
        if (!this.isCurrent(sessionId, fence)) break;
        this.deps.goalManager.finishContinuationTurn(
          sessionId,
          { tokensDelta: turnTokens, activeMsDelta: Date.now() - startedAt },
          fence,
        );
        if (blockReason) {
          this.proposeTransition(sessionId, { target: "blocked", reason: blockReason }, fence);
          continue;
        }
        if (result.kind === "timeout" || result.kind === "no-response") {
          consecutiveErrors += 1;
        } else {
          consecutiveErrors = 0;
          this.systemRejections.delete(sessionId);
        }
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          this.proposeSystemTransition(
            sessionId,
            {
              target: "blocked",
              reason:
                result.kind === "timeout"
                  ? "The agent repeatedly timed out."
                  : "The agent repeatedly returned no response.",
            },
            fence,
          );
        }
        await delay(CONTINUATION_DEBOUNCE_MS);
      }
    } finally {
      if (matchesGoalFence(this.running.get(sessionId), fence)) this.running.delete(sessionId);
    }
  }

  private async runPendingReview(sessionId: string): Promise<void> {
    const pending = this.pendingReviews.get(sessionId);
    if (!pending || pending.running) return;
    if (!this.deps.goalManager.isFenceCurrent(sessionId, pending.fence)) {
      this.clearPendingReview(sessionId, pending);
      return;
    }
    // Sign-out, login, or an inactive runtime: park the review instead of
    // burning bounded attempts into a durable block over a transient auth
    // state. signalResumeTrigger re-runs it once dispatch is ready again.
    if (this.deps.isDispatchReady?.(sessionId) === false) return;
    pending.running = true;
    try {
      const goal = this.deps.goalManager.getGoal(sessionId);
      if (!goal || goal.status !== "pursuing") {
        this.clearPendingReview(sessionId, pending);
        return;
      }
      // Conversation context is advisory for review; the durable goal record
      // is the authority. A context-collection failure must not wedge the
      // review (and with it the proposed transition) behind endless retries.
      const conversationContext = await Promise.resolve()
        .then(() => this.deps.getConversationContext(sessionId))
        .catch((error: unknown) => {
          log
            .with({ sessionId })
            .warn("Goal review conversation context unavailable; reviewing goal state only", error);
          return `[conversation context unavailable: ${boundedErrorMessage(error)}]`;
        });
      const verdict = await withTimeout(
        this.deps.reviewTransition(
          {
            goal: structuredClone(goal),
            proposal: structuredClone(pending.proposal),
            conversationContext,
          },
          sessionId,
        ),
        REVIEW_TIMEOUT_MS,
        "Goal transition review timed out",
      );
      // pause/stop withdrew this review while the reviewer ran: drop the verdict.
      if (!this.isTracked(sessionId, pending)) return;
      if (!this.deps.goalManager.isFenceCurrent(sessionId, pending.fence)) {
        this.clearPendingReview(sessionId, pending);
        return;
      }
      if (this.isStaleRunProposal(sessionId, pending)) return;
      if (verdict.decision === "approve") {
        const applied = this.deps.goalManager.applyReviewedTransition(
          sessionId,
          pending.proposal,
          pending.fence,
        );
        this.clearPendingReview(sessionId, pending);
        if (applied?.status === "completed") {
          await this.deliverCompletedGoal(sessionId, applied, pending.proposal.finalMessage);
        } else if (applied) {
          this.running.delete(sessionId);
        }
        return;
      }
      this.deps.goalManager.recordReviewRejection(sessionId, verdict.feedback, pending.fence);
      if (pending.system) {
        const rejections = (this.systemRejections.get(sessionId) ?? 0) + 1;
        this.systemRejections.set(sessionId, rejections);
        if (rejections >= MAX_SYSTEM_REVIEW_REJECTIONS) {
          log
            .with({ sessionId })
            .error(
              `Transition review rejected ${rejections} consecutive system failure reports; recording terminal failure`,
            );
          this.applyUnreviewedSystemBlock(
            sessionId,
            pending,
            `review rejected ${rejections} consecutive system failure reports; stopping unattended retries`,
          );
          return;
        }
      }
      this.reviewContinuationAllowances.set(sessionId, { ...pending.fence });
      this.clearPendingReview(sessionId, pending);
      this.start(sessionId);
    } catch (error) {
      pending.running = false;
      if (!this.isTracked(sessionId, pending)) return;
      if (!this.deps.goalManager.isFenceCurrent(sessionId, pending.fence)) {
        this.clearPendingReview(sessionId, pending);
        return;
      }
      if (this.deps.isDispatchReady?.(sessionId) === false) {
        log
          .with({ sessionId })
          .info("Goal transition review parked during auth/runtime transition", error);
        return;
      }
      pending.attempts += 1;
      if (pending.attempts >= MAX_REVIEW_ATTEMPTS) {
        log
          .with({ sessionId })
          .error("Goal transition review unavailable; recording terminal system failure", error);
        this.applyUnreviewedSystemBlock(
          sessionId,
          pending,
          `transition review unavailable after ${MAX_REVIEW_ATTEMPTS} attempts: ${boundedErrorMessage(error)}`,
        );
        return;
      }
      log.with({ sessionId }).warn("Goal transition review unavailable; scheduling retry", error);
      pending.retryTimer = setTimeout(() => void this.runPendingReview(sessionId), REVIEW_RETRY_MS);
      pending.retryTimer.unref?.();
    }
  }

  /**
   * Deterministic terminal fallback when the review mechanism itself fails —
   * unavailable after bounded retries, or repeatedly rejecting a genuine
   * system failure report: the goal must reach a durable, visible state
   * instead of retrying invisibly forever. Despite routing through
   * `applyReviewedTransition` (the manager's fenced status mutation), this is
   * an unreviewed application — it never completes a goal (an unreviewable
   * completion claim degrades to `blocked` with the claim recorded), and a
   * stale pending review is dropped, never applied.
   */
  /** A pending proposal belongs to the RUN that raised it. When a replacement
   *  run was adopted mid-review under unchanged goal authority (same
   *  goalId/epoch, different delegation identity), the fence still matches —
   *  this guard is what drops the dead run's proposal instead of letting it
   *  block or complete the replacement's pursuit. */
  private isStaleRunProposal(sessionId: string, pending: PendingReview): boolean {
    const current = this.deps.getRunIdentity?.(sessionId);
    if (current === pending.runIdentity) return false;
    log.with({ sessionId }).info("Dropping pending goal proposal from a replaced run", {
      proposalTarget: pending.proposal.target,
      pendingRun: pending.runIdentity ?? "(none)",
      currentRun: current ?? "(none)",
    });
    this.clearPendingReview(sessionId, pending);
    return true;
  }

  private applyUnreviewedSystemBlock(
    sessionId: string,
    pending: PendingReview,
    failure: string,
  ): void {
    if (this.isStaleRunProposal(sessionId, pending)) return;
    this.clearPendingReview(sessionId, pending);
    this.systemRejections.delete(sessionId);
    const reason =
      pending.proposal.target === "completed"
        ? `Completion was claimed but not reviewed (${failure}). Resume to continue pursuit.`
        : `${pending.proposal.reason} (${failure})`;
    const applied = this.deps.goalManager.applyReviewedTransition(
      sessionId,
      { target: "blocked", reason },
      pending.fence,
    );
    if (applied && matchesGoalFence(this.running.get(sessionId), pending.fence)) {
      this.running.delete(sessionId);
    }
  }

  private async deliverCompletedGoal(
    sessionId: string,
    goal: GoalRecord,
    proposedMessage?: string,
  ): Promise<void> {
    const fence = goalFenceFor(goal);
    const current = this.deps.goalManager.getGoal(sessionId);
    if (
      goal.status !== "completed" ||
      current?.status !== "completed" ||
      !this.deps.goalManager.isFenceCurrent(sessionId, fence)
    ) {
      return;
    }
    const latestProgress = goal.progress.at(-1);
    const message =
      proposedMessage?.trim() ||
      [`Goal completed: ${goal.objective}`, latestProgress].filter(Boolean).join("\n\n");
    try {
      await this.deps.deliverCompletion({ sessionId, fence, message });
      this.clearCompletionRetry(sessionId);
    } catch (error) {
      log.with({ sessionId }).warn("Goal completion enqueue failed; scheduling retry", error);
      if (
        !this.completionRetryTimers.has(sessionId) &&
        this.deps.goalManager.isFenceCurrent(sessionId, fence)
      ) {
        const timer = setTimeout(() => {
          this.completionRetryTimers.delete(sessionId);
          void this.deliverCompletedGoal(sessionId, goal, proposedMessage);
        }, DELIVERY_RETRY_MS);
        timer.unref?.();
        this.completionRetryTimers.set(sessionId, timer);
      }
    }
  }

  private isCurrent(sessionId: string, fence: GoalFence): boolean {
    return (
      matchesGoalFence(this.running.get(sessionId), fence) &&
      this.deps.goalManager.isFenceCurrent(sessionId, fence)
    );
  }

  /** With `owner`, clears only that review's own map entry: a verdict that
   *  resolves after pause/resume or goal:set must never delete the NEWER
   *  review mapped for the session (formal/tla GoalEngine LiveReviewTracked). */
  private clearPendingReview(sessionId: string, owner?: PendingReview): void {
    const pending = this.pendingReviews.get(sessionId);
    if (owner?.retryTimer) clearTimeout(owner.retryTimer);
    if (owner && pending !== owner) return;
    if (pending?.retryTimer) clearTimeout(pending.retryTimer);
    this.pendingReviews.delete(sessionId);
  }

  private isTracked(sessionId: string, pending: PendingReview): boolean {
    return this.pendingReviews.get(sessionId) === pending;
  }

  private parkForUsageLimit(sessionId: string, retryAt: number | undefined): void {
    const now = Date.now();
    const resumeAt =
      retryAt !== undefined && retryAt > now
        ? retryAt + USAGE_LIMIT_RESUME_GRACE_MS
        : now + USAGE_LIMIT_FALLBACK_WAIT_MS;
    this.park(sessionId, "usage-limit", resumeAt);
  }

  private park(sessionId: string, reason: GoalParkReason, resumeAt: number): void {
    this.clearPark(sessionId);
    log.with({ sessionId }).info("Goal parked until the runtime can take turns again", {
      reason,
      resumeAt: new Date(resumeAt).toISOString(),
    });
    const timer = setTimeout(
      () => {
        this.parks.delete(sessionId);
        this.start(sessionId);
      },
      Math.min(Math.max(resumeAt - Date.now(), 0), MAX_TIMER_DELAY_MS),
    );
    timer.unref?.();
    this.parks.set(sessionId, { reason, resumeAt, timer });
  }

  private clearPark(sessionId: string): void {
    const park = this.parks.get(sessionId);
    if (park) clearTimeout(park.timer);
    this.parks.delete(sessionId);
  }

  private clearCompletionRetry(sessionId: string): void {
    const timer = this.completionRetryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.completionRetryTimers.delete(sessionId);
  }
}
