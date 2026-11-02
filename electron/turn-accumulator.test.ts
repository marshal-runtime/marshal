import { describe, it, expect, beforeEach, vi } from "vitest";

import type { TurnEvent } from "../common/marshal-ipc-contract";
import type { BackendEvent } from "./backend/types";
import { TurnAccumulator } from "./turn-accumulator";

/** processEvent returns TurnEvent[]; this extracts the first event or null for convenience. */
function first(events: TurnEvent[]): TurnEvent | null {
  return events[0] ?? null;
}

/** Narrow a TurnEvent to a specific type and return it, or fail the test. */
function expectEvent<T extends TurnEvent["type"]>(
  event: TurnEvent | null,
  type: T,
): Extract<TurnEvent, { type: T }> {
  expect(event).not.toBeNull();
  expect(event!.type).toBe(type);
  return event as Extract<TurnEvent, { type: T }>; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- type verified by assertion above
}

describe("TurnAccumulator", () => {
  let acc: TurnAccumulator;

  beforeEach(() => {
    acc = new TurnAccumulator();
  });

  // ── Text delta accumulation ──────────────────────────────────────────

  describe("text-delta", () => {
    it("returns turn:text-delta with the delta content", () => {
      const result = first(acc.processEvent({ type: "text-delta", text: "Hello" }));
      expect(result).toEqual({ type: "turn:text-delta", delta: "Hello" });
    });

    it("accumulates text across multiple deltas", () => {
      acc.processEvent({ type: "text-delta", text: "Hello " });
      acc.processEvent({ type: "text-delta", text: "world" });
      expect(acc.hasPendingContent()).toBe(true);
    });

    it("returns null for empty delta content", () => {
      const result = first(acc.processEvent({ type: "text-delta", text: "" }));
      expect(result).toBeNull();
    });
  });

  // ── Turn error handling ──────────────────────────────────────────────
  describe("turn-error", () => {
    it("emits turn:error and carries the retrying flag", () => {
      const result = first(
        acc.processEvent({
          type: "turn-error",
          error: "503 service unavailable",
          recoverable: true,
          retrying: true,
        }),
      );
      const event = expectEvent(result, "turn:error");
      expect(event.error).toBe("503 service unavailable");
      expect(event.retrying).toBe(true);
      expect(event.message).toBeUndefined();
    });

    it("omits retrying for a terminal (non-retrying) error", () => {
      const result = first(
        acc.processEvent({ type: "turn-error", error: "boom", recoverable: false }),
      );
      const event = expectEvent(result, "turn:error");
      expect(event.error).toBe("boom");
      expect(event.retrying).toBeUndefined();
      expect(event.message).toBeUndefined();
    });

    it("de-masks a mis-typed object error instead of surfacing [object Object]", () => {
      const result = first(
        acc.processEvent({
          type: "turn-error",
          // The backend event types `error` as a string, but guard against a
          // producer passing a raw object (the original [object Object] bug).
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- intentional bad-type injection
          error: { message: "rate limited" } as unknown as string,
          recoverable: false,
        }),
      );
      const event = expectEvent(result, "turn:error");
      expect(event.error).toBe("rate limited");
      expect(event.error).not.toContain("[object Object]");
    });
  });

  // ── Reasoning accumulation ───────────────────────────────────────────

  describe("reasoning-delta", () => {
    it("returns turn:reasoning-updated with accumulated text", () => {
      const result = first(acc.processEvent({ type: "reasoning-delta", text: "Thinking..." }));
      expect(result).toMatchObject({
        type: "turn:reasoning-updated",
        reasoning: { text: "Thinking..." },
      });
    });

    it("accumulates reasoning across deltas", () => {
      acc.processEvent({ type: "reasoning-delta", text: "Step 1. " });
      const result = first(acc.processEvent({ type: "reasoning-delta", text: "Step 2." }));
      expect(result).toMatchObject({
        type: "turn:reasoning-updated",
        reasoning: { text: "Step 1. Step 2." },
      });
    });

    it("tracks duration from first delta", () => {
      vi.useFakeTimers();
      try {
        acc.processEvent({ type: "reasoning-delta", text: "A" });
        vi.advanceTimersByTime(3000);
        const result = first(acc.processEvent({ type: "reasoning-delta", text: "B" }));
        expect(result!.type).toBe("turn:reasoning-updated");
        const reasoning = expectEvent(result, "turn:reasoning-updated").reasoning;
        expect(reasoning.durationSeconds).toBeGreaterThanOrEqual(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns null for empty reasoning delta", () => {
      const result = first(acc.processEvent({ type: "reasoning-delta", text: "" }));
      expect(result).toBeNull();
    });
  });

  // ── Tool call tracking ───────────────────────────────────────────────

  describe("tool-start", () => {
    it("returns turn:tools-updated with the new tool", () => {
      const result = first(
        acc.processEvent({
          type: "tool-start",
          toolCallId: "tc-1",
          toolName: "bash",
          description: "Running shell command",
        }),
      );
      expect(result).toMatchObject({
        type: "turn:tools-updated",
        toolCalls: [{ id: "tc-1", name: "bash", running: true }],
      });
    });

    it("includes all tools accumulated this turn", () => {
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-1",
        toolName: "bash",
        description: "List files",
      });
      const result = first(
        acc.processEvent({
          type: "tool-start",
          toolCallId: "tc-2",
          toolName: "view",
          args: { path: "/tmp/foo.ts" },
        }),
      );
      expect(result).toMatchObject({
        type: "turn:tools-updated",
        toolCalls: [
          { id: "tc-1", name: "bash", running: true },
          { id: "tc-2", name: "view", running: true },
        ],
      });
    });

    it("renders the description from an object-shaped args (gateway-backend wire shape)", () => {
      // Copilot sends args as a JSON string; gateway passes data.args through
      // as a parsed object. formatToolDescription handles both via its
      // parse-or-passthrough branch — pin the object path explicitly so a
      // future refactor that breaks one direction doesn't silently fall back
      // to the generic "Running shell command" label.
      const result = first(
        acc.processEvent({
          type: "tool-start",
          toolCallId: "tc-obj",
          toolName: "bash",
          args: { description: "list files" },
        }),
      );
      expect(result).toMatchObject({
        type: "turn:tools-updated",
        toolCalls: [{ description: "list files" }],
      });
    });

    it("falls back to the generic bash label when args is an unexpected shape (array, number, etc.)", () => {
      // Wire-resilience guard: an unexpected args shape (array of positionals,
      // a number, etc.) drops through to the named-tool fallback string. The
      // tool card still renders with a meaningful description rather than
      // throwing or going blank.
      const result = first(
        acc.processEvent({
          type: "tool-start",
          toolCallId: "tc-arr",
          toolName: "bash",
          args: ["positional"],
        }),
      );
      expect(result).toMatchObject({
        type: "turn:tools-updated",
        toolCalls: [{ description: "Running shell command" }],
      });
    });

    it("skips report_intent tool", () => {
      const result = first(
        acc.processEvent({
          type: "tool-start",
          toolCallId: "tc-x",
          toolName: "report_intent",
        }),
      );
      expect(result).toBeNull();
    });

    it("skips askUser tool", () => {
      const result = first(
        acc.processEvent({
          type: "tool-start",
          toolCallId: "tc-ask",
          toolName: "askUser",
        }),
      );
      expect(result).toBeNull();
    });

    it("does not suppress a third-party MCP tool named askUser", () => {
      const result = first(
        acc.processEvent({
          type: "tool-start",
          toolCallId: "tc-external-ask",
          toolName: "askUser",
          serverName: "third-party",
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          type: "turn:tools-updated",
          startedToolId: "tc-external-ask",
          toolCalls: [
            expect.objectContaining({
              id: "tc-external-ask",
              name: "askUser",
              description: "Using third-party",
              running: true,
            }),
          ],
        }),
      );
    });

    it("prioritizes server attribution over first-party formatting collisions", () => {
      const result = first(
        acc.processEvent({
          type: "tool-start",
          toolCallId: "tc-external-skill",
          toolName: "createSkill",
          serverName: "external-skills",
        }),
      );
      expect(result).toMatchObject({
        type: "turn:tools-updated",
        toolCalls: [{ description: "Using external-skills" }],
      });
    });

    it("falls back to server name for unknown tools", () => {
      const result = first(
        acc.processEvent({
          type: "tool-start",
          toolCallId: "tc-1",
          toolName: "unknown_custom_tool",
          serverName: "my-server",
        }),
      );
      expect(result).toMatchObject({
        type: "turn:tools-updated",
        toolCalls: [{ description: "Using my-server" }],
      });
    });

    it("uses the resolved display name when serverName is a sanitized SDK key", () => {
      // The SDK is registered with snake_case keys (e.g. `power_bi`), not
      // the user-facing display name. Without the resolver the renderer
      // would show "Using power_bi" — the resolver maps the key back to
      // the configured display name.
      const accWithResolver = new TurnAccumulator({
        resolveServerDisplayName: (key) => (key === "power_bi" ? "Power BI" : undefined),
      });
      const result = first(
        accWithResolver.processEvent({
          type: "tool-start",
          toolCallId: "tc-1",
          toolName: "list_datasets",
          serverName: "power_bi",
        }),
      );
      expect(result).toMatchObject({
        type: "turn:tools-updated",
        toolCalls: [{ description: "Using Power BI" }],
      });
    });

    it("falls back to the raw server name when the resolver returns undefined", () => {
      // Built-in servers (filesystem, playwright) and any unrecognized key
      // pass through unchanged so we never lose the label entirely.
      const accWithResolver = new TurnAccumulator({
        resolveServerDisplayName: () => undefined,
      });
      const result = first(
        accWithResolver.processEvent({
          type: "tool-start",
          toolCallId: "tc-1",
          toolName: "read_file",
          serverName: "filesystem",
        }),
      );
      expect(result).toMatchObject({
        type: "turn:tools-updated",
        toolCalls: [{ description: "Using filesystem" }],
      });
    });

    it("falls back to Running {toolName} when no server name", () => {
      const result = first(
        acc.processEvent({
          type: "tool-start",
          toolCallId: "tc-1",
          toolName: "custom_tool",
        }),
      );
      expect(result).toMatchObject({
        type: "turn:tools-updated",
        toolCalls: [{ description: "Running custom_tool" }],
      });
    });

    it("falls back to toolName from tool-start event", () => {
      const result = first(
        acc.processEvent({
          type: "tool-start",
          toolCallId: "tc-1",
          toolName: "filesystem__read_file",
        }),
      );
      expect(result).toMatchObject({
        type: "turn:tools-updated",
        toolCalls: [{ id: "tc-1", name: "filesystem__read_file", running: true }],
      });
    });

    it("sets startedToolId on tool start", () => {
      const result = first(
        acc.processEvent({
          type: "tool-start",
          toolCallId: "tc-1",
          toolName: "getSkill",
        }),
      );
      expect(result).toMatchObject({
        type: "turn:tools-updated",
        startedToolId: "tc-1",
      });
    });

    it("does not set startedToolId on tool complete", () => {
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-1",
        toolName: "bash",
        description: "cmd",
      });
      const result = first(
        acc.processEvent({
          type: "tool-result",
          toolCallId: "tc-1",
          result: "",
          success: true,
        }),
      );
      expect(result).toMatchObject({ type: "turn:tools-updated" });
      expect(result).not.toHaveProperty("startedToolId");
    });
  });

  describe("tool-result", () => {
    it("marks tool as not running on tool-result", () => {
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-1",
        toolName: "view",
        args: { path: "/a.ts" },
      });
      const result = first(
        acc.processEvent({
          type: "tool-result",
          toolCallId: "tc-1",
          result: "",
          success: true,
        }),
      );
      expect(result).toMatchObject({
        type: "turn:tools-updated",
        toolCalls: [
          {
            id: "tc-1",
            activityKind: "read",
            running: false,
            input: '{\n  "path": "/a.ts"\n}',
            output: "",
            success: true,
          },
        ],
      });
    });

    it("preserves live failure details and activity kind in both completion events", () => {
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-mkdir",
        toolName: "createLocalDirectory",
        args: { path: "notes" },
      });
      const events = acc.processEvent({
        type: "tool-result",
        toolCallId: "tc-mkdir",
        result: { requestId: "req-1" },
        success: false,
        error: "Create failed",
      });

      expect(events[0]).toMatchObject({
        type: "turn:tools-updated",
        toolCalls: [
          {
            id: "tc-mkdir",
            name: "createLocalDirectory",
            activityKind: "mutation",
            running: false,
            input: '{\n  "path": "notes"\n}',
            output: '{\n  "requestId": "req-1"\n}',
            success: false,
            error: "Create failed",
          },
        ],
      });
      expect(events[1]).toMatchObject({
        type: "turn:tool-completed",
        toolCallId: "tc-mkdir",
        success: false,
        error: "Create failed",
      });
    });

    it("returns turn:tool-completed event as the second event", () => {
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-1",
        toolName: "bash",
        description: "cmd",
      });
      const events = acc.processEvent({
        type: "tool-result",
        toolCallId: "tc-1",
        result: "",
        success: true,
      });
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        type: "turn:tool-completed",
        toolCallId: "tc-1",
        output: "",
        success: true,
      });
    });

    it("extracts output from result.content", () => {
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-1",
        toolName: "bash",
        description: "cmd",
      });
      const events = acc.processEvent({
        type: "tool-result",
        toolCallId: "tc-1",
        result: { content: "File found at /path" },
        success: true,
      });
      expect(events[1]).toMatchObject({
        type: "turn:tool-completed",
        toolCallId: "tc-1",
        output: "File found at /path",
        success: true,
      });
    });

    it("truncates large completed tool output", () => {
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-large",
        toolName: "bash",
        description: "cmd",
      });
      const events = acc.processEvent({
        type: "tool-result",
        toolCallId: "tc-large",
        result: { content: "x".repeat(120_000) },
        success: true,
      });

      const completed = events[1];
      expect(completed).toMatchObject({ type: "turn:tool-completed" });
      if (completed.type !== "turn:tool-completed") throw new Error("expected tool-completed");
      expect(completed.output.length).toBeLessThan(101_000);
      expect(completed.output).toContain("... truncated");
    });

    it("propagates success=false", () => {
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-1",
        toolName: "bash",
        description: "cmd",
      });
      const events = acc.processEvent({
        type: "tool-result",
        toolCallId: "tc-1",
        result: "",
        success: false,
      });
      expect(events[1]).toMatchObject({
        type: "turn:tool-completed",
        toolCallId: "tc-1",
        success: false,
      });
    });

    it("handles missing result gracefully with empty output", () => {
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-1",
        toolName: "bash",
        description: "cmd",
      });
      const events = acc.processEvent({
        type: "tool-result",
        toolCallId: "tc-1",
        result: "",
        success: true,
      });
      expect(events[1]).toMatchObject({
        type: "turn:tool-completed",
        toolCallId: "tc-1",
        output: "",
        success: true,
      });
    });

    it("returns empty array when toolCallId is missing", () => {
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-1",
        toolName: "bash",
        description: "cmd",
      });
      const events = acc.processEvent({
        type: "tool-result",
        toolCallId: "",
        result: "",
        success: true,
      });
      expect(events).toEqual([]);
    });

    it("emits sanitized tool provenance on completion", () => {
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-file",
        toolName: "read_file",
        serverName: "filesystem",
        args: { path: "C:\\Users\\omerm\\Documents\\secret-roadmap.md" },
        startedAtMs: 100,
      });
      const events = acc.processEvent({
        type: "tool-result",
        toolCallId: "tc-file",
        result: { content: "Private Project Falcon contents" },
        success: true,
        completedAtMs: 130,
      });

      const completed = events[1];
      expect(completed).toMatchObject({
        type: "turn:tool-completed",
        provenance: {
          type: "command-center.tool-provenance",
          domain: "filesystem",
          status: "succeeded",
          durationMs: 30,
          file: { operation: "read", extensions: [".md"] },
        },
      });
      if (completed.type !== "turn:tool-completed") throw new Error("expected tool-completed");
      const serialized = JSON.stringify(completed.provenance);
      expect(serialized).not.toContain("secret-roadmap");
      expect(serialized).not.toContain("Project Falcon");
      expect(serialized).not.toContain("C:\\Users");
    });
  });

  describe("tool persistence", () => {
    it("persists each tool call by toolCallId so distinct calls are kept", () => {
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-1",
        toolName: "bash",
        description: "Running shell command",
      });
      acc.processEvent({
        type: "tool-result",
        toolCallId: "tc-1",
        result: "",
        success: true,
      });
      // Same description, different toolCallId — kept as a separate call.
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-2",
        toolName: "bash",
        description: "Running shell command",
      });

      const msg = acc.assembleMessage("test-id");
      expect(msg.toolCalls).toHaveLength(2);
      expect(msg.toolCalls!.map((t) => t.id)).toEqual(["tc-1", "tc-2"]);
    });
  });

  // ── turn-complete (commit) ──────────────────────────────────────────

  describe("turn-complete", () => {
    it("preserves chronological text, thought, and tool streams as separate blocks", () => {
      acc.processEvent({ type: "text-delta", text: "First update", messageId: "message-1" });
      acc.processEvent({ type: "reasoning-delta", text: "Think A. " });
      acc.processEvent({ type: "reasoning-delta", text: "Think B." });
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tool-1",
        toolName: "shell",
        description: "Run one",
      });
      acc.processEvent({
        type: "tool-result",
        toolCallId: "tool-1",
        result: "ok",
        success: true,
      });
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tool-2",
        toolName: "shell",
        description: "Run two",
      });
      acc.processEvent({
        type: "tool-result",
        toolCallId: "tool-2",
        result: "ok",
        success: true,
      });
      acc.processEvent({ type: "reasoning-delta", text: "Think C." });
      acc.processEvent({ type: "text-delta", text: "Second update", messageId: "message-2" });

      const committed = expectEvent(
        first(
          acc.processEvent({
            type: "turn-complete",
            message: {
              id: "final",
              role: "assistant",
              content: "First updateSecond update",
            },
          }),
        ),
        "turn:message-committed",
      );

      expect(committed.message.contentBlocks?.map((block) => block.type)).toEqual([
        "text",
        "reasoning",
        "tools",
        "reasoning",
        "text",
      ]);
      expect(committed.message.contentBlocks?.[0]).toMatchObject({
        type: "text",
        content: "First update",
      });
      expect(committed.message.contentBlocks?.[1]).toMatchObject({
        type: "reasoning",
        text: "Think A. Think B.",
      });
      expect(committed.message.contentBlocks?.[2]).toMatchObject({
        type: "tools",
        toolCalls: [
          { id: "tool-1", description: "Run one", success: true },
          { id: "tool-2", description: "Run two", success: true },
        ],
      });
      expect(committed.message.contentBlocks?.[3]).toMatchObject({
        type: "reasoning",
        text: "Think C.",
      });
      expect(committed.message.contentBlocks?.[4]).toMatchObject({
        type: "text",
        content: "Second update",
      });
    });

    it("keeps distinct backend assistant messages in distinct text blocks", () => {
      acc.processEvent({ type: "text-delta", text: "One", messageId: "message-1" });
      acc.processEvent({ type: "text-delta", text: "Two", messageId: "message-2" });

      const message = acc.assembleMessage("final");
      expect(message.contentBlocks).toEqual([
        { id: "message-1", type: "text", content: "One" },
        { id: "message-2", type: "text", content: "Two" },
      ]);
    });

    it("coalesces adjacent text packets when the runtime has no logical message id", () => {
      acc.processEvent({ type: "text-delta", text: "Two things to we" });
      acc.processEvent({ type: "text-delta", text: "igh before launching the swarm." });

      const message = acc.assembleMessage("assistant-1");
      expect(message.content).toBe("Two things to weigh before launching the swarm.");
      expect(message.contentBlocks).toBeUndefined();
    });

    it("returns turn:message-committed with assembled message", () => {
      acc.processEvent({ type: "text-delta", text: "Hello" });
      const result = first(
        acc.processEvent({
          type: "turn-complete",
          message: { id: "msg-1", role: "assistant", content: "Hello world" },
        }),
      );
      expect(result).toMatchObject({
        type: "turn:message-committed",
        message: {
          id: "msg-1",
          role: "assistant",
          content: "Hello world", // uses event.data.content, not accumulated
        },
      });
    });

    it("uses event content (not accumulated text)", () => {
      acc.processEvent({ type: "text-delta", text: "partial" });
      const result = first(
        acc.processEvent({
          type: "turn-complete",
          message: { id: "msg-1", role: "assistant", content: "full content from SDK" },
        }),
      );
      const msg = expectEvent(result, "turn:message-committed").message;
      expect(msg.content).toBe("full content from SDK");
    });

    it("preserves accumulated state when turn-complete has empty content", () => {
      // In multi-tool flows, the SDK emits turn-complete with empty content
      // between tool-use rounds. Accumulated reasoning/tools must survive.
      acc.processEvent({ type: "reasoning-delta", text: "Thinking..." });
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-1",
        toolName: "bash",
        description: "Running ls",
      });
      acc.processEvent({ type: "text-delta", text: "partial" });

      // Empty turn-complete — should NOT reset accumulated state
      const emptyResult = acc.processEvent({
        type: "turn-complete",
        message: { id: "mid-turn", role: "assistant", content: "" },
      });
      expect(emptyResult).toEqual([]);
      expect(acc.hasPendingContent()).toBe(true);

      // Final turn-complete with real content — should include reasoning from earlier
      const result = first(
        acc.processEvent({
          type: "turn-complete",
          message: { id: "final", role: "assistant", content: "Done" },
        }),
      );
      const msg = expectEvent(result, "turn:message-committed").message;
      expect(msg.reasoning).toMatchObject({ text: "Thinking..." });
      expect(msg.toolCalls).toEqual([
        {
          id: "tc-1",
          name: "bash",
          description: "Running ls",
          activityKind: "command",
        },
      ]);
    });

    it("commits a question-only message when content is empty", () => {
      acc.setQuestion({
        question: "Pick one",
        answers: [{ title: "A" }, { title: "B" }],
      });

      const result = first(
        acc.processEvent({
          type: "turn-complete",
          message: { id: "msg-question", role: "assistant", content: "" },
        }),
      );

      const msg = expectEvent(result, "turn:message-committed").message;
      expect(msg.content).toBe("");
      expect(msg.question).toMatchObject({ question: "Pick one" });
    });

    it("includes accumulated reasoning in the message", () => {
      acc.processEvent({ type: "reasoning-delta", text: "I think..." });
      const result = first(
        acc.processEvent({
          type: "turn-complete",
          message: { id: "msg-1", role: "assistant", content: "Answer" },
        }),
      );
      const msg = expectEvent(result, "turn:message-committed").message;
      expect(msg.reasoning).toMatchObject({ text: "I think..." });
    });

    it("includes persisted tool calls in the message", () => {
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-1",
        toolName: "bash",
        description: "Running shell command",
      });
      const result = first(
        acc.processEvent({
          type: "turn-complete",
          message: { id: "msg-1", role: "assistant", content: "Done" },
        }),
      );
      const msg = expectEvent(result, "turn:message-committed").message;
      expect(msg.toolCalls).toEqual([
        {
          id: "tc-1",
          name: "bash",
          description: "Running shell command",
          activityKind: "command",
        },
      ]);
    });

    it("persists sanitized tool provenance in committed assistant messages", () => {
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-shell",
        toolName: "powershell_exec",
        serverName: "shell",
        args: { command: "git diff -- C:\\private\\secret.ts" },
      });
      acc.processEvent({
        type: "tool-result",
        toolCallId: "tc-shell",
        result: { stdout: "private diff output" },
        success: true,
      });

      const result = first(
        acc.processEvent({
          type: "turn-complete",
          message: { id: "msg-1", role: "assistant", content: "Done" },
        }),
      );
      const msg = expectEvent(result, "turn:message-committed").message;
      expect(msg.toolProvenance).toHaveLength(1);
      expect(msg.toolProvenance?.[0]).toMatchObject({
        type: "command-center.tool-provenance",
        domain: "shell",
        shell: { category: "git" },
      });
      const serialized = JSON.stringify(msg.toolProvenance);
      expect(serialized).not.toContain("secret.ts");
      expect(serialized).not.toContain("private diff output");
      expect(serialized).not.toContain("git diff");
    });

    it("does not persist askUser in committed tool calls", () => {
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-ask",
        toolName: "askUser",
      });
      acc.setQuestion({
        question: "Pick one",
        answers: [{ title: "A" }, { title: "B" }],
      });

      const result = first(
        acc.processEvent({
          type: "turn-complete",
          message: { id: "msg-1", role: "assistant", content: "" },
        }),
      );

      const msg = expectEvent(result, "turn:message-committed").message;
      expect(msg.question).toMatchObject({ question: "Pick one" });
      expect(msg.toolCalls).toBeUndefined();
    });

    it("resets state after committing", () => {
      acc.processEvent({ type: "text-delta", text: "text" });
      acc.processEvent({ type: "reasoning-delta", text: "reasoning" });
      acc.processEvent({
        type: "turn-complete",
        message: { id: "msg-1", role: "assistant", content: "text" },
      });
      expect(acc.hasPendingContent()).toBe(false);
    });

    it("falls back to Date.now() for message id when empty", () => {
      const evt: BackendEvent = {
        type: "turn-complete",
        message: { id: "", role: "assistant", content: "Hello" },
      };
      const result = first(acc.processEvent(evt));
      const msg = expectEvent(result, "turn:message-committed").message;
      // Should be a numeric string from Date.now() fallback
      expect(Number(msg.id)).toBeGreaterThan(0);
    });
  });

  // ── idle ─────────────────────────────────────────────────────────────

  describe("idle", () => {
    it("returns turn:idle", () => {
      const result = first(acc.processEvent({ type: "idle" }));
      expect(result).toEqual({ type: "turn:idle" });
    });

    it("does NOT reset accumulated state", () => {
      acc.processEvent({ type: "text-delta", text: "pending" });
      acc.processEvent({ type: "idle" });
      expect(acc.hasPendingContent()).toBe(true);
    });
  });

  describe("hasPendingTools", () => {
    describe("Sanity Tests", () => {
      it("is true after a tool starts", () => {
        acc.processEvent({
          type: "tool-start",
          toolCallId: "tc-1",
          toolName: "bash",
        });
        expect(acc.hasPendingTools()).toBe(true);
      });
    });

    describe("Error Handling", () => {
      it("stays true after a failed tool result", () => {
        acc.processEvent({
          type: "tool-start",
          toolCallId: "tc-1",
          toolName: "bash",
        });
        acc.processEvent({
          type: "tool-result",
          toolCallId: "tc-1",
          result: null,
          success: false,
          error: "boom",
        });
        expect(acc.hasPendingTools()).toBe(true);
      });
    });

    describe("Edge Cases", () => {
      it("is false before any tool activity and after reset", () => {
        expect(acc.hasPendingTools()).toBe(false);
        acc.processEvent({
          type: "tool-start",
          toolCallId: "tc-1",
          toolName: "bash",
        });
        acc.reset();
        expect(acc.hasPendingTools()).toBe(false);
      });
    });
  });

  // ── Error handling ───────────────────────────────────────────────────

  describe("turn-error", () => {
    it("returns turn:error with error message", () => {
      const result = first(
        acc.processEvent({ type: "turn-error", error: "Something went wrong", recoverable: false }),
      );
      expect(result).toMatchObject({
        type: "turn:error",
        error: "Something went wrong",
      });
    });

    it("includes assembled message if content was accumulated", () => {
      acc.processEvent({ type: "text-delta", text: "partial" });
      const result = first(
        acc.processEvent({ type: "turn-error", error: "Oops", recoverable: false }),
      );
      expect(result).toMatchObject({
        type: "turn:error",
        error: "Oops",
      });
      const errorEvent = expectEvent(result, "turn:error");
      expect(errorEvent.message).toBeDefined();
      expect(errorEvent.message!.content).toBe("partial");
      expect(errorEvent.message!.error).toBe(true);
    });

    it("resets state after error", () => {
      acc.processEvent({ type: "text-delta", text: "text" });
      acc.processEvent({ type: "turn-error", error: "Fail", recoverable: false });
      expect(acc.hasPendingContent()).toBe(false);
    });

    it("handles error with no message content", () => {
      const result = first(
        acc.processEvent({ type: "turn-error", error: "Unknown error", recoverable: false }),
      );
      expect(result).toMatchObject({
        type: "turn:error",
      });
      const errorEvent = expectEvent(result, "turn:error");
      expect(errorEvent.error).toBeTruthy();
      expect(errorEvent.message).toBeUndefined();
    });
  });

  // ── Passthrough events ───────────────────────────────────────────────

  describe("status", () => {
    it("returns turn:status", () => {
      const result = first(acc.processEvent({ type: "status", text: "thinking" }));
      expect(result).toEqual({ type: "turn:status", status: "thinking" });
    });

    it("handles null status", () => {
      const result = first(acc.processEvent({ type: "status", text: null }));
      expect(result).toEqual({ type: "turn:status", status: null });
    });
  });

  describe("token-usage", () => {
    it("returns turn:token-usage", () => {
      const result = first(
        acc.processEvent({ type: "token-usage", currentTokens: 1500, tokenLimit: 4096 }),
      );
      expect(result).toEqual({
        type: "turn:token-usage",
        currentTokens: 1500,
        tokenLimit: 4096,
      });
    });
  });

  describe("llm-usage", () => {
    it("returns turn:llm-usage (pass-through)", () => {
      const result = first(
        acc.processEvent({
          type: "llm-usage",
          model: "gpt-4o",
          inputTokens: 1200,
          outputTokens: 350,
          cacheReadTokens: 800,
          cacheWriteTokens: 100,
          reasoningTokens: 50,
          cost: 1.5,
          duration: 2300,
          ttftMs: 120,
          interTokenLatencyMs: 15,
          initiator: "sub-agent",
          apiCallId: "chatcmpl-abc",
          providerCallId: "req-xyz",
        }),
      );
      expect(result).toEqual({
        type: "turn:llm-usage",
        model: "gpt-4o",
        inputTokens: 1200,
        outputTokens: 350,
        cacheReadTokens: 800,
        cacheWriteTokens: 100,
        reasoningTokens: 50,
        cost: 1.5,
        duration: 2300,
        ttftMs: 120,
        interTokenLatencyMs: 15,
        initiator: "sub-agent",
        apiCallId: "chatcmpl-abc",
        providerCallId: "req-xyz",
      });
    });
  });

  describe("metadata-updated", () => {
    it("returns turn:metadata-updated", () => {
      const result = first(acc.processEvent({ type: "metadata-updated" }));
      expect(result).toEqual({ type: "turn:metadata-updated" });
    });
  });

  // ── reset() ──────────────────────────────────────────────────────────

  describe("reset()", () => {
    it("clears all accumulated state", () => {
      acc.processEvent({ type: "text-delta", text: "text" });
      acc.processEvent({ type: "reasoning-delta", text: "reason" });
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-1",
        toolName: "bash",
        description: "cmd",
      });
      acc.reset();
      expect(acc.hasPendingContent()).toBe(false);

      // After reset, assembleMessage should produce empty content
      const msg = acc.assembleMessage("test-id");
      expect(msg.content).toBe("");
      expect(msg.reasoning).toBeUndefined();
      expect(msg.toolCalls).toBeUndefined();
      expect(msg.question).toBeUndefined();
    });
  });

  // ── assembleMessage ──────────────────────────────────────────────────

  describe("assembleMessage()", () => {
    it("builds a message with accumulated text", () => {
      acc.processEvent({ type: "text-delta", text: "Hello " });
      acc.processEvent({ type: "text-delta", text: "world" });
      const msg = acc.assembleMessage("msg-1");
      expect(msg).toMatchObject({
        id: "msg-1",
        role: "assistant",
        content: "Hello world",
      });
      expect(msg.timestamp).toBeTruthy();
    });

    it("uses contentOverride when provided", () => {
      acc.processEvent({ type: "text-delta", text: "partial" });
      const msg = acc.assembleMessage("msg-1", "override content");
      expect(msg.content).toBe("override content");
    });

    it("includes reasoning when present", () => {
      acc.processEvent({ type: "reasoning-delta", text: "Thinking..." });
      const msg = acc.assembleMessage("msg-1");
      expect(msg.reasoning).toMatchObject({ text: "Thinking..." });
    });

    it("includes a persisted entry per tool call when present", () => {
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-1",
        toolName: "bash",
        description: "Running shell command",
      });
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-2",
        toolName: "bash",
        description: "Running shell command",
      });
      const msg = acc.assembleMessage("msg-1");
      expect(msg.toolCalls).toHaveLength(2);
    });

    it("omits reasoning and toolCalls when empty", () => {
      const msg = acc.assembleMessage("msg-1");
      expect(msg.reasoning).toBeUndefined();
      expect(msg.toolCalls).toBeUndefined();
    });

    it("includes a buffered question when present", () => {
      acc.setQuestion({
        question: "Pick one",
        answers: [{ title: "A" }, { title: "B" }],
      });

      const msg = acc.assembleMessage("msg-1");

      expect(msg.question).toMatchObject({ question: "Pick one" });
    });
  });

  // ── getTurnState() ───────────────────────────────────────────────────

  describe("getTurnState()", () => {
    it("returns null when nothing accumulated", () => {
      expect(acc.getTurnState()).toBeNull();
    });

    it("returns text when deltas accumulated", () => {
      acc.processEvent({ type: "text-delta", text: "Hello " });
      acc.processEvent({ type: "text-delta", text: "world" });
      const state = acc.getTurnState();
      expect(state).toMatchObject({ text: "Hello world", reasoning: null });
      expect(state!.toolCalls).toHaveLength(0);
    });

    it("includes reasoning when present", () => {
      acc.processEvent({ type: "reasoning-delta", text: "Thinking..." });
      const state = acc.getTurnState();
      expect(state!.reasoning).toMatchObject({ text: "Thinking..." });
      expect(state!.reasoning!.durationSeconds).toEqual(expect.any(Number));
    });

    it("includes live tool calls with running status", () => {
      acc.processEvent({
        type: "tool-start",
        toolCallId: "tc-1",
        toolName: "bash",
        description: "cmd",
      });
      const state = acc.getTurnState();
      expect(state!.toolCalls).toHaveLength(1);
      expect(state!.toolCalls[0]).toMatchObject({ id: "tc-1", running: true });
    });

    it("returns null after reset", () => {
      acc.processEvent({ type: "text-delta", text: "text" });
      acc.reset();
      expect(acc.getTurnState()).toBeNull();
    });
  });
});
