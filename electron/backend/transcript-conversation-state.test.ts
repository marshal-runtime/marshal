import { describe, expect, it } from "vitest";

import type { SessionMessage } from "../../common/marshal-ipc-contract";
import type { RuntimeConversationState } from "../../common/runtime-conversation-state";
import { MAX_HANDOFF_CONTEXT_CHARS } from "./conversation-state";
import {
  buildTranscriptConversationState,
  reconcileWithTranscript,
} from "./transcript-conversation-state";

let nextId = 0;
function message(
  role: SessionMessage["role"],
  content: string,
  extra: Partial<SessionMessage> = {},
): SessionMessage {
  nextId += 1;
  return { id: `m${nextId}`, role, content, timestamp: "", ...extra };
}

function size(state: RuntimeConversationState): number {
  return (
    (state.summary?.length ?? 0) +
    state.messages.reduce((total, entry) => total + entry.content.length, 0)
  );
}

describe("buildTranscriptConversationState", () => {
  it("keeps real turns in order, records tools, and skips failures and hidden plumbing", () => {
    const state = buildTranscriptConversationState(
      {
        messages: [
          message("user", "Plan the migration"),
          message("assistant", "Here is the plan.", {
            toolCalls: [
              {
                name: "readFile",
                description: "",
                input: '{"path":"db.ts"}',
                output: "x".repeat(5_000),
              },
            ],
          }),
          message("assistant", "Request failed", { error: true }),
          message("assistant", "status ack", { suppressedAgentStatusResponse: true }),
          message("user", "hidden composer prompt", {
            internalControl: {
              exchangeId: "e",
              kind: "goal-continuation-composer",
              side: "request",
            } as SessionMessage["internalControl"],
          }),
          message("user", "Keep pursuing the goal", { goalContinuation: true }),
          message("system", 'Subagent "worker" is idle and ready for follow-up.'),
          message("user", "Ship it"),
        ],
      },
      "codex",
      "export-failed",
    );
    expect(state.sourceRuntimeId).toBe("codex");
    expect(state.summary).toContain("rebuilt this context from its own chat transcript");
    expect(state.summary).toContain("reason: export-failed");
    expect(state.messages.map((entry) => entry.role)).toEqual([
      "user",
      "tool",
      "assistant",
      "user",
      "user",
      "user",
    ]);
    expect(state.messages[0].content).toBe("Plan the migration");
    const tool: unknown = JSON.parse(state.messages[1].content);
    expect(tool).toMatchObject({ name: "readFile", input: '{"path":"db.ts"}' });
    expect(String(Reflect.get(Object(tool), "output")).length).toBeLessThan(2_100);
    expect(state.messages[3].content).toBe("Keep pursuing the goal");
    expect(state.messages[4].content).toContain("[Marshal notice]");
    expect(state.messages.at(-1)?.content).toBe("Ship it");
    expect(JSON.stringify(state)).not.toContain("Request failed");
    expect(JSON.stringify(state)).not.toContain("hidden composer prompt");
  });

  it("removes host transport wrappers from user turns", () => {
    const state = buildTranscriptConversationState(
      {
        messages: [
          message(
            "user",
            "<marshal-instructions>\nprompt\n</marshal-instructions>\n\n<user-request>\nfix it\n</user-request>",
          ),
        ],
      },
      "cursor",
      "missing-native-id",
    );
    expect(state.messages).toEqual([{ role: "user", content: "fix it" }]);
  });

  it("trims to the transfer bound and keeps the newest turns", () => {
    const messages = Array.from({ length: 60 }, (_, index) =>
      message(index % 2 ? "assistant" : "user", `${index}:${"y".repeat(5_000)}`),
    );
    const state = buildTranscriptConversationState({ messages }, "claude", "export-failed");
    expect(size(state)).toBeLessThanOrEqual(MAX_HANDOFF_CONTEXT_CHARS);
    expect(state.messages.at(-1)?.content.startsWith("59:")).toBe(true);
    expect(state.summary).toContain("omitted older retained context");
  });

  it("uses Marshal's cached summary instead of dropping turns when the transcript is too large", () => {
    const messages = Array.from({ length: 60 }, (_, index) =>
      message(index % 2 ? "assistant" : "user", `${index}:${"z".repeat(5_000)}`),
    );
    const state = buildTranscriptConversationState(
      {
        messages,
        contextSummary: "Summary of the first forty messages.",
        summaryUpToMessageId: messages[39].id,
      },
      "claude",
      "export-unavailable",
    );
    expect(state.summary).toContain("Summary of the first forty messages.");
    expect(state.messages[0].content.startsWith("40:")).toBe(true);
    expect(size(state)).toBeLessThanOrEqual(MAX_HANDOFF_CONTEXT_CHARS);
  });
});

describe("reconcileWithTranscript", () => {
  const transcript = [
    message("user", "first question"),
    message("assistant", "first answer"),
    message("user", "second question"),
    message("assistant", "second answer"),
    message("user", "third question"),
    message("assistant", "third answer"),
  ];

  it("leaves a complete state untouched", () => {
    const state: RuntimeConversationState = {
      version: 1,
      sourceRuntimeId: "claude",
      summary: "native summary",
      messages: [
        { role: "user", content: "third question" },
        { role: "assistant", content: "third answer" },
      ],
    };
    expect(reconcileWithTranscript(state, { messages: transcript })).toEqual({ state });
  });

  it("appends turns that ran after the state was captured", () => {
    const state: RuntimeConversationState = {
      version: 1,
      sourceRuntimeId: "claude",
      summary: "native summary",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
      ],
    };
    const result = reconcileWithTranscript(state, { messages: transcript });
    expect(result.repair).toBe("extended");
    expect(result.state.summary).toBe("native summary");
    expect(result.state.messages.map((entry) => entry.content)).toEqual([
      "first question",
      "first answer",
      "second question",
      "second answer",
      "third question",
      "third answer",
    ]);
  });

  it("prepends older turns a summary-less native session never saw", () => {
    const state: RuntimeConversationState = {
      version: 1,
      sourceRuntimeId: "claude",
      messages: [
        { role: "user", content: "third question" },
        { role: "assistant", content: "third answer" },
      ],
    };
    const result = reconcileWithTranscript(state, { messages: transcript }, { fresh: true });
    expect(result.repair).toBe("extended");
    expect(result.state.messages.map((entry) => entry.content)).toEqual([
      "first question",
      "first answer",
      "second question",
      "second answer",
      "third question",
      "third answer",
    ]);
  });

  it("trusts a fresh native summary that covers every turn", () => {
    const state: RuntimeConversationState = {
      version: 1,
      sourceRuntimeId: "cursor",
      summary: "Everything so far, compacted.",
      messages: [],
    };
    expect(reconcileWithTranscript(state, { messages: transcript }, { fresh: true })).toEqual({
      state,
    });
  });

  it("rebuilds from the transcript with the native summary when no turn is shared", () => {
    const state: RuntimeConversationState = {
      version: 1,
      sourceRuntimeId: "codex",
      summary: "compacted native summary",
      messages: [],
    };
    const result = reconcileWithTranscript(state, { messages: transcript });
    expect(result.repair).toBe("rebuilt");
    expect(result.state.sourceRuntimeId).toBe("codex");
    expect(result.state.summary).toContain("reason: stale-checkpoint");
    expect(result.state.summary).toContain("compacted native summary");
    expect(result.state.messages).toHaveLength(6);
  });
});
