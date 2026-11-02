import { randomUUID } from "node:crypto";

import type {
  ModelUsage,
  SDKMessage,
  SDKResultMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  RuntimeSessionEvent,
  RuntimeSessionEventDataMap,
  RuntimeSessionEventType,
} from "../../../common/runtime-events";
import { parseClaudeToolName } from "./tool-names";

interface RuntimeEventMetadata {
  id: string;
  timestamp?: string;
  parentId?: string | null;
}

function event<K extends RuntimeSessionEventType>(
  type: K,
  data: RuntimeSessionEventDataMap[K],
  metadata: RuntimeEventMetadata,
): Extract<RuntimeSessionEvent, { type: K }> {
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic event construction is checked by RuntimeSessionEventDataMap[K].
  return {
    id: metadata.id,
    timestamp: metadata.timestamp ?? new Date().toISOString(),
    parentId: metadata.parentId ?? null,
    type,
    data,
  } as Extract<RuntimeSessionEvent, { type: K }>;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}

function stringField(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  return typeof value === "string" ? value : "";
}

function contentBlocks(message: unknown): unknown[] {
  const content = toRecord(message)["content"];
  return Array.isArray(content)
    ? content
    : typeof content === "string"
      ? [{ type: "text", text: content }]
      : [];
}

function resultErrorText(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  if (!Array.isArray(result)) return undefined;
  const text = result
    .map((item) => {
      const block = toRecord(item);
      return block["type"] === "text" ? stringField(block, "text") : "";
    })
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

export function isUserStoppedToolResult(result: SDKResultMessage): boolean {
  if (result.subtype === "success") return false;
  return result.errors.some(
    (error) =>
      error.includes("[ede_diagnostic]") &&
      error.includes("result_type=user") &&
      error.includes("stop_reason=tool_use"),
  );
}

function usageEvent(
  id: string,
  rawModel: string,
  usage: ModelUsage,
  result: SDKResultMessage,
): RuntimeSessionEvent {
  return event(
    "assistant.usage",
    {
      model: usage.canonicalModel ?? rawModel,
      // Shared input counters include cache reads/writes; cached input is a subset.
      inputTokens: usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadInputTokens,
      cacheWriteTokens: usage.cacheCreationInputTokens,
      cost: usage.costUSD,
      duration: result.duration_api_ms,
      ttftMs: result.subtype === "success" ? result.ttft_ms : undefined,
      providerCallId: JSON.stringify([result.uuid, rawModel]),
    },
    { id },
  );
}

export class ClaudeEventTranslator {
  private assistantText: string[] = [];
  private assistantReasoning: string[] = [];
  private lastAssistantMessageId: string | undefined;
  private pendingAssistantError: string | undefined;
  private currentModel: string | undefined;
  private readonly emittedToolStarts = new Set<string>();
  private readonly modelUsageTotals = new Map<string, ModelUsage>();
  private readonly processedUsageIds = new Set<string>();
  private readonly retiredUsageSessions = new Set<string>();
  private usageSessionId: string | undefined;

  translate(message: SDKMessage): RuntimeSessionEvent[] {
    const messageId = message.uuid ?? randomUUID();
    const metadata = {
      id: messageId,
      timestamp: "timestamp" in message ? message.timestamp : undefined,
      parentId:
        "parent_tool_use_id" in message && typeof message.parent_tool_use_id === "string"
          ? message.parent_tool_use_id
          : null,
    };

    switch (message.type) {
      case "stream_event":
        return this.translatePartial(message.event, metadata);
      case "assistant":
        this.pendingAssistantError = message.error;
        return this.translateAssistant(message.message, messageId, metadata, false);
      case "user":
        return this.translateUser(message.message, messageId, metadata);
      case "result":
        return this.translateResult(message);
      case "auth_status":
        return [
          event(
            "session.status",
            {
              status: message.isAuthenticating
                ? "Authenticating with the configured Claude API provider"
                : "Claude authentication status updated",
            },
            metadata,
          ),
          ...(message.error
            ? [
                event(
                  "session.error",
                  { message: message.error, errorType: "authentication_failed" },
                  { ...metadata, id: `${message.uuid}:error` },
                ),
              ]
            : []),
        ];
      case "prompt_suggestion":
        return [];
      case "rate_limit_event":
        // `allowed` is the steady-state subscription telemetry emitted by the
        // Claude SDK, not a user-actionable status. Showing it leaves a
        // full-width banner behind even though the turn completed normally.
        if (message.rate_limit_info.status === "allowed") return [];
        return [
          event(
            "session.status",
            { status: `Claude rate limit status: ${message.rate_limit_info.status}` },
            metadata,
          ),
        ];
      case "tool_use_summary":
        return [event("session.status", { status: message.summary }, metadata)];
      case "tool_progress":
        return [
          event("session.status", { status: `${message.tool_name} is still running` }, metadata),
        ];
      case "conversation_reset":
        if (
          !this.processedUsageIds.has(messageId) &&
          !this.retiredUsageSessions.has(message.new_conversation_id)
        ) {
          this.processedUsageIds.add(messageId);
          this.resetUsage(message.new_conversation_id);
        }
        return [
          event(
            "runtime.unknown",
            {
              runtimeType: "claude.conversation_reset",
              payload: { newConversationId: message.new_conversation_id },
            },
            metadata,
          ),
        ];
      case "system":
        return this.translateSystem(message, metadata);
      default:
        return [
          event(
            "runtime.unknown",
            {
              runtimeType: `claude.${String(Reflect.get(message, "type"))}`,
              payload: message,
            },
            metadata,
          ),
        ];
    }
  }

  translateHistory(messages: SessionMessage[]): RuntimeSessionEvent[] {
    const translated: RuntimeSessionEvent[] = [];
    const historyTranslator = new ClaudeEventTranslator();
    for (const message of messages) {
      const metadata = { id: message.uuid, parentId: message.parent_tool_use_id };
      if (message.type === "assistant") {
        translated.push(
          ...historyTranslator.translateAssistant(message.message, message.uuid, metadata, true),
        );
      } else if (message.type === "user") {
        translated.push(
          ...historyTranslator.translateUser(message.message, message.uuid, metadata),
        );
      } else {
        const payload = toRecord(message.message);
        if (payload["subtype"] === "compact_boundary") {
          translated.push(event("session.compaction_complete", {}, metadata));
        } else {
          translated.push(
            event(
              "runtime.unknown",
              { runtimeType: "claude.history.system", payload: message.message },
              metadata,
            ),
          );
        }
      }
    }
    return translated;
  }

  private translatePartial(
    rawEvent: unknown,
    metadata: RuntimeEventMetadata,
  ): RuntimeSessionEvent[] {
    const streamEvent = toRecord(rawEvent);
    if (streamEvent["type"] === "message_start") {
      const message = toRecord(streamEvent["message"]);
      const messageId = stringField(message, "id");
      const model = stringField(message, "model");
      if (messageId) this.lastAssistantMessageId = messageId;
      if (model && model !== this.currentModel) {
        this.currentModel = model;
        return [event("session.model_change", { newModel: model }, metadata)];
      }
      return [];
    }
    if (streamEvent["type"] !== "content_block_delta") return [];
    const delta = toRecord(streamEvent["delta"]);
    if (delta["type"] === "text_delta") {
      const text = stringField(delta, "text");
      return text
        ? [
            event(
              "assistant.message_delta",
              { messageId: this.lastAssistantMessageId, deltaContent: text },
              metadata,
            ),
          ]
        : [];
    }
    if (delta["type"] === "thinking_delta") {
      const thinking = stringField(delta, "thinking");
      return thinking
        ? [
            event(
              "assistant.reasoning_delta",
              { reasoningId: this.lastAssistantMessageId, deltaContent: thinking },
              metadata,
            ),
          ]
        : [];
    }
    return [];
  }

  private translateAssistant(
    rawMessage: unknown,
    uuid: string,
    metadata: RuntimeEventMetadata,
    finalize: boolean,
  ): RuntimeSessionEvent[] {
    const message = toRecord(rawMessage);
    const messageId = stringField(message, "id") || uuid;
    this.lastAssistantMessageId = messageId;
    const events: RuntimeSessionEvent[] = [];

    for (const rawBlock of contentBlocks(rawMessage)) {
      const block = toRecord(rawBlock);
      switch (block["type"]) {
        case "text": {
          const text = stringField(block, "text");
          if (text) this.assistantText.push(text);
          break;
        }
        case "thinking": {
          const thinking = stringField(block, "thinking");
          if (thinking) this.assistantReasoning.push(thinking);
          break;
        }
        case "tool_use":
        case "server_tool_use": {
          const toolCallId = stringField(block, "id");
          const sdkToolName = stringField(block, "name");
          if (!toolCallId || !sdkToolName || this.emittedToolStarts.has(toolCallId)) break;
          const parsedName = parseClaudeToolName(sdkToolName);
          this.emittedToolStarts.add(toolCallId);
          events.push(
            event(
              "tool.execution_start",
              {
                toolName: parsedName.runtimeName,
                toolCallId,
                arguments: block["input"],
                mcpServerName:
                  parsedName.serverName && !parsedName.isHostTool
                    ? parsedName.serverName
                    : undefined,
                mcpToolName:
                  parsedName.serverName && !parsedName.isHostTool
                    ? parsedName.mcpToolName
                    : undefined,
              },
              { ...metadata, id: `${uuid}:tool:${toolCallId}:start` },
            ),
          );
          break;
        }
      }
    }

    if (finalize) {
      events.push(
        event(
          "assistant.message",
          {
            messageId,
            content: this.assistantText.join(""),
            reasoningText: this.assistantReasoning.join("") || undefined,
          },
          { ...metadata, id: `${uuid}:message` },
        ),
      );
      this.resetTurn();
    }
    return events;
  }

  private translateUser(
    rawMessage: unknown,
    uuid: string,
    metadata: RuntimeEventMetadata,
  ): RuntimeSessionEvent[] {
    const events: RuntimeSessionEvent[] = [];
    for (const rawBlock of contentBlocks(rawMessage)) {
      const block = toRecord(rawBlock);
      if (block["type"] !== "tool_result") continue;
      const toolCallId = stringField(block, "tool_use_id");
      if (!toolCallId) continue;
      const isError = block["is_error"] === true;
      const result = block["content"];
      events.push(
        event(
          "tool.execution_complete",
          {
            toolCallId,
            success: !isError,
            result,
            error: isError ? resultErrorText(result) : undefined,
          },
          { ...metadata, id: `${uuid}:tool:${toolCallId}:complete` },
        ),
      );
      this.emittedToolStarts.delete(toolCallId);
    }
    return events;
  }

  private translateResult(result: SDKResultMessage): RuntimeSessionEvent[] {
    const events: RuntimeSessionEvent[] = [];
    const userStoppedTool = isUserStoppedToolResult(result);
    const finalContent =
      this.assistantText.join("") || (result.subtype === "success" ? result.result : "");
    if (!userStoppedTool || finalContent || this.assistantReasoning.length > 0) {
      events.push(
        event(
          "assistant.message",
          {
            messageId: this.lastAssistantMessageId ?? result.uuid,
            content: finalContent,
            reasoningText: this.assistantReasoning.join("") || undefined,
          },
          { id: `${result.uuid}:message` },
        ),
      );
    }

    // One persistent query emits cumulative modelUsage on each turn. Convert at
    // the provider boundary so generic execution receipts remain additive.
    // See Claude Agent SDK cost-tracking: streaming input totals reset only for
    // a new query or conversation reset; crash results may carry zeroed totals.
    if (
      !this.processedUsageIds.has(result.uuid) &&
      !this.retiredUsageSessions.has(result.session_id)
    ) {
      this.processedUsageIds.add(result.uuid);
      if (this.usageSessionId !== result.session_id) this.resetUsage(result.session_id);
      for (const [index, [model, usage]] of Object.entries(result.modelUsage).entries()) {
        const previous = this.modelUsageTotals.get(model);
        const next = { ...usage };
        const delta = { ...usage };
        for (const key of [
          "inputTokens",
          "outputTokens",
          "cacheReadInputTokens",
          "cacheCreationInputTokens",
          "webSearchRequests",
          "costUSD",
        ] as const) {
          next[key] = Math.max(previous?.[key] ?? 0, usage[key]);
          delta[key] = next[key] - (previous?.[key] ?? 0);
        }
        this.modelUsageTotals.set(model, next);
        events.push(usageEvent(`${result.uuid}:usage:${index}`, model, delta, result));
      }
    }

    if (result.subtype !== "success" && !userStoppedTool) {
      const assistantError = this.pendingAssistantError;
      events.push(
        event(
          "session.error",
          {
            message:
              result.errors.join("\n") ||
              (assistantError
                ? `Claude assistant request failed: ${assistantError}`
                : `Claude turn ended with ${result.subtype}`),
            errorType: assistantError ?? result.subtype,
          },
          { id: `${result.uuid}:error` },
        ),
      );
    }
    // A result is Claude's authoritative end-of-turn boundary. Some SDK
    // versions deliver session_state_changed(idle) later (or omit it), which
    // otherwise leaves Marshal busy and causes the next prompt to be queued.
    events.push(event("session.idle", {}, { id: `${result.uuid}:idle` }));
    this.resetTurn();
    return events;
  }

  private resetUsage(sessionId: string): void {
    if (this.usageSessionId && this.usageSessionId !== sessionId)
      this.retiredUsageSessions.add(this.usageSessionId);
    this.usageSessionId = sessionId;
    this.modelUsageTotals.clear();
  }

  private translateSystem(
    message: Extract<SDKMessage, { type: "system" }>,
    metadata: RuntimeEventMetadata,
  ): RuntimeSessionEvent[] {
    switch (message.subtype) {
      case "init": {
        const events: RuntimeSessionEvent[] = [];
        if (message.model && message.model !== this.currentModel) {
          this.currentModel = message.model;
          events.push(
            event(
              "session.model_change",
              { newModel: message.model },
              { ...metadata, id: `${message.uuid}:model` },
            ),
          );
        }
        events.push(
          event(
            "session.mcp_servers_loaded",
            {
              servers: message.mcp_servers.map((server) => ({
                name: server.name,
                status: server.status,
              })),
            },
            { ...metadata, id: `${message.uuid}:mcp` },
          ),
        );
        return events;
      }
      case "compact_boundary":
        return [event("session.compaction_complete", {}, metadata)];
      case "status":
        if (message.status?.trim().toLowerCase() === "requesting") return [];
        return [
          event(
            "session.status",
            {
              status:
                message.status ??
                (message.compact_result ? `Compaction ${message.compact_result}` : null),
            },
            metadata,
          ),
          ...(message.compact_result === "failed"
            ? [
                event(
                  "session.error",
                  {
                    message: message.compact_error ?? "Claude session compaction failed",
                    errorType: "compaction_failed",
                  },
                  { ...metadata, id: `${message.uuid}:error` },
                ),
              ]
            : []),
        ];
      case "session_state_changed": {
        // `requesting` is Claude's transport-level "model call in flight"
        // state. Marshal already represents that through the live turn's
        // compact animated Working indicator, so surfacing it as a full-width
        // dismissible status banner is noisy and duplicates the same state.
        const transportState: unknown = message.state;
        if (transportState === "requesting") return [];
        return message.state === "idle"
          ? [event("session.idle", {}, metadata)]
          : [event("session.status", { status: message.state }, metadata)];
      }
      case "api_retry":
        return [
          event(
            "session.status",
            {
              status: `Retrying Claude API request (${message.attempt}/${message.max_retries})`,
            },
            metadata,
          ),
        ];
      case "permission_denied":
        return [
          event(
            "tool.execution_complete",
            {
              toolCallId: message.tool_use_id,
              success: false,
              error: message.message,
            },
            metadata,
          ),
        ];
      case "model_refusal_fallback":
        this.currentModel = message.fallback_model;
        return [
          event("session.model_change", { newModel: message.fallback_model }, metadata),
          event(
            "session.status",
            { status: `Claude switched models after a refusal` },
            { ...metadata, id: `${message.uuid}:status` },
          ),
        ];
      case "model_refusal_no_fallback":
        return [
          event(
            "session.error",
            { message: message.content, errorType: "model_refusal" },
            metadata,
          ),
        ];
      case "notification":
        if (message.text.trim().toLowerCase() === "requesting") return [];
        return [event("session.status", { status: message.text }, metadata)];
      case "worker_shutting_down":
        return [event("session.status", { status: message.reason }, metadata)];
      case "mirror_error":
        return [
          event(
            "session.error",
            { message: message.error, errorType: "session_store_error" },
            metadata,
          ),
        ];
      case "task_started":
        // Only backgrounded tasks (backgrounded Bash, backgrounded Agent
        // subagents) get a `session.background_task` event — a foreground
        // task's lifecycle is already covered by tool.execution_start/complete.
        if (!message.is_backgrounded) return [];
        return [
          event(
            "session.background_task",
            {
              taskId: message.task_id,
              toolCallId: message.tool_use_id,
              status: "started",
              description: message.description,
            },
            metadata,
          ),
        ];
      case "task_notification":
        return [
          event(
            "session.background_task",
            {
              taskId: message.task_id,
              toolCallId: message.tool_use_id,
              status: message.status,
              summary: message.summary,
              outputFile: message.output_file,
            },
            metadata,
          ),
        ];
      default:
        return [
          event(
            "runtime.unknown",
            { runtimeType: `claude.system.${message.subtype}`, payload: message },
            metadata,
          ),
        ];
    }
  }

  private resetTurn(): void {
    this.assistantText = [];
    this.assistantReasoning = [];
    this.lastAssistantMessageId = undefined;
    this.pendingAssistantError = undefined;
  }
}
