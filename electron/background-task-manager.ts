/**
 * BackgroundTaskManager — tracks runtime tasks that outlive the turn that
 * started them (a backgrounded Bash command, a backgrounded Agent subagent,
 * or a host MCP/self tool call Marshal itself detached to the background —
 * see `recordHostToolCompletion` / `tool-backgrounding.ts`) so that:
 *  - the idle-session reaper does not tear down a session's backend process
 *    while one of its background tasks is still running (see
 *    `SessionManager.canAutomaticallyPauseSession`).
 *  - completion wakes the *user* the same way heartbeat/automation events do
 *    (see `SessionManager.setBackgroundTaskCallback`, wired in main.ts to
 *    `NotificationRouter.notify`).
 *  - completion wakes the *session itself* so it can actually resume, not
 *    just alert a human who happens to be looking (see
 *    `SessionManager.tryWakeSessionForBackgroundTask`, the consumer of
 *    {@link BackgroundTaskManager.hasPendingWake} /
 *    {@link BackgroundTaskManager.drainPendingWake}).
 *
 * Mirrors the `McpStatusManager.handleBackendEvent` pattern: callers
 * short-circuit `SessionManager.subscribeToBackendEvents` on a `true` return
 * so TurnAccumulator never sees these (not turn-related) events.
 */
import type { BackendEvent } from "./backend/types";

export interface BackgroundTaskUpdate {
  sessionId: string;
  /**
   * "sdk-task": an SDK-reported background task (a backgrounded Bash command
   * or Agent subagent) — recorded via `handleBackendEvent`. "host-tool": a
   * host-owned MCP/self tool call that Marshal itself moved to the
   * background after `TOOL_BACKGROUND_DETACH_THRESHOLD_MS` (see
   * `tool-backgrounding.ts`) — recorded via `recordHostToolCompletion`. Both
   * share this same queue/drain/wake path so a session that ended its turn
   * waiting on either kind resumes identically, and completions landing
   * close together coalesce into one wake turn instead of two.
   */
  kind: "sdk-task" | "host-tool";
  taskId: string;
  toolCallId?: string;
  /** Set only for `kind: "host-tool"` — the MCP/self tool's name (e.g.
   *  "mcp__marshal__sleep"), so the wake prompt can name what finished. */
  toolName?: string;
  status: "completed" | "failed" | "stopped";
  description?: string;
  summary?: string;
  outputFile?: string;
}

/** How long a `background-task-auto-continuation-observed` mark stays valid
 *  for `consumeRecentAutoContinuation` — generous margin over the ~1-3s gaps
 *  observed live between the CLI's own auto-continuation turn starting and
 *  SessionManager's busy-retry getting a chance to check again (see
 *  manual-bg-wake-repro.test.ts), without leaving a stale mark from an
 *  unrelated earlier completion able to suppress a later, real wake. */
const AUTO_CONTINUATION_OBSERVED_WINDOW_MS = 60_000;

export class BackgroundTaskManager {
  private readonly runningBySession = new Map<string, Set<string>>();
  private readonly pendingWakesBySession = new Map<string, BackgroundTaskUpdate[]>();
  private readonly autoContinuationObservedAtBySession = new Map<string, number>();
  private callback: ((update: BackgroundTaskUpdate) => void) | null = null;

  /** Wired by main.ts to route completions through NotificationRouter. */
  setCallback(callback: (update: BackgroundTaskUpdate) => void): void {
    this.callback = callback;
  }

  hasRunning(sessionId: string): boolean {
    return (this.runningBySession.get(sessionId)?.size ?? 0) > 0;
  }

  /** True if this session has one or more completions not yet delivered
   *  into its own conversation via a wake turn (see `drainPendingWake`). */
  hasPendingWake(sessionId: string): boolean {
    return (this.pendingWakesBySession.get(sessionId)?.length ?? 0) > 0;
  }

  /** Take and clear all pending completions for a session, for the caller
   *  to fold into one wake turn. Draining discards on failure by design —
   *  a best-effort re-invocation, backstopped by the OS notification from
   *  `setCallback`, not a durable delivery guarantee. */
  drainPendingWake(sessionId: string): BackgroundTaskUpdate[] {
    const pending = this.pendingWakesBySession.get(sessionId) ?? [];
    this.pendingWakesBySession.delete(sessionId);
    return pending;
  }

  /** Drop tracked tasks for a session being torn down (delete, force-stop). */
  clear(sessionId: string): void {
    this.runningBySession.delete(sessionId);
    this.pendingWakesBySession.delete(sessionId);
    this.autoContinuationObservedAtBySession.delete(sessionId);
  }

  /** True, and consumes the mark, if the runtime's own auto-continuation for
   *  this session was observed within the last {@link
   *  AUTO_CONTINUATION_OBSERVED_WINDOW_MS}. Consuming (not just reading)
   *  keeps this one-shot per completion — a later, genuinely new completion
   *  must be marked again to suppress SessionManager's own wake for it. */
  consumeRecentAutoContinuation(sessionId: string): boolean {
    const at = this.autoContinuationObservedAtBySession.get(sessionId);
    if (at === undefined) return false;
    this.autoContinuationObservedAtBySession.delete(sessionId);
    return Date.now() - at < AUTO_CONTINUATION_OBSERVED_WINDOW_MS;
  }

  /**
   * Routes a `background-task-update` / `background-task-auto-continuation-
   * observed` backend event. Returns **true** if the event was handled here
   * (either type); the caller must short-circuit further routing on a true
   * return.
   */
  handleBackendEvent(event: BackendEvent, sessionId: string): boolean {
    if (event.type === "background-task-auto-continuation-observed") {
      this.autoContinuationObservedAtBySession.set(sessionId, Date.now());
      return true;
    }
    if (event.type !== "background-task-update") return false;

    if (event.status === "started") {
      let tasks = this.runningBySession.get(sessionId);
      if (!tasks) {
        tasks = new Set();
        this.runningBySession.set(sessionId, tasks);
      }
      tasks.add(event.taskId);
      return true;
    }

    const tasks = this.runningBySession.get(sessionId);
    const wasTracked = tasks?.delete(event.taskId) ?? false;
    if (tasks && tasks.size === 0) this.runningBySession.delete(sessionId);

    // Only notify for tasks we actually saw start in the background — a
    // completion for a foreground task never reaches here (see
    // ClaudeEventTranslator, which only emits `started` for is_backgrounded).
    if (wasTracked) {
      const update: BackgroundTaskUpdate = {
        kind: "sdk-task",
        sessionId,
        taskId: event.taskId,
        toolCallId: event.toolCallId,
        status: event.status,
        description: event.description,
        summary: event.summary,
        outputFile: event.outputFile,
      };
      this.callback?.(update);
      const pending = this.pendingWakesBySession.get(sessionId) ?? [];
      pending.push(update);
      this.pendingWakesBySession.set(sessionId, pending);
    }
    return true;
  }

  /**
   * Records a host-owned tool call (a Marshal self-tool or MCP tool) that
   * Marshal itself detached to the background — see `tool-backgrounding.ts`
   * and `SessionManager.completeBackgroundToolInvocation` — finishing,
   * success, error, or cancellation ("stopped", matching the SDK background-
   * task status vocabulary), and queues it for the next wake turn exactly
   * like an SDK background task. Only call this for a completion that was
   * actually detached (`RunningToolCallInfo.backgrounded === true` at
   * completion time); a tool that finishes within its own turn needs no
   * wake — its result already flows back into the turn still waiting on it.
   */
  recordHostToolCompletion(update: {
    sessionId: string;
    handle: string;
    toolName: string;
    status: "completed" | "failed" | "stopped";
    summary?: string;
  }): void {
    const full: BackgroundTaskUpdate = {
      kind: "host-tool",
      sessionId: update.sessionId,
      taskId: update.handle,
      toolName: update.toolName,
      status: update.status,
      summary: update.summary,
    };
    this.callback?.(full);
    const pending = this.pendingWakesBySession.get(update.sessionId) ?? [];
    pending.push(full);
    this.pendingWakesBySession.set(update.sessionId, pending);
  }
}
