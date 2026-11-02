import type { SDKMessage, SDKResultMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { testDouble } from "../../testing/harness/test-double";
import { ClaudeEventTranslator } from "./events";

function assistantMessage(
  content: unknown[],
  overrides: Partial<Extract<SDKMessage, { type: "assistant" }>> = {},
): Extract<SDKMessage, { type: "assistant" }> {
  return testDouble({
    type: "assistant",
    message: testDouble({ id: "assistant-api-message", content }),
    parent_tool_use_id: null,
    uuid: "assistant-wire-message",
    session_id: "session-1",
    ...overrides,
  });
}

function successResult(): SDKResultMessage {
  return testDouble({
    type: "result",
    subtype: "success",
    duration_ms: 25,
    duration_api_ms: 20,
    ttft_ms: 5,
    is_error: false,
    num_turns: 1,
    result: "fallback result",
    stop_reason: "end_turn",
    total_cost_usd: 0.03,
    usage: testDouble({}),
    modelUsage: {
      "claude-sonnet-5": {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 10,
        webSearchRequests: 0,
        costUSD: 0.03,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
      },
    },
    permission_denials: [],
    uuid: "result-1",
    session_id: "session-1",
  });
}

describe("ClaudeEventTranslator", () => {
  it("emits additive model deltas for persistent-query results, including failed turns", () => {
    const translator = new ClaudeEventTranslator();
    const first = successResult();
    const firstUsage = first.modelUsage["claude-sonnet-5"];
    const second = testDouble<SDKResultMessage>({
      ...first,
      uuid: "result-2",
      subtype: "error_max_turns",
      errors: ["Turn limit"],
      modelUsage: {
        "claude-sonnet-5": {
          ...firstUsage,
          inputTokens: 110,
          outputTokens: 25,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 12,
          costUSD: 0.05,
        },
        "claude-haiku-4-5": {
          ...firstUsage,
          inputTokens: 3,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.001,
        },
      },
    });
    const initial = translator.translate(first).filter((event) => event.type === "assistant.usage");
    const delta = translator.translate(second).filter((event) => event.type === "assistant.usage");
    expect(initial[0]?.data).toMatchObject({ inputTokens: 140, outputTokens: 20, cost: 0.03 });
    expect(delta.map((event) => event.data)).toEqual([
      expect.objectContaining({
        model: "claude-sonnet-5",
        inputTokens: 62,
        outputTokens: 5,
        cacheReadTokens: 50,
        cacheWriteTokens: 2,
        cost: expect.closeTo(0.02),
      }),
      expect.objectContaining({
        model: "claude-haiku-4-5",
        inputTokens: 3,
        outputTokens: 1,
        cost: 0.001,
      }),
    ]);
    expect(delta[0]?.data.providerCallId).not.toBe(delta[1]?.data.providerCallId);
    expect(
      translator.translate(second).filter((event) => event.type === "assistant.usage"),
    ).toEqual([]);
    expect(translator.translate(first).filter((event) => event.type === "assistant.usage")).toEqual(
      [],
    );
    // An unseen stale result cannot roll the high-water counters backward.
    expect(
      translator
        .translate({ ...first, uuid: "late-result-0-0-0" })
        .filter((event) => event.type === "assistant.usage")[0]?.data,
    ).toMatchObject({ inputTokens: 0, outputTokens: 0, cost: 0 });
    expect(
      translator
        .translate({ ...second, uuid: "result-3-0-0-0" })
        .filter((event) => event.type === "assistant.usage")[0]?.data,
    ).toMatchObject({ inputTokens: 0, outputTokens: 0, cost: 0 });
  });
  it("resets totals only at a new query/conversation, not duplicate or late results", () => {
    const translator = new ClaudeEventTranslator();
    const first = successResult();
    translator.translate(first);
    const reset = testDouble<SDKMessage>({
      type: "conversation_reset",
      uuid: "reset-1",
      new_conversation_id: "session-2",
    });
    translator.translate(reset);
    const fresh = testDouble<SDKResultMessage>({
      ...first,
      uuid: "fresh-1",
      session_id: "session-2",
    });
    expect(
      translator.translate(fresh).filter((event) => event.type === "assistant.usage")[0]?.data,
    ).toMatchObject({ inputTokens: 140 });
    translator.translate(reset);
    expect(
      translator
        .translate({ ...fresh, uuid: "fresh-2-0-0-0" })
        .filter((event) => event.type === "assistant.usage")[0]?.data,
    ).toMatchObject({ inputTokens: 0 });
    expect(
      translator
        .translate({ ...first, uuid: "old-session-late-0-0" })
        .filter((event) => event.type === "assistant.usage"),
    ).toEqual([]);
    // ClaudeRuntimeSession owns one translator per query, including resumed IDs.
    expect(
      new ClaudeEventTranslator()
        .translate(first)
        .filter((event) => event.type === "assistant.usage")[0]?.data,
    ).toMatchObject({ inputTokens: 140 });
  });
  it("ends a user-declined tool turn without a session error banner", () => {
    const translator = new ClaudeEventTranslator();
    const events = translator.translate(
      testDouble<SDKResultMessage>({
        ...successResult(),
        subtype: "error_during_execution",
        is_error: true,
        stop_reason: "tool_use",
        errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
      }),
    );

    expect(events.some((event) => event.type === "session.error")).toBe(false);
    expect(events.some((event) => event.type === "session.idle")).toBe(true);
  });

  it("maps partial text and reasoning deltas", () => {
    const translator = new ClaudeEventTranslator();

    translator.translate(
      testDouble<SDKMessage>({
        type: "stream_event",
        event: testDouble({
          type: "message_start",
          message: { id: "stream-message", model: "claude-sonnet-5" },
        }),
        parent_tool_use_id: null,
        uuid: "stream-start",
        session_id: "session-1",
      }),
    );
    const textEvents = translator.translate(
      testDouble<SDKMessage>({
        type: "stream_event",
        event: testDouble({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hello" },
        }),
        parent_tool_use_id: null,
        uuid: "stream-text",
        session_id: "session-1",
      }),
    );
    const reasoningEvents = translator.translate(
      testDouble<SDKMessage>({
        type: "stream_event",
        event: testDouble({
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "reason" },
        }),
        parent_tool_use_id: null,
        uuid: "stream-thinking",
        session_id: "session-1",
      }),
    );

    expect(textEvents).toMatchObject([
      {
        type: "assistant.message_delta",
        data: { messageId: "stream-message", deltaContent: "hello" },
      },
    ]);
    expect(reasoningEvents).toMatchObject([
      { type: "assistant.reasoning_delta", data: { deltaContent: "reason" } },
    ]);
  });

  it("maps assistant content, host/MCP tool calls, tool results, and usage", () => {
    const translator = new ClaudeEventTranslator();

    const assistantEvents = translator.translate(
      assistantMessage([
        { type: "thinking", thinking: "because" },
        { type: "text", text: "hello" },
        {
          type: "tool_use",
          id: "host-call",
          name: "mcp__marshal__host_tool",
          input: { value: 1 },
        },
        {
          type: "tool_use",
          id: "remote-call",
          name: "mcp__github__list_issues",
          input: { repo: "owner/repo" },
        },
      ]),
    );
    const toolResultEvents = translator.translate(
      testDouble<SDKMessage>({
        type: "user",
        message: testDouble({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "host-call",
              content: "ok",
            },
          ],
        }),
        parent_tool_use_id: null,
        uuid: "tool-result-wire",
        session_id: "session-1",
      }),
    );
    const resultEvents = translator.translate(successResult());

    expect(assistantEvents).toMatchObject([
      {
        type: "tool.execution_start",
        data: {
          toolName: "host_tool",
          toolCallId: "host-call",
          arguments: { value: 1 },
        },
      },
      {
        type: "tool.execution_start",
        data: {
          toolName: "mcp__github__list_issues",
          toolCallId: "remote-call",
          mcpServerName: "github",
          mcpToolName: "list_issues",
        },
      },
    ]);
    expect(toolResultEvents).toMatchObject([
      {
        type: "tool.execution_complete",
        data: { toolCallId: "host-call", success: true, result: "ok" },
      },
    ]);
    expect(resultEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "assistant.message",
          data: {
            messageId: "assistant-api-message",
            content: "hello",
            reasoningText: "because",
          },
        }),
        expect.objectContaining({
          type: "assistant.usage",
          data: expect.objectContaining({
            model: "claude-sonnet-5",
            inputTokens: 140,
            outputTokens: 20,
            cacheReadTokens: 30,
            cacheWriteTokens: 10,
            cost: 0.03,
          }),
        }),
        expect.objectContaining({ type: "session.idle" }),
      ]),
    );
  });

  it("hides normal rate-limit telemetry but preserves actionable warnings", () => {
    const translator = new ClaudeEventTranslator();
    const allowed = translator.translate(
      testDouble<SDKMessage>({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed" },
        uuid: "rate-limit-allowed",
        session_id: "session-1",
      }),
    );
    const warning = translator.translate(
      testDouble<SDKMessage>({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning" },
        uuid: "rate-limit-warning",
        session_id: "session-1",
      }),
    );

    expect(allowed).toEqual([]);
    expect(warning).toMatchObject([
      {
        type: "session.status",
        data: { status: "Claude rate limit status: allowed_warning" },
      },
    ]);
  });

  it("maps SDK errors, compaction, status, model changes, and MCP status", () => {
    const translator = new ClaudeEventTranslator();

    translator.translate(assistantMessage([], { error: "authentication_failed" }));
    const assistantError = translator.translate(
      testDouble<SDKResultMessage>({
        type: "result",
        subtype: "error_during_execution",
        duration_ms: 5,
        duration_api_ms: 4,
        is_error: true,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage: testDouble({}),
        modelUsage: {},
        permission_denials: [],
        errors: [],
        uuid: "auth-error-result",
        session_id: "session-1",
      }),
    );
    const init = translator.translate(
      testDouble<SDKMessage>({
        type: "system",
        subtype: "init",
        model: "claude-opus-4-8",
        mcp_servers: [
          { name: "github", status: "connected" },
          { name: "oauth", status: "needs-auth" },
        ],
        uuid: "init-1",
        session_id: "session-1",
      }),
    );
    const compact = translator.translate(
      testDouble<SDKMessage>({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 190_000 },
        uuid: "compact-1",
        session_id: "session-1",
      }),
    );
    const status = translator.translate(
      testDouble<SDKMessage>({
        type: "system",
        subtype: "status",
        status: "compacting",
        uuid: "status-1",
        session_id: "session-1",
      }),
    );
    const fallback = translator.translate(
      testDouble<SDKMessage>({
        type: "system",
        subtype: "model_refusal_fallback",
        trigger: "refusal",
        direction: "retry",
        original_model: "claude-opus-4-8",
        fallback_model: "claude-sonnet-5",
        request_id: "request-1",
        content: "Retrying",
        uuid: "fallback-1",
        session_id: "session-1",
      }),
    );
    const idle = translator.translate(
      testDouble<SDKMessage>({
        type: "system",
        subtype: "session_state_changed",
        state: "idle",
        uuid: "idle-1",
        session_id: "session-1",
      }),
    );

    expect(assistantError).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session.error",
          data: {
            message: "Claude assistant request failed: authentication_failed",
            errorType: "authentication_failed",
          },
        }),
      ]),
    );
    expect(init).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session.model_change",
          data: { newModel: "claude-opus-4-8" },
        }),
        expect.objectContaining({
          type: "session.mcp_servers_loaded",
          data: {
            servers: [
              { name: "github", status: "connected" },
              { name: "oauth", status: "needs-auth" },
            ],
          },
        }),
      ]),
    );
    expect(compact).toMatchObject([{ type: "session.compaction_complete" }]);
    expect(status).toMatchObject([{ type: "session.status", data: { status: "compacting" } }]);
    expect(fallback).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session.model_change",
          data: { newModel: "claude-sonnet-5" },
        }),
      ]),
    );
    expect(idle).toMatchObject([{ type: "session.idle" }]);
  });

  it("leaves Claude requesting state to the standard live-turn animation", () => {
    const translator = new ClaudeEventTranslator();
    const requesting = translator.translate(
      testDouble<SDKMessage>({
        type: "system",
        subtype: "session_state_changed",
        state: "requesting",
        uuid: "requesting-state",
        session_id: "session-1",
      }),
    );

    expect(requesting).toEqual([]);
  });

  it("maps persisted assistant, tool-result, and compact-boundary history", () => {
    const translator = new ClaudeEventTranslator();
    const history = translator.translateHistory([
      testDouble<SessionMessage>({
        type: "assistant",
        uuid: "history-assistant",
        session_id: "session-1",
        message: testDouble({
          id: "history-message",
          content: [
            { type: "thinking", thinking: "past reasoning" },
            { type: "text", text: "past answer" },
          ],
        }),
        parent_tool_use_id: null,
        parent_agent_id: null,
      }),
      testDouble<SessionMessage>({
        type: "user",
        uuid: "history-tool",
        session_id: "session-1",
        message: testDouble({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "history-call",
              content: "history output",
              is_error: false,
            },
          ],
        }),
        parent_tool_use_id: null,
        parent_agent_id: null,
      }),
      testDouble<SessionMessage>({
        type: "system",
        uuid: "history-compact",
        session_id: "session-1",
        message: { subtype: "compact_boundary" },
        parent_tool_use_id: null,
        parent_agent_id: null,
      }),
    ]);

    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "assistant.message",
          data: {
            messageId: "history-message",
            content: "past answer",
            reasoningText: "past reasoning",
          },
        }),
        expect.objectContaining({
          type: "tool.execution_complete",
          data: {
            toolCallId: "history-call",
            success: true,
            result: "history output",
          },
        }),
        expect.objectContaining({ type: "session.compaction_complete" }),
      ]),
    );
  });
});
