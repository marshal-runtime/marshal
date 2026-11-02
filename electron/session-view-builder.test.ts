import { describe, it, expect, beforeEach } from "vitest";

import type { SessionMessage } from "../common/marshal-ipc-contract";
import { SessionViewBuilder } from "./session-view-builder";

function msg(id: string, content: string): SessionMessage {
  return {
    id,
    role: "assistant",
    content,
    timestamp: new Date().toISOString(),
  };
}

describe("SessionViewBuilder", () => {
  let builder: SessionViewBuilder;

  beforeEach(() => {
    builder = new SessionViewBuilder();
  });

  // ── Initial state ──────────────────────────────────────────────────────

  describe("initial state", () => {
    it("starts with ready status and empty fields", () => {
      const { view } = builder.drainSnapshot();
      expect(view.status).toBe("ready");
      expect(view.streamingText).toBe("");
      expect(view.reasoning).toBeNull();
      expect(view.toolStatuses).toEqual([]);
      expect(view.tokenUsage).toBeNull();
      expect(view.lastTurnUsage).toBeNull();
      expect(view.error).toBeNull();
      expect(view.sessionStatus).toBeNull();
    });
  });

  // ── Status transitions ─────────────────────────────────────────────────

  describe("status transitions", () => {
    it("ready -> submitted via setSubmitted()", () => {
      builder.setSubmitted();
      expect(builder.getView().status).toBe("submitted");
    });

    it("submitted -> streaming on first text delta", () => {
      builder.setSubmitted();
      builder.apply({ type: "turn:text-delta", delta: "Hi" });
      expect(builder.getView().status).toBe("streaming");
    });

    it("submitted -> streaming on reasoning update", () => {
      builder.setSubmitted();
      builder.apply({
        type: "turn:reasoning-updated",
        reasoning: { text: "thinking...", durationSeconds: 1 },
      });
      expect(builder.getView().status).toBe("streaming");
    });

    it("submitted -> streaming on tools update", () => {
      builder.setSubmitted();
      builder.apply({
        type: "turn:tools-updated",
        toolCalls: [{ id: "t1", name: "shell", description: "ls", running: true }],
      });
      expect(builder.getView().status).toBe("streaming");
    });

    it("streaming -> ready on idle", () => {
      builder.apply({ type: "turn:text-delta", delta: "Hi" });
      expect(builder.getView().status).toBe("streaming");
      builder.apply({ type: "turn:idle" });
      expect(builder.getView().status).toBe("ready");
    });

    it("streaming -> error on turn:error", () => {
      builder.apply({ type: "turn:text-delta", delta: "Hi" });
      builder.apply({ type: "turn:error", error: "something broke" });
      expect(builder.getView().status).toBe("error");
      expect(builder.getView().error).toBe("Something went wrong. Please try again.");
    });

    it("setSubmitted clears previous error state", () => {
      builder.apply({ type: "turn:error", error: "old error" });
      builder.setSubmitted();
      expect(builder.getView().status).toBe("submitted");
      expect(builder.getView().error).toBeNull();
    });
  });

  // ── Text delta accumulation ────────────────────────────────────────────

  describe("text delta accumulation", () => {
    it("accumulates text across multiple deltas", () => {
      builder.apply({ type: "turn:text-delta", delta: "Hello " });
      builder.apply({ type: "turn:text-delta", delta: "world" });
      expect(builder.getView().streamingText).toBe("Hello world");
    });

    it("clears streaming text on idle", () => {
      builder.apply({ type: "turn:text-delta", delta: "Hello" });
      builder.apply({ type: "turn:idle" });
      expect(builder.getView().streamingText).toBe("");
    });

    it("clears streaming text on message committed", () => {
      builder.apply({ type: "turn:text-delta", delta: "Hello" });
      builder.apply({ type: "turn:message-committed", message: msg("m1", "Hello") });
      expect(builder.getView().streamingText).toBe("");
    });

    it("clears streaming text on error", () => {
      builder.apply({ type: "turn:text-delta", delta: "Hello" });
      builder.apply({ type: "turn:error", error: "fail" });
      expect(builder.getView().streamingText).toBe("");
    });
  });

  // ── Reasoning accumulation ─────────────────────────────────────────────

  describe("reasoning", () => {
    it("tracks reasoning state", () => {
      builder.apply({
        type: "turn:reasoning-updated",
        reasoning: { text: "thinking...", durationSeconds: 2 },
      });
      expect(builder.getView().reasoning).toEqual({
        text: "thinking...",
        durationSeconds: 2,
      });
    });

    it("clears reasoning on idle", () => {
      builder.apply({
        type: "turn:reasoning-updated",
        reasoning: { text: "thinking", durationSeconds: 1 },
      });
      builder.apply({ type: "turn:idle" });
      expect(builder.getView().reasoning).toBeNull();
    });

    it("clears reasoning on message committed", () => {
      builder.apply({
        type: "turn:reasoning-updated",
        reasoning: { text: "thinking", durationSeconds: 1 },
      });
      builder.apply({ type: "turn:message-committed", message: msg("m1", "done") });
      expect(builder.getView().reasoning).toBeNull();
    });
  });

  // ── Tool statuses ──────────────────────────────────────────────────────

  describe("tool statuses", () => {
    it("tracks tool calls from turn:tools-updated", () => {
      builder.apply({
        type: "turn:tools-updated",
        toolCalls: [
          {
            id: "t1",
            name: "shell",
            description: "ls -la",
            running: true,
            input: '{"command":"ls -la"}',
            output: "listed files",
            success: true,
          },
          { id: "t2", name: "read", description: "cat file.ts", running: false },
        ],
      });
      expect(builder.getView().toolStatuses).toHaveLength(2);
      expect(builder.getView().toolStatuses[0]).toEqual({
        id: "t1",
        name: "shell",
        description: "ls -la",
        running: true,
        input: '{"command":"ls -la"}',
        output: "listed files",
        success: true,
      });
    });

    it("clears tool statuses on idle", () => {
      builder.apply({
        type: "turn:tools-updated",
        toolCalls: [{ id: "t1", name: "shell", description: "ls", running: true }],
      });
      builder.apply({ type: "turn:idle" });
      expect(builder.getView().toolStatuses).toEqual([]);
    });

    it("does NOT clear tool statuses on message committed", () => {
      builder.apply({
        type: "turn:tools-updated",
        toolCalls: [{ id: "t1", name: "shell", description: "ls", running: false }],
      });
      builder.apply({ type: "turn:message-committed", message: msg("m1", "done") });
      // Tool statuses stay — they're cleared on idle, not on message commit
      expect(builder.getView().toolStatuses).toHaveLength(1);
    });

    it("merges completion success, failure, cancellation, output, and error details", () => {
      builder.apply({
        type: "turn:tools-updated",
        toolCalls: [
          {
            id: "failed",
            name: "sendEmail",
            description: "Running send email",
            activityKind: "mutation",
            running: true,
            input: '{"subject":"Status"}',
          },
          {
            id: "cancelled",
            name: "browser_click",
            description: "Using playwright",
            activityKind: "mutation",
            running: true,
          },
        ],
      });
      builder.apply({
        type: "turn:tool-completed",
        toolCallId: "failed",
        output: "request rejected",
        success: false,
        error: "Send failed",
      });
      builder.apply({
        type: "turn:tool-completed",
        toolCallId: "cancelled",
        output: "",
        success: false,
        error: "Operation cancelled",
      });

      expect(builder.getView().toolStatuses).toEqual([
        {
          id: "failed",
          name: "sendEmail",
          description: "Running send email",
          activityKind: "mutation",
          running: false,
          input: '{"subject":"Status"}',
          output: "request rejected",
          success: false,
          error: "Send failed",
        },
        {
          id: "cancelled",
          name: "browser_click",
          description: "Using playwright",
          activityKind: "mutation",
          running: false,
          output: "",
          success: false,
          cancelled: true,
          error: "Operation cancelled",
        },
      ]);
    });
  });

  // ── Committed messages (atomic snapshot) ───────────────────────────────

  describe("committed messages", () => {
    it("accumulates committed messages in snapshot", () => {
      builder.apply({ type: "turn:message-committed", message: msg("m1", "Hello") });
      builder.apply({ type: "turn:message-committed", message: msg("m2", "World") });

      const snapshot = builder.drainSnapshot();
      expect(snapshot.committedMessages).toHaveLength(2);
      expect(snapshot.committedMessages[0].content).toBe("Hello");
      expect(snapshot.committedMessages[1].content).toBe("World");
    });

    it("drains committed messages on drainSnapshot()", () => {
      builder.apply({ type: "turn:message-committed", message: msg("m1", "Hello") });

      const first = builder.drainSnapshot();
      expect(first.committedMessages).toHaveLength(1);

      const second = builder.drainSnapshot();
      expect(second.committedMessages).toHaveLength(0);
    });

    it("includes error message in committed messages", () => {
      builder.apply({ type: "turn:error", error: "fail", message: msg("e1", "Error occurred") });

      const snapshot = builder.drainSnapshot();
      expect(snapshot.committedMessages).toHaveLength(1);
      expect(snapshot.committedMessages[0].id).toBe("e1");
      expect(snapshot.committedMessages[0].error).toBe(true);
    });

    it("synthesizes error message when none provided", () => {
      builder.apply({ type: "turn:error", error: "something broke" });

      const snapshot = builder.drainSnapshot();
      expect(snapshot.committedMessages).toHaveLength(1);
      expect(snapshot.committedMessages[0].role).toBe("assistant");
      expect(snapshot.committedMessages[0].content).toBe("Something went wrong. Please try again.");
      expect(snapshot.committedMessages[0].error).toBe(true);
    });

    it("suppresses error state for a retrying (recoverable) turn:error", () => {
      builder.apply({ type: "turn:text-delta", delta: "partial" });
      const flush = builder.apply({ type: "turn:error", error: "503", retrying: true });
      expect(flush).toBe(false); // throttle; no view change
      expect(builder.getView().status).not.toBe("error");
      expect(builder.getView().error).toBeNull();
      // No synthesized assistant error message for a transient retry.
      expect(builder.drainSnapshot().committedMessages).toHaveLength(0);
    });

    it("a retrying error followed by idle yields a clean ready view", () => {
      builder.apply({ type: "turn:error", error: "503", retrying: true });
      builder.apply({ type: "turn:text-delta", delta: "done" });
      builder.apply({ type: "turn:idle" });
      expect(builder.getView().status).toBe("ready");
      expect(builder.getView().error).toBeNull();
    });

    it("atomic: streaming text is cleared in same snapshot as committed message", () => {
      builder.apply({ type: "turn:text-delta", delta: "Hello world" });
      builder.apply({ type: "turn:message-committed", message: msg("m1", "Hello world") });

      const snapshot = builder.drainSnapshot();
      expect(snapshot.view.streamingText).toBe("");
      expect(snapshot.committedMessages).toHaveLength(1);
      expect(snapshot.committedMessages[0].content).toBe("Hello world");
    });
  });

  // ── Flush signals ──────────────────────────────────────────────────────

  describe("flush signals", () => {
    it("preserves ordered live content blocks from accumulator events", () => {
      builder.apply({
        type: "turn:text-delta",
        delta: "answer",
        contentBlocks: [
          { id: "thought-1", type: "reasoning", text: "think", durationSeconds: 1 },
          { id: "text-1", type: "text", content: "answer" },
        ],
      });

      expect(builder.getView().contentBlocks).toEqual([
        { id: "thought-1", type: "reasoning", text: "think", durationSeconds: 1 },
        { id: "text-1", type: "text", content: "answer" },
      ]);
    });

    it("text delta returns false (throttle)", () => {
      expect(builder.apply({ type: "turn:text-delta", delta: "hi" })).toBe(false);
    });

    it("reasoning returns false (throttle)", () => {
      expect(
        builder.apply({
          type: "turn:reasoning-updated",
          reasoning: { text: "think", durationSeconds: null },
        }),
      ).toBe(false);
    });

    it("tools-updated returns false (throttle)", () => {
      expect(
        builder.apply({
          type: "turn:tools-updated",
          toolCalls: [{ id: "t1", name: "shell", description: "ls", running: true }],
        }),
      ).toBe(false);
    });

    it("message-committed returns true (flush)", () => {
      expect(builder.apply({ type: "turn:message-committed", message: msg("m1", "done") })).toBe(
        true,
      );
    });

    it("idle returns true (flush)", () => {
      expect(builder.apply({ type: "turn:idle" })).toBe(true);
    });

    it("error returns true (flush)", () => {
      expect(builder.apply({ type: "turn:error", error: "fail" })).toBe(true);
    });

    it("status returns false (throttle)", () => {
      expect(builder.apply({ type: "turn:status", status: "thinking" })).toBe(false);
    });

    it("token-usage returns false (throttle)", () => {
      expect(
        builder.apply({ type: "turn:token-usage", currentTokens: 100, tokenLimit: 1000 }),
      ).toBe(false);
    });
  });

  // ── Token usage ────────────────────────────────────────────────────────

  describe("token usage", () => {
    it("tracks the latest turn input and output usage", () => {
      builder.apply({ type: "turn:usage", inputTokens: 12_345, outputTokens: 678 });
      expect(builder.getView().lastTurnUsage).toEqual({
        inputTokens: 12_345,
        outputTokens: 678,
      });
    });

    it("tracks token usage", () => {
      builder.apply({ type: "turn:token-usage", currentTokens: 500, tokenLimit: 4000 });
      expect(builder.getView().tokenUsage).toEqual({
        currentTokens: 500,
        tokenLimit: 4000,
      });
    });

    it("token usage survives idle (persists across turns)", () => {
      builder.apply({ type: "turn:token-usage", currentTokens: 500, tokenLimit: 4000 });
      builder.apply({ type: "turn:idle" });
      expect(builder.getView().tokenUsage).toEqual({
        currentTokens: 500,
        tokenLimit: 4000,
      });
    });
  });

  // ── Session status ─────────────────────────────────────────────────────

  describe("session status", () => {
    it("tracks session status text", () => {
      builder.apply({ type: "turn:status", status: "Searching the web..." });
      expect(builder.getView().sessionStatus).toBe("Searching the web...");
    });

    it("clears session status on idle", () => {
      builder.apply({ type: "turn:status", status: "Working..." });
      builder.apply({ type: "turn:idle" });
      expect(builder.getView().sessionStatus).toBeNull();
    });

    it("handles null status", () => {
      builder.apply({ type: "turn:status", status: "Working..." });
      builder.apply({ type: "turn:status", status: null });
      expect(builder.getView().sessionStatus).toBeNull();
    });
  });

  // ── Reset ──────────────────────────────────────────────────────────────

  describe("reset", () => {
    it("clears all state including pending committed messages", () => {
      builder.setSubmitted();
      builder.apply({ type: "turn:text-delta", delta: "Hello" });
      builder.apply({
        type: "turn:reasoning-updated",
        reasoning: { text: "think", durationSeconds: 1 },
      });
      builder.apply({
        type: "turn:tools-updated",
        toolCalls: [{ id: "t1", name: "shell", description: "ls", running: true }],
      });
      builder.apply({ type: "turn:message-committed", message: msg("m1", "done") });
      builder.apply({ type: "turn:token-usage", currentTokens: 100, tokenLimit: 1000 });

      builder.reset();

      const { view, committedMessages } = builder.drainSnapshot();
      expect(view.status).toBe("ready");
      expect(view.streamingText).toBe("");
      expect(view.reasoning).toBeNull();
      expect(view.toolStatuses).toEqual([]);
      expect(view.tokenUsage).toBeNull();
      expect(view.lastTurnUsage).toBeNull();
      expect(view.error).toBeNull();
      expect(view.sessionStatus).toBeNull();
      expect(committedMessages).toEqual([]);
    });
  });

  // ── Snapshot immutability ──────────────────────────────────────────────

  describe("snapshot immutability", () => {
    it("getSnapshot returns copies, not references to internal state", () => {
      builder.apply({
        type: "turn:tools-updated",
        toolCalls: [{ id: "t1", name: "shell", description: "ls", running: true }],
      });

      const snapshot1 = builder.drainSnapshot();
      // Mutate the returned snapshot
      snapshot1.view.toolStatuses.push({
        id: "t2",
        name: "hack",
        description: "injected",
        running: false,
      });

      // Internal state should be unaffected
      const snapshot2 = builder.drainSnapshot();
      expect(snapshot2.view.toolStatuses).toHaveLength(1);
    });
  });

  // ── Multi-turn sequence ────────────────────────────────────────────────

  describe("multi-turn sequence", () => {
    it("handles text -> commit -> more tools -> more text -> idle", () => {
      // First message
      builder.apply({ type: "turn:text-delta", delta: "I'll check that." });
      expect(builder.getView().status).toBe("streaming");

      builder.apply({
        type: "turn:message-committed",
        message: msg("m1", "I'll check that."),
      });
      const snap1 = builder.drainSnapshot();
      expect(snap1.view.streamingText).toBe("");
      expect(snap1.committedMessages).toHaveLength(1);

      // Tool execution
      builder.apply({
        type: "turn:tools-updated",
        toolCalls: [{ id: "t1", name: "shell", description: "ls -la", running: true }],
      });
      expect(builder.getView().status).toBe("streaming");
      expect(builder.getView().toolStatuses).toHaveLength(1);

      // Second message
      builder.apply({ type: "turn:text-delta", delta: "Here are the files." });
      builder.apply({
        type: "turn:message-committed",
        message: msg("m2", "Here are the files."),
      });

      const snap2 = builder.drainSnapshot();
      expect(snap2.view.streamingText).toBe("");
      expect(snap2.committedMessages).toHaveLength(1); // snap1 drained m1

      // Idle
      builder.apply({ type: "turn:idle" });
      expect(builder.getView().status).toBe("ready");
      expect(builder.getView().toolStatuses).toEqual([]);
    });
  });

  // ── defaultView ────────────────────────────────────────────────────────

  describe("defaultView", () => {
    it("returns a ready view with empty fields", () => {
      const view = SessionViewBuilder.defaultView();
      expect(view.status).toBe("ready");
      expect(view.streamingText).toBe("");
      expect(view.reasoning).toBeNull();
      expect(view.toolStatuses).toEqual([]);
      expect(view.tokenUsage).toBeNull();
      expect(view.lastTurnUsage).toBeNull();
      expect(view.error).toBeNull();
      expect(view.sessionStatus).toBeNull();
    });
  });
});
