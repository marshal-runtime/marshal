/**
 * BusySessionTracker — tracks which sessions are actively processing a turn
 * and detects stuck sessions via inactivity timers.
 *
 * Extracted from SessionManager (Tier 2 of the SessionManager decomposition).
 * The `onStuck` callback decouples stuck-recovery (synthetic
 * idle emission) from the view/event system.
 */

import { STUCK_TIMEOUT_MS } from "./session-view-builder";

export class BusySessionTracker {
  private busySessions = new Set<string>();
  private activityTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * @param onStuck fired when a busy session sees no events for STUCK_TIMEOUT_MS.
   * @param onChange fired only on real busy-set membership transitions
   *   (idle→busy, busy→idle), never on re-arms or no-op idles. Drives live
   *   sidebar refresh so a parent's transitive-subagent spinner updates.
   */
  constructor(
    private onStuck: (sessionId: string) => void,
    private onChange?: (sessionId: string, busy: boolean) => void,
    private shouldWatchForStuck: (sessionId: string) => boolean = () => true,
  ) {}

  isBusy(sessionId: string): boolean {
    return this.busySessions.has(sessionId);
  }

  /** Snapshot of all busy session IDs. Intended for test assertions. */
  getBusySessionIds(): ReadonlySet<string> {
    return this.busySessions;
  }

  setBusy(sessionId: string): void {
    const wasBusy = this.busySessions.has(sessionId);
    this.busySessions.add(sessionId);
    this.resetActivityTimer(sessionId);
    if (!wasBusy) this.onChange?.(sessionId, true);
  }

  /** Mark a session as idle and clear its activity timer. */
  setIdle(sessionId: string): void {
    const wasBusy = this.busySessions.delete(sessionId);
    this.clearActivityTimer(sessionId);
    if (wasBusy) this.onChange?.(sessionId, false);
  }

  /**
   * Reset the per-session activity timer. If {@link STUCK_TIMEOUT_MS} passes
   * with no events while the session is busy, the `onStuck` callback fires.
   */
  resetActivityTimer(sessionId: string): void {
    const existing = this.activityTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    if (!this.busySessions.has(sessionId) || !this.shouldWatchForStuck(sessionId)) {
      this.activityTimers.delete(sessionId);
      return;
    }

    const timer = setTimeout(() => {
      this.activityTimers.delete(sessionId);
      if (!this.busySessions.has(sessionId)) return;
      // Atomic stuck handling: keep the id in busySessions ACROSS onStuck. The
      // onStuck callback may re-arm (setBusy) while tools are still running; with
      // the id already present that re-arm is a no-op membership transition, so
      // no spurious idle→busy onChange flicker fires. Only after onStuck returns
      // WITHOUT a re-arm (no fresh timer was created for this id) do we treat the
      // session as truly idle and fire the busy→idle transition.
      this.onStuck(sessionId);
      if (!this.activityTimers.has(sessionId)) {
        this.busySessions.delete(sessionId);
        this.onChange?.(sessionId, false);
      }
    }, STUCK_TIMEOUT_MS);

    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }

    this.activityTimers.set(sessionId, timer);
  }

  /** Clear the activity timer for a session (on natural idle or session delete). */
  clearActivityTimer(sessionId: string): void {
    const timer = this.activityTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.activityTimers.delete(sessionId);
    }
  }

  /** Full cleanup: clear timer and remove from busy set. */
  cleanupSession(sessionId: string): void {
    // Intentionally does NOT fire onChange: the sole caller (SessionManager.
    // deleteSession) removes the session from the index and then calls
    // emitSessionsListChanged(), so any parent's transitive hasRunningSubagent
    // is recomputed without a per-session callback here.
    this.clearActivityTimer(sessionId);
    this.busySessions.delete(sessionId);
  }

  /** Clear all timers and busy state (called on backend reset / graceful stop). */
  clearAll(): void {
    // Intentionally does NOT fire per-session onChange: the reset/restart callers
    // (gracefulStop, resetClient, restartBackendRuntimeAfterSessionStartTimeout)
    // each call emitSessionsListChanged() once right after, the coalesced equivalent.
    for (const timer of this.activityTimers.values()) clearTimeout(timer);
    this.activityTimers.clear();
    this.busySessions.clear();
  }
}
