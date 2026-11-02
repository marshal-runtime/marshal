import type { GoalRecord, GoalTransitionProposal } from "../../common/goal-contract";
import {
  isUserVisibleSessionMessage,
  type SessionMessage,
} from "../../common/marshal-ipc-contract";

export interface GoalContinuationContext {
  conversationContext: string;
  goal: {
    id: string;
    epoch: number;
    objective: string;
    criteria: string[];
    sourceInstruction?: GoalRecord["sourceInstruction"];
    progress: string[];
    openQuestions: string[];
    assumptions: string[];
    decisions: string[];
    state: GoalRecord["state"];
    continuationCount: number;
  };
}

export function buildContinuationContext(
  goal: GoalRecord,
  conversationContext: string,
): GoalContinuationContext {
  return {
    conversationContext: conversationContext.slice(-24_000),
    goal: {
      id: goal.id,
      epoch: goal.epoch,
      objective: goal.objective,
      criteria: [...goal.criteria],
      ...(goal.sourceInstruction ? { sourceInstruction: goal.sourceInstruction } : {}),
      progress: goal.progress.slice(-20),
      openQuestions: goal.openQuestions.slice(-20),
      assumptions: goal.assumptions.slice(-20),
      decisions: goal.decisions.slice(-20),
      state: structuredClone(goal.state),
      continuationCount: goal.continuationCount,
    },
  };
}

export function buildGoalConversationContext(input: {
  contextSummary?: string;
  messages: readonly SessionMessage[];
}): string {
  const recent = input.messages
    .filter(
      (message) =>
        isUserVisibleSessionMessage(message) ||
        (message.internalControl?.kind === "goal-transition-review" &&
          message.internalControl.side === "response"),
    )
    .slice(-20)
    .map((message) => {
      const role =
        message.internalControl?.kind === "goal-transition-review" ? "reviewer" : message.role;
      return `${role}: ${message.content.slice(0, 2_000)}`;
    })
    .join("\n");
  return [input.contextSummary, recent].filter(Boolean).join("\n\n").slice(-24_000);
}

export const GOAL_CONTEXT_CHAR_BUDGET = 32_000;

const TRIMMABLE_GOAL_LISTS = ["progress", "openQuestions", "assumptions", "decisions"] as const;
type TrimmableGoalList = (typeof TRIMMABLE_GOAL_LISTS)[number];

const TRUNCATION_MARKER_MAX_STATE_KEYS = 40;
const TRUNCATION_MARKER_MAX_KEY_CHARS = 80;

export interface FitGoalPayloadInput {
  goal: GoalContinuationContext["goal"] | GoalRecord;
  proposal?: GoalTransitionProposal;
  conversationContext?: string;
}

/** The goal's authority fields alone exceed the context budget; the caller must handle this instead of receiving a silently truncated payload. */
export class GoalContextOverflowError extends Error {
  readonly budget: number;
  readonly requiredChars: number;
  constructor(budget: number, requiredChars: number) {
    super(
      `Goal authority fields serialize to ${requiredChars} characters and cannot fit the ${budget}-character context budget`,
    );
    this.name = "GoalContextOverflowError";
    this.budget = budget;
    this.requiredChars = requiredChars;
  }
}

interface GoalPayloadTruncationMarker {
  droppedListEntries?: Partial<Record<TrimmableGoalList, number>>;
  droppedStateKeys?: string[];
  droppedStateKeyCount?: number;
  droppedConversationChars?: number;
}

/**
 * Serialize a goal payload into valid JSON that never exceeds `budget` characters.
 * Authority fields (objective, criteria, status, counters, proposal) are reserved whole
 * and never trimmed. Overflow is absorbed by the conversation text first (tail kept),
 * then by dropping whole oldest progress/openQuestions/assumptions/decisions entries and
 * whole state keys, recorded in a `truncated` marker inside the payload. If the authority
 * fields alone cannot fit, throws GoalContextOverflowError rather than emitting invalid
 * JSON or silently losing authoritative content.
 */
export function fitGoalPayload(
  input: FitGoalPayloadInput,
  budget: number = GOAL_CONTEXT_CHAR_BUDGET,
  indent?: number,
): string {
  const serialize = (value: unknown): string =>
    indent === undefined ? JSON.stringify(value) : JSON.stringify(value, null, indent);
  const build = (
    goal: Record<string, unknown>,
    conversation: string | undefined,
    marker: GoalPayloadTruncationMarker | undefined,
  ): Record<string, unknown> => {
    const payload: Record<string, unknown> = { goal };
    if (input.proposal !== undefined) payload.proposal = input.proposal;
    if (conversation !== undefined) payload.conversationContext = conversation;
    if (marker !== undefined) payload.truncated = marker;
    return payload;
  };

  const conversation = input.conversationContext;
  const fullGoal = { ...input.goal } as Record<string, unknown>;
  const full = serialize(build(fullGoal, conversation, undefined));
  if (full.length <= budget) return full;

  const authorityOnlyGoal: Record<string, unknown> = { ...input.goal, state: {} };
  for (const key of TRIMMABLE_GOAL_LISTS) authorityOnlyGoal[key] = [];
  const authorityOnly = serialize(
    build(authorityOnlyGoal, conversation === undefined ? undefined : "", undefined),
  );
  if (authorityOnly.length > budget) {
    throw new GoalContextOverflowError(budget, authorityOnly.length);
  }

  // Phase 1: the goal fits whole — absorb the overflow with the conversation tail.
  if (conversation !== undefined) {
    const probe = serialize(build(fullGoal, "", { droppedConversationChars: conversation.length }));
    if (probe.length <= budget) {
      let low = 0;
      let high = conversation.length;
      let best = 0;
      const attempt = (keep: number): string => {
        const kept = tailSlice(conversation, keep);
        const marker: GoalPayloadTruncationMarker | undefined =
          kept.length < conversation.length
            ? { droppedConversationChars: conversation.length - kept.length }
            : undefined;
        return serialize(build(fullGoal, kept, marker));
      };
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (attempt(mid).length <= budget) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      for (let keep = best; keep >= 0; keep -= 1) {
        const out = attempt(keep);
        if (out.length <= budget) return out;
      }
    }
  }

  // Phase 2: the goal alone overflows — drop the conversation entirely, then whole
  // oldest list entries and whole state keys (largest first) until the payload fits.
  const keptConversation = conversation === undefined ? undefined : "";
  const droppedConversationChars = conversation?.length ?? 0;
  const lists: Record<TrimmableGoalList, unknown[]> = {
    progress: [...input.goal.progress],
    openQuestions: [...input.goal.openQuestions],
    assumptions: [...input.goal.assumptions],
    decisions: [...input.goal.decisions],
  };
  const stateEntries = Object.entries(input.goal.state).map(([key, value]) => ({
    key,
    value,
    cost: JSON.stringify(key).length + 1 + serialize(value).length,
  }));
  const droppedListEntries: Partial<Record<TrimmableGoalList, number>> = {};
  const droppedStateKeys: string[] = [];
  let droppedStateKeyCount = 0;

  const makeMarker = (): GoalPayloadTruncationMarker => {
    const marker: GoalPayloadTruncationMarker = {};
    if (Object.keys(droppedListEntries).length > 0) marker.droppedListEntries = droppedListEntries;
    if (droppedStateKeyCount > 0) {
      marker.droppedStateKeys = droppedStateKeys;
      if (droppedStateKeyCount > droppedStateKeys.length) {
        marker.droppedStateKeyCount = droppedStateKeyCount;
      }
    }
    if (droppedConversationChars > 0) marker.droppedConversationChars = droppedConversationChars;
    return marker;
  };
  const assembleGoal = (): Record<string, unknown> => {
    const goal = { ...input.goal } as Record<string, unknown>;
    for (const key of TRIMMABLE_GOAL_LISTS) goal[key] = lists[key];
    goal.state = Object.fromEntries(stateEntries.map((entry) => [entry.key, entry.value]));
    return goal;
  };
  const dropOne = (): number | null => {
    let bestList: TrimmableGoalList | null = null;
    let bestCost = -1;
    for (const key of TRIMMABLE_GOAL_LISTS) {
      const oldest = lists[key][0];
      if (oldest === undefined) continue;
      const cost = serialize(oldest).length + 1;
      if (cost > bestCost) {
        bestCost = cost;
        bestList = key;
      }
    }
    let bestState = -1;
    for (let i = 0; i < stateEntries.length; i += 1) {
      if (stateEntries[i].cost > bestCost) {
        bestCost = stateEntries[i].cost;
        bestState = i;
      }
    }
    if (bestState >= 0) {
      const [removed] = stateEntries.splice(bestState, 1);
      droppedStateKeyCount += 1;
      if (droppedStateKeys.length < TRUNCATION_MARKER_MAX_STATE_KEYS) {
        droppedStateKeys.push(removed.key.slice(0, TRUNCATION_MARKER_MAX_KEY_CHARS));
      }
      return bestCost;
    }
    if (bestList !== null) {
      lists[bestList].shift();
      droppedListEntries[bestList] = (droppedListEntries[bestList] ?? 0) + 1;
      return bestCost;
    }
    return null;
  };

  let out = serialize(build(assembleGoal(), keptConversation, makeMarker()));
  while (out.length > budget) {
    let estimate = out.length;
    let dropped = false;
    while (estimate > budget) {
      const cost = dropOne();
      if (cost === null) break;
      dropped = true;
      estimate -= cost;
    }
    if (!dropped) throw new GoalContextOverflowError(budget, out.length);
    out = serialize(build(assembleGoal(), keptConversation, makeMarker()));
  }
  return out;
}

/** Keep the last `keep` UTF-16 units without starting on an orphaned low surrogate. */
function tailSlice(text: string, keep: number): string {
  if (keep <= 0) return "";
  let sliced = text.slice(text.length - keep);
  const first = sliced.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) sliced = sliced.slice(1);
  return sliced;
}

export function defaultComposeContinuation(context: GoalContinuationContext): string {
  return [
    "[GOAL CONTINUATION]",
    `Objective: ${context.goal.objective}`,
    "Criteria:",
    ...(context.goal.criteria.length
      ? context.goal.criteria.map((item) => `- ${item}`)
      : ["- None"]),
    `Bounded durable goal payload (authoritative; includes compacted conversation context):\n${fitGoalPayload(context)}`,
    'If the payload carries a "truncated" marker, the omitted entries still exist in the durable record — recover the full goal with goalGet before broad completion judgments. Empty or shortened lists in this prompt do not mean none exist.',
    "Take the next concrete step. Use goalUpdateDefinition to refine the objective or criteria, goalUpdateContext to persist progress/questions/assumptions/decisions/state, and goalProposeTransition when pausing, blocking, or completing. Do not finalize a transition directly.",
  ].join("\n\n");
}
