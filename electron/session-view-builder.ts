/**
 * SessionViewBuilder — consumes TurnEvents and maintains a SessionView snapshot
 * for emission to the renderer.
 *
 * Pure logic class with no IPC or Electron dependencies. The SessionManager
 * creates one per session and pipes TurnEvents into it after TurnAccumulator
 * enrichment. The builder projects UI state; the accumulator enriches events.
 */

import {
  DEFAULT_SESSION_VIEW,
  type AssistantContentBlock,
  type SessionMessage,
  type SessionView,
  type SessionViewEvent,
  type SessionViewStatus,
  type TurnEvent,
  type TurnToolStatus,
} from "../common/marshal-ipc-contract";
import { isCancelledToolError } from "../common/tool-activity";
import { formatUserFacingError } from "./error-formatting";

/** Throttle interval for session:view snapshot emissions (ms). */
export const VIEW_THROTTLE_MS = 80;
/**
 * Inactivity timeout before a busy session is considered stuck (ms).
 *
 * This fires only after this long with NO events at all while a turn is busy
 * (the detector re-arms whenever a tool is still running). High-reasoning
 * models (gpt-5.5 at high/xhigh) and long workflow investigator turns can think
 * for several minutes between streamed events, which the old 3-minute value
 * misread as "stuck" and force-failed mid-investigation. 20 minutes leaves
 * deep reasoning + long tool gaps alone while still catching a genuine hang.
 */
export const STUCK_TIMEOUT_MS = 20 * 60 * 1000;

export class SessionViewBuilder {
  private status: SessionViewStatus = "ready";
  private streamingText = "";
  private reasoning: { text: string; durationSeconds: number | null } | null = null;
  private toolStatuses: TurnToolStatus[] = [];
  private tokenUsage: { currentTokens: number; tokenLimit: number } | null = null;
  private lastTurnUsage: { inputTokens: number; outputTokens: number } | null = null;
  private error: string | null = null;
  private sessionStatus: string | null = null;
  private pendingCommittedMessages: SessionMessage[] = [];
  private contentBlocks: AssistantContentBlock[] | undefined;

  /**
   * Apply a TurnEvent to update the view state.
   * Returns true if this event should trigger an immediate flush
   * (state transition), false if it can be throttled (streaming delta).
   */
  apply(event: TurnEvent): boolean {
    switch (event.type) {
      case "turn:text-delta":
        this.status = "streaming";
        this.streamingText += event.delta;
        this.error = null;
        this.setContentBlocks(event.contentBlocks);
        return false; // throttle

      case "turn:reasoning-updated":
        this.status = "streaming";
        this.reasoning = event.reasoning;
        this.error = null;
        this.setContentBlocks(event.contentBlocks);
        return false; // throttle

      case "turn:tools-updated":
        this.status = "streaming";
        this.toolStatuses = event.toolCalls.map((t) => ({ ...t }));
        this.error = null;
        this.setContentBlocks(event.contentBlocks);
        return false; // throttle

      case "turn:message-committed":
        this.pendingCommittedMessages.push(event.message);
        this.streamingText = "";
        this.reasoning = null;
        this.contentBlocks = undefined;
        // Don't clear toolStatuses here — they may still be displayed briefly.
        // Don't change status — more content may follow in a multi-turn sequence.
        return true; // flush immediately

      case "turn:idle":
        this.status = "ready";
        this.streamingText = "";
        this.reasoning = null;
        this.toolStatuses = [];
        this.contentBlocks = undefined;
        this.error = null;
        this.sessionStatus = null;
        return true; // flush immediately

      case "turn:error":
        if (event.retrying) {
          // The backend is retrying THIS turn (transient recoverable error).
          // Don't paint the view as errored or synthesize a permanent error
          // message — the retried turn's own events (text/idle, or a final
          // non-retrying error) drive the view. Avoids a stale error bubble
          // appearing alongside the successful retried answer.
          return false; // throttle; no view change
        }
        this.status = "error";
        this.error = formatUserFacingError(event.error);
        this.streamingText = "";
        this.reasoning = null;
        this.toolStatuses = [];
        this.contentBlocks = undefined;
        if (event.message) {
          this.pendingCommittedMessages.push({ ...event.message, error: true });
        } else {
          // Synthesize an error message so the renderer doesn't have to
          this.pendingCommittedMessages.push({
            id: crypto.randomUUID(),
            role: "assistant",
            content: this.error,
            timestamp: new Date().toISOString(),
            error: true,
          });
        }
        return true; // flush immediately

      case "turn:status":
        this.sessionStatus = event.status;
        return false; // throttle

      case "turn:token-usage":
        this.tokenUsage = {
          currentTokens: event.currentTokens,
          tokenLimit: event.tokenLimit,
        };
        return false; // throttle

      case "turn:usage":
        this.lastTurnUsage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        };
        return false;

      case "turn:tool-completed":
        this.toolStatuses = this.toolStatuses.map((tool) => {
          if (tool.id !== event.toolCallId) return tool;
          return {
            ...tool,
            running: false,
            success: event.success,
            ...(event.cancelled || (!event.success && isCancelledToolError(event.error))
              ? { cancelled: true }
              : {}),
            ...(event.output || tool.output === undefined ? { output: event.output } : {}),
            ...(event.error ? { error: event.error } : {}),
          };
        });
        return false;

      case "turn:metadata-updated":
        // Consumed by session list sidebar via separate IPC; no view state change.
        return false;

      default:
        return false;
    }
  }

  /** Mark the session as submitted (user sent a message). */
  setSubmitted(): void {
    this.status = "submitted";
    this.error = null;
    this.streamingText = "";
    this.reasoning = null;
    this.toolStatuses = [];
    this.contentBlocks = undefined;
  }

  /**
   * Get the current snapshot and drain pending committed messages.
   * After calling this, `pendingCommittedMessages` is empty until
   * more `turn:message-committed` events arrive.
   */
  drainSnapshot(): SessionViewEvent {
    const committed = this.pendingCommittedMessages;
    this.pendingCommittedMessages = [];

    return {
      type: "session:view",
      view: {
        status: this.status,
        streamingText: this.streamingText,
        reasoning: this.reasoning ? { ...this.reasoning } : null,
        toolStatuses: this.toolStatuses.map((t) => ({ ...t })),
        tokenUsage: this.tokenUsage ? { ...this.tokenUsage } : null,
        lastTurnUsage: this.lastTurnUsage ? { ...this.lastTurnUsage } : null,
        error: this.error,
        sessionStatus: this.sessionStatus,
        ...(this.contentBlocks ? { contentBlocks: this.cloneContentBlocks() } : {}),
      },
      committedMessages: committed,
    };
  }

  /** Get the current view without draining committed messages. */
  getView(): SessionView {
    return {
      status: this.status,
      streamingText: this.streamingText,
      reasoning: this.reasoning ? { ...this.reasoning } : null,
      toolStatuses: this.toolStatuses.map((t) => ({ ...t })),
      tokenUsage: this.tokenUsage ? { ...this.tokenUsage } : null,
      lastTurnUsage: this.lastTurnUsage ? { ...this.lastTurnUsage } : null,
      error: this.error,
      sessionStatus: this.sessionStatus,
      ...(this.contentBlocks ? { contentBlocks: this.cloneContentBlocks() } : {}),
    };
  }

  /** Reset all state. Used on session cleanup. */
  reset(): void {
    this.status = "ready";
    this.streamingText = "";
    this.reasoning = null;
    this.toolStatuses = [];
    this.contentBlocks = undefined;

    this.tokenUsage = null;
    this.lastTurnUsage = null;
    this.error = null;
    this.sessionStatus = null;
    this.pendingCommittedMessages = [];
  }

  /** Return a default "ready" view with no state. */
  static defaultView(): SessionView {
    return { ...DEFAULT_SESSION_VIEW, toolStatuses: [] };
  }

  private setContentBlocks(contentBlocks?: AssistantContentBlock[]): void {
    if (!contentBlocks) return;
    this.contentBlocks = contentBlocks.map((block) =>
      block.type === "tools"
        ? { ...block, toolCalls: block.toolCalls.map((tool) => ({ ...tool })) }
        : { ...block },
    );
  }

  private cloneContentBlocks(): AssistantContentBlock[] {
    return (this.contentBlocks ?? []).map((block) =>
      block.type === "tools"
        ? { ...block, toolCalls: block.toolCalls.map((tool) => ({ ...tool })) }
        : { ...block },
    );
  }
}
