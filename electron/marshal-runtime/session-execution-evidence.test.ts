import { describe, expect, it } from "vitest";

import type { TurnLlmUsageEvent } from "../../common/marshal-ipc-contract";
import type { PersistedSession } from "../session-store";
import { testDouble } from "../testing/harness";
import { recordSessionExecutionUsage } from "./session-execution-evidence";

describe("session execution evidence", () => {
  it("keeps auxiliary and primary model rows from one provider result and deduplicates both after reload", () => {
    const session = testDouble<PersistedSession>({
      id: "worker",
      model: "claude-sonnet-5",
      runtimeActiveExecutionId: "worker:turn",
      messages: [],
    });
    const helper = testDouble<TurnLlmUsageEvent>({
      providerCallId: "same-result",
      model: "claude-haiku-4-5",
      inputTokens: 4887,
      outputTokens: 17,
      cacheReadTokens: 0,
      cost: 0.004972,
    });
    const primary = testDouble<TurnLlmUsageEvent>({
      providerCallId: "same-result",
      model: "claude-sonnet-5",
      inputTokens: 80000,
      outputTokens: 18000,
      cacheReadTokens: 70000,
      cost: 0.75,
    });
    recordSessionExecutionUsage(session, helper, "/worker.json", "high");
    recordSessionExecutionUsage(session, primary, "/worker.json", "high");
    const before = JSON.stringify(session.runtimeExecutions);
    const reloaded = testDouble<PersistedSession>(JSON.parse(JSON.stringify(session)));
    recordSessionExecutionUsage(reloaded, primary, "/worker.json", "high");
    recordSessionExecutionUsage(reloaded, helper, "/worker.json", "high");
    expect(JSON.stringify(reloaded.runtimeExecutions)).toBe(before);
    expect(reloaded.runtimeExecutions?.[0]).toMatchObject({
      model: "claude-sonnet-5",
      usage: {
        inputTokens: 84887,
        outputTokens: 18017,
        cachedInputTokens: 70000,
        costUsd: 0.754972,
      },
      usageByModel: [
        { model: "claude-haiku-4-5", usage: { outputTokens: 17 } },
        { model: "claude-sonnet-5", usage: { outputTokens: 18000 } },
      ],
    });
  });
  it("does not re-add old receipts persisted before model-aware deduplication", () => {
    const session = testDouble<PersistedSession>({
      id: "session",
      messages: [],
      runtimeActiveExecutionId: "turn",
      runtimeExecutions: [
        { executionId: "turn", callIds: ["old-result"], model: "old", usage: { inputTokens: 4 } },
      ],
    });
    recordSessionExecutionUsage(
      session,
      testDouble<TurnLlmUsageEvent>({ providerCallId: "old-result", model: "old", inputTokens: 4 }),
      "/session.json",
    );
    expect(session.runtimeExecutions?.[0]?.usage?.inputTokens).toBe(4);
  });
  it("persists counters by turn, deduplicates calls and never attributes later messages to the old turn", () => {
    const session = testDouble<PersistedSession>({
      id: "session",
      messages: [{ id: "first", role: "user", content: "work", timestamp: "now" }],
    });
    const usage = testDouble<TurnLlmUsageEvent>({
      model: "actual-model",
      inputTokens: 12,
      outputTokens: 4,
      cacheReadTokens: 7,
      cost: 0.03,
      apiCallId: "call-1",
    });
    recordSessionExecutionUsage(session, usage, "/data/session.json", "high");
    recordSessionExecutionUsage(session, usage, "/data/session.json", "high");
    const persisted = testDouble<PersistedSession>(JSON.parse(JSON.stringify(session)));
    persisted.messages.push(
      testDouble({ id: "later", role: "user", content: "unrelated follow-up", timestamp: "later" }),
    );
    recordSessionExecutionUsage(
      persisted,
      { ...usage, apiCallId: "call-2", inputTokens: 40 },
      "/data/session.json",
      "low",
    );
    expect(persisted.runtimeExecutions).toHaveLength(2);
    expect(persisted.runtimeExecutions?.[0]).toMatchObject({
      executionId: "session:first",
      model: "actual-model",
      reasoningEffort: "high",
      usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 7 },
    });
    expect(persisted.runtimeExecutions?.[1]).toMatchObject({
      executionId: "session:later",
      reasoningEffort: "low",
      usage: { inputTokens: 40 },
    });
    expect(JSON.stringify(persisted.runtimeExecutions)).not.toContain("unrelated follow-up");
  });
  it("keeps reasoning selected at dispatch while recording the actual usage model", () => {
    const session = testDouble<PersistedSession>({
      id: "session",
      messages: [{ id: "turn", role: "user", content: "work", timestamp: "now" }],
      runtimeExecutions: [
        {
          executionId: "session:turn",
          sessionId: "session",
          transcriptRef: "/session.json",
          model: "requested",
          reasoningEffort: "high",
        },
      ],
    });
    recordSessionExecutionUsage(
      session,
      testDouble<TurnLlmUsageEvent>({
        model: "resolved",
        inputTokens: 2,
        outputTokens: 1,
        cacheReadTokens: 0,
        cost: 0,
      }),
      "/session.json",
      "low",
    );
    expect(session.runtimeExecutions?.[0]).toMatchObject({
      model: "resolved",
      reasoningEffort: "high",
      usage: { inputTokens: 2 },
    });
  });
  it("attributes late usage to the dispatched turn when a newer user message is queued", () => {
    const session = testDouble<PersistedSession>({
      id: "session",
      runtimeActiveExecutionId: "session:active",
      messages: [
        { id: "active", role: "user", content: "task", timestamp: "now" },
        { id: "queued", role: "user", content: "later unrelated message", timestamp: "later" },
      ],
    });
    recordSessionExecutionUsage(
      session,
      testDouble<TurnLlmUsageEvent>({
        model: "actual",
        inputTokens: 9,
        outputTokens: 3,
        cacheReadTokens: 2,
        cost: 0.01,
      }),
      "/session.json",
      "high",
    );
    expect(session.runtimeExecutions?.[0]).toMatchObject({
      executionId: "session:active",
      usage: { inputTokens: 9 },
    });
    session.runtimeActiveExecutionId = "session:queued";
    recordSessionExecutionUsage(
      session,
      testDouble<TurnLlmUsageEvent>({
        model: "actual",
        inputTokens: 20,
        outputTokens: 4,
        cacheReadTokens: 0,
        cost: 0.02,
      }),
      "/session.json",
      "high",
    );
    expect(session.runtimeExecutions?.map((entry) => entry.usage?.inputTokens)).toEqual([9, 20]);
  });
  it("keeps model buckets separate and does not invent missing cost or cache measurements", () => {
    const session = testDouble<PersistedSession>({
      id: "session",
      runtimeActiveExecutionId: "turn",
      messages: [],
    });
    const usage = testDouble<TurnLlmUsageEvent>({
      model: "model-a",
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 0,
      cost: 0,
      usageAvailability: {
        inputTokens: true,
        outputTokens: true,
        cachedInputTokens: false,
        costUsd: false,
      },
    });
    recordSessionExecutionUsage(session, usage, "/session.json", "high");
    recordSessionExecutionUsage(
      session,
      {
        ...usage,
        model: "model-b",
        cost: 0.02,
        cacheReadTokens: 1,
        usageAvailability: {
          inputTokens: true,
          outputTokens: true,
          cachedInputTokens: true,
          costUsd: true,
        },
      },
      "/session.json",
      "high",
    );
    const receipt = session.runtimeExecutions?.[0];
    expect(receipt?.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(receipt?.model).toBeUndefined();
    expect(receipt?.usageByModel).toEqual([
      { model: "model-a", usage: { inputTokens: 5, outputTokens: 2 } },
      {
        model: "model-b",
        usage: { inputTokens: 5, outputTokens: 2, cachedInputTokens: 1, costUsd: 0.02 },
      },
    ]);
  });
});
