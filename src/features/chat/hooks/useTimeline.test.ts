import { renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import type { PermissionCardData } from "@/types/electron";

import type { Message } from "../components/ChatMessage";
import { prependToMessageWindow } from "../state/messageWindow";
import { createTimelineFilterState, type TimelineFilterState } from "../state/timelineFilters";
import { type TimelineItem, useTimeline } from "./useTimeline";

/** Narrow a timeline item to its permissions variant (asserts kind at runtime). */
function permissionsData(item: TimelineItem): PermissionCardData[] {
  if (item.kind === "permissions") return item.data;
  throw new Error(`Expected permissions item, got ${item.kind}`);
}

function makeMessage(id: string, role: "user" | "assistant", ts: number): Message {
  return {
    id,
    role,
    content: `msg-${id}`,
    timestamp: new Date(ts),
  };
}

function makeAgentMessage(source: string, name: string): NonNullable<Message["agentMessage"]> {
  return {
    messageId: `delivery-${source}`,
    idempotencyKey: `delivery-${source}`,
    source,
    target: "parent",
    kind: "parent",
    deliveryMode: "queue",
    priority: 10,
    sequence: 1,
    attempts: 1,
    state: "leased",
    acceptedAt: "2026-07-24T09:00:00.000Z",
    updatedAt: "2026-07-24T09:00:01.000Z",
    sourceLabel: name,
    sourceSessionSource: "subagent",
  };
}

function makeCard(id: string, overrides: Partial<PermissionCardData> = {}): PermissionCardData {
  return {
    id,
    kind: "shell",
    title: `card-${id}`,
    message: "",
    detail: "",
    buttons: ["Allow", "Deny"],
    resolved: "allowed",
    output: "done",
    createdAt: 1000,
    ...overrides,
  };
}

const goalFence = {
  goalId: "goal-1",
  epoch: 1,
};

describe("useTimeline", () => {
  it("returns empty runs for empty inputs", () => {
    const { result } = renderHook(() => useTimeline([], []));
    expect(result.current.runs).toEqual([]);
    expect(result.current.activeCards).toEqual([]);
  });

  it("keeps interrupted reasoning-only and tool-only assistant messages in the timeline", () => {
    const reasoningOnly: Message = {
      ...makeMessage("reasoning", "assistant", 1000),
      content: "",
      reasoning: { text: "Inspecting the call path", durationSeconds: null },
    };
    const toolOnly: Message = {
      ...makeMessage("tool", "assistant", 2000),
      content: "",
      toolCalls: [{ name: "read", description: "Read sessions.ts", cancelled: true }],
    };

    const { result } = renderHook(() => useTimeline([reasoningOnly, toolOnly], []));

    expect(
      result.current.runs.flatMap((run) =>
        run.items.flatMap((item) => (item.kind === "message" ? [item.data.id] : [])),
      ),
    ).toEqual(["reasoning", "tool"]);
  });

  it("renders legacy goal continuation control turns as standalone timeline events", () => {
    const messages = [
      makeMessage("a1", "assistant", 1000),
      {
        ...makeMessage("continuation", "user", 2000),
        goalContinuation: true,
      },
      makeMessage("a2", "assistant", 3000),
    ];

    const { result } = renderHook(() => useTimeline(messages, []));

    expect(result.current.runs.map((run) => run.role)).toEqual(["assistant", "event", "assistant"]);
    const eventRun = result.current.runs[1];
    if (eventRun.role !== "event") throw new Error(`expected event run, got ${eventRun.role}`);
    expect(eventRun.items[0].data.id).toBe("continuation");
  });

  it("keeps internal composer results out of history, filters, and assistant grouping", () => {
    const exchangeId = "goal-continuation:goal-1:1";
    const request: Message = {
      ...makeMessage("continuation", "user", 2000),
      goalContinuation: true,
      internalControl: {
        kind: "goal-continuation",
        exchangeId,
        side: "request",
      },
      goalTimelineEvent: {
        type: "goal.continuation",
        fence: goalFence,
        sequence: 1,
        verification: false,
        resumeTrigger: {
          kind: "initial-pursuit",
          reason: "Autonomous pursuit started.",
          occurredAt: new Date(2000).toISOString(),
        },
        durableMilestone: {},
        agent: {
          sessionId: "parent-1",
          source: "assistant",
          sourceLabel: "Primary agent",
        },
      },
    };
    const internalResponse: Message = {
      ...makeMessage("internal-result", "assistant", 3000),
      content: 'Based on "You are a continuation-prompt composer..."',
      internalControl: {
        kind: "goal-continuation-composer",
        exchangeId,
        side: "response",
      },
    };
    const ordinary = makeMessage("ordinary", "assistant", 4000);

    const { result } = renderHook(() =>
      useTimeline(
        [makeMessage("before", "assistant", 1000), request, internalResponse, ordinary],
        [],
      ),
    );

    expect(result.current.runs.map((run) => run.role)).toEqual(["assistant", "event", "assistant"]);
    expect(
      result.current.runs.flatMap((run) =>
        run.items.flatMap((item) => (item.kind === "message" ? [item.data.id] : [])),
      ),
    ).toEqual(["before", "continuation", "ordinary"]);
    expect(result.current.totalEntryCount).toBe(3);
  });

  it("keeps the pursuing agent's continuation work in history after the goal boundary", () => {
    const exchangeId = "goal-continuation:goal-1:7";
    const request: Message = {
      ...makeMessage("continuation", "user", 2000),
      goalContinuation: true,
      internalControl: { kind: "goal-continuation", exchangeId, side: "request" },
      goalTimelineEvent: {
        type: "goal.continuation",
        fence: goalFence,
        sequence: 7,
        verification: false,
        resumeTrigger: {
          kind: "continuation-completed",
          reason: "The previous continuation completed while the goal remained open.",
          occurredAt: new Date(2000).toISOString(),
        },
        durableMilestone: {},
        agent: { sessionId: "parent-1", source: "assistant", sourceLabel: "Primary agent" },
      },
    };
    const work: Message = {
      ...makeMessage("continuation-work", "assistant", 3000),
      content: "Reproduced the defect and captured the failing command output.",
      internalControl: { kind: "goal-continuation", exchangeId, side: "response" },
    };

    const { result } = renderHook(() => useTimeline([request, work], []));

    expect(
      result.current.runs.flatMap((run) =>
        run.items.flatMap((item) => (item.kind === "message" ? [item.data.id] : [])),
      ),
    ).toEqual(["continuation", "continuation-work"]);
    expect(result.current.totalEntryCount).toBe(2);
  });

  it("shows readiness-triggered assistant work without exposing the hidden request", () => {
    const exchangeId = "subagent-readiness:parent-1:test";
    const request: Message = {
      ...makeMessage("readiness-request", "user", 2000),
      content: "PRIVATE_PARENT_WAKE_PROMPT",
      internalControl: { kind: "subagent-readiness", exchangeId, side: "request" },
    };
    const work: Message = {
      ...makeMessage("readiness-work", "assistant", 3000),
      content: "Integrated both child results.",
      internalControl: { kind: "subagent-readiness", exchangeId, side: "response" },
    };

    const { result } = renderHook(() => useTimeline([request, work], []));

    expect(result.current.runs).toHaveLength(1);
    expect(result.current.runs[0].items).toEqual([{ kind: "message", data: work }]);
    expect(result.current.totalEntryCount).toBe(1);
  });

  it("keeps a prepended internal composer response hidden while retaining the current ordinary reply", () => {
    const internalResponse: Message = {
      ...makeMessage("older-internal", "assistant", 1000),
      content: "PRIVATE_INTERNAL_RESULT",
      internalControl: {
        kind: "goal-continuation-composer",
        exchangeId: "goal-continuation:goal-1:older",
        side: "response",
      },
    };
    const ordinary = makeMessage("current-visible", "assistant", 2000);
    const prepended = prependToMessageWindow([ordinary], [internalResponse]);
    const { result } = renderHook(() => useTimeline(prepended.messages, []));

    expect(prepended.messages.map((message) => message.id)).toEqual([
      "older-internal",
      "current-visible",
    ]);
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.runs[0].items).toEqual([{ kind: "message", data: ordinary }]);
  });

  it("orders a subagent handoff before the reviewed continuation it triggered", () => {
    const declaration: Message = {
      id: "declared",
      role: "system",
      content: "Goal started: Ship onboarding",
      timestamp: new Date(1000),
      goalTimelineEvent: {
        type: "goal.declared",
        fence: goalFence,
        objective: "Ship onboarding",
      },
    };
    const handoff: Message = {
      id: "handoff",
      role: "user",
      content: "Message from subagent Worker (child-1):\n\nImplementation is ready.",
      timestamp: new Date(2000),
      agentMessage: {
        source: "child-1",
        sourceLabel: "Worker",
        kind: "parent",
        deliveryMode: "queue",
        sequence: 7,
        sourceSessionSource: "subagent",
      },
    };
    const continuation: Message = {
      id: "continuation",
      role: "user",
      content: "[GOAL CONTINUATION] internal prompt",
      timestamp: new Date(2000),
      goalContinuation: true,
      goalTimelineEvent: {
        type: "goal.continuation",
        fence: goalFence,
        sequence: 2,
        verification: false,
        resumeTrigger: {
          kind: "milestone-available",
          reason: "A delegated subagent reached an idle milestone.",
          milestoneSummary: "Worker is ready for integration.",
          occurredAt: new Date(2000).toISOString(),
        },
        durableMilestone: { handoffSummary: "Implementation is ready." },
        agent: {
          sessionId: "parent-1",
          source: "assistant",
          sourceLabel: "Primary agent",
        },
        reviewer: {
          sessionId: "goal:continuation-reviewer",
          source: "reviewer",
          sourceLabel: "Independent continuation reviewer",
          requestedCompaction: false,
        },
      },
    };

    const { result } = renderHook(() =>
      useTimeline(
        [declaration, handoff, continuation, makeMessage("answer", "assistant", 3000)],
        [],
      ),
    );

    expect(result.current.runs.map((run) => run.role)).toEqual([
      "event",
      "event",
      "event",
      "assistant",
    ]);
    const eventIds = result.current.runs.slice(0, 3).map((run) => {
      if (run.role !== "event") throw new Error(`expected event run, got ${run.role}`);
      return run.items[0].data.id;
    });
    expect(eventIds).toEqual(["declared", "handoff", "continuation"]);
    expect(result.current.subagents).toEqual([
      { id: "child-1", name: "Worker", source: "subagent" },
      {
        id: "goal:continuation-reviewer",
        name: "Independent continuation reviewer",
        source: "reviewer",
      },
    ]);
  });

  it("creates a user run for user messages", () => {
    const msgs = [makeMessage("1", "user", 1000)];
    const { result } = renderHook(() => useTimeline(msgs, []));
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.runs[0].role).toBe("user");
  });

  it("creates an assistant run for assistant messages", () => {
    const msgs = [makeMessage("1", "assistant", 1000)];
    const { result } = renderHook(() => useTimeline(msgs, []));
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.runs[0].role).toBe("assistant");
  });

  it("creates a named subagent event instead of a user run", () => {
    const message = {
      ...makeMessage("subagent", "user", 1000),
      agentMessage: makeAgentMessage("subagent-1", "Research helper"),
    };
    const { result } = renderHook(() => useTimeline([message], []));

    expect(result.current.runs).toEqual([
      {
        role: "event",
        items: [{ kind: "message", data: message }],
      },
    ]);
    expect(result.current.subagents).toEqual([
      { id: "subagent-1", name: "Research helper", source: "subagent" },
    ]);
  });

  it("creates a standalone system run", () => {
    const message: Message = {
      id: "system",
      role: "system",
      content: "Runtime restarted",
      timestamp: new Date(1000),
    };
    const { result } = renderHook(() => useTimeline([message], []));
    expect(result.current.runs[0]?.role).toBe("system");
  });

  it("filters to a named subagent goal continuation", () => {
    const continuation: Message = {
      id: "continuation",
      role: "user",
      content: "internal continuation prompt",
      timestamp: new Date(1000),
      goalContinuation: true,
      goalTimelineEvent: {
        type: "goal.continuation",
        fence: {
          goalId: "goal-1",
          epoch: 1,
        },
        sequence: 2,
        verification: false,
        resumeTrigger: {
          kind: "continuation-completed",
          reason: "Continue delegated work.",
          occurredAt: "2026-07-24T09:00:00.000Z",
        },
        durableMilestone: {},
        agent: {
          sessionId: "subagent-1",
          source: "subagent",
          sourceLabel: "Research helper",
        },
      },
    };
    const filter: TimelineFilterState = {
      ...createTimelineFilterState(),
      categories: ["subagent", "goal"],
      subagentId: "subagent-1",
    };
    const { result } = renderHook(() => useTimeline([continuation], [], { filter }));

    expect(result.current.runs[0]?.role).toBe("event");
    expect(result.current.subagents).toEqual([
      { id: "subagent-1", name: "Research helper", source: "subagent" },
    ]);
  });

  it("groups consecutive assistant messages into one run", () => {
    const msgs = [makeMessage("1", "assistant", 1000), makeMessage("2", "assistant", 2000)];
    const { result } = renderHook(() => useTimeline(msgs, []));
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.runs[0].role).toBe("assistant");
    expect(result.current.runs[0].items).toHaveLength(2);
  });

  it("user messages break assistant runs", () => {
    const msgs = [
      makeMessage("1", "assistant", 1000),
      makeMessage("2", "user", 2000),
      makeMessage("3", "assistant", 3000),
    ];
    const { result } = renderHook(() => useTimeline(msgs, []));
    expect(result.current.runs).toHaveLength(3);
    expect(result.current.runs[0].role).toBe("assistant");
    expect(result.current.runs[1].role).toBe("user");
    expect(result.current.runs[2].role).toBe("assistant");
  });

  it("sorts messages and resolved cards chronologically", () => {
    const msgs = [makeMessage("1", "assistant", 3000)];
    const cards = [makeCard("c1", { createdAt: 1000 })];
    const { result } = renderHook(() => useTimeline(msgs, cards));
    // Card at t=1000, message at t=3000 — card first
    const items = result.current.runs[0].items;
    expect(items[0].kind).toBe("permissions");
    expect(items[1].kind).toBe("message");
  });

  it("excludes resolved permission history older than the loaded transcript", () => {
    const msgs = [makeMessage("m1", "assistant", 2000), makeMessage("m2", "assistant", 4000)];
    const cards = [
      makeCard("too-old", { createdAt: 1000 }),
      makeCard("in-page", { createdAt: 3000 }),
      makeCard("too-new", { createdAt: 5000 }),
    ];
    const { result } = renderHook(() => useTimeline(msgs, cards, { constrainResolvedCards: true }));

    const permissionItems = result.current.runs.flatMap((run) =>
      run.items.filter((item) => item.kind === "permissions"),
    );
    expect(permissionItems.flatMap((item) => permissionsData(item).map((card) => card.id))).toEqual(
      ["in-page", "too-new"],
    );
  });

  it("groups consecutive permission cards into a single permissions item", () => {
    const cards = [makeCard("c1", { createdAt: 1000 }), makeCard("c2", { createdAt: 1001 })];
    const { result } = renderHook(() => useTimeline([], cards));
    expect(result.current.runs).toHaveLength(1);
    const items = result.current.runs[0].items;
    expect(items).toHaveLength(1);
    expect(permissionsData(items[0])).toHaveLength(2);
  });

  it("separates active (unresolved) cards from the timeline", () => {
    const cards = [
      makeCard("c1", { resolved: "allowed", output: "done", createdAt: 1000 }),
      makeCard("c2", { resolved: undefined, output: undefined, createdAt: 2000 }),
    ];
    const { result } = renderHook(() => useTimeline([], cards));
    // Only the resolved card appears in timeline
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.activeCards).toHaveLength(1);
    expect(result.current.activeCards[0].id).toBe("c2");
  });

  it("treats cards with resolved but no output as active (running)", () => {
    const cards = [makeCard("c1", { resolved: "allowed", output: undefined, createdAt: 1000 })];
    const { result } = renderHook(() => useTimeline([], cards));
    expect(result.current.runs).toHaveLength(0);
    expect(result.current.activeCards).toHaveLength(1);
  });

  it("filters out messages with empty content", () => {
    const msgs = [
      makeMessage("1", "user", 1000),
      { id: "2", role: "assistant" as const, content: "   ", timestamp: new Date(2000) },
    ];
    const { result } = renderHook(() => useTimeline(msgs, []));
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.runs[0].items).toHaveLength(1);
  });

  it("interleaves a single permission card between two assistant messages", () => {
    const msgs = [makeMessage("a1", "assistant", 1000), makeMessage("a2", "assistant", 3000)];
    const cards = [makeCard("c1", { createdAt: 2000 })];
    const { result } = renderHook(() => useTimeline(msgs, cards));
    // All three items land in one assistant run: msg, perm, msg
    expect(result.current.runs).toHaveLength(1);
    const items = result.current.runs[0].items;
    expect(items).toHaveLength(3);
    expect(items[0].kind).toBe("message");
    expect(items[1].kind).toBe("permissions");
    expect(items[2].kind).toBe("message");
  });

  it("a user message splits permission cards into separate assistant runs", () => {
    // assistant msg -> perm card -> user msg -> perm card -> assistant msg
    const msgs = [
      makeMessage("a1", "assistant", 1000),
      makeMessage("u1", "user", 3000),
      makeMessage("a2", "assistant", 5000),
    ];
    const cards = [makeCard("c1", { createdAt: 2000 }), makeCard("c2", { createdAt: 4000 })];
    const { result } = renderHook(() => useTimeline(msgs, cards));
    // Run 0 (assistant): a1 + perm[c1]
    // Run 1 (user): u1
    // Run 2 (assistant): perm[c2] + a2
    expect(result.current.runs).toHaveLength(3);
    expect(result.current.runs[0].role).toBe("assistant");
    expect(result.current.runs[0].items).toHaveLength(2);
    expect(result.current.runs[1].role).toBe("user");
    expect(result.current.runs[2].role).toBe("assistant");
    expect(result.current.runs[2].items).toHaveLength(2);
  });

  it("groups multiple consecutive permission cards between messages", () => {
    // assistant msg -> 3 perm cards -> assistant msg
    const msgs = [makeMessage("a1", "assistant", 1000), makeMessage("a2", "assistant", 5000)];
    const cards = [
      makeCard("c1", { createdAt: 2000 }),
      makeCard("c2", { createdAt: 2500 }),
      makeCard("c3", { createdAt: 3000 }),
    ];
    const { result } = renderHook(() => useTimeline(msgs, cards));
    expect(result.current.runs).toHaveLength(1);
    const items = result.current.runs[0].items;
    // msg, permissions(3 grouped), msg
    expect(items).toHaveLength(3);
    expect(items[0].kind).toBe("message");
    expect(permissionsData(items[1])).toHaveLength(3);
    expect(items[2].kind).toBe("message");
  });

  it("handles denied cards in the timeline", () => {
    const cards = [makeCard("c1", { resolved: "denied", createdAt: 1000 })];
    const { result } = renderHook(() => useTimeline([], cards));
    // Denied cards are settled and appear in timeline
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.activeCards).toHaveLength(0);
  });

  it("handles failed cards in the timeline", () => {
    const cards = [makeCard("c1", { resolved: "failed", output: "error", createdAt: 1000 })];
    const { result } = renderHook(() => useTimeline([], cards));
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.activeCards).toHaveLength(0);
  });

  it("handles failed cards without output as settled", () => {
    const cards = [makeCard("c1", { resolved: "failed", output: undefined, createdAt: 1000 })];
    const { result } = renderHook(() => useTimeline([], cards));
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.activeCards).toHaveLength(0);
  });

  it("filters categories and a named subagent without changing source order", () => {
    const messages = [
      makeMessage("assistant", "assistant", 1000),
      {
        ...makeMessage("subagent-1", "user", 2000),
        agentMessage: makeAgentMessage("subagent-1", "Research helper"),
      },
      {
        ...makeMessage("subagent-2", "user", 3000),
        agentMessage: makeAgentMessage("subagent-2", "Verifier"),
      },
      makeMessage("user", "user", 4000),
    ];
    const originalIds = messages.map((message) => message.id);
    const filter: TimelineFilterState = {
      ...createTimelineFilterState(),
      categories: ["subagent"],
      subagentId: "subagent-2",
    };

    const { result } = renderHook(() => useTimeline(messages, [], { filter }));

    expect(
      result.current.runs.flatMap((run) =>
        run.items.flatMap((item) => (item.kind === "message" ? [item.data.id] : [])),
      ),
    ).toEqual(["subagent-2"]);
    expect(messages.map((message) => message.id)).toEqual(originalIds);
  });

  it("applies inclusive date-time bounds before grouping", () => {
    const messages = [
      makeMessage("before", "assistant", new Date(2026, 6, 24, 12, 9).getTime()),
      makeMessage("boundary", "assistant", new Date(2026, 6, 24, 12, 10).getTime()),
      makeMessage("after", "assistant", new Date(2026, 6, 24, 12, 11).getTime()),
    ];
    const filter = {
      ...createTimelineFilterState(),
      from: "2026-07-24T12:10",
      to: "2026-07-24T12:10",
    };
    const { result } = renderHook(() => useTimeline(messages, [], { filter }));

    expect(result.current.visibleEntryCount).toBe(1);
    expect(result.current.runs[0]?.items[0]).toMatchObject({
      kind: "message",
      data: { id: "boundary" },
    });
  });

  it("filters every settled permission kind through the runtime category", () => {
    const filter: TimelineFilterState = {
      ...createTimelineFilterState(),
      categories: ["runtime"],
    };
    const cards = [
      makeCard("shell", { kind: "shell" }),
      makeCard("write", { kind: "write" }),
      makeCard("mcp", { kind: "mcp" }),
      makeCard("read", { kind: "read" }),
      makeCard("url", { kind: "url" }),
      makeCard("custom-tool", { kind: "custom-tool" }),
      makeCard("memory", { kind: "memory" }),
      makeCard("hook", { kind: "hook" }),
    ];
    const { result } = renderHook(() => useTimeline([], cards, { filter }));

    const permissionIds = result.current.timeline.flatMap((item) =>
      item.kind === "permissions" ? item.data.map((card) => card.id) : [],
    );
    expect(permissionIds).toEqual(cards.map((card) => card.id));
  });

  it("showcases all grouping variants in a realistic conversation", () => {
    // Simulate a full conversation with all possible grouping scenarios:
    //   user msg -> assistant msg -> 2 shell permissions (grouped) -> assistant msg
    //   -> user msg -> assistant msg -> 1 write + 1 mcp permission (grouped) -> assistant msg
    const msgs = [
      makeMessage("u1", "user", 1000),
      makeMessage("a1", "assistant", 2000),
      makeMessage("a2", "assistant", 5000),
      makeMessage("u2", "user", 6000),
      makeMessage("a3", "assistant", 7000),
      makeMessage("a4", "assistant", 10000),
    ];
    const cards = [
      makeCard("c1", { kind: "shell", createdAt: 3000 }),
      makeCard("c2", { kind: "shell", createdAt: 3500 }),
      makeCard("c3", { kind: "write", createdAt: 8000 }),
      makeCard("c4", { kind: "mcp", createdAt: 8500 }),
    ];
    const { result } = renderHook(() => useTimeline(msgs, cards));

    // Expected runs:
    // Run 0 (user): u1
    // Run 1 (assistant): a1, permissions[c1,c2], a2
    // Run 2 (user): u2
    // Run 3 (assistant): a3, permissions[c3,c4], a4
    expect(result.current.runs).toHaveLength(4);

    expect(result.current.runs[0].role).toBe("user");

    const run1 = result.current.runs[1];
    expect(run1.role).toBe("assistant");
    expect(run1.items).toHaveLength(3);
    expect(run1.items[0].kind).toBe("message");
    const run1Perm = permissionsData(run1.items[1]);
    expect(run1Perm).toHaveLength(2);
    expect(run1Perm[0].kind).toBe("shell");
    expect(run1.items[2].kind).toBe("message");

    expect(result.current.runs[2].role).toBe("user");

    const run3 = result.current.runs[3];
    expect(run3.role).toBe("assistant");
    expect(run3.items).toHaveLength(3);
    const run3Perm = permissionsData(run3.items[1]);
    expect(run3Perm).toHaveLength(2);
    expect(run3Perm[0].kind).toBe("write");
    expect(run3Perm[1].kind).toBe("mcp");
  });

  it("permission cards at the very start form an assistant run before any messages", () => {
    const msgs = [makeMessage("u1", "user", 3000)];
    const cards = [makeCard("c1", { createdAt: 1000 })];
    const { result } = renderHook(() => useTimeline(msgs, cards));
    // Run 0 (assistant): perm card
    // Run 1 (user): u1
    expect(result.current.runs).toHaveLength(2);
    expect(result.current.runs[0].role).toBe("assistant");
    expect(result.current.runs[0].items[0].kind).toBe("permissions");
    expect(result.current.runs[1].role).toBe("user");
  });

  it("mixes settled and active cards correctly", () => {
    const msgs = [makeMessage("a1", "assistant", 2000)];
    const cards = [
      makeCard("c1", { resolved: "allowed", output: "done", createdAt: 1000 }),
      makeCard("c2", { resolved: "denied", createdAt: 1500 }),
      makeCard("c3", { resolved: "allowed", output: undefined, createdAt: 3000 }), // running = active
      makeCard("c4", { resolved: undefined, output: undefined, createdAt: 4000 }), // pending = active
    ];
    const { result } = renderHook(() => useTimeline(msgs, cards));
    // c1 and c2 are settled -> in timeline; c3 and c4 are active
    expect(result.current.activeCards).toHaveLength(2);
    expect(result.current.activeCards.map((c) => c.id)).toEqual(["c3", "c4"]);
    // Timeline: permissions[c1,c2] then message a1
    expect(result.current.runs).toHaveLength(1);
    const items = result.current.runs[0].items;
    expect(items).toHaveLength(2);
    expect(permissionsData(items[0])).toHaveLength(2);
  });
});
