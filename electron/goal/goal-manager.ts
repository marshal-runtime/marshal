import { randomUUID } from "node:crypto";

import type {
  GoalContextPatch,
  GoalDefinitionPatch,
  GoalFence,
  GoalJsonValue,
  GoalRecord,
  GoalRuntimeSnapshot,
  GoalState,
  GoalTransitionProposal,
} from "../../common/goal-contract";
import { goalFenceFor, matchesGoalFence } from "../../common/goal-contract";
import type { GoalSourceInstruction } from "../../common/goal-contract";
import {
  isUserVisibleSessionMessage,
  type SessionMessage,
} from "../../common/marshal-ipc-contract";
import { makeIntentTitleFallback } from "../../common/marshal-quick-title";
import { createInitialGoalDocument, GoalStateBagSchema } from "../schemas/goal-schema";
import type { PersistedSession } from "../session-store";

export const MAX_GOAL_TEXT_LEN = 8_000;
export const MAX_ACCEPTANCE_CRITERIA = 50;
export const MAX_CONTEXT_ITEMS = 100;
export const GOAL_SOURCE_EXCERPT_MAX = 4_000;

/**
 * The user's actual instruction behind a new goal, selected by provenance
 * rather than stored role: goal continuations, host-authored control
 * exchanges, and agent-forwarded reports (swarm workers, subagents, relay)
 * are persisted with role "user" but are not the user's words, so they are
 * excluded. Returns undefined when the session has no genuine user message
 * (e.g. programmatically-created worker sessions).
 */
export function selectGoalSourceInstruction(
  messages: readonly SessionMessage[],
): GoalSourceInstruction | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    if (!isUserVisibleSessionMessage(message)) continue;
    if (message.agentMessage) continue;
    const content = message.content.trim();
    if (!content) continue;
    return { messageId: message.id, excerpt: content.slice(0, GOAL_SOURCE_EXCERPT_MAX) };
  }
  return undefined;
}

export interface IGoalSessionStore {
  loadSessionData(id: string): PersistedSession | null;
  loadSessionMetadata?(id: string): Pick<PersistedSession, "goal" | "goalRecovery"> | null;
  saveSessionData(session: PersistedSession): void;
}

export interface GoalManagerDeps {
  store: IGoalSessionStore;
  emit: (sessionId: string, goal: GoalState | null) => void;
  seedSessionTitle?: (sessionId: string, title: string) => void;
  emitTimelineMessage?: (sessionId: string, message: SessionMessage) => void;
}

export class GoalManager {
  private readonly continuationDispatchFences = new Map<string, GoalFence>();

  constructor(private readonly deps: GoalManagerDeps) {}

  getGoal(sessionId: string): GoalState | null {
    return this.readGoalMetadata(sessionId)?.goal ?? null;
  }

  getRuntimeSnapshot(sessionId: string): GoalRuntimeSnapshot {
    const session = this.readGoalMetadata(sessionId);
    const goal = session?.goal ?? null;
    const recovery = session?.goalRecovery;
    return {
      sessionId,
      goal,
      fence: goal ? goalFenceFor(goal) : null,
      // The retained quarantine copy stays in the session file; only a bounded
      // notice crosses IPC, and a resolved quarantine is no longer surfaced.
      ...(recovery && !goal && recovery.resolvedAt === undefined
        ? {
            recovery: {
              reason: recovery.reason,
              quarantinedAt: recovery.quarantinedAt,
              rawBytes: Buffer.byteLength(recovery.raw, "utf8"),
            },
          }
        : {}),
    };
  }

  private readGoalMetadata(
    sessionId: string,
  ): Pick<PersistedSession, "goal" | "goalRecovery"> | null {
    // Goal polling and startup indexing must not rebuild entire chat transcripts.
    return this.deps.store.loadSessionMetadata
      ? this.deps.store.loadSessionMetadata(sessionId)
      : this.deps.store.loadSessionData(sessionId);
  }

  captureFence(sessionId: string): GoalFence | null {
    const goal = this.getGoal(sessionId);
    return goal ? goalFenceFor(goal) : null;
  }

  isFenceCurrent(sessionId: string, fence: GoalFence): boolean {
    return matchesGoalFence(this.captureFence(sessionId), fence);
  }

  createGoal(
    sessionId: string,
    objective: string,
    opts?: { acceptanceCriteria?: string[]; criteria?: string[] },
  ): GoalRecord {
    const session = this.requireSession(sessionId);
    if (session.goal) throw new Error("This conversation already has a goal");
    return this.writeNewGoal(session, objective, opts, true);
  }

  replaceGoal(
    sessionId: string,
    objective: string,
    opts?: { acceptanceCriteria?: string[]; criteria?: string[] },
  ): GoalRecord {
    return this.writeNewGoal(this.requireSession(sessionId), objective, opts, false);
  }

  private writeNewGoal(
    session: PersistedSession,
    objective: string,
    opts?: { acceptanceCriteria?: string[]; criteria?: string[] },
    seedSessionTitle = true,
  ): GoalRecord {
    const goal = createInitialGoalDocument({
      objective: clampText(objective),
      criteria: clampList(
        opts?.criteria ?? opts?.acceptanceCriteria ?? [],
        MAX_ACCEPTANCE_CRITERIA,
      ),
      sourceInstruction: selectGoalSourceInstruction(session.messages),
    });
    session.goal = goal;
    // Setting a new goal resolves the quarantine NOTICE but keeps the retained
    // copy durably — replacing a goal is not consent to erase the only copy of
    // the quarantined data.
    if (session.goalRecovery && session.goalRecovery.resolvedAt === undefined) {
      session.goalRecovery = {
        ...session.goalRecovery,
        resolvedAt: goal.createdAt,
        resolvedByGoalId: goal.id,
      };
    }
    this.persist(session);
    if (seedSessionTitle) {
      this.deps.seedSessionTitle?.(session.id, makeIntentTitleFallback(goal.objective));
    }
    return goal;
  }

  updateDefinition(
    sessionId: string,
    patch: GoalDefinitionPatch,
    expectedFence?: GoalFence,
  ): GoalRecord | null {
    return this.mutate(sessionId, expectedFence, (goal) => {
      if (patch.objective !== undefined) goal.objective = clampText(patch.objective);
      if (patch.criteria !== undefined) {
        goal.criteria = clampList(patch.criteria, MAX_ACCEPTANCE_CRITERIA);
      }
      goal.epoch += 1;
      if (goal.status === "completed") {
        goal.status = "pursuing";
        goal.startedPursuingAt = nowIso();
        delete goal.completedAt;
      }
    });
  }

  updateContext(
    sessionId: string,
    patch: GoalContextPatch,
    expectedFence?: GoalFence,
  ): GoalRecord | null {
    return this.mutate(sessionId, expectedFence, (goal) => {
      if (patch.progress !== undefined) goal.progress = clampList(patch.progress);
      if (patch.openQuestions) {
        goal.openQuestions = clampList(patch.openQuestions);
      }
      if (patch.assumptions !== undefined) goal.assumptions = clampList(patch.assumptions);
      if (patch.decisions !== undefined) goal.decisions = clampList(patch.decisions);
      if (patch.state) {
        const next: Record<string, GoalJsonValue> = { ...goal.state };
        for (const key of patch.state.delete ?? []) delete next[key];
        Object.assign(next, patch.state.set ?? {});
        goal.state = GoalStateBagSchema.parse(next);
      }
    });
  }

  steer(sessionId: string, instruction: string, expectedFence?: GoalFence): GoalRecord | null {
    return this.mutate(sessionId, expectedFence, (goal) => {
      goal.decisions = mergeBounded(goal.decisions, [`User steering: ${clampText(instruction)}`]);
      goal.epoch += 1;
      if (goal.status !== "stopped") {
        goal.status = "pursuing";
        goal.startedPursuingAt = nowIso();
        delete goal.blockedReason;
        delete goal.completedAt;
      }
    });
  }

  pause(sessionId: string, expectedFence?: GoalFence): GoalRecord | null {
    return this.applyUserStatus(sessionId, "paused", expectedFence);
  }

  resume(sessionId: string, expectedFence?: GoalFence): GoalRecord | null {
    return this.applyUserStatus(sessionId, "pursuing", expectedFence);
  }

  stop(sessionId: string, expectedFence?: GoalFence): GoalRecord | null {
    return this.applyUserStatus(sessionId, "stopped", expectedFence);
  }

  applyReviewedTransition(
    sessionId: string,
    proposal: GoalTransitionProposal,
    expectedFence: GoalFence,
  ): GoalRecord | null {
    return this.mutate(sessionId, expectedFence, (goal) => {
      if (goal.status !== "pursuing") throw new InvalidGoalTransitionError();
      goal.status = proposal.target;
      goal.epoch += 1;
      delete goal.startedPursuingAt;
      if (proposal.target === "blocked") {
        goal.blockedReason = clampText(proposal.reason);
      } else {
        delete goal.blockedReason;
      }
      if (proposal.target === "completed") goal.completedAt = nowIso();
    });
  }

  recordReviewRejection(sessionId: string, feedback: string, expectedFence: GoalFence): boolean {
    if (!this.isFenceCurrent(sessionId, expectedFence)) return false;
    const session = this.requireSession(sessionId);
    const message: SessionMessage = {
      id: randomUUID(),
      role: "system",
      content: `Transition review rejected the proposal: ${clampText(feedback)}`,
      timestamp: nowIso(),
      internalControl: {
        kind: "goal-transition-review",
        exchangeId: randomUUID(),
        side: "response",
      },
    };
    session.messages.push(message);
    this.persist(session, false);
    this.deps.emitTimelineMessage?.(sessionId, message);
    return true;
  }

  finishContinuationTurn(
    sessionId: string,
    deltas: { tokensDelta?: number; activeMsDelta?: number },
    expectedFence: GoalFence,
  ): GoalRecord | null {
    return this.mutate(sessionId, expectedFence, (goal) => {
      goal.continuationCount += 1;
      goal.tokensUsed += Math.max(0, deltas.tokensDelta ?? 0);
      goal.activeMs += Math.max(0, deltas.activeMsDelta ?? 0);
    });
  }

  stageContinuationDispatch(sessionId: string, fence: GoalFence): boolean {
    if (!this.isFenceCurrent(sessionId, fence)) return false;
    this.continuationDispatchFences.set(sessionId, fence);
    return true;
  }

  claimContinuationDispatch(sessionId: string): GoalFence | null {
    return this.continuationDispatchFences.get(sessionId) ?? this.captureFence(sessionId);
  }

  clearContinuationDispatch(sessionId: string, fence: GoalFence): void {
    if (matchesGoalFence(this.continuationDispatchFences.get(sessionId), fence)) {
      this.continuationDispatchFences.delete(sessionId);
    }
  }

  private applyUserStatus(
    sessionId: string,
    status: Extract<GoalRecord["status"], "pursuing" | "paused" | "stopped">,
    expectedFence?: GoalFence,
  ): GoalRecord | null {
    return this.mutate(sessionId, expectedFence, (goal) => {
      if (goal.status === "stopped" && status !== "stopped") throw new InvalidGoalTransitionError();
      if (goal.status === status) return;
      goal.status = status;
      goal.epoch += 1;
      if (status === "pursuing") {
        goal.startedPursuingAt = nowIso();
        delete goal.completedAt;
        delete goal.blockedReason;
      } else {
        delete goal.startedPursuingAt;
      }
    });
  }

  private mutate(
    sessionId: string,
    expectedFence: GoalFence | undefined,
    update: (goal: GoalRecord) => void,
  ): GoalRecord | null {
    const session = this.requireSession(sessionId);
    if (!session.goal) return null;
    if (expectedFence && !matchesGoalFence(goalFenceFor(session.goal), expectedFence)) return null;
    const goal = structuredClone(session.goal);
    try {
      update(goal);
    } catch (error) {
      if (error instanceof InvalidGoalTransitionError) return null;
      throw error;
    }
    goal.updatedAt = nowIso();
    session.goal = goal;
    this.persist(session);
    return goal;
  }

  private requireSession(sessionId: string): PersistedSession {
    const session = this.deps.store.loadSessionData(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  private persist(session: PersistedSession, emit = true): void {
    this.deps.store.saveSessionData(session);
    if (emit) this.deps.emit(session.id, session.goal ?? null);
  }
}

class InvalidGoalTransitionError extends Error {}

function clampText(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Goal text cannot be empty");
  return normalized.slice(0, MAX_GOAL_TEXT_LEN);
}

function clampList(items: readonly string[], maxItems = MAX_CONTEXT_ITEMS): string[] {
  return items
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => clampText(item))
    .slice(-maxItems);
}

function mergeBounded(existing: string[], additions: readonly string[]): string[] {
  return clampList([...existing, ...additions]);
}

function nowIso(): string {
  return new Date().toISOString();
}

export { matchesGoalFence };
