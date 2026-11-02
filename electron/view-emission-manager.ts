// Marshal owns this event-listener and throttled-view emission boundary.

/**
 * ViewEmissionManager — owns event listeners and throttled view snapshot emission.
 *
 * Extracted from SessionManager (Tier 2 of the SessionManager decomposition)
 * so that event dispatch and view-throttling logic are
 * independently testable and decoupled from session orchestration.
 */

import type { SessionView, SessionViewEvent, TurnEvent } from "../common/marshal-ipc-contract";
import { SessionViewBuilder, VIEW_THROTTLE_MS } from "./session-view-builder";

export class ViewEmissionManager {
  private sessionViewBuilders = new Map<string, SessionViewBuilder>();
  private viewEmitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private viewEventListeners = new Set<(sessionId: string, event: SessionViewEvent) => void>();
  private eventListeners = new Set<(sessionId: string, event: TurnEvent) => void>();

  // ── TurnEvent listeners (Channel 0: raw events for in-process consumers) ──

  addEventListener(listener: (sessionId: string, event: TurnEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  emitEvent(sessionId: string, event: TurnEvent): void {
    for (const listener of this.eventListeners) listener(sessionId, event);
  }

  // ── Session View (Channel 1: throttled snapshots for renderer) ─────────

  private getViewBuilder(sessionId: string): SessionViewBuilder {
    let builder = this.sessionViewBuilders.get(sessionId);
    if (!builder) {
      builder = new SessionViewBuilder();
      this.sessionViewBuilders.set(sessionId, builder);
    }
    return builder;
  }

  /** Mark a session as submitted (user sent a message) and flush immediately. */
  setSubmitted(sessionId: string): void {
    this.getViewBuilder(sessionId).setSubmitted();
    this.flushViewEmit(sessionId);
  }

  /**
   * Atomically commit a user message AND mark the session as submitted in one
   * snapshot. Peer windows that watch via `session:view` broadcast would
   * otherwise briefly see the new user bubble with the previous turn's status
   * (e.g. `"ready"`) before a second snapshot delivered the `"submitted"`
   * flag. One flush carries both state changes together.
   */
  commitUserMessage(sessionId: string, event: TurnEvent): void {
    const builder = this.getViewBuilder(sessionId);
    builder.setSubmitted();
    builder.apply(event);
    this.flushViewEmit(sessionId);
  }

  /**
   * Apply an error event to the view builder and flush immediately.
   * Note: this updates only the view channel (SessionViewEvent listeners), not the
   * TurnEvent channel. SDK-originated errors reach TurnEvent listeners via the
   * backend subscription; sendMessage catch-block errors reach callers via the
   * re-thrown exception. Both paths update the view via this method.
   */
  emitViewError(sessionId: string, error: string): void {
    this.getViewBuilder(sessionId).apply({ type: "turn:error", error });
    this.flushViewEmit(sessionId);
  }

  /** Pipe a TurnEvent into the session's ViewBuilder and schedule/flush emission. */
  updateView(sessionId: string, turnEvent: TurnEvent): void {
    const builder = this.getViewBuilder(sessionId);
    const shouldFlush = builder.apply(turnEvent);
    if (shouldFlush) {
      this.flushViewEmit(sessionId);
    } else {
      this.scheduleViewEmit(sessionId);
    }
  }

  /** Schedule a throttled view emission (~80ms). No-op if already scheduled. */
  private scheduleViewEmit(sessionId: string): void {
    if (this.viewEmitTimers.has(sessionId)) return;
    this.viewEmitTimers.set(
      sessionId,
      setTimeout(() => {
        this.viewEmitTimers.delete(sessionId);
        this.emitViewSnapshot(sessionId);
      }, VIEW_THROTTLE_MS),
    );
  }

  /** Flush immediately: cancel any pending throttled emit and emit now. */
  private flushViewEmit(sessionId: string): void {
    const timer = this.viewEmitTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.viewEmitTimers.delete(sessionId);
    }
    this.emitViewSnapshot(sessionId);
  }

  /** Emit the current session view snapshot to all view listeners. */
  private emitViewSnapshot(sessionId: string): void {
    const builder = this.sessionViewBuilders.get(sessionId);
    if (!builder) return;
    const snapshot = builder.drainSnapshot();
    for (const listener of this.viewEventListeners) listener(sessionId, snapshot);
  }

  /** Subscribe to session:view events (throttled snapshots for the renderer). */
  addViewEventListener(listener: (sessionId: string, event: SessionViewEvent) => void): () => void {
    this.viewEventListeners.add(listener);
    return () => this.viewEventListeners.delete(listener);
  }

  /** Get the current SessionView for a session (initial fetch on session switch). */
  getSessionView(sessionId: string): { view: SessionView } {
    const builder = this.sessionViewBuilders.get(sessionId);
    return { view: builder ? builder.getView() : SessionViewBuilder.defaultView() };
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  /** Remove the view builder and cancel any pending throttle timer for a session. */
  cleanupSession(sessionId: string): void {
    this.sessionViewBuilders.delete(sessionId);
    const viewTimer = this.viewEmitTimers.get(sessionId);
    if (viewTimer) {
      clearTimeout(viewTimer);
      this.viewEmitTimers.delete(sessionId);
    }
  }

  /** Clear all builders and timers (called on backend reset / graceful stop). */
  clearAll(): void {
    for (const timer of this.viewEmitTimers.values()) clearTimeout(timer);
    this.viewEmitTimers.clear();
    this.sessionViewBuilders.clear();
  }
}
