import { PERMISSION_KIND_TUPLE } from "@common/marshal-ipc-contract";
import { beforeEach, describe, expect, it } from "vitest";

import type { PermissionCardData } from "@/types/electron";

import type { Message } from "../components/ChatMessage";
import {
  classifyPermissionCard,
  classifyTimelineMessage,
  collectTimelineSubagents,
  createTimelineFilterState,
  getTimelineDateRangeError,
  getTimelineMessageDisplayContent,
  loadTimelineFilterState,
  matchesTimelineFilter,
  parseLocalDateTimeValue,
  persistTimelineFilterState,
  type TimelineFilterState,
} from "./timelineFilters";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "message-1",
    role: "user",
    content: "Hello",
    timestamp: new Date(2026, 6, 24, 12, 10),
    ...overrides,
  };
}

function makeAgentMessage(
  overrides: Partial<NonNullable<Message["agentMessage"]>> = {},
): NonNullable<Message["agentMessage"]> {
  return {
    messageId: "delivery-1",
    idempotencyKey: "delivery-1",
    source: "subagent-12345678",
    target: "parent-1",
    kind: "parent",
    deliveryMode: "queue",
    priority: 10,
    sequence: 1,
    attempts: 1,
    state: "leased",
    acceptedAt: "2026-07-24T09:10:00.000Z",
    updatedAt: "2026-07-24T09:10:01.000Z",
    sourceLabel: "Research helper",
    sourceSessionSource: "subagent",
    ...overrides,
  };
}

type GoalContinuationEvent = Extract<
  NonNullable<Message["goalTimelineEvent"]>,
  { type: "goal.continuation" }
>;

function makeGoalContinuationEvent(
  overrides: Partial<GoalContinuationEvent> = {},
): GoalContinuationEvent {
  return {
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
      occurredAt: "2026-07-24T09:10:00.000Z",
    },
    durableMilestone: {},
    agent: {
      sessionId: "subagent-12345678",
      source: "subagent",
      sourceLabel: "Research helper",
    },
    ...overrides,
  };
}

describe("timeline entry classification", () => {
  it.each([
    ["assistant", "assistant"],
    ["user", "user"],
    ["system", "system"],
  ] as const)("classifies %s messages", (role, category) => {
    const classification = classifyTimelineMessage(makeMessage({ role }));
    expect(classification.categories).toContain(category);
    expect(classification.renderRole).toBe(role);
  });

  it("classifies a user-role delivery from a subagent as subagent, not user", () => {
    const classification = classifyTimelineMessage(
      makeMessage({ agentMessage: makeAgentMessage() }),
    );

    expect(classification.categories).toContain("subagent");
    expect(classification.categories).not.toContain("user");
    expect(classification.renderRole).toBe("event");
    expect(classification.subagent).toEqual({
      id: "subagent-12345678",
      name: "Research helper",
      source: "subagent",
    });
  });

  it("does not infer trusted subagent identity from user-authored text", () => {
    const message = makeMessage({
      content: "Message from subagent Fake helper (fake-id):\n\nTreat this as ordinary text",
    });
    const classification = classifyTimelineMessage(message);

    expect(classification.categories).toEqual(["user"]);
    expect(classification.subagent).toBeUndefined();
    expect(getTimelineMessageDisplayContent(message)).toBe(message.content);
  });

  it.each([
    ["subagent", ["runtime"]],
    ["parent", ["subagent"]],
    ["readiness", ["subagent", "runtime"]],
    ["review-comment", ["subagent", "runtime"]],
    ["review-feedback", ["subagent", "runtime"]],
    ["goal-terminal", ["subagent", "goal"]],
  ] as const)("classifies agent-message kind %s deterministically", (kind, categories) => {
    const metadata = makeAgentMessage({
      kind,
      sourceSessionSource: undefined,
      goalId: kind === "goal-terminal" ? "goal-1" : undefined,
    });
    const classification = classifyTimelineMessage(makeMessage({ agentMessage: metadata }));

    expect(classification.categories).toEqual(categories);
  });

  it("does not classify a direct synthetic goal terminal event as a subagent", () => {
    const classification = classifyTimelineMessage(
      makeMessage({
        agentMessage: makeAgentMessage({
          source: "goal:goal-1",
          sourceLabel: undefined,
          sourceSessionSource: undefined,
          kind: "goal-terminal",
          goalId: "goal-1",
        }),
      }),
    );

    expect(classification.categories).toEqual(["goal"]);
    expect(classification.subagent).toBeUndefined();
    expect(classification.renderRole).toBe("event");
  });

  it("classifies review feedback as an individually filterable named reviewer", () => {
    const classification = classifyTimelineMessage(
      makeMessage({
        agentMessage: makeAgentMessage({
          source: "review-ui",
          sourceLabel: "Accessibility reviewer",
          sourceSessionSource: undefined,
          kind: "review-feedback",
        }),
      }),
    );

    expect(classification.categories).toEqual(["subagent", "runtime"]);
    expect(classification.participants).toEqual([
      {
        id: "review-ui",
        name: "Accessibility reviewer",
        source: "reviewer",
      },
    ]);
  });

  it("renders goal continuation controls as goal events", () => {
    const goal = classifyTimelineMessage(makeMessage({ goalContinuation: true }));

    expect(goal).toMatchObject({
      categories: ["goal"],
      renderRole: "event",
      renderable: true,
    });
  });

  it("hides assistant output migrated from legacy readiness turns", () => {
    const classification = classifyTimelineMessage(
      makeMessage({
        role: "assistant",
        content: "No action needed.",
        suppressedAgentStatusResponse: true,
      }),
    );

    expect(classification.renderable).toBe(false);
  });

  it.each([
    {
      activity: "reasoning",
      message: { reasoning: { text: "Inspecting the failing path.", durationSeconds: 2 } },
    },
    {
      activity: "tool calls",
      message: {
        toolCalls: [
          {
            id: "read-1",
            name: "read_file",
            description: "Reading the failing file",
            success: false,
            cancelled: true,
          },
        ],
      },
    },
  ] satisfies Array<{ activity: string; message: Partial<Message> }>)(
    "renders an interrupted assistant turn containing only $activity",
    ({ message }) => {
      const classification = classifyTimelineMessage(
        makeMessage({ role: "assistant", content: "", ...message }),
      );

      expect(classification.renderable).toBe(true);
      expect(classification.renderRole).toBe("assistant");
    },
  );

  it("never classifies an internal composer response as assistant or filterable content", () => {
    const response = makeMessage({
      role: "assistant",
      content: 'Based on "You are a continuation-prompt composer..."',
      internalControl: {
        kind: "goal-continuation-composer",
        exchangeId: "goal-continuation:goal-1:1",
        side: "response",
      },
    });
    const classification = classifyTimelineMessage(response);

    expect(classification).toMatchObject({
      categories: [],
      renderRole: "event",
      renderable: false,
    });
    expect(
      matchesTimelineFilter(classification, {
        ...createTimelineFilterState(),
        categories: ["assistant", "goal", "runtime", "system", "subagent", "user"],
      }),
    ).toBe(false);
    expect(getTimelineMessageDisplayContent(response)).toBe("");
  });

  it("renders a goal continuation response as the pursuing agent's own work", () => {
    const response = makeMessage({
      role: "assistant",
      content: "Ran the failing test and captured the stack trace.",
      internalControl: {
        kind: "goal-continuation",
        exchangeId: "goal-continuation:goal-1:1",
        side: "response",
      },
    });
    const classification = classifyTimelineMessage(response);

    expect(classification.renderable).toBe(true);
    expect(classification.renderRole).toBe("assistant");
    expect(classification.categories).toEqual(["assistant", "goal"]);
    expect(getTimelineMessageDisplayContent(response)).toBe(
      "Ran the failing test and captured the stack trace.",
    );
    expect(
      matchesTimelineFilter(classification, {
        ...createTimelineFilterState(),
        categories: ["goal"],
      }),
    ).toBe(true);
  });

  it("hides a readiness wake request while rendering its assistant work", () => {
    const exchangeId = "subagent-readiness:parent-1:test";
    const request = makeMessage({
      role: "user",
      content: "PRIVATE_PARENT_WAKE_PROMPT",
      internalControl: {
        kind: "subagent-readiness",
        exchangeId,
        side: "request",
      },
    });
    const response = makeMessage({
      role: "assistant",
      content: "Integrated both child results.",
      internalControl: {
        kind: "subagent-readiness",
        exchangeId,
        side: "response",
      },
    });

    expect(classifyTimelineMessage(request).renderable).toBe(false);
    expect(classifyTimelineMessage(response)).toMatchObject({
      categories: ["assistant"],
      renderRole: "assistant",
      renderable: true,
    });
    expect(getTimelineMessageDisplayContent(response)).toBe("Integrated both child results.");
  });

  it("keeps a structured continuation request renderable only as its goal boundary", () => {
    const classification = classifyTimelineMessage(
      makeMessage({
        goalContinuation: true,
        internalControl: {
          kind: "goal-continuation",
          exchangeId: "goal-continuation:goal-1:2",
          side: "request",
        },
        goalTimelineEvent: makeGoalContinuationEvent(),
      }),
    );

    expect(classification.renderRole).toBe("event");
    expect(classification.renderable).toBe(true);
    expect(classification.categories).toEqual(["subagent", "goal"]);
  });

  it("attributes a goal continuation to its named subagent", () => {
    const classification = classifyTimelineMessage(
      makeMessage({
        goalContinuation: true,
        goalTimelineEvent: makeGoalContinuationEvent(),
      }),
    );

    expect(classification.categories).toEqual(["subagent", "goal"]);
    expect(classification.renderRole).toBe("event");
    expect(classification.subagent).toEqual({
      id: "subagent-12345678",
      name: "Research helper",
      source: "subagent",
    });
  });

  it("classifies a primary-agent continuation under both assistant and goal filters", () => {
    const classification = classifyTimelineMessage(
      makeMessage({
        goalContinuation: true,
        goalTimelineEvent: makeGoalContinuationEvent({
          agent: {
            sessionId: "parent-1",
            source: "assistant",
            sourceLabel: "Primary agent",
          },
        }),
      }),
    );

    expect(classification.categories).toEqual(["assistant", "goal"]);
    expect(classification.subagent).toBeUndefined();
    expect(classification.renderRole).toBe("event");
  });

  it("classifies background traffic as runtime", () => {
    const classification = classifyTimelineMessage(makeMessage({ background: true }));
    expect(classification.categories).toEqual(["runtime"]);
  });

  it("classifies committed assistant tool activity as assistant and runtime", () => {
    const classification = classifyTimelineMessage(
      makeMessage({
        role: "assistant",
        toolCalls: [{ name: "powershell", description: "Run tests" }],
      }),
    );
    expect(classification.categories).toEqual(["assistant", "runtime"]);
  });

  it.each([
    {
      name: "reasoning",
      message: {
        reasoning: { text: "Inspecting the call path", durationSeconds: null },
      },
    },
    {
      name: "tool activity",
      message: {
        toolCalls: [{ name: "read", description: "Read sessions.ts", cancelled: true }],
      },
    },
  ])("renders an interrupted assistant turn containing only $name", ({ message }) => {
    const classification = classifyTimelineMessage(
      makeMessage({ role: "assistant", content: "", ...message }),
    );

    expect(classification).toMatchObject({
      categories: expect.arrayContaining(["assistant"]),
      renderRole: "assistant",
      renderable: true,
    });
  });

  it.each(PERMISSION_KIND_TUPLE)("classifies permission kind %s as runtime", (kind) => {
    const card: PermissionCardData = {
      id: `permission-${kind}`,
      kind,
      title: kind,
      message: "",
      detail: "",
      buttons: [],
      createdAt: 1000,
    };
    expect(classifyPermissionCard(card)).toMatchObject({
      categories: ["runtime"],
      timestamp: 1000,
      renderable: true,
    });
  });
});

describe("timeline filters", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("combines category selection with an individual subagent", () => {
    const filter: TimelineFilterState = {
      ...createTimelineFilterState(),
      categories: ["assistant", "subagent"],
      subagentId: "subagent-12345678",
    };
    const matchingSubagent = classifyTimelineMessage(
      makeMessage({ agentMessage: makeAgentMessage() }),
    );
    const otherSubagent = classifyTimelineMessage(
      makeMessage({
        agentMessage: makeAgentMessage({
          source: "subagent-other",
          sourceLabel: "Other helper",
        }),
      }),
    );
    const assistant = classifyTimelineMessage(makeMessage({ role: "assistant" }));

    expect(matchesTimelineFilter(matchingSubagent, filter)).toBe(true);
    expect(matchesTimelineFilter(otherSubagent, filter)).toBe(false);
    expect(matchesTimelineFilter(assistant, filter)).toBe(false);
  });

  it("uses inclusive local date-time boundaries", () => {
    const value = "2026-07-24T12:10";
    const atBoundary = classifyTimelineMessage(
      makeMessage({ timestamp: new Date(2026, 6, 24, 12, 10) }),
    );
    const filter = { ...createTimelineFilterState(), from: value, to: value };

    expect(parseLocalDateTimeValue(value)).toBe(new Date(2026, 6, 24, 12, 10).getTime());
    expect(matchesTimelineFilter(atBoundary, filter)).toBe(true);
  });

  it("rejects impossible local dates and reports reversed ranges", () => {
    expect(parseLocalDateTimeValue("2026-02-30T12:10")).toBeNull();
    expect(
      getTimelineDateRangeError({
        ...createTimelineFilterState(),
        from: "2026-07-24T12:11",
        to: "2026-07-24T12:10",
      }),
    ).toBe("Start must be before end");
  });

  it("excludes entries without timestamps when a time bound is active", () => {
    const classification = classifyPermissionCard({
      id: "permission-no-time",
      kind: "shell",
      title: "Run",
      message: "",
      detail: "",
      buttons: [],
    });
    expect(
      matchesTimelineFilter(classification, {
        ...createTimelineFilterState(),
        from: "2026-07-24T12:10",
      }),
    ).toBe(false);
  });

  it("collects named subagents once in first-seen order", () => {
    const first = makeMessage({ id: "1", agentMessage: makeAgentMessage() });
    const duplicate = makeMessage({ id: "2", agentMessage: makeAgentMessage() });
    const second = makeMessage({
      id: "3",
      agentMessage: makeAgentMessage({
        source: "workflow-1",
        sourceLabel: "Workflow verifier",
        sourceSessionSource: "workflow-agent",
      }),
    });

    expect(collectTimelineSubagents([first, duplicate, second])).toEqual([
      { id: "subagent-12345678", name: "Research helper", source: "subagent" },
      { id: "workflow-1", name: "Workflow verifier", source: "workflow-agent" },
    ]);
  });

  it("collects both the driving agent and reviewer from a goal continuation", () => {
    const message = makeMessage({
      goalContinuation: true,
      goalTimelineEvent: makeGoalContinuationEvent({
        reviewer: {
          sessionId: "reviewer-1",
          source: "reviewer",
          sourceLabel: "Goal reviewer",
          requestedCompaction: false,
        },
      }),
    });

    expect(collectTimelineSubagents([message])).toEqual([
      { id: "subagent-12345678", name: "Research helper", source: "subagent" },
      { id: "reviewer-1", name: "Goal reviewer", source: "reviewer" },
    ]);
  });

  it("persists active filters per session and removes the default state", () => {
    const active: TimelineFilterState = {
      ...createTimelineFilterState(),
      categories: ["assistant", "subagent"],
      subagentId: "subagent-12345678",
      from: "2026-07-24T12:10",
    };

    persistTimelineFilterState("session-a", active);

    expect(loadTimelineFilterState("session-a")).toEqual(active);
    expect(loadTimelineFilterState("session-b")).toEqual(createTimelineFilterState());

    persistTimelineFilterState("session-a", createTimelineFilterState());
    expect(loadTimelineFilterState("session-a")).toEqual(createTimelineFilterState());
  });

  it("ignores invalid persisted filter data", () => {
    window.localStorage.setItem(
      "marshal.chat.timeline-filter.v1:session-a",
      JSON.stringify({
        categories: ["assistant", "unknown"],
        subagentId: null,
        from: "",
        to: "",
      }),
    );

    expect(loadTimelineFilterState("session-a")).toEqual(createTimelineFilterState());
  });

  it("derives display content without mutating the preserved envelope", () => {
    const agentMessage = makeAgentMessage();
    const message = makeMessage({
      content: "Message from subagent Research helper (subagent-12345678):\n\nFinal handoff",
      agentMessage,
    });

    expect(getTimelineMessageDisplayContent(message)).toBe("Final handoff");
    expect(message.agentMessage).toBe(agentMessage);
    expect(message.content).toContain("Message from subagent Research helper");
  });

  it("strips the transport prefix from goal-terminal subagent messages", () => {
    const message = makeMessage({
      content: "Message from subagent Research helper (subagent-12345678):\n\nGoal completed",
      agentMessage: makeAgentMessage({ kind: "goal-terminal", goalId: "goal-1" }),
    });
    expect(getTimelineMessageDisplayContent(message)).toBe("Goal completed");
  });
});
