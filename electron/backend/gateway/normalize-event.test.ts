import { describe, expect, it } from "vitest";

import { expectBackendEvent } from "../../testing/harness/backend-events";
import { normalizeGatewayEvent, normalizeHistoryMessages } from "./normalize-event";

describe("normalizeGatewayEvent", () => {
  // 1. assistant stream with delta → text-delta
  it("maps assistant stream with delta to text-delta", () => {
    const result = normalizeGatewayEvent("agent", {
      stream: "assistant",
      data: { delta: "Hello", text: "Hello" },
    });
    expect(result).toEqual([{ type: "text-delta", text: "Hello" }]);
  });

  // 2. assistant stream with only text (no delta) → text-snapshot
  it("maps assistant stream with only text to text-snapshot", () => {
    const result = normalizeGatewayEvent("agent", {
      stream: "assistant",
      data: { text: "Hello world" },
    });
    expect(result).toEqual([{ type: "text-snapshot", text: "Hello world" }]);
  });

  // 3. assistant stream with empty data → no event
  it("returns no event for assistant stream with empty data", () => {
    const result = normalizeGatewayEvent("agent", {
      stream: "assistant",
      data: {},
    });
    expect(result).toEqual([]);
  });

  // 4. lifecycle stream with phase "end" → no event (idle is emitted from chat.final,
  //    not lifecycle.end — emitting it here would reset the accumulator before the
  //    final message arrives and wipe the committed content).
  it("returns no event for lifecycle stream with phase end", () => {
    const result = normalizeGatewayEvent("agent", {
      stream: "lifecycle",
      data: { phase: "end" },
    });
    expect(result).toEqual([]);
  });

  // 5. lifecycle stream with other phase → no event
  it("returns no event for lifecycle stream with non-end phase", () => {
    const result = normalizeGatewayEvent("agent", {
      stream: "lifecycle",
      data: { phase: "start" },
    });
    expect(result).toEqual([]);
  });

  // 6. tool stream phase:"start" → tool-start event
  // (Tool-stream tests use minimal payloads — the normalizer only reads `stream`
  // and `data` for these events; envelope fields like runId/seq/ts are
  // session-routing concerns handled one layer up in GatewaySessionBackend.)
  it("maps tool phase:start to a tool-start BackendEvent", () => {
    const result = normalizeGatewayEvent("agent", {
      stream: "tool",
      data: {
        phase: "start",
        name: "shell",
        toolCallId: "tc-abc",
        args: { command: "ls -la" },
      },
    });
    expect(result).toHaveLength(1);
    const evt = expectBackendEvent(result[0], "tool-start");
    expect(evt.toolCallId).toBe("tc-abc");
    expect(evt.toolName).toBe("shell");
    expect(evt.args).toEqual({ command: "ls -la" });
    expect(evt.startedAtMs).toEqual(expect.any(Number));
  });

  it("preserves third-party tool identity and server attribution", () => {
    const result = normalizeGatewayEvent("agent", {
      stream: "tool",
      data: {
        phase: "start",
        name: "mail_send_email",
        serverName: "third-party",
        toolCallId: "tc-external",
        args: {},
      },
    });

    expect(expectBackendEvent(result[0], "tool-start")).toEqual(
      expect.objectContaining({
        toolName: "mail_send_email",
        serverName: "third-party",
      }),
    );
  });

  it("preserves a serverless event name when origin metadata is unavailable", () => {
    const result = normalizeGatewayEvent("agent", {
      stream: "tool",
      data: {
        phase: "start",
        name: "marshal_recall",
        toolCallId: "tc-host",
        args: {},
      },
    });

    expect(expectBackendEvent(result[0], "tool-start").toolName).toBe("marshal_recall");
  });

  // 6b. tool stream phase:"result" (success) → tool-result event with success:true
  it("maps tool phase:result with isError:false to a successful tool-result event", () => {
    const result = normalizeGatewayEvent("agent", {
      stream: "tool",
      data: {
        phase: "result",
        name: "shell",
        toolCallId: "tc-abc",
        isError: false,
        result: { stdout: "file.txt\n", exitCode: 0 },
      },
    });
    expect(result).toHaveLength(1);
    const evt = expectBackendEvent(result[0], "tool-result");
    expect(evt.toolCallId).toBe("tc-abc");
    expect(evt.success).toBe(true);
    expect(evt.result).toEqual({ stdout: "file.txt\n", exitCode: 0 });
    expect(evt.error).toBeUndefined();
    expect(evt.completedAtMs).toEqual(expect.any(Number));
  });

  // 6c. tool stream phase:"result" (error) → tool-result event with success:false + error from result.details.error
  it("maps tool phase:result with isError:true to a failed tool-result event and extracts the error from result.details.error", () => {
    const result = normalizeGatewayEvent("agent", {
      stream: "tool",
      data: {
        phase: "result",
        name: "shell",
        toolCallId: "tc-abc",
        isError: true,
        result: { details: { error: "Command not found: foo" } },
      },
    });
    expect(result).toHaveLength(1);
    const evt = expectBackendEvent(result[0], "tool-result");
    expect(evt.toolCallId).toBe("tc-abc");
    expect(evt.success).toBe(false);
    expect(evt.error).toBe("Command not found: foo");
  });

  // 6c-bis. tool stream phase:"result" (error) → extracts error from top-level result.error when there's no details wrapper
  it("maps tool phase:result with isError:true and extracts the error from result.error when details is absent", () => {
    const result = normalizeGatewayEvent("agent", {
      stream: "tool",
      data: {
        phase: "result",
        name: "shell",
        toolCallId: "tc-abc",
        isError: true,
        result: { error: "Permission denied" },
      },
    });
    const evt = expectBackendEvent(result[0], "tool-result");
    expect(evt.success).toBe(false);
    expect(evt.error).toBe("Permission denied");
  });

  // 6c-ter. tool stream phase:"result" (error) with a bare-string `result` → success:false + that string as error.
  it("maps tool phase:result with isError:true and a bare-string result to a failed event with that error", () => {
    const result = normalizeGatewayEvent("agent", {
      stream: "tool",
      data: {
        phase: "result",
        name: "shell",
        toolCallId: "tc-x",
        isError: true,
        result: "Permission denied",
      },
    });
    const evt = expectBackendEvent(result[0], "tool-result");
    expect(evt.success).toBe(false);
    expect(evt.error).toBe("Permission denied");
  });

  // 6d. tool phase:"update" (live partial results) → no event (no tool-delta BackendEvent)
  it("returns no event for tool phase:update — no tool-delta variant in the BackendEvent contract", () => {
    const result = normalizeGatewayEvent("agent", {
      stream: "tool",
      data: {
        phase: "update",
        name: "shell",
        toolCallId: "tc-abc",
        partialResult: { stdout: "file" },
      },
    });
    expect(result).toEqual([]);
  });

  // 6e. tool stream missing toolCallId → no event (don't synthesise events the UI can't correlate)
  it("returns no event when tool payload is missing toolCallId", () => {
    const result = normalizeGatewayEvent("agent", {
      stream: "tool",
      data: { phase: "start", name: "shell", args: {} },
    });
    expect(result).toEqual([]);
  });

  // 6f. tool stream phase:"start" missing name → no event (tool-start needs the name to render the card)
  it("returns no event when tool phase:start payload is missing name", () => {
    const result = normalizeGatewayEvent("agent", {
      stream: "tool",
      data: { phase: "start", toolCallId: "tc-abc", args: {} },
    });
    expect(result).toEqual([]);
  });

  // 6f-bis. tool stream phase:"result" missing name → still emits the result event (renderer correlates by toolCallId)
  it("still emits tool-result for phase:result even when name is missing — correlation is by toolCallId", () => {
    const result = normalizeGatewayEvent("agent", {
      stream: "tool",
      data: { phase: "result", toolCallId: "tc-abc", isError: false, result: {} },
    });
    const evt = expectBackendEvent(result[0], "tool-result");
    expect(evt.toolCallId).toBe("tc-abc");
    expect(evt.success).toBe(true);
  });

  // 6g. tool stream with unknown phase → no event
  it("returns no event for tool stream with an unknown phase", () => {
    const result = normalizeGatewayEvent("agent", {
      stream: "tool",
      data: { phase: "cancelled", name: "shell", toolCallId: "tc-abc" },
    });
    expect(result).toEqual([]);
  });

  // 7. non-agent non-chat event → no event
  it("returns no event for unknown event names", () => {
    const result = normalizeGatewayEvent("presence", {
      stream: "assistant",
      data: { delta: "Hello" },
    });
    expect(result).toEqual([]);
  });

  // 8. agent event with unknown stream → no event
  it("returns no event for agent event with unknown stream", () => {
    const result = normalizeGatewayEvent("agent", {
      stream: "unknown-stream",
      data: { something: "value" },
    });
    expect(result).toEqual([]);
  });

  // 9. chat event with state "final" and text content → [turn-complete, idle]
  it("maps chat.final with text content to turn-complete + idle", () => {
    const result = normalizeGatewayEvent("chat", {
      runId: "run-42",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello from Aether" }],
      },
    });
    expect(result).toHaveLength(2);
    const tc = expectBackendEvent(result[0], "turn-complete");
    expect(tc.message.id).toBe("run-42");
    expect(tc.message.role).toBe("assistant");
    expect(tc.message.content).toBe("Hello from Aether");
    expect(result[1].type).toBe("idle");
  });

  // 10. chat event with state "final" concatenates multiple text blocks in order
  it("joins multiple text content blocks on chat.final", () => {
    const result = normalizeGatewayEvent("chat", {
      runId: "run-43",
      state: "final",
      message: {
        content: [
          { type: "text", text: "Part one. " },
          { type: "tool_use", input: { cmd: "ignored" } },
          { type: "text", text: "Part two." },
        ],
      },
    });
    expect(expectBackendEvent(result[0], "turn-complete").message.content).toBe(
      "Part one. Part two.",
    );
  });

  // 11. chat event with state "final" but no text content → no event
  it("returns no event for chat.final with empty text content", () => {
    const result = normalizeGatewayEvent("chat", {
      runId: "run-44",
      state: "final",
      message: { content: [{ type: "tool_use", input: {} }] },
    });
    expect(result).toEqual([]);
  });

  // 12. chat event with state other than "final"/"error" → no event (deltas are emitted via agent stream)
  it("returns no event for chat events with non-final state", () => {
    const result = normalizeGatewayEvent("chat", {
      runId: "run-45",
      state: "delta",
      message: { content: [{ type: "text", text: "partial" }] },
    });
    expect(result).toEqual([]);
  });

  // 13. chat event with state "error" → turn-error carrying the runtime's
  //    errorMessage so the renderer surfaces it (e.g. "LLM request timed out.")
  //    instead of the user staring at an indefinite spinner.
  it("maps chat state=error to a recoverable turn-error with the runtime's errorMessage", () => {
    const result = normalizeGatewayEvent("chat", {
      runId: "run-46",
      sessionKey: "agent:k",
      state: "error",
      errorMessage: "LLM request timed out.",
    });
    expect(result).toEqual([
      { type: "turn-error", error: "LLM request timed out.", recoverable: true },
    ]);
  });

  // 14. chat state=error with no errorMessage falls back to a generic message
  //    rather than dropping silently (which would leave the spinner stuck).
  it("falls back to a generic error message when chat state=error omits errorMessage", () => {
    const result = normalizeGatewayEvent("chat", {
      runId: "run-47",
      state: "error",
    });
    expect(result).toEqual([
      {
        type: "turn-error",
        error: "Run failed (no error message from runtime)",
        recoverable: true,
      },
    ]);
  });
});

describe("normalizeHistoryMessages", () => {
  it("flattens a single text block", () => {
    const result = normalizeHistoryMessages([
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1000 },
    ]);
    expect(result).toEqual([
      {
        id: expect.any(String),
        role: "user",
        content: "hello",
        timestamp: "1000",
      },
    ]);
  });

  it("joins multiple text blocks with no separator", () => {
    const result = normalizeHistoryMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "part one " },
          { type: "text", text: "part two" },
        ],
        timestamp: 2000,
      },
    ]);
    expect(result[0].content).toBe("part one part two");
  });

  it("drops tool-call blocks but keeps text blocks around them", () => {
    const result = normalizeHistoryMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "before " },
          { type: "tool_call", toolName: "read_file" },
          { type: "text", text: "after" },
        ],
        timestamp: 3000,
      },
    ]);
    expect(result[0].content).toBe("before after");
  });

  it("drops messages whose content reduces to empty after cleaning", () => {
    // Empty-content messages and pure-metadata messages are filtered out
    // entirely — they have no value in the chat view and would render as
    // blank rows.
    const result = normalizeHistoryMessages([{ role: "user", content: [], timestamp: 4000 }]);
    expect(result).toEqual([]);
  });

  it("returns empty array on empty input", () => {
    expect(normalizeHistoryMessages([])).toEqual([]);
  });

  it("maps tool/other roles to system to stay inside SessionMessage role union", () => {
    const result = normalizeHistoryMessages([
      { role: "tool", content: [{ type: "text", text: "tool log" }], timestamp: 5000 },
    ]);
    expect(result[0].role).toBe("system");
  });

  it("strips [cron:<id> <name>] prefix from user messages", () => {
    const result = normalizeHistoryMessages([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "[cron:63254ef5-b2a7-46b9-9ef4-d6405ff50c70 Morning briefing] tell me about you pls",
          },
        ],
        timestamp: 100,
      },
    ]);
    expect(result[0].content).toBe("tell me about you pls");
  });

  it("strips the 'Current time:' suffix marshal appends to cron-fired prompts", () => {
    const result = normalizeHistoryMessages([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "[cron:abc Foo] hi\n\nCurrent time: Wednesday, April 22nd, 2026 — 5:07 PM (UTC)",
          },
        ],
        timestamp: 100,
      },
    ]);
    expect(result[0].content).toBe("hi");
  });

  it("filters assistant messages that are bare tool-result JSON blobs", () => {
    const result = normalizeHistoryMessages([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: '{ "results": [], "provider": "none", "citations": "auto", "mode": "fts-only" }',
          },
        ],
        timestamp: 200,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here's what I found." }],
        timestamp: 201,
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Here's what I found.");
  });

  it("does NOT filter user messages that happen to contain JSON (only assistant tool-result)", () => {
    const result = normalizeHistoryMessages([
      {
        role: "user",
        content: [{ type: "text", text: '{ "results": [], "provider": "none", "mode": "x" }' }],
        timestamp: 300,
      },
    ]);
    expect(result[0].content).toContain("results");
  });

  it("strips a leading tool-result JSON envelope from assistant messages whose text also includes prose", () => {
    // Marshal concatenates the search-tool result JSON with the actual
    // assistant reply into a single text block. The block-level filter can't
    // drop it because the whole text doesn't look like JSON — the cleaner
    // must strip just the leading envelope.
    const result = normalizeHistoryMessages([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              '{ "results": [], "provider": "none", "citations": "auto", "mode": "fts-only" }\n\n' +
              "Here's your morning briefing: …",
          },
        ],
        timestamp: 400,
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Here's your morning briefing: …");
  });

  it("string-aware brace counter: braces inside JSON string values don't fool the stripper", () => {
    // The naive depth counter would fail here: the closing `}` of "provider"
    // sits inside a string literal whose value contains `{ not a brace }`.
    // The string-aware counter must skip braces inside `"…"` so the entire
    // envelope is recognized as one balanced JSON object and stripped
    // cleanly, leaving only the actual prose behind.
    const result = normalizeHistoryMessages([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              '{ "results": [], "provider": "none { not a brace }", "mode": "fts-only" }\n\n' +
              "Actual reply.",
          },
        ],
        timestamp: 500,
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Actual reply.");
  });

  it("string-aware brace counter handles escaped quotes inside string values", () => {
    // A `\"` inside the string must not count as the closing quote — the
    // brace inside `"\"foo\""` would otherwise trip the in-string flag and
    // resume counting braces in what's still a string literal.
    const result = normalizeHistoryMessages([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              '{ "results": [], "provider": "say \\"{ hi }\\"", "mode": "fts-only" }\n\n' +
              "After.",
          },
        ],
        timestamp: 600,
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("After.");
  });
});
