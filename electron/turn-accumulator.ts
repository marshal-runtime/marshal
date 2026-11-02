/**
 * TurnAccumulator — accumulates normalized BackendEvents for the current assistant turn
 * and returns enriched TurnEvent objects for emission to the renderer.
 *
 * Pure logic class with no IPC or Electron dependencies.
 */

import { formatToolDescription } from "../common/marshal-format-tool-description";
import type {
  AssistantContentBlock,
  MessageQuestion,
  MessageToolCall,
  SessionMessage,
  ToolProvenanceRecord,
  TurnEvent,
  TurnState,
  TurnToolCompletedEvent,
  TurnToolsUpdatedEvent,
} from "../common/marshal-ipc-contract";
import { createLogger } from "../common/marshal-logger";
import { classifyToolActivityKind, isCancelledToolError } from "../common/tool-activity";
import type { BackendEvent } from "./backend/types";
import {
  normalizeToolProvenance,
  type ToolProvenanceDraft,
} from "./command-center/tool-provenance-normalizer";
import { coerceErrorText } from "./error-formatting";

const log = createLogger("TurnAccumulator");

interface LiveToolCall {
  id: string;
  name: string;
  description: string;
  activityKind: MessageToolCall["activityKind"];
  running: boolean;
  input?: string;
  output?: string;
  success?: boolean;
  cancelled?: boolean;
  error?: string;
}

interface ActiveToolProvenanceDraft extends ToolProvenanceDraft {
  toolName: string;
}

/** Tool call for persistence — deduplicated by description. */
type PersistenceToolCall = MessageToolCall;

const MAX_TOOL_DETAIL_CHARS = 100_000;

function formatToolDetail(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = "[unserializable tool detail]";
    }
  }
  if (text.length <= MAX_TOOL_DETAIL_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_DETAIL_CHARS)}\n... truncated ${text.length - MAX_TOOL_DETAIL_CHARS} characters`;
}

function formatCompletedToolOutput(result: unknown): string {
  if (typeof result === "string") return formatToolDetail(result) ?? "";
  if (result && typeof result === "object" && "content" in result) {
    return formatToolDetail((result as Record<string, unknown>).content) ?? "";
  }
  return "";
}

function finalizeInterruptedToolCall<T extends MessageToolCall & { running?: boolean }>(
  toolCall: T,
): T {
  if (
    toolCall.running !== true &&
    (toolCall.success !== undefined || toolCall.cancelled === true || toolCall.error !== undefined)
  ) {
    return { ...toolCall, ...(toolCall.running === undefined ? {} : { running: false }) };
  }
  return {
    ...toolCall,
    running: false,
    success: false,
    cancelled: true,
    error: toolCall.error ?? "Turn interrupted",
  };
}

export function finalizeInterruptedCheckpoint(message: SessionMessage): SessionMessage {
  return {
    ...message,
    toolCalls: message.toolCalls?.map((toolCall) => finalizeInterruptedToolCall(toolCall)),
    contentBlocks: message.contentBlocks?.map((block) =>
      block.type === "tools"
        ? {
            ...block,
            toolCalls: block.toolCalls.map((toolCall) => finalizeInterruptedToolCall(toolCall)),
          }
        : { ...block },
    ),
  };
}

/** Wrap a single nullable event into an array. */
function wrap(event: TurnEvent | null): TurnEvent[] {
  return event ? [event] : [];
}

export class TurnAccumulator {
  private text = "";
  private reasoningText = "";
  private reasoningStart: number | null = null;
  private reasoningBlockStart: number | null = null;
  private contentBlocks: AssistantContentBlock[] = [];
  private blockSequence = 0;
  private structuredBlocks = false;

  /** Live tool calls keyed by toolCallId — for real-time renderer display. */
  private liveToolCalls = new Map<string, LiveToolCall>();

  /** Persistence tool calls deduplicated by description — for saving to disk. */
  private persistenceToolCalls: PersistenceToolCall[] = [];

  /** Sanitized tool provenance entries for the current assistant turn. */
  private toolProvenance: ToolProvenanceRecord[] = [];

  /** Raw in-flight tool drafts, discarded after being normalized on completion. */
  private activeToolProvenance = new Map<string, ActiveToolProvenanceDraft>();

  /** Pending question from askUser tool — attached to the committed message. */
  private pendingQuestion: MessageQuestion | null = null;

  /**
   * Resolves an SDK-registered MCP server key (snake_case, produced by
   * `toMcpServerKey`) back to the display name the user configured (e.g.
   * `power_bi` → `Power BI`). Used for "Using ${serverName}" labels so the
   * renderer doesn't show the sanitized storage key. Returns undefined when
   * the key isn't a known custom server (e.g. built-ins like `filesystem`),
   * in which case the caller falls back to the raw key.
   */
  private resolveServerDisplayName?: (serverKey: string) => string | undefined;

  constructor(opts: { resolveServerDisplayName?: (serverKey: string) => string | undefined } = {}) {
    this.resolveServerDisplayName = opts.resolveServerDisplayName;
  }

  /** Set a question to be included on the next committed message. */
  setQuestion(question: MessageQuestion): void {
    this.pendingQuestion = question;
  }

  /**
   * Process a normalized BackendEvent and return enriched TurnEvent(s).
   * Returns an empty array if the event should be suppressed.
   * Tool completion events return two events: tools-updated + tool-completed.
   */
  processEvent(event: BackendEvent): TurnEvent[] {
    switch (event.type) {
      case "text-delta":
        return wrap(this.handleTextDelta(event));
      case "text-snapshot":
        return wrap(this.handleTextSnapshot(event));
      case "reasoning-delta":
        return wrap(this.handleReasoningDelta(event));
      case "tool-start":
        return wrap(this.handleToolStart(event));
      case "tool-result":
        return this.handleToolResult(event);
      case "turn-complete":
        return wrap(this.handleTurnComplete(event));
      case "idle":
        return [{ type: "turn:idle" }];
      case "turn-error":
        return [this.handleTurnError(event)];
      case "status":
        return [{ type: "turn:status", status: event.text }];
      case "token-usage":
        return [
          {
            type: "turn:token-usage",
            currentTokens: event.currentTokens,
            tokenLimit: event.tokenLimit,
          },
        ];
      case "llm-usage":
        return [
          {
            type: "turn:llm-usage",
            ...(event.usageAvailability ? { usageAvailability: event.usageAvailability } : {}),
            model: event.model,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheReadTokens: event.cacheReadTokens,
            cacheWriteTokens: event.cacheWriteTokens,
            reasoningTokens: event.reasoningTokens,
            cost: event.cost,
            duration: event.duration,
            ttftMs: event.ttftMs,
            interTokenLatencyMs: event.interTokenLatencyMs,
            initiator: event.initiator,
            apiCallId: event.apiCallId,
            providerCallId: event.providerCallId,
          },
        ];
      case "turn-usage":
        return [
          {
            type: "turn:usage",
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
          },
        ];
      case "metadata-updated":
        return [{ type: "turn:metadata-updated" }];
      default:
        return [];
    }
  }

  /**
   * Assemble a SessionMessage from accumulated state.
   * @param id - The message id
   * @param contentOverride - If provided, use this instead of accumulated text
   */
  assembleMessage(id: string, contentOverride?: string): SessionMessage {
    const content = contentOverride ?? this.text;

    const reasoning = this.reasoningText.trim()
      ? {
          text: this.reasoningText,
          durationSeconds: this.computeReasoningDuration(),
        }
      : undefined;

    const toolCalls =
      this.persistenceToolCalls.length > 0 ? [...this.persistenceToolCalls] : undefined;

    const toolProvenance =
      this.toolProvenance.length > 0
        ? this.toolProvenance.map((entry) => ({ ...entry }))
        : undefined;

    const question = this.pendingQuestion ?? undefined;

    if (content && !this.contentBlocks.some((block) => block.type === "text")) {
      this.pushTextBlock(content);
    }

    const contentBlocks = this.snapshotContentBlocks();

    return {
      id,
      role: "assistant",
      content,
      timestamp: new Date().toISOString(),
      reasoning,
      toolCalls,
      toolProvenance,
      question,
      ...(contentBlocks ? { contentBlocks } : {}),
    };
  }

  /** Commit interrupted activity with unfinished calls marked as cancelled in the transcript. */
  assembleInterruptedMessage(id: string): SessionMessage {
    for (const tool of this.liveToolCalls.values()) {
      if (!tool.running) continue;
      this.handleToolResult({
        type: "tool-result",
        toolCallId: tool.id,
        result: tool.output,
        success: false,
        error: "Turn cancelled",
      });
    }
    return this.assembleMessage(id);
  }

  /** Whether there is uncommitted text content. */
  hasPendingContent(): boolean {
    return this.text.length > 0;
  }

  /** Whether reasoning has arrived without a final assistant message yet. */
  hasPendingReasoning(): boolean {
    return this.reasoningText.length > 0;
  }

  /** Whether a question is buffered for the next committed message. */
  hasPendingQuestion(): boolean {
    return this.pendingQuestion !== null;
  }

  /** Whether tool activity is waiting to be persisted on idle. */
  hasPendingTools(): boolean {
    return this.persistenceToolCalls.length > 0 || this.liveToolCalls.size > 0;
  }

  /** Snapshot of current turn state for re-subscribing renderers. Returns null if nothing accumulated. */
  getTurnState(): TurnState | null {
    if (!this.text && !this.reasoningText && this.liveToolCalls.size === 0) return null;
    return {
      text: this.text,
      reasoning: this.reasoningText
        ? { text: this.reasoningText, durationSeconds: this.computeReasoningDuration() }
        : null,
      toolCalls: Array.from(this.liveToolCalls.values()),
      ...(this.snapshotContentBlocks() ? { contentBlocks: this.snapshotContentBlocks() } : {}),
    };
  }

  /** Clear all accumulated state for a new turn. */
  reset(): void {
    this.text = "";
    this.reasoningText = "";
    this.reasoningStart = null;
    this.reasoningBlockStart = null;
    this.contentBlocks = [];
    this.blockSequence = 0;
    this.structuredBlocks = false;
    this.liveToolCalls.clear();
    this.persistenceToolCalls = [];
    this.toolProvenance = [];
    this.activeToolProvenance.clear();
    this.pendingQuestion = null;
  }

  // ── Private handlers ─────────────────────────────────────────────────

  private handleTextDelta(event: Extract<BackendEvent, { type: "text-delta" }>): TurnEvent | null {
    if (!event.text) return null;
    this.text += event.text;
    this.appendTextBlock(event.text, event.messageId);
    return {
      type: "turn:text-delta",
      delta: event.text,
      ...(this.snapshotContentBlocks() ? { contentBlocks: this.snapshotContentBlocks() } : {}),
    };
  }

  /** Handle full-text snapshots (gateway mode). Diff against accumulated text.
   * Assumes snapshots always extend the accumulated text (prefix-only growth).
   * If the snapshot doesn't extend, treat it as a correction — update state but
   * don't emit a delta (can't compute a meaningful diff). */
  private handleTextSnapshot(
    event: Extract<BackendEvent, { type: "text-snapshot" }>,
  ): TurnEvent | null {
    const newText = event.text;
    if (newText === this.text) return null;
    if (!newText.startsWith(this.text)) {
      log.warn("text-snapshot does not extend accumulated text — possible correction");
      this.text = newText; // Keep state consistent even for corrections
      return null; // No delta emitted for corrections (can't compute meaningful diff)
    }
    const delta = newText.slice(this.text.length);
    this.text = newText;
    if (!delta) return null;
    this.appendTextBlock(delta);
    return {
      type: "turn:text-delta",
      delta,
      ...(this.snapshotContentBlocks() ? { contentBlocks: this.snapshotContentBlocks() } : {}),
    };
  }

  private handleReasoningDelta(
    event: Extract<BackendEvent, { type: "reasoning-delta" }>,
  ): TurnEvent | null {
    if (!event.text) return null;
    if (this.reasoningStart === null) this.reasoningStart = Date.now();
    this.reasoningText += event.text;
    const block = this.appendReasoningBlock(event.text);
    return {
      type: "turn:reasoning-updated",
      reasoning: { text: block.text, durationSeconds: block.durationSeconds },
      ...(this.snapshotContentBlocks() ? { contentBlocks: this.snapshotContentBlocks() } : {}),
    };
  }

  private handleToolStart(event: Extract<BackendEvent, { type: "tool-start" }>): TurnEvent | null {
    const { toolCallId, toolName, description: desc, serverName } = event;
    if (!toolName || (!serverName && (toolName === "report_intent" || toolName === "askUser"))) {
      return null;
    }
    this.startToolProvenance(event);

    const description =
      desc ||
      (serverName
        ? `Using ${this.resolveServerDisplayName?.(serverName) ?? serverName}`
        : formatToolDescription(toolName, event.args) || `Running ${toolName}`);

    this.liveToolCalls.set(toolCallId, {
      id: toolCallId,
      name: toolName,
      description,
      activityKind: classifyToolActivityKind(toolName),
      running: true,
      ...(event.args !== undefined ? { input: formatToolDetail(event.args) } : {}),
    });

    if (!this.persistenceToolCalls.some((t) => t.id === toolCallId)) {
      this.persistenceToolCalls.push({
        id: toolCallId,
        name: toolName,
        description,
        activityKind: classifyToolActivityKind(toolName),
        ...(event.args !== undefined ? { input: formatToolDetail(event.args) } : {}),
      });
    }

    this.appendToolToBlock(this.liveToolCalls.get(toolCallId)!);

    return this.buildToolsUpdatedEvent(toolCallId);
  }

  private handleToolResult(event: Extract<BackendEvent, { type: "tool-result" }>): TurnEvent[] {
    const { toolCallId, success } = event;
    if (!toolCallId) return [];
    const provenance = this.completeToolProvenance(event);

    const existing = this.liveToolCalls.get(toolCallId);
    // Dedup: if tool is already marked complete, skip (SDK may emit both
    // tool.execution_end and tool.execution_complete for the same call)
    if (existing && !existing.running) return [];
    if (existing) {
      existing.running = false;
      existing.output = formatToolDetail(event.result);
      existing.success = success;
      if (!success && isCancelledToolError(event.error)) existing.cancelled = true;
      if (event.error) existing.error = event.error;
    }

    const persisted = this.persistenceToolCalls.find((t) => t.id === toolCallId);
    if (persisted) {
      persisted.output = formatToolDetail(event.result);
      persisted.success = success;
      if (!success && isCancelledToolError(event.error)) persisted.cancelled = true;
      if (event.error) persisted.error = event.error;
    }

    this.updateToolInBlocks(toolCallId, existing);

    const output = formatCompletedToolOutput(event.result);

    const completed: TurnToolCompletedEvent = {
      type: "turn:tool-completed",
      toolCallId,
      output,
      success,
      ...(!success && isCancelledToolError(event.error) ? { cancelled: true } : {}),
      ...(event.error ? { error: event.error } : {}),
      ...(provenance ? { provenance } : {}),
    };

    return [this.buildToolsUpdatedEvent(undefined, toolCallId), completed];
  }

  private handleTurnComplete(
    event: Extract<BackendEvent, { type: "turn-complete" }>,
  ): TurnEvent | null {
    const { message } = event;
    const content = message.content?.trim() ?? "";
    if (!content && !this.pendingQuestion) {
      // Empty turn-complete events can happen between tool-use rounds in multi-tool flows.
      // Don't reset — accumulated reasoning/tools are still needed for the final message.
      return null;
    }

    const sessionMessage = this.assembleMessage(message.id || Date.now().toString(), content);
    this.reset();
    return { type: "turn:message-committed", message: sessionMessage };
  }

  private handleTurnError(event: Extract<BackendEvent, { type: "turn-error" }>): TurnEvent {
    const error = coerceErrorText(event.error);
    const message = event.retrying
      ? undefined
      : this.hasPendingContent() || this.hasPendingQuestion()
        ? { ...this.assembleMessage(Date.now().toString()), error: true }
        : undefined;
    this.reset();
    return {
      type: "turn:error",
      // Defence-in-depth de-mask: the backend event types `error` as a string,
      // but a mis-typed producer could pass an object — never surface
      // "[object Object]" to the renderer or the sendAndCollect collectors.
      error,
      ...(event.retrying ? { retrying: true } : {}),
      ...(event.code ? { code: event.code } : {}),
      ...(event.retryAt !== undefined ? { retryAt: event.retryAt } : {}),
      message,
    };
  }

  private buildToolsUpdatedEvent(
    startedToolId?: string,
    targetToolId?: string,
  ): TurnToolsUpdatedEvent {
    const containingBlock =
      startedToolId || targetToolId
        ? this.findToolBlock(startedToolId ?? targetToolId!)
        : [...this.contentBlocks]
            .reverse()
            .find(
              (block): block is Extract<AssistantContentBlock, { type: "tools" }> =>
                block.type === "tools",
            );
    const toolCalls = containingBlock
      ? containingBlock.toolCalls.map((toolCall) => ({
          ...toolCall,
          id: toolCall.id ?? "",
          running: toolCall.running === true,
        }))
      : Array.from(this.liveToolCalls.values()).map((toolCall) => ({ ...toolCall }));
    return {
      type: "turn:tools-updated",
      toolCalls,
      ...(startedToolId ? { startedToolId } : {}),
      ...(this.snapshotContentBlocks() ? { contentBlocks: this.snapshotContentBlocks() } : {}),
    };
  }

  private nextBlockId(type: AssistantContentBlock["type"]): string {
    this.blockSequence += 1;
    return `${type}-${this.blockSequence}`;
  }

  private markBlockBoundary(): void {
    if (this.contentBlocks.length > 0) this.structuredBlocks = true;
  }

  private appendTextBlock(text: string, messageId?: string): void {
    const last = this.contentBlocks.at(-1);
    if (last?.type === "text" && (!messageId || last.id === messageId)) {
      last.content += text;
      return;
    }
    this.markBlockBoundary();
    if (messageId) this.structuredBlocks = true;
    this.reasoningBlockStart = null;
    this.contentBlocks.push({
      id: messageId ?? this.nextBlockId("text"),
      type: "text",
      content: text,
    });
  }

  private pushTextBlock(text: string): void {
    this.markBlockBoundary();
    this.contentBlocks.push({ id: this.nextBlockId("text"), type: "text", content: text });
  }

  private appendReasoningBlock(
    text: string,
  ): Extract<AssistantContentBlock, { type: "reasoning" }> {
    const last = this.contentBlocks.at(-1);
    if (last?.type === "reasoning") {
      last.text += text;
      last.durationSeconds = this.computeReasoningBlockDuration();
      return last;
    }
    this.markBlockBoundary();
    this.reasoningBlockStart = Date.now();
    const block: Extract<AssistantContentBlock, { type: "reasoning" }> = {
      id: this.nextBlockId("reasoning"),
      type: "reasoning",
      text,
      durationSeconds: this.computeReasoningBlockDuration(),
    };
    this.contentBlocks.push(block);
    return block;
  }

  private appendToolToBlock(toolCall: LiveToolCall): void {
    const last = this.contentBlocks.at(-1);
    if (last?.type === "tools") {
      if (!last.toolCalls.some((tool) => tool.id === toolCall.id)) {
        last.toolCalls.push({ ...toolCall });
      }
      return;
    }
    this.markBlockBoundary();
    this.reasoningBlockStart = null;
    this.contentBlocks.push({
      id: this.nextBlockId("tools"),
      type: "tools",
      toolCalls: [{ ...toolCall }],
    });
  }

  private findToolBlock(
    toolCallId: string,
  ): Extract<AssistantContentBlock, { type: "tools" }> | undefined {
    return this.contentBlocks.find(
      (block): block is Extract<AssistantContentBlock, { type: "tools" }> =>
        block.type === "tools" && block.toolCalls.some((tool) => tool.id === toolCallId),
    );
  }

  private updateToolInBlocks(toolCallId: string, toolCall?: LiveToolCall): void {
    if (!toolCall) return;
    const block = this.findToolBlock(toolCallId);
    if (!block) return;
    const index = block.toolCalls.findIndex((tool) => tool.id === toolCallId);
    if (index >= 0) block.toolCalls[index] = { ...toolCall };
  }

  private snapshotContentBlocks(): AssistantContentBlock[] | undefined {
    if (!this.structuredBlocks) return undefined;
    return this.contentBlocks.map((block) =>
      block.type === "tools"
        ? { ...block, toolCalls: block.toolCalls.map((tool) => ({ ...tool })) }
        : { ...block },
    );
  }

  private startToolProvenance(event: Extract<BackendEvent, { type: "tool-start" }>): void {
    if (!event.toolCallId || !event.toolName) return;
    this.activeToolProvenance.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(event.serverName ? { serverName: event.serverName } : {}),
      ...(event.args !== undefined ? { args: event.args } : {}),
      ...(event.startedAtMs !== undefined ? { startedAtMs: event.startedAtMs } : {}),
    });
  }

  private completeToolProvenance(
    event: Extract<BackendEvent, { type: "tool-result" }>,
  ): ToolProvenanceRecord | undefined {
    const draft = this.activeToolProvenance.get(event.toolCallId);
    if (!draft) return undefined;
    this.activeToolProvenance.delete(event.toolCallId);

    const provenance = normalizeToolProvenance({
      ...draft,
      result: event.result,
      success: event.success,
      ...(event.error ? { error: event.error } : {}),
      ...(event.completedAtMs !== undefined ? { completedAtMs: event.completedAtMs } : {}),
    });
    this.toolProvenance.push(provenance);
    return provenance;
  }

  private computeReasoningDuration(): number | null {
    if (this.reasoningStart === null) return null;
    return Math.ceil((Date.now() - this.reasoningStart) / 1000);
  }

  private computeReasoningBlockDuration(): number | null {
    if (this.reasoningBlockStart === null) return null;
    return Math.ceil((Date.now() - this.reasoningBlockStart) / 1000);
  }
}
