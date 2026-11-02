import type {
  CommandCenterEventInput,
  CommandCenterSafeBackendEvent,
  CommandCenterSessionActivityDetails,
  CommandCenterSnapshot,
  CommandCenterTodoStatus,
} from "../../common/command-center-contract";
import type { SessionMetadata } from "../../common/marshal-ipc-contract";
import { createLogger } from "../../common/marshal-logger";
import { CommandCenterActivityDetailStore } from "./activity-detail-store";
import { CommandCenterPrivacyNormalizer } from "./privacy-normalizer";
import { CommandCenterRepository } from "./repository";
import type {
  CommandCenterSessionLifecycleInput,
  CommandCenterSessionObserver,
} from "./session-observer";

const log = createLogger("CommandCenterManager");
const TOOL_START_MAX_AGE_MS = 10 * 60_000;
const TOOL_START_MAX_ENTRIES = 1_000;

export type CommandCenterBroadcaster = (snapshot: CommandCenterSnapshot) => void;

interface ToolStartMetadata {
  sessionId: string;
  toolName: string;
  serverName?: string;
  args?: unknown;
  startedAt: number;
}

export class CommandCenterManager implements CommandCenterSessionObserver {
  private broadcaster: CommandCenterBroadcaster | null = null;
  private broadcastQueued = false;
  private queuedSnapshot: CommandCenterSnapshot | null = null;
  private activityDetailQueue: Promise<void> = Promise.resolve();
  private toolStarts = new Map<string, ToolStartMetadata>();
  /** Per-rawSessionId active goal. Ephemeral (in-memory only) — after
   *  app restart, the first replace call mints a new goal, which is
   *  fine because the panel groups by goalId and shows the latest. */
  private activeGoals = new Map<string, { goalId: string; goalLabel?: string }>();

  constructor(
    private readonly repository = new CommandCenterRepository(),
    private readonly normalizer = new CommandCenterPrivacyNormalizer(),
    private readonly activityDetails = new CommandCenterActivityDetailStore(),
  ) {}

  attachBroadcaster(broadcaster: CommandCenterBroadcaster): void {
    this.broadcaster = broadcaster;
  }

  getSnapshot(): CommandCenterSnapshot {
    return this.repository.getSnapshot();
  }

  async flush(): Promise<void> {
    await this.activityDetailQueue.catch(() => {});
    await this.activityDetails.flush();
  }

  refresh(): CommandCenterSnapshot {
    this.activityDetails.reload();
    return this.repository.rebuild();
  }

  onSessionLifecycle(input: CommandCenterSessionLifecycleInput): void {
    if (input.lifecycle === "deleted") {
      this.clearToolStartsForSession(input.sessionId);
      this.activeGoals.delete(input.sessionId);
    }
    this.appendBestEffort(this.normalizer.sessionLifecycle(input));
  }

  onSafeBackendEvent(event: CommandCenterSafeBackendEvent): void {
    if (event.type === "idle" || event.type === "turn-error") {
      this.clearToolStartsForSession(event.sessionId);
    }
    for (const input of this.normalizer.backendEvent(event)) {
      this.appendBestEffort(input);
    }
  }

  onToolActivity(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    serverName?: string;
    args?: unknown;
  }): void {
    const now = Date.now();
    this.pruneToolStarts(now);
    this.toolStarts.set(input.toolCallId, {
      sessionId: input.sessionId,
      toolName: input.toolName,
      serverName: input.serverName,
      args: input.args,
      startedAt: now,
    });
    this.pruneToolStarts(now);
    this.enqueueActivityDetailWrite("tool-start", input.sessionId, () => {
      this.activityDetails.recordToolStart(input);
    });
  }

  onToolResult(input: { sessionId: string; toolCallId: string; result: unknown }): void {
    this.pruneToolStarts(Date.now());
    const start = this.toolStarts.get(input.toolCallId);
    if (!start) return;
    this.toolStarts.delete(input.toolCallId);
    const detailInput = {
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: start.toolName,
      serverName: start.serverName,
      args: start.args,
      result: input.result,
    };
    this.enqueueActivityDetailWrite("tool-result", input.sessionId, () => {
      this.activityDetails.recordToolResult(detailInput);
    });
  }

  private pruneToolStarts(now: number): void {
    for (const [toolCallId, start] of this.toolStarts) {
      if (now - start.startedAt > TOOL_START_MAX_AGE_MS) this.toolStarts.delete(toolCallId);
    }
    while (this.toolStarts.size > TOOL_START_MAX_ENTRIES) {
      const oldest = this.toolStarts.keys().next().value;
      if (!oldest) break;
      this.toolStarts.delete(oldest);
    }
  }

  private clearToolStartsForSession(sessionId: string): void {
    for (const [toolCallId, start] of this.toolStarts) {
      if (start.sessionId === sessionId) this.toolStarts.delete(toolCallId);
    }
  }

  _getPendingToolStartCountForTests(): number {
    return this.toolStarts.size;
  }

  private enqueueActivityDetailWrite(
    operation: string,
    sessionId: string,
    write: () => void,
  ): void {
    this.activityDetailQueue = this.activityDetailQueue
      .catch(() => {})
      .then(
        () =>
          new Promise<void>((resolve) => {
            setImmediate(() => {
              try {
                write();
              } catch (err) {
                log
                  .with({ sessionId })
                  .warn(`Command Center ${operation} activity write failed:`, err);
              } finally {
                resolve();
              }
            });
          }),
      );
  }

  getSessionActivity(
    rootSessionId: string,
    sessions: readonly SessionMetadata[],
  ): CommandCenterSessionActivityDetails {
    const activity = this.activityDetails.getSessionActivity(rootSessionId, sessions);
    return {
      ...activity,
      safeSessionIds: activity.sessionIds.map((id) => this.normalizer.safeId("session", id)),
    };
  }

  async upsertTodo(input: {
    todoId: string;
    title: string;
    status: CommandCenterTodoStatus;
    sessionId?: string;
    goalId?: string;
    goalLabel?: string;
  }): Promise<CommandCenterSnapshot> {
    const event: CommandCenterEventInput = {
      schemaVersion: 1,
      redactionVersion: 1,
      type: "todo.upsert",
      todoId: this.safeOrNormalizeId("todo", input.todoId),
      title: safeTodoTitle(input.title),
      status: input.status,
      sessionId: input.sessionId ? this.safeOrNormalizeId("session", input.sessionId) : undefined,
      goalId: input.goalId,
      goalLabel: input.goalLabel ? safeGoalLabel(input.goalLabel) : undefined,
    };
    const result = await this.append(event);
    return result;
  }

  async deleteTodo(todoId: string): Promise<CommandCenterSnapshot> {
    const result = await this.append({
      schemaVersion: 1,
      redactionVersion: 1,
      type: "todo.delete",
      todoId: this.safeOrNormalizeId("todo", todoId),
    });
    return result;
  }

  /**
   * Replaces the current goal's todo list for a chat session.
   *
   * Goal semantics: each chat session may pass through several "goals"
   * (typically tied to top-level user requests). One goal === one
   * ordered todo list rendered in the Progress panel. The active goal
   * id per session is tracked in memory here; pass `startNewGoal: true`
   * (e.g. when the user's objective shifts) to mint a fresh one.
   *
   * Identity: the caller provides a `localId` per todo (stable within
   * the goal). The persisted todoId is namespaced by the resolved
   * goalId so that starting a new goal cannot collide with — and
   * silently move — todos from a prior goal. This preserves goal
   * history in the snapshot.
   *
   * Replace semantics: any todos previously associated with the
   * resolved (session, goal) that are NOT in the new list (compared by
   * the namespaced todoId) are deleted, then the provided todos are
   * upserted with the goal id/label. This prevents earlier-but-stale
   * list entries from accumulating as a second numbered list within
   * the same goal.
   */
  async replaceSessionGoalTodos(input: {
    sessionId: string;
    startNewGoal?: boolean;
    goalLabel?: string;
    todos: ReadonlyArray<{
      localId: string;
      title: string;
      status: CommandCenterTodoStatus;
    }>;
  }): Promise<{
    snapshot: CommandCenterSnapshot;
    goalId: string;
    goalLabel?: string;
    todoIds: string[];
  }> {
    const goal = this.resolveActiveGoal(input.sessionId, {
      startNewGoal: input.startNewGoal,
      goalLabel: input.goalLabel,
    });

    const safeSessionId = this.safeOrNormalizeId("session", input.sessionId);
    const todosWithIds = input.todos.map((todo) => {
      const todoId = buildGoalScopedTodoId(input.sessionId, goal.goalId, todo.localId);
      return {
        todoId,
        safeTodoId: this.safeOrNormalizeId("todo", todoId),
        title: todo.title,
        status: todo.status,
      };
    });
    const newSafeTodoIds = new Set(todosWithIds.map((todo) => todo.safeTodoId));

    // Drop any todos previously recorded under this (session, goal) that
    // are not part of the new ordered list. Compared on the safe id used
    // in the snapshot so it works after privacy normalization.
    const snapshot = this.repository.getSnapshot();
    const stale = snapshot.todos.filter(
      (existing) =>
        existing.sessionId === safeSessionId &&
        existing.goalId === goal.goalId &&
        !newSafeTodoIds.has(existing.id),
    );
    for (const todo of stale) {
      // eslint-disable-next-line no-await-in-loop -- persisted replacements must preserve delete-before-upsert ordering
      await this.append({
        schemaVersion: 1,
        redactionVersion: 1,
        type: "todo.delete",
        todoId: todo.id,
      });
    }

    let latest = this.repository.getSnapshot();
    for (const todo of todosWithIds) {
      // eslint-disable-next-line no-await-in-loop -- each returned snapshot must include every prior ordered todo write
      latest = await this.upsertTodo({
        todoId: todo.todoId,
        title: todo.title,
        status: todo.status,
        sessionId: input.sessionId,
        goalId: goal.goalId,
        goalLabel: goal.goalLabel,
      });
    }

    return {
      snapshot: latest,
      goalId: goal.goalId,
      goalLabel: goal.goalLabel,
      todoIds: todosWithIds.map((todo) => todo.todoId),
    };
  }

  /**
   * Returns the active goal for a session, creating a new one if absent
   * or if `startNewGoal` is explicitly requested. Caller-supplied
   * `goalLabel` is treated as the new authoritative label whenever
   * provided, so updating the label is just "set it on the next call".
   */
  resolveActiveGoal(
    sessionId: string,
    opts: { startNewGoal?: boolean; goalLabel?: string } = {},
  ): { goalId: string; goalLabel?: string } {
    const current = this.activeGoals.get(sessionId);
    if (!opts.startNewGoal && current) {
      const next = {
        goalId: current.goalId,
        goalLabel: opts.goalLabel ?? current.goalLabel,
      };
      this.activeGoals.set(sessionId, next);
      return next;
    }
    const goalId = newGoalId();
    const next = { goalId, goalLabel: opts.goalLabel };
    this.activeGoals.set(sessionId, next);
    return next;
  }

  resolveSessionId(safeSessionId: string, rawSessionIds: readonly string[]): string | null {
    return (
      rawSessionIds.find((id) => this.normalizer.safeId("session", id) === safeSessionId) ?? null
    );
  }

  private async append(input: CommandCenterEventInput): Promise<CommandCenterSnapshot> {
    try {
      const result = await this.repository.append(input);
      this.queueBroadcast(result.snapshot);
      return result.snapshot;
    } catch (error) {
      this.queueBroadcast(this.repository.getSnapshot());
      throw error;
    }
  }

  private appendBestEffort(input: CommandCenterEventInput): void {
    void this.append(input).catch((error: unknown) => {
      log.warn("Best-effort Command Center observer append failed", {
        code: persistenceErrorCode(error),
      });
    });
  }

  private queueBroadcast(snapshot: CommandCenterSnapshot): void {
    this.queuedSnapshot = snapshot;
    if (!this.broadcaster || this.broadcastQueued) return;
    this.broadcastQueued = true;
    queueMicrotask(() => {
      this.broadcastQueued = false;
      const latest = this.queuedSnapshot;
      this.queuedSnapshot = null;
      if (latest) {
        this.broadcaster?.(latest);
      }
    });
  }

  private safeOrNormalizeId(prefix: string, value: string): string {
    return value.startsWith(`${prefix}_`) ? value : this.normalizer.safeId(prefix, value);
  }
}

function safeTodoTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return "Untitled todo";
  return trimmed.replace(/[^\w .:-]/g, "_").slice(0, 120);
}

function safeGoalLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "";
  // Goal labels are user-visible session-scoped strings; sanitize the
  // same way we do todo titles to avoid leaking unusual characters from
  // upstream prompts into the Command Center event log.
  return trimmed.replace(/[^\w .:-]/g, "_").slice(0, 160);
}

function newGoalId(): string {
  // Goal IDs are not privacy-sensitive (no salted id needed) but should
  // be unique enough for in-session grouping. Combining ts + random
  // covers fast-fire calls in tests and real sessions.
  const rand = Math.random().toString(36).slice(2, 8);
  return `goal-${Date.now().toString(36)}-${rand}`;
}

function buildGoalScopedTodoId(sessionId: string, goalId: string, localId: string): string {
  // Goal-scoped todoIds so that "start a new goal" cannot collide with
  // — and silently move — todos from a prior goal in the snapshot.
  // The session prefix matches the existing per-session convention
  // used elsewhere in self-tools.
  return `${sessionId}:goal:${goalId}:todo:${localId}`;
}

function persistenceErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name : "UNKNOWN";
}
