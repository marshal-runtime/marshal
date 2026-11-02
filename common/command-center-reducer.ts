import type { CommandCenterEvent } from "./command-center-contract/events";
import type {
  CommandCenterArtifactSummary,
  CommandCenterBlockerSummary,
  CommandCenterFileSummary,
  CommandCenterRelationshipSummary,
  CommandCenterRunSummary,
  CommandCenterSessionSummary,
  CommandCenterSnapshot,
  CommandCenterTodoSummary,
  CommandCenterToolSummary,
} from "./command-center-contract/snapshot";

export function createEmptyCommandCenterSnapshot(): CommandCenterSnapshot {
  return {
    replay: { status: "ok", lastDurableSeq: -1, skippedEvents: 0 },
    sessions: [],
    relationships: [],
    tools: [],
    files: [],
    artifacts: [],
    todos: [],
    runs: [],
    blockers: [],
  };
}

export function replayCommandCenterEvents(events: readonly unknown[]): CommandCenterSnapshot {
  const replay = new CommandCenterReplayBuilder();
  for (const event of events) replay.append(event);
  return replay.finish();
}

export function reduceCommandCenterEvent(
  snapshot: CommandCenterSnapshot,
  event: unknown,
): CommandCenterSnapshot {
  if (!isEventShape(event)) {
    return {
      ...snapshot,
      replay: { ...snapshot.replay, skippedEvents: snapshot.replay.skippedEvents + 1 },
    };
  }

  switch (event.type) {
    case "session.lifecycle":
      return upsert(snapshot, "sessions", event.globalSeq, {
        id: event.sessionId,
        label: `Session ${event.sessionId.slice(0, 8)}`,
        lifecycle: event.lifecycle,
        updatedAt: event.ts,
        source: event.source,
        backendOrigin: event.backendOrigin,
      });
    case "relationship.upsert":
      return upsert(snapshot, "relationships", event.globalSeq, {
        id: event.relationshipId,
        fromId: event.fromId,
        toId: event.toId,
        kind: event.kind,
        updatedAt: event.ts,
      });
    case "tool.observed":
      return upsert(snapshot, "tools", event.globalSeq, {
        id: event.toolCallId,
        sessionId: event.sessionId,
        toolName: event.toolName,
        kind: event.kind,
        status: event.status,
        serverName: event.serverName,
        argKeys: [...event.argKeys].sort(),
        errorClass: event.errorClass,
        updatedAt: event.ts,
      });
    case "file.observed":
      return upsert(snapshot, "files", event.globalSeq, {
        id: event.fileId,
        sessionId: event.sessionId,
        label: event.fileLabel,
        kind: event.fileKind,
        updatedAt: event.ts,
      });
    case "artifact.observed":
      return upsert(snapshot, "artifacts", event.globalSeq, {
        id: event.artifactId,
        sessionId: event.sessionId,
        label: event.artifactLabel,
        kind: event.artifactKind,
        updatedAt: event.ts,
      });
    case "todo.upsert":
      return upsert(snapshot, "todos", event.globalSeq, {
        id: event.todoId,
        title: event.title,
        status: event.status,
        sessionId: event.sessionId,
        goalId: event.goalId,
        goalLabel: event.goalLabel,
        updatedAt: event.ts,
      });
    case "todo.delete":
      return {
        ...snapshot,
        replay: replayFor(snapshot, event.globalSeq),
        todos: snapshot.todos.filter((todo) => todo.id !== event.todoId),
      };
    case "run.upsert":
      return upsert(snapshot, "runs", event.globalSeq, {
        id: event.runId,
        label: event.label,
        status: event.status,
        sessionId: event.sessionId,
        updatedAt: event.ts,
      });
    case "blocker.upsert":
      return upsert(snapshot, "blockers", event.globalSeq, {
        id: event.blockerId,
        label: event.label,
        severity: event.severity,
        status: event.status,
        sessionId: event.sessionId,
        updatedAt: event.ts,
      });
    default:
      return {
        ...snapshot,
        replay: { ...snapshot.replay, skippedEvents: snapshot.replay.skippedEvents + 1 },
      };
  }
}

export function markCommandCenterDegraded(
  snapshot: CommandCenterSnapshot,
  degradedReason: string,
): CommandCenterSnapshot {
  return {
    ...snapshot,
    replay: { ...snapshot.replay, status: "degraded", degradedReason },
  };
}

class CommandCenterReplayBuilder {
  private readonly sessions = new Map<string, CommandCenterSessionSummary>();
  private readonly relationships = new Map<string, CommandCenterRelationshipSummary>();
  private readonly tools = new Map<string, CommandCenterToolSummary>();
  private readonly files = new Map<string, CommandCenterFileSummary>();
  private readonly artifacts = new Map<string, CommandCenterArtifactSummary>();
  private readonly todos = new Map<string, CommandCenterTodoSummary>();
  private readonly runs = new Map<string, CommandCenterRunSummary>();
  private readonly blockers = new Map<string, CommandCenterBlockerSummary>();
  private lastDurableSeq = -1;
  private skippedEvents = 0;

  append(event: unknown): void {
    if (!isEventShape(event)) {
      this.skippedEvents++;
      return;
    }

    switch (event.type) {
      case "session.lifecycle":
        this.sessions.set(event.sessionId, {
          id: event.sessionId,
          label: `Session ${event.sessionId.slice(0, 8)}`,
          lifecycle: event.lifecycle,
          updatedAt: event.ts,
          source: event.source,
          backendOrigin: event.backendOrigin,
        });
        break;
      case "relationship.upsert":
        this.relationships.set(event.relationshipId, {
          id: event.relationshipId,
          fromId: event.fromId,
          toId: event.toId,
          kind: event.kind,
          updatedAt: event.ts,
        });
        break;
      case "tool.observed":
        this.tools.set(event.toolCallId, {
          id: event.toolCallId,
          sessionId: event.sessionId,
          toolName: event.toolName,
          kind: event.kind,
          status: event.status,
          serverName: event.serverName,
          argKeys: [...event.argKeys].sort(),
          errorClass: event.errorClass,
          updatedAt: event.ts,
        });
        break;
      case "file.observed":
        this.files.set(event.fileId, {
          id: event.fileId,
          sessionId: event.sessionId,
          label: event.fileLabel,
          kind: event.fileKind,
          updatedAt: event.ts,
        });
        break;
      case "artifact.observed":
        this.artifacts.set(event.artifactId, {
          id: event.artifactId,
          sessionId: event.sessionId,
          label: event.artifactLabel,
          kind: event.artifactKind,
          updatedAt: event.ts,
        });
        break;
      case "todo.upsert":
        this.todos.set(event.todoId, {
          id: event.todoId,
          title: event.title,
          status: event.status,
          sessionId: event.sessionId,
          goalId: event.goalId,
          goalLabel: event.goalLabel,
          updatedAt: event.ts,
        });
        break;
      case "todo.delete":
        this.todos.delete(event.todoId);
        break;
      case "run.upsert":
        this.runs.set(event.runId, {
          id: event.runId,
          label: event.label,
          status: event.status,
          sessionId: event.sessionId,
          updatedAt: event.ts,
        });
        break;
      case "blocker.upsert":
        this.blockers.set(event.blockerId, {
          id: event.blockerId,
          label: event.label,
          severity: event.severity,
          status: event.status,
          sessionId: event.sessionId,
          updatedAt: event.ts,
        });
        break;
      default:
        this.skippedEvents++;
        return;
    }
    this.lastDurableSeq = Math.max(this.lastDurableSeq, event.globalSeq);
  }

  finish(): CommandCenterSnapshot {
    return {
      replay: {
        status: "ok",
        lastDurableSeq: this.lastDurableSeq,
        skippedEvents: this.skippedEvents,
      },
      sessions: sortedValues(this.sessions),
      relationships: sortedValues(this.relationships),
      tools: sortedValues(this.tools),
      files: sortedValues(this.files),
      artifacts: sortedValues(this.artifacts),
      todos: sortedValues(this.todos),
      runs: sortedValues(this.runs),
      blockers: sortedValues(this.blockers),
    };
  }
}

type CollectionKey =
  | "sessions"
  | "relationships"
  | "tools"
  | "files"
  | "artifacts"
  | "todos"
  | "runs"
  | "blockers";

type CollectionItem =
  | CommandCenterSessionSummary
  | CommandCenterRelationshipSummary
  | CommandCenterToolSummary
  | CommandCenterFileSummary
  | CommandCenterArtifactSummary
  | CommandCenterTodoSummary
  | CommandCenterRunSummary
  | CommandCenterBlockerSummary;

function upsert<K extends CollectionKey>(
  snapshot: CommandCenterSnapshot,
  key: K,
  seq: number,
  item: CommandCenterSnapshot[K][number],
): CommandCenterSnapshot {
  const current = snapshot[key] as CollectionItem[];
  const next = [...current.filter((existing) => existing.id !== item.id), item as CollectionItem];
  next.sort(compareSummary);
  return { ...snapshot, replay: replayFor(snapshot, seq), [key]: next };
}

function compareSummary(a: CollectionItem, b: CollectionItem): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id.localeCompare(b.id);
}

function sortedValues<T extends CollectionItem>(items: ReadonlyMap<string, T>): T[] {
  return [...items.values()].sort(compareSummary);
}

function replayFor(snapshot: CommandCenterSnapshot, seq: number) {
  return {
    ...snapshot.replay,
    status: "ok" as const,
    lastDurableSeq: Math.max(snapshot.replay.lastDurableSeq, seq),
  };
}

function isEventShape(event: unknown): event is CommandCenterEvent {
  return (
    !!event && typeof event === "object" && "type" in event && "globalSeq" in event && "ts" in event
  );
}
