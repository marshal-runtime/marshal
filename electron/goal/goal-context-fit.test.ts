import { describe, expect, test } from "vitest";

import type { GoalRecord, GoalTransitionProposal } from "../../common/goal-contract";
import {
  GOAL_CONTEXT_CHAR_BUDGET,
  GoalContextOverflowError,
  defaultComposeContinuation,
  fitGoalPayload,
} from "./goal-context";
import { buildTransitionReviewPrompt } from "./transition-reviewer";

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    schemaVersion: 3,
    id: "goal-1",
    epoch: 1,
    objective: "Ship the bounded goal context serializer",
    criteria: ["output is valid JSON", "authority is never trimmed"],
    status: "pursuing",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    progress: ["step one done", "step two done"],
    openQuestions: ["is the budget right?"],
    assumptions: ["budget measured in UTF-16 units"],
    decisions: ["reserve authority before conversation"],
    state: { phase: "implementation", coverage: "12/52" },
    continuationCount: 3,
    activeMs: 1000,
    tokensUsed: 500,
    ...overrides,
  };
}

const proposal: GoalTransitionProposal = {
  target: "completed",
  reason: "All criteria validated against the real artifacts.",
  finalMessage: "Done.",
};

describe("fitGoalPayload", () => {
  test("payload within budget is returned unchanged with no truncation marker", () => {
    const input = { goal: makeGoal(), proposal, conversationContext: "user: hi\nassistant: hi" };
    const out = fitGoalPayload(input);
    expect(out).toBe(JSON.stringify(input));
    expect(out.length).toBeLessThanOrEqual(GOAL_CONTEXT_CHAR_BUDGET);
    expect(JSON.parse(out)).not.toHaveProperty("truncated");
  });

  test("long realistic recorded shape: overflow absorbed by conversation, goal byte-identical, valid JSON", () => {
    // Mirrors evidence/copycat-continuation-shape.json: {conversationContext, goal} at
    // indent 2, 22-58KB total, where the blind slice produced invalid JSON 57/65 times.
    const goal = makeGoal({
      objective: "learn how copycat works and produce a verified coverage map",
      criteria: Array.from({ length: 8 }, (_, i) => `criterion ${i}: ${"c".repeat(400)}`),
      progress: Array.from({ length: 20 }, (_, i) => `progress ${i}: ${"p".repeat(200)}`),
      decisions: Array.from({ length: 20 }, (_, i) => `decision ${i}`),
      state: {
        workspace: "copycat-lab",
        provokedCoverage: "34/75",
        pixelCoverage: "12/52",
        collapsedNodes: 76,
        notes: "n".repeat(2_000),
      },
    });
    const conversation = Array.from(
      { length: 60 },
      (_, i) => `assistant: turn ${i} ${"x".repeat(800)}`,
    ).join("\n");
    const input = { conversationContext: conversation, goal };
    expect(JSON.stringify(input, null, 2).length).toBeGreaterThan(GOAL_CONTEXT_CHAR_BUDGET);

    const out = fitGoalPayload(input, GOAL_CONTEXT_CHAR_BUDGET, 2);
    expect(out.length).toBeLessThanOrEqual(GOAL_CONTEXT_CHAR_BUDGET);
    const parsed = JSON.parse(out);
    expect(JSON.stringify(parsed.goal)).toBe(JSON.stringify(goal));
    const droppedChars: number = parsed.truncated.droppedConversationChars;
    expect(droppedChars).toBeGreaterThan(0);
    const keptConversation: string = parsed.conversationContext;
    expect(keptConversation.length + droppedChars).toBe(conversation.length);
    expect(conversation.endsWith(keptConversation)).toBe(true);
  });

  test("goal alone over budget: conversation dropped, oldest list entries and largest state keys dropped whole, marker records them", () => {
    const goal = makeGoal({
      progress: Array.from({ length: 30 }, (_, i) => `progress ${i}: ${"p".repeat(1_500)}`),
      state: {
        keep: "small",
        huge: "h".repeat(20_000),
      },
    });
    const input = { goal, conversationContext: "user: short conversation" };
    const out = fitGoalPayload(input);
    expect(out.length).toBeLessThanOrEqual(GOAL_CONTEXT_CHAR_BUDGET);
    const parsed = JSON.parse(out);
    expect(parsed.goal.objective).toBe(goal.objective);
    expect(parsed.goal.criteria).toEqual(goal.criteria);
    expect(parsed.conversationContext).toBe("");
    expect(parsed.truncated.droppedConversationChars).toBe(input.conversationContext.length);
    expect(parsed.truncated.droppedStateKeys).toContain("huge");
    expect(parsed.goal.state.keep).toBe("small");
    // Oldest dropped first: the retained entries are the newest suffix.
    const droppedProgress: number = parsed.truncated.droppedListEntries.progress;
    expect(droppedProgress).toBeGreaterThan(0);
    expect(parsed.goal.progress).toEqual(goal.progress.slice(droppedProgress));
  });

  test("oversized authority (50x8KB criteria) throws a typed, inspectable error instead of emitting truncated output", () => {
    const goal = makeGoal({
      criteria: Array.from({ length: 50 }, (_, i) => `criterion ${i}: ${"a".repeat(8_192)}`),
      state: { blob: "s".repeat(64_000) },
    });
    let caught: unknown;
    try {
      fitGoalPayload({ goal, conversationContext: "user: go" });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof GoalContextOverflowError)) {
      throw new Error("expected GoalContextOverflowError");
    }
    expect(caught.name).toBe("GoalContextOverflowError");
    expect(caught.budget).toBe(GOAL_CONTEXT_CHAR_BUDGET);
    expect(caught.requiredChars).toBeGreaterThan(GOAL_CONTEXT_CHAR_BUDGET);
  });

  test("proposal is reserved whole through heavy trimming", () => {
    const goal = makeGoal({
      progress: Array.from({ length: 40 }, (_, i) => `progress ${i}: ${"p".repeat(1_000)}`),
      state: { big: "b".repeat(10_000) },
    });
    const conversation = "z".repeat(40_000);
    const out = fitGoalPayload({ goal, proposal, conversationContext: conversation });
    expect(out.length).toBeLessThanOrEqual(GOAL_CONTEXT_CHAR_BUDGET);
    expect(JSON.parse(out).proposal).toEqual(proposal);
  });

  test("adversarial unicode: surrogate pairs never split at the conversation cut", () => {
    const goal = makeGoal({ objective: "emoji objective \u{1F680}\u{1F9EA} é́" });
    const conversation = "\u{1F680}".repeat(30_000);
    const out = fitGoalPayload({ goal, conversationContext: conversation });
    expect(out.length).toBeLessThanOrEqual(GOAL_CONTEXT_CHAR_BUDGET);
    const parsed = JSON.parse(out);
    expect(parsed.goal.objective).toBe(goal.objective);
    const keptConversation: string = parsed.conversationContext;
    const first = keptConversation.charCodeAt(0);
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    expect(conversation.endsWith(keptConversation)).toBe(true);
  });

  test("escaping-heavy content: budget applies to serialized length, output stays valid", () => {
    const goal = makeGoal({ objective: 'quotes "and" \\backslashes\\ and\nnewlines' });
    const conversation = '"\\\n\t'.repeat(15_000);
    const out = fitGoalPayload({ goal, conversationContext: conversation });
    expect(out.length).toBeLessThanOrEqual(GOAL_CONTEXT_CHAR_BUDGET);
    const parsed = JSON.parse(out);
    expect(parsed.goal.objective).toBe(goal.objective);
    const keptConversation: string = parsed.conversationContext;
    expect(conversation.endsWith(keptConversation)).toBe(true);
  });

  test("exact budget boundary: fits at exactly N, trims at N-1", () => {
    const input = { goal: makeGoal(), conversationContext: "user: boundary test payload" };
    const exact = JSON.stringify(input).length;
    expect(fitGoalPayload(input, exact)).toBe(JSON.stringify(input));
    const trimmed = fitGoalPayload(input, exact - 1);
    expect(trimmed.length).toBeLessThanOrEqual(exact - 1);
    expect(JSON.parse(trimmed)).toHaveProperty("truncated");
  });
});

describe("callsite integration", () => {
  test("buildTransitionReviewPrompt embeds a valid, bounded payload with the proposal intact and marker guidance", () => {
    const goal = makeGoal({
      progress: Array.from({ length: 30 }, (_, i) => `progress ${i}: ${"p".repeat(2_000)}`),
    });
    const prompt = buildTransitionReviewPrompt({
      goal,
      proposal,
      conversationContext: "y".repeat(50_000),
    });
    expect(prompt).toContain("Treat omitted content as unknown, not absent");
    const payload = prompt.split("\n\n").at(-1) ?? "";
    expect(payload.length).toBeLessThanOrEqual(GOAL_CONTEXT_CHAR_BUDGET);
    const parsed = JSON.parse(payload);
    expect(parsed.proposal).toEqual(proposal);
    expect(parsed.goal.objective).toBe(goal.objective);
    expect(parsed.goal.criteria).toEqual(goal.criteria);
  });

  test("defaultComposeContinuation embeds the same bounded payload representation with goalGet recovery guidance", () => {
    const prompt = defaultComposeContinuation({
      conversationContext: "recent conversation",
      goal: {
        id: "goal-1",
        epoch: 1,
        objective: "objective",
        criteria: ["criterion"],
        progress: Array.from({ length: 20 }, (_, i) => `progress ${i}: ${"p".repeat(4_000)}`),
        openQuestions: [],
        assumptions: [],
        decisions: [],
        state: { big: "b".repeat(10_000) },
        continuationCount: 1,
      },
    });
    expect(prompt).toContain("recover the full goal with goalGet");
    const payload =
      prompt
        .split(
          "Bounded durable goal payload (authoritative; includes compacted conversation context):\n",
        )
        .at(-1)
        ?.split("\n\n")[0] ?? "";
    expect(payload.length).toBeLessThanOrEqual(GOAL_CONTEXT_CHAR_BUDGET);
    const parsed = JSON.parse(payload);
    expect(parsed.goal.objective).toBe("objective");
    expect(parsed.goal.criteria).toEqual(["criterion"]);
    // This goal alone exceeds the budget, so the conversation is dropped and the
    // drop is recorded honestly rather than silently.
    expect(parsed.conversationContext).toBe("");
    expect(parsed.truncated.droppedConversationChars).toBe("recent conversation".length);
    expect(parsed.truncated.droppedListEntries.progress).toBeGreaterThan(0);
  });
});
