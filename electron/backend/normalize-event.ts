/**
 * Event normalization — converts runtime-adapter session events into BackendEvent.
 *
 * Extracted into its own module so it can be unit-tested without pulling in
 * Electron dependencies (app, auth, etc.) that are imported by copilot/provider.ts.
 *
 * Note: text-snapshot is not produced by CopilotBackend (SDK uses text-delta).
 * It exists for Phase 2 GatewayBackend, which sends full accumulated text per delta.
 */

import { randomUUID } from "crypto";

import type { RuntimeSessionEvent } from "../../common/runtime-events";
import type { BackendEvent } from "./types";

/** Safely extract a string from an unknown value. */
function str(val: unknown): string {
  return typeof val === "string" ? val : "";
}

/** Safely extract a positive finite number from an unknown value, else 0. */
function num(val: unknown): number {
  return typeof val === "number" && Number.isFinite(val) && val > 0 ? val : 0;
}

function toRecord(source: unknown): Record<string, unknown> {
  if (typeof source !== "object" || source === null) return {};
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    result[key] = Reflect.get(source, key);
  }
  return result;
}

const MCP_STATUSES = [
  "connected",
  "failed",
  "needs-auth",
  "pending",
  "disabled",
  "not_configured",
] as const;
type McpServerStatus = (typeof MCP_STATUSES)[number];

function toMcpStatus(val: unknown): McpServerStatus {
  return (MCP_STATUSES as readonly string[]).includes(str(val))
    ? // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- guarded by includes() above
      (str(val) as McpServerStatus)
    : "not_configured";
}

/**
 * Convert a raw runtime session event into zero or more normalized BackendEvents.
 *
 * Known SDK events use discriminated-union narrowing for full compile-time type
 * safety on event.data fields. Events not yet in the SessionEvent union (e.g.
 * tool.execution_end, session.metadata_updated, session.status) fall through to
 * the default branch and are handled defensively via Record<string, unknown>.
 */
export function normalizeEvent(event: RuntimeSessionEvent): BackendEvent[] {
  const data = "data" in event ? toRecord(event.data) : {};

  switch (event.type) {
    case "session.history_snapshot":
      return [{ type: "history-snapshot", messages: event.data.messages }];
    case "session.context_checkpoint":
      return [{ type: "context-checkpoint", state: event.data.state }];
    case "assistant.message_delta":
      return [
        {
          type: "text-delta",
          text: event.data.deltaContent,
          ...(event.data.messageId ? { messageId: event.data.messageId } : {}),
        },
      ];

    case "assistant.message": {
      const { content, messageId, reasoningText } = event.data;
      // Empty mid-turn messages are NOT suppressed here because TurnAccumulator
      // needs them to commit question-only messages (askUser). The suppression
      // of truly empty turn-complete events lives in TurnAccumulator.handleTurnComplete()
      // which checks for pending questions before discarding.
      return [
        {
          type: "turn-complete",
          message: {
            id: messageId || randomUUID(),
            role: "assistant",
            content,
            reasoning: reasoningText ? { text: reasoningText, durationSeconds: null } : undefined,
          },
        },
      ];
    }

    case "assistant.reasoning_delta":
      return [{ type: "reasoning-delta", text: event.data.deltaContent }];

    case "tool.execution_start": {
      const { toolName: sdkToolName, toolCallId, arguments: args, mcpServerName } = event.data;
      const toolName = str(data.mcpToolName) || sdkToolName;
      return [
        {
          type: "tool-start",
          toolCallId,
          toolName,
          args,
          serverName: mcpServerName ?? undefined,
          startedAtMs: Date.now(),
        },
      ];
    }

    case "tool.execution_complete": {
      const { toolCallId, success, result, error } = event.data;
      return [
        {
          type: "tool-result",
          toolCallId,
          result,
          success,
          error: typeof error === "string" ? error : error?.message,
          completedAtMs: Date.now(),
        },
      ];
    }

    case "session.idle":
      return [{ type: "idle" }];

    case "session.background_task": {
      const { taskId, toolCallId, status, description, summary, outputFile } = event.data;
      return [
        {
          type: "background-task-update",
          taskId,
          toolCallId,
          status,
          description,
          summary,
          outputFile,
        },
      ];
    }

    case "session.error": {
      const { message, errorType, retryAt } = event.data;
      return [
        {
          type: "turn-error",
          error: message || "Unknown error",
          recoverable: false,
          code: errorType || undefined,
          ...(typeof retryAt === "number" ? { retryAt } : {}),
        },
      ];
    }

    case "session.usage_info": {
      const { currentTokens, tokenLimit } = event.data;
      return [{ type: "token-usage", currentTokens, tokenLimit }];
    }

    case "assistant.usage": {
      const d = event.data;
      // The new base already surfaces the rich `llm-usage` telemetry event.
      // ALSO emit a lean `turn-usage` event carrying just real per-turn
      // input/output spend, which the GoalEngine accumulates into
      // `GoalState.tokensUsed` (it must not sum the context-size `token-usage`).
      const inputTokens = num(d.inputTokens);
      const outputTokens = num(d.outputTokens);
      const events: BackendEvent[] = [
        {
          type: "llm-usage",
          ...(d.inputTokens === undefined ||
          d.outputTokens === undefined ||
          d.cacheReadTokens === undefined ||
          d.cost === undefined
            ? {
                usageAvailability: {
                  inputTokens: d.inputTokens !== undefined,
                  outputTokens: d.outputTokens !== undefined,
                  cachedInputTokens: d.cacheReadTokens !== undefined,
                  costUsd: d.cost !== undefined,
                },
              }
            : {}),
          model: d.model,
          inputTokens: d.inputTokens ?? 0,
          outputTokens: d.outputTokens ?? 0,
          cacheReadTokens: d.cacheReadTokens ?? 0,
          cacheWriteTokens: d.cacheWriteTokens ?? 0,
          reasoningTokens: d.reasoningTokens ?? 0,
          cost: d.cost ?? 0,
          duration: d.duration ?? 0,
          ttftMs: d.ttftMs ?? 0,
          interTokenLatencyMs: d.interTokenLatencyMs ?? 0,
          initiator: d.initiator,
          apiCallId: d.apiCallId,
          providerCallId: d.providerCallId,
        },
      ];
      if (inputTokens > 0 || outputTokens > 0) {
        events.push({ type: "turn-usage", inputTokens, outputTokens });
      }
      return events;
    }

    case "session.model_change":
      return [{ type: "metadata-updated", model: event.data.newModel || undefined }];

    case "tool.execution_end":
    case "session.metadata_updated":
    case "session.status":
    case "session.mcp_servers_loaded":
    case "session.mcp_server_status_changed":
    case "mcp.oauth_required":
    case "mcp.oauth_completed":
      return normalizeUnregisteredEvent(event.type, toRecord(event.data));

    case "runtime.unknown":
      return normalizeUnregisteredEvent(event.data.runtimeType, toRecord(event.data.payload));

    case "abort":
      return [];
  }
  return [];
}

/**
 * Handles adapter events whose payload is intentionally decoded defensively.
 * Uses defensive Record<string, unknown> access since types are unknown.
 */
function normalizeUnregisteredEvent(
  eventType: string,
  data: Record<string, unknown>,
): BackendEvent[] {
  switch (eventType) {
    case "tool.execution_end":
      return [
        {
          type: "tool-result",
          toolCallId: str(data["toolCallId"]),
          result: data["result"],
          success: data["success"] !== false,
          error: str(data["error"]) || undefined,
          completedAtMs: Date.now(),
        },
      ];

    case "session.metadata_updated":
      return [{ type: "metadata-updated", model: str(data["newModel"]) || undefined }];

    case "session.status": {
      const statusText =
        typeof data["status"] === "string"
          ? str(data["status"])
          : typeof data["message"] === "string"
            ? str(data["message"])
            : null;
      return [{ type: "status", text: statusText }];
    }

    case "session.mcp_servers_loaded": {
      // Fan out one mcp-server-status event per server so the UI gets a
      // consistent stream of status updates regardless of whether the change
      // arrived via the initial-load event or the per-server delta event.
      const servers = Array.isArray(data.servers) ? (data.servers as unknown[]) : [];
      return servers
        .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
        .map(
          (s) =>
            ({
              type: "mcp-server-status",
              serverName: str(s.name),
              status: toMcpStatus(s.status),
              error: str(s.error) || undefined,
              source: str(s.source) || undefined,
            }) as const,
        );
    }

    case "session.mcp_server_status_changed":
      return [
        {
          type: "mcp-server-status",
          serverName: str(data.serverName),
          status: toMcpStatus(data.status),
          error: str(data.error) || undefined,
        },
      ];

    case "mcp.oauth_required":
      return [
        {
          type: "mcp-oauth-required",
          requestId: str(data.requestId),
          serverName: str(data.serverName),
          serverUrl: str(data.serverUrl),
        },
      ];

    case "mcp.oauth_completed":
      return [
        {
          type: "mcp-oauth-completed",
          requestId: str(data.requestId),
        },
      ];

    default:
      // Unmapped SDK events (intentionally suppressed):
      // assistant.turn_start, assistant.turn_end, session.start,
      // permission.*, session.extensions_loaded
      return [];
  }
}
