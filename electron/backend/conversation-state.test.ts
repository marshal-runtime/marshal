import { describe, expect, it } from "vitest";

import type { RuntimeConversationState } from "../../common/runtime-conversation-state";
import type { RuntimeSessionEvent, RuntimeSessionEventDataMap } from "../../common/runtime-events";
import { testDouble } from "../testing/harness/test-double";
import {
  MAX_HANDOFF_CONTEXT_CHARS,
  appendUserContext,
  handoffUserPrompt,
  stateFromEvents,
  validateConversationState,
} from "./conversation-state";

function event<T extends keyof RuntimeSessionEventDataMap>(
  type: T,
  data: RuntimeSessionEventDataMap[T],
): RuntimeSessionEvent {
  return testDouble<RuntimeSessionEvent>({ id: type, timestamp: "", parentId: null, type, data });
}

describe("runtime conversation handoff", () => {
  const source: RuntimeConversationState = {
    version: 1,
    sourceRuntimeId: "cursor",
    summary: "We chose a SQLite store.",
    messages: [
      {
        role: "user",
        content:
          "<marshal-instructions>\nSource Marshal prompt\n</marshal-instructions>\n\n<user-request>\nImplement migration\n</user-request>",
      },
      { role: "assistant", content: "Migration is ready." },
    ],
  };

  it("removes Cursor's prompt and retains the actual request without changing the source", () => {
    const cleaned = validateConversationState(source);
    expect(cleaned.messages[0].content).toBe("Implement migration");
    expect(source.messages[0].content).toContain("Source Marshal prompt");
    expect(handoffUserPrompt(source, "continue")).not.toContain("Source Marshal prompt");
  });

  it("expands a previous handoff exactly once when switching back", () => {
    const target: RuntimeConversationState = {
      version: 1,
      sourceRuntimeId: "claude",
      messages: [],
    };
    appendUserContext(target, handoffUserPrompt(source, "Review </user-request> handling"));
    target.messages.push({ role: "assistant", content: "Reviewed." });
    const roundtrip: RuntimeConversationState = {
      version: 1,
      sourceRuntimeId: "cursor",
      messages: [],
    };
    appendUserContext(
      roundtrip,
      `<marshal-instructions>\nNew prompt\n</marshal-instructions>\n\n<user-request>\n${handoffUserPrompt(target, "ship")}\n</user-request>`,
    );
    expect(roundtrip.summary).toBe(source.summary);
    expect(roundtrip.messages.map((message) => message.content)).toEqual([
      "Implement migration",
      "Migration is ready.",
      "Review </user-request> handling",
      "Reviewed.",
      "ship",
    ]);
    expect(JSON.stringify(roundtrip)).not.toContain("marshal-conversation-state");
  });

  it("uses the latest compaction summary and only the subsequent turns", () => {
    const state = stateFromEvents("copilot", [
      event("user.message", { content: "obsolete" }),
      event("session.compaction_complete", { summaryContent: "first summary" }),
      event("user.message", { content: "also obsolete" }),
      event("session.compaction_complete", { summaryContent: "current summary" }),
      event("user.message", { content: "next step" }),
      event("tool.execution_start", {
        toolCallId: "t",
        toolName: "read",
        arguments: { path: "a" },
      }),
      event("tool.execution_complete", { toolCallId: "t", success: true, result: "file contents" }),
      event("assistant.message", { content: "done" }),
    ]);
    expect(state.summary).toBe("current summary");
    expect(state.messages.map((message) => message.role)).toEqual([
      "user",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(JSON.stringify(state)).not.toContain("obsolete");
  });

  it("drops oldest complete messages and preserves recent context without altering the source", () => {
    const oversizedState: RuntimeConversationState = {
      version: 1,
      sourceRuntimeId: "claude",
      summary: "Latest native summary",
      messages: [
        { role: "user", content: "old".repeat(MAX_HANDOFF_CONTEXT_CHARS) },
        { role: "assistant", content: "recent answer" },
        { role: "user", content: "latest question" },
      ],
    };
    const clean = validateConversationState(oversizedState);
    expect(clean.messages).toEqual(oversizedState.messages.slice(1));
    expect(clean.summary).toContain("Latest native summary");
    expect(clean.summary).toContain("omitted older retained context");
    expect(oversizedState.messages).toHaveLength(3);
    expect(oversizedState.summary).toBe("Latest native summary");
    expect(validateConversationState(clean)).toEqual(clean);
    expect(handoffUserPrompt(oversizedState, "continue")).toContain("latest question");
  });

  it("keeps the tail of a single oversized message within the limit", () => {
    const oversizedState: RuntimeConversationState = {
      version: 1,
      sourceRuntimeId: "cursor",
      messages: [
        { role: "tool", content: "x".repeat(MAX_HANDOFF_CONTEXT_CHARS) + "latest result" },
      ],
    };
    const clean = validateConversationState(oversizedState);
    expect(clean.messages[0].content).toMatch(/latest result$/);
    expect((clean.summary?.length ?? 0) + clean.messages[0].content.length).toBe(
      MAX_HANDOFF_CONTEXT_CHARS,
    );
    expect(oversizedState.messages[0].content.length).toBeGreaterThan(MAX_HANDOFF_CONTEXT_CHARS);
  });

  it("bounds an oversized summary while retaining the newest messages", () => {
    const clean = validateConversationState({
      version: 1,
      sourceRuntimeId: "claude",
      summary: "s".repeat(MAX_HANDOFF_CONTEXT_CHARS) + "latest summary facts",
      messages: [{ role: "user", content: "newest request" }],
    });
    expect(clean.summary).toMatch(/latest summary facts$/);
    expect(clean.messages[0].content).toBe("newest request");
    expect((clean.summary?.length ?? 0) + clean.messages[0].content.length).toBeLessThanOrEqual(
      MAX_HANDOFF_CONTEXT_CHARS,
    );
    const summaryOnly = validateConversationState({
      version: 1,
      sourceRuntimeId: "claude",
      summary: "s".repeat(MAX_HANDOFF_CONTEXT_CHARS + 1),
      messages: [],
    });
    expect(summaryOnly.summary?.length).toBe(MAX_HANDOFF_CONTEXT_CHARS);
  });

  it("reports unavailable summaries without discarding failed-compaction history", () => {
    expect(() => stateFromEvents("copilot", [event("session.compaction_complete", {})])).toThrow(
      "compaction summary",
    );
    expect(
      stateFromEvents("copilot", [
        event("user.message", { content: "keep" }),
        event("session.compaction_complete", { success: false }),
      ]).messages,
    ).toEqual([{ role: "user", content: "keep" }]);
  });
});
