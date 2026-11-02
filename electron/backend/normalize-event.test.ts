import { describe, it, expect } from "vitest";

import type { RuntimeSessionEvent } from "../../common/runtime-events";
import { expectBackendEvent } from "../testing/harness/backend-events";
import { normalizeEvent } from "./normalize-event";
import type { BackendEvent } from "./types";

/**
 * Build a partial runtime event for testing. normalizeEvent only reads `type` and `data`,
 * so we omit the other required envelope fields.
 */
const runtimeEvent = (partial: { type: string; data?: Record<string, unknown> }) =>
  partial as unknown as RuntimeSessionEvent; // oxlint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test helper: partial events for normalizeEvent which only reads type+data
const sdkEvent = runtimeEvent;

/** Helper — feed a raw runtime event and return the first normalized event (or null). */
function first(event: RuntimeSessionEvent): BackendEvent | null {
  const results = normalizeEvent(event);
  return results[0] ?? null;
}

describe("normalizeEvent", () => {
  // ── assistant.message_delta ──────────────────────────────────────────

  it("assistant.message_delta -> text-delta", () => {
    const result = first(
      runtimeEvent({
        type: "assistant.message_delta",
        data: { deltaContent: "Hello" },
      }),
    );
    expect(result).toEqual({ type: "text-delta", text: "Hello" });
  });

  // ── tool.execution_start ─────────────────────────────────────────────

  it("tool.execution_start with toolName -> tool-start", () => {
    const result = first(
      runtimeEvent({
        type: "tool.execution_start",
        data: { toolCallId: "tc-1", toolName: "read_file", arguments: { path: "/a" } },
      }),
    );
    expect(result).toMatchObject({
      type: "tool-start",
      toolCallId: "tc-1",
      toolName: "read_file",
      args: { path: "/a" },
      serverName: undefined,
    });
    expect(expectBackendEvent(result ?? undefined, "tool-start").startedAtMs).toEqual(
      expect.any(Number),
    );
  });

  it("tool.execution_start with mcpToolName uses mcpToolName over SDK toolName", () => {
    const result = first(
      sdkEvent({
        type: "tool.execution_start",
        data: {
          toolCallId: "tc-2",
          toolName: "mcp_read",
          mcpToolName: "read",
          mcpServerName: "fs",
        },
      }),
    );
    expect(result).toMatchObject({
      type: "tool-start",
      toolCallId: "tc-2",
      toolName: "read",
      serverName: "fs",
    });
  });

  it("preserves SDK and third-party MCP tool identities", () => {
    const host = first(
      runtimeEvent({
        type: "tool.execution_start",
        data: { toolCallId: "host", toolName: "marshal_recall", arguments: {} },
      }),
    );
    expect(host).toEqual(
      expect.objectContaining({ type: "tool-start", toolName: "marshal_recall" }),
    );

    const external = first(
      sdkEvent({
        type: "tool.execution_start",
        data: {
          toolCallId: "external",
          toolName: "mcp-call",
          mcpToolName: "mail_send_email",
          mcpServerName: "third-party",
        },
      }),
    );
    expect(external).toEqual(
      expect.objectContaining({ type: "tool-start", toolName: "mail_send_email" }),
    );
  });

  it("tool.execution_start includes mcpServerName as serverName", () => {
    const result = first(
      sdkEvent({
        type: "tool.execution_start",
        data: { toolCallId: "tc-3", toolName: "browser_click", mcpServerName: "playwright" },
      }),
    );
    expect(result).toMatchObject({
      type: "tool-start",
      serverName: "playwright",
    });
  });

  // ── tool.execution_complete ──────────────────────────────────────────

  it("tool.execution_complete -> tool-result with success: true (default)", () => {
    const result = first(
      sdkEvent({
        type: "tool.execution_complete",
        data: { toolCallId: "tc-1", result: "ok", success: true },
      }),
    );
    expect(result).toMatchObject({
      type: "tool-result",
      toolCallId: "tc-1",
      result: "ok",
      success: true,
    });
    expect(expectBackendEvent(result ?? undefined, "tool-result").completedAtMs).toEqual(
      expect.any(Number),
    );
  });

  it("tool.execution_complete with success: false -> tool-result with success: false", () => {
    const result = first(
      sdkEvent({
        type: "tool.execution_complete",
        data: { toolCallId: "tc-1", result: null, success: false, error: { message: "timeout" } },
      }),
    );
    expect(result).toMatchObject({
      type: "tool-result",
      toolCallId: "tc-1",
      success: false,
      error: "timeout",
    });
  });

  it("tool.execution_complete with error object -> error message string extracted", () => {
    const result = first(
      sdkEvent({
        type: "tool.execution_complete",
        data: {
          toolCallId: "tc-1",
          result: null,
          success: false,
          error: { message: "not found", code: "404" },
        },
      }),
    );
    expect(result).toMatchObject({
      type: "tool-result",
      success: false,
      error: "not found",
    });
  });

  it("tool.execution_complete with explicit success: true -> tool-result with success: true", () => {
    const result = first(
      sdkEvent({
        type: "tool.execution_complete",
        data: { toolCallId: "tc-1", result: "done", success: true },
      }),
    );
    expect(result).toMatchObject({
      type: "tool-result",
      success: true,
    });
  });

  // ── tool.execution_end (alias) ───────────────────────────────────────

  it("tool.execution_end -> tool-result (alias for tool.execution_complete)", () => {
    const result = first(
      sdkEvent({
        type: "tool.execution_end",
        data: { toolCallId: "tc-alias", result: "done", success: true },
      }),
    );
    expect(result).toMatchObject({
      type: "tool-result",
      toolCallId: "tc-alias",
      result: "done",
      success: true,
    });
  });

  it("tool.execution_end defaults success to true when field is absent", () => {
    // The unregistered-event handler uses `data["success"] !== false` so missing
    // success is treated as success=true (defensive default for forward-compat events).
    const result = first(
      sdkEvent({
        type: "tool.execution_end",
        data: { toolCallId: "tc-no-success", result: "ok" },
      }),
    );
    expect(result).toMatchObject({ type: "tool-result", success: true });
  });

  // ── assistant.message (turn-complete) ────────────────────────────────

  it("assistant.message with content -> turn-complete", () => {
    const result = first(
      sdkEvent({
        type: "assistant.message",
        data: { messageId: "msg-1", content: "Hello world" },
      }),
    );
    expect(result).toMatchObject({
      type: "turn-complete",
      message: {
        id: "msg-1",
        role: "assistant",
        content: "Hello world",
      },
    });
  });

  it("assistant.message with empty content passes through (TurnAccumulator handles suppression)", () => {
    // Empty assistant.message events are NOT suppressed in normalizeEvent because
    // TurnAccumulator needs them to commit question-only messages (askUser flow).
    // Suppression of truly empty turn-complete events lives in TurnAccumulator.handleTurnComplete().
    const result = first(
      sdkEvent({
        type: "assistant.message",
        data: { content: "" },
      }),
    );
    expect(result).toMatchObject({
      type: "turn-complete",
      message: {
        role: "assistant",
        content: "",
      },
    });
    // messageId should be generated when missing
    expect(expectBackendEvent(result ?? undefined, "turn-complete").message.id).toBeTruthy();
  });

  it("assistant.message with reasoning -> turn-complete with reasoning", () => {
    const result = first(
      sdkEvent({
        type: "assistant.message",
        data: { messageId: "msg-2", content: "Answer", reasoningText: "Let me think..." },
      }),
    );
    expect(result).toMatchObject({
      type: "turn-complete",
      message: {
        content: "Answer",
        reasoning: { text: "Let me think...", durationSeconds: null },
      },
    });
  });

  // ── session.idle ─────────────────────────────────────────────────────

  it("session.idle -> idle", () => {
    const result = first(sdkEvent({ type: "session.idle" }));
    expect(result).toEqual({ type: "idle" });
  });

  it("session.compaction_start is suppressed (not the trigger event)", () => {
    expect(normalizeEvent(sdkEvent({ type: "session.compaction_start", data: {} }))).toEqual([]);
  });

  // ── session.model_change ─────────────────────────────────────────────

  it("session.model_change -> metadata-updated", () => {
    const result = first(
      sdkEvent({
        type: "session.model_change",
        data: { newModel: "gpt-5" },
      }),
    );
    expect(result).toEqual({ type: "metadata-updated", model: "gpt-5" });
  });

  // ── session.metadata_updated ────────────────────────────────────────

  it("session.metadata_updated -> metadata-updated", () => {
    const result = first(
      sdkEvent({
        type: "session.metadata_updated",
        data: { newModel: "o3" },
      }),
    );
    expect(result).toEqual({ type: "metadata-updated", model: "o3" });
  });

  it("session.metadata_updated with no model -> metadata-updated with undefined model", () => {
    const result = first(
      sdkEvent({
        type: "session.metadata_updated",
        data: {},
      }),
    );
    expect(result).toEqual({ type: "metadata-updated", model: undefined });
  });

  // ── session.error ────────────────────────────────────────────────────

  it("session.error -> turn-error", () => {
    const result = first(
      sdkEvent({
        type: "session.error",
        data: { message: "Connection lost", errorType: "connection_error" },
      }),
    );
    expect(result).toMatchObject({
      type: "turn-error",
      error: "Connection lost",
      recoverable: false,
      code: "connection_error",
    });
  });

  it("session.error with no message falls back to 'Unknown error'", () => {
    const result = first(sdkEvent({ type: "session.error", data: {} }));
    expect(result).toMatchObject({ type: "turn-error", error: "Unknown error" });
  });

  // ── session.usage_info ───────────────────────────────────────────────

  it("session.usage_info -> token-usage", () => {
    const result = first(
      sdkEvent({
        type: "session.usage_info",
        data: { currentTokens: 1500, tokenLimit: 4096 },
      }),
    );
    expect(result).toEqual({
      type: "token-usage",
      currentTokens: 1500,
      tokenLimit: 4096,
    });
  });

  // ── assistant.usage ──────────────────────────────────────────────────

  it("assistant.usage -> llm-usage with all fields", () => {
    const result = first(
      sdkEvent({
        type: "assistant.usage",
        data: {
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
          apiCallId: "chatcmpl-abc123",
          providerCallId: "req-xyz",
        },
      }),
    );
    expect(result).toEqual({
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
      apiCallId: "chatcmpl-abc123",
      providerCallId: "req-xyz",
    });
  });

  it("assistant.usage preserves missing measurement availability beside legacy numeric defaults", () => {
    const result = first(
      sdkEvent({
        type: "assistant.usage",
        data: { model: "gpt-4o-mini" },
      }),
    );
    expect(result).toEqual({
      type: "llm-usage",
      usageAvailability: {
        inputTokens: false,
        outputTokens: false,
        cachedInputTokens: false,
        costUsd: false,
      },
      model: "gpt-4o-mini",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      cost: 0,
      duration: 0,
      ttftMs: 0,
      interTokenLatencyMs: 0,
      initiator: undefined,
      apiCallId: undefined,
      providerCallId: undefined,
    });
  });

  // ── assistant.reasoning_delta ────────────────────────────────────────

  it("assistant.reasoning_delta -> reasoning-delta", () => {
    const result = first(
      sdkEvent({
        type: "assistant.reasoning_delta",
        data: { deltaContent: "Thinking..." },
      }),
    );
    expect(result).toEqual({ type: "reasoning-delta", text: "Thinking..." });
  });

  // ── session.status ───────────────────────────────────────────────────

  it("session.status with status string -> status event", () => {
    const result = first(
      sdkEvent({
        type: "session.status",
        data: { status: "thinking" },
      }),
    );
    expect(result).toEqual({ type: "status", text: "thinking" });
  });

  it("session.status with message string -> status event (fallback)", () => {
    const result = first(
      sdkEvent({
        type: "session.status",
        data: { message: "processing request" },
      }),
    );
    expect(result).toEqual({ type: "status", text: "processing request" });
  });

  it("session.status with no text fields -> status event with null text", () => {
    const result = first(
      sdkEvent({
        type: "session.status",
        data: {},
      }),
    );
    expect(result).toEqual({ type: "status", text: null });
  });

  // ── MCP server status / OAuth ────────────────────────────────────────

  it("session.mcp_server_status_changed -> mcp-server-status", () => {
    const result = first(
      sdkEvent({
        type: "session.mcp_server_status_changed",
        data: { serverName: "powerbi", status: "needs-auth" },
      }),
    );
    expect(result).toEqual({
      type: "mcp-server-status",
      serverName: "powerbi",
      status: "needs-auth",
    });
  });

  it("session.mcp_server_status_changed forwards the error field for failed status", () => {
    const result = first(
      sdkEvent({
        type: "session.mcp_server_status_changed",
        data: { serverName: "powerbi", status: "failed", error: "Connection refused" },
      }),
    );
    expect(result).toEqual({
      type: "mcp-server-status",
      serverName: "powerbi",
      status: "failed",
      error: "Connection refused",
    });
  });

  it("session.mcp_servers_loaded -> one mcp-server-status per server", () => {
    const results = normalizeEvent(
      sdkEvent({
        type: "session.mcp_servers_loaded",
        data: {
          servers: [
            { name: "fs", status: "connected", source: "user" },
            { name: "powerbi", status: "failed", error: "boom", source: "plugin" },
          ],
        },
      }),
    );
    expect(results).toEqual([
      { type: "mcp-server-status", serverName: "fs", status: "connected", source: "user" },
      {
        type: "mcp-server-status",
        serverName: "powerbi",
        status: "failed",
        error: "boom",
        source: "plugin",
      },
    ]);
  });

  it("mcp.oauth_required -> mcp-oauth-required", () => {
    const result = first(
      sdkEvent({
        type: "mcp.oauth_required",
        data: {
          requestId: "req-1",
          serverName: "powerbi",
          serverUrl: "https://api.powerbi.com/mcp",
        },
      }),
    );
    expect(result).toEqual({
      type: "mcp-oauth-required",
      requestId: "req-1",
      serverName: "powerbi",
      serverUrl: "https://api.powerbi.com/mcp",
    });
  });

  it("mcp.oauth_completed -> mcp-oauth-completed", () => {
    const result = first(
      sdkEvent({
        type: "mcp.oauth_completed",
        data: { requestId: "req-1" },
      }),
    );
    expect(result).toEqual({ type: "mcp-oauth-completed", requestId: "req-1" });
  });

  // ── unknown event ────────────────────────────────────────────────────

  it("unknown event type -> empty array (dropped)", () => {
    const results = normalizeEvent(
      sdkEvent({
        type: "some.unknown.event",
        data: {},
      }),
    );
    expect(results).toEqual([]);
  });
});
