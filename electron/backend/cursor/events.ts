import { randomUUID } from "node:crypto";

import type { InteractionUpdate, SDKMessage, TokenUsage } from "@cursor/sdk";

import type {
  RuntimeSessionEvent,
  RuntimeSessionEventDataMap,
  RuntimeSessionEventType,
} from "../../../common/runtime-events";
import {
  CURSOR_DELTA_THINKING_DELTA,
  CURSOR_DELTA_TOOL_CALL_COMPLETED,
  CURSOR_DELTA_TOOL_CALL_STARTED,
  CURSOR_RUN_STATUS_ERROR,
  CURSOR_SILENT_RUN_STATUSES,
  CURSOR_STREAM_TOOL_STATUS_COMPLETED,
  CURSOR_STREAM_TOOL_STATUS_RUNNING,
  CURSOR_TOOL_CALL_FAILED_MESSAGE,
  CURSOR_TOOL_RESULT_ERROR,
  CURSOR_TOOL_RESULT_SUCCESS,
} from "./constants";

function event<K extends RuntimeSessionEventType>(
  type: K,
  data: RuntimeSessionEventDataMap[K],
): Extract<RuntimeSessionEvent, { type: K }> {
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic event construction is checked by RuntimeSessionEventDataMap[K].
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    parentId: null,
    type,
    data,
  } as Extract<RuntimeSessionEvent, { type: K }>;
}

function usageEvent(usage: TokenUsage, model: string): RuntimeSessionEvent {
  return event("assistant.usage", {
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    reasoningTokens: usage.reasoningTokens,
  });
}

function isSilentRunStatus(status: string): boolean {
  return CURSOR_SILENT_RUN_STATUSES.some((silent) => silent === status);
}

function toolCallErrorText(
  result: { status: string; error?: unknown } | undefined,
): string | undefined {
  if (result?.status !== CURSOR_TOOL_RESULT_ERROR) return undefined;
  if (typeof result.error === "string" && result.error) return result.error;
  if (result.error && typeof result.error === "object" && "message" in result.error) {
    const message = result.error.message;
    if (typeof message === "string" && message) return message;
  }
  return CURSOR_TOOL_CALL_FAILED_MESSAGE;
}

function toolCallResultValue(result: { status: string; value?: unknown } | undefined): unknown {
  if (result?.status === CURSOR_TOOL_RESULT_SUCCESS) return result.value;
  return result;
}

export class CursorEventTranslator {
  private readonly startedCallIds = new Set<string>();
  private readonly completedCallIds = new Set<string>();

  translate(message: SDKMessage, model: string): RuntimeSessionEvent[] {
    switch (message.type) {
      case "assistant": {
        const translated: RuntimeSessionEvent[] = [];
        for (const block of message.message.content) {
          if (block.type === "text" && block.text) {
            translated.push(
              event("assistant.message_delta", {
                deltaContent: block.text,
              }),
            );
          } else if (block.type === "tool_use") {
            translated.push(...this.startTool(block.id, block.name, block.input));
          }
        }
        return translated;
      }
      case "thinking":
        return message.text
          ? [event("assistant.reasoning_delta", { deltaContent: message.text })]
          : [];
      case "tool_call":
        if (message.status === CURSOR_STREAM_TOOL_STATUS_RUNNING) {
          return this.startTool(message.call_id, message.name, message.args);
        }
        return this.completeTool(
          message.call_id,
          message.status === CURSOR_STREAM_TOOL_STATUS_COMPLETED,
          message.result,
          message.status === CURSOR_TOOL_RESULT_ERROR ? CURSOR_TOOL_CALL_FAILED_MESSAGE : undefined,
        );
      case "status":
        if (message.status === CURSOR_RUN_STATUS_ERROR) {
          return [
            event("session.error", {
              message: message.message ?? "Cursor run failed",
              errorType: message.status,
            }),
          ];
        }
        if (isSilentRunStatus(message.status)) {
          return [];
        }
        return [
          event("session.status", {
            status: message.status,
            message: message.message ?? null,
          }),
        ];
      case "usage":
        return [usageEvent(message.usage, model)];
      default:
        return [];
    }
  }

  /** Map Cursor onDelta tool updates without duplicating streamed text or thinking. */
  translateDelta(update: InteractionUpdate): RuntimeSessionEvent[] {
    switch (update.type) {
      case CURSOR_DELTA_TOOL_CALL_STARTED:
        return this.startTool(update.callId, update.toolCall.type, update.toolCall.args);
      case CURSOR_DELTA_TOOL_CALL_COMPLETED: {
        const result = update.toolCall.result;
        return this.completeTool(
          update.callId,
          result?.status !== CURSOR_TOOL_RESULT_ERROR,
          toolCallResultValue(result),
          toolCallErrorText(result),
        );
      }
      case CURSOR_DELTA_THINKING_DELTA:
        // Thinking is delivered again as ordered `thinking` messages on run.stream().
        // Consuming both channels duplicates every reasoning token in the transcript.
        return [];
      default:
        return [];
    }
  }

  private startTool(toolCallId: string, toolName: string, args: unknown): RuntimeSessionEvent[] {
    if (this.startedCallIds.has(toolCallId)) return [];
    this.startedCallIds.add(toolCallId);
    return [
      event("tool.execution_start", {
        toolName,
        toolCallId,
        arguments: args,
      }),
    ];
  }

  private completeTool(
    toolCallId: string,
    success: boolean,
    result?: unknown,
    error?: string,
  ): RuntimeSessionEvent[] {
    if (this.completedCallIds.has(toolCallId)) return [];
    this.completedCallIds.add(toolCallId);
    return [
      event("tool.execution_complete", {
        toolCallId,
        success,
        result,
        ...(error ? { error } : {}),
      }),
    ];
  }
}
