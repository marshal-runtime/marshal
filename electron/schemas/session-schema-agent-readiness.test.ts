import { describe, expect, it } from "vitest";

import { StoredSessionSchema, normalizeLegacyReadinessMessages } from "./session-schema";

const legacyReadinessContent =
  'Message from subagent Worker (child-1):\n\nSubagent "Worker" (child-1) is idle and ready for follow-up.';

describe("legacy subagent readiness migration", () => {
  it("drops legacy tool-pin control turns", () => {
    const parsed = StoredSessionSchema.parse({
      id: "session",
      name: "Session",
      createdAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z",
      hasUnread: false,
      isActive: true,
      messages: [
        {
          id: "legacy-tool-pin",
          role: "user",
          content: "call tool_search_tool_regex",
          timestamp: "2026-08-08T12:00:00.000Z",
          toolPinNudge: true,
        },
        {
          id: "user-message",
          role: "user",
          content: "Hello",
          timestamp: "2026-08-08T12:00:01.000Z",
        },
      ],
    });

    expect(parsed.messages.map((message) => message.id)).toEqual(["user-message"]);
  });

  it("preserves hidden relay progress control metadata", () => {
    const parsed = StoredSessionSchema.parse({
      id: "session",
      name: "Session",
      createdAt: "2026-08-08T12:00:00.000Z",
      updatedAt: "2026-08-08T12:00:00.000Z",
      hasUnread: false,
      isActive: true,
      messages: [
        {
          id: "relay-progress:session:test",
          role: "user",
          content: "Consider a useful update.",
          timestamp: "2026-08-08T12:00:00.000Z",
          internalControl: {
            kind: "relay-progress",
            exchangeId: "relay-progress:session:test",
            side: "request",
          },
        },
      ],
    });

    expect(parsed.messages[0]?.internalControl).toEqual({
      kind: "relay-progress",
      exchangeId: "relay-progress:session:test",
      side: "request",
    });
  });

  it("migrates a structured idle envelope to readiness state and suppresses its model reply", () => {
    const parsed = StoredSessionSchema.parse({
      id: "parent",
      name: "Parent",
      createdAt: "2026-07-25T08:00:00.000Z",
      updatedAt: "2026-07-25T08:01:00.000Z",
      hasUnread: false,
      isActive: true,
      messages: [
        {
          id: "legacy-idle",
          role: "user",
          content: legacyReadinessContent,
          timestamp: "2026-07-25T08:00:00.000Z",
          agentMessage: {
            source: "child-1",
            sourceLabel: "Worker",
            sourceSessionSource: "subagent",
            kind: "parent",
            deliveryMode: "queue",
            sequence: 4,
            messageId: "legacy-idle",
            idempotencyKey: "subagent-idle:child-1:2026-07-25T08:00:00.000Z",
            target: "parent",
          },
        },
        {
          id: "legacy-reply",
          role: "assistant",
          content: "No action needed.",
          timestamp: "2026-07-25T08:00:01.000Z",
        },
        {
          id: "handoff",
          role: "user",
          content: "Message from subagent Worker (child-1):\n\nImplementation complete.",
          timestamp: "2026-07-25T08:01:00.000Z",
          agentMessage: {
            source: "child-1",
            sourceLabel: "Worker",
            sourceSessionSource: "subagent",
            kind: "parent",
            deliveryMode: "queue",
            sequence: 5,
          },
        },
      ],
    });

    expect(parsed.messages[0]).toMatchObject({
      role: "system",
      agentMessage: {
        source: "child-1",
        kind: "readiness",
        readinessGeneration: "legacy:subagent-idle:child-1:2026-07-25T08:00:00.000Z",
      },
    });
    expect(parsed.messages[1]?.suppressedAgentStatusResponse).toBe(true);
    expect(parsed.messages[2]).toMatchObject({
      role: "user",
      agentMessage: { kind: "parent" },
    });
  });

  it("does not reinterpret exact text without the legacy transport identity", () => {
    const [userAuthored, explicitHandoff] = normalizeLegacyReadinessMessages([
      {
        id: "user-text",
        role: "user",
        content: legacyReadinessContent,
        timestamp: "2026-07-25T08:00:00.000Z",
      },
      {
        id: "explicit-handoff",
        role: "user",
        content: legacyReadinessContent,
        timestamp: "2026-07-25T08:00:01.000Z",
        agentMessage: {
          source: "child-1",
          sourceLabel: "Worker",
          sourceSessionSource: "subagent",
          kind: "parent",
          deliveryMode: "queue",
          sequence: 1,
          idempotencyKey: "explicit-handoff",
        },
      },
    ]);

    expect(userAuthored?.role).toBe("user");
    expect(userAuthored).not.toHaveProperty("agentMessage");
    expect(explicitHandoff).toMatchObject({
      role: "user",
      agentMessage: { kind: "parent", idempotencyKey: "explicit-handoff" },
    });
  });

  it("normalizes internal control and legacy readiness exchanges without cross-contamination", () => {
    const parsed = StoredSessionSchema.parse({
      id: "mixed-control",
      name: "Mixed control",
      createdAt: "2026-07-25T08:00:00.000Z",
      updatedAt: "2026-07-25T08:01:00.000Z",
      hasUnread: false,
      isActive: true,
      messages: [
        {
          id: "goal-request",
          role: "user",
          content: "PRIVATE_GOAL_CONTINUATION",
          timestamp: "2026-07-25T08:00:00.000Z",
          goalContinuation: true,
        },
        {
          id: "goal-response",
          role: "assistant",
          content: "PRIVATE_GOAL_RESULT",
          timestamp: "2026-07-25T08:00:01.000Z",
        },
        {
          id: "legacy-idle",
          role: "user",
          content: legacyReadinessContent,
          timestamp: "2026-07-25T08:00:02.000Z",
          agentMessage: {
            source: "child-1",
            sourceLabel: "Worker",
            sourceSessionSource: "subagent",
            kind: "parent",
            deliveryMode: "queue",
            sequence: 4,
            messageId: "legacy-idle",
            idempotencyKey: "subagent-idle:child-1:2026-07-25T08:00:02.000Z",
            target: "mixed-control",
          },
        },
        {
          id: "legacy-reply",
          role: "assistant",
          content: "No action needed.",
          timestamp: "2026-07-25T08:00:03.000Z",
        },
      ],
    });

    expect(parsed.messages).toMatchObject([
      {
        id: "goal-request",
        internalControl: { kind: "goal-continuation", side: "request" },
      },
      {
        id: "goal-response",
        internalControl: { kind: "goal-continuation", side: "response" },
      },
      {
        id: "legacy-idle",
        role: "system",
        agentMessage: { kind: "readiness", readinessGeneration: expect.any(String) },
      },
      {
        id: "legacy-reply",
        suppressedAgentStatusResponse: true,
      },
    ]);
    expect(parsed.messages[3]).not.toHaveProperty("internalControl");
  });

  it("preserves subagent readiness control correlation", () => {
    const parsed = StoredSessionSchema.parse({
      id: "readiness-control",
      name: "Readiness control",
      createdAt: "2026-07-25T08:00:00.000Z",
      updatedAt: "2026-07-25T08:01:00.000Z",
      hasUnread: false,
      isActive: true,
      messages: [
        {
          id: "request",
          role: "user",
          content: "PRIVATE_PARENT_WAKE_PROMPT",
          timestamp: "2026-07-25T08:00:00.000Z",
          internalControl: {
            kind: "subagent-readiness",
            exchangeId: "subagent-readiness:parent:test",
            side: "request",
          },
        },
        {
          id: "response",
          role: "assistant",
          content: "Integrated the child result.",
          timestamp: "2026-07-25T08:00:01.000Z",
          internalControl: {
            kind: "subagent-readiness",
            exchangeId: "subagent-readiness:parent:test",
            side: "response",
          },
        },
      ],
    });

    expect(parsed.messages.map((message) => message.internalControl)).toEqual([
      {
        kind: "subagent-readiness",
        exchangeId: "subagent-readiness:parent:test",
        side: "request",
      },
      {
        kind: "subagent-readiness",
        exchangeId: "subagent-readiness:parent:test",
        side: "response",
      },
    ]);
  });

  it("preserves the readiness backend execution identity for restart reconciliation", () => {
    const parsed = StoredSessionSchema.parse({
      id: "readiness-execution",
      name: "Readiness execution",
      createdAt: "2026-07-25T08:00:00.000Z",
      updatedAt: "2026-07-25T08:01:00.000Z",
      hasUnread: false,
      isActive: true,
      messages: [
        {
          id: "readiness-1",
          role: "system",
          content: "Child ready",
          timestamp: "2026-07-25T08:00:00.000Z",
          agentMessage: {
            source: "child-1",
            kind: "readiness",
            deliveryMode: "queue",
            sequence: 1,
            messageId: "readiness-1",
            readinessGeneration: "generation-1",
            readinessWakeVersion: 1,
            readinessDispatchExchangeId: "subagent-readiness:parent:test",
          },
        },
      ],
    });

    expect(parsed.messages[0]?.agentMessage?.readinessDispatchExchangeId).toBe(
      "subagent-readiness:parent:test",
    );
  });

  it("preserves a durable relay origin for choice and publication scoping", () => {
    const parsed = StoredSessionSchema.parse({
      id: "relay-origin",
      name: "Relay origin",
      createdAt: "2026-08-09T01:00:00.000Z",
      updatedAt: "2026-08-09T01:00:00.000Z",
      hasUnread: false,
      isActive: true,
      messages: [
        {
          id: "relay-message",
          role: "user",
          content: "Relay turn",
          timestamp: "2026-08-09T01:00:00.000Z",
          agentMessage: {
            source: "relay",
            kind: "relay",
            deliveryMode: "interrupt",
            sequence: 1,
            relayOrigin: {
              providerId: "example-chat",
              accountId: "default",
              conversationId: "legacy-bot",
            },
          },
        },
      ],
    });

    expect(parsed.messages[0]?.agentMessage?.relayOrigin).toEqual({
      providerId: "example-chat",
      accountId: "default",
      conversationId: "legacy-bot",
    });
  });
});
