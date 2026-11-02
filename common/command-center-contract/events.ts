import type {
  CommandCenterBlockerStatus,
  CommandCenterHash,
  CommandCenterSafeId,
  CommandCenterSessionLifecycle,
  CommandCenterTodoStatus,
  CommandCenterToolKind,
  CommandCenterToolStatus,
} from "./privacy";

export interface CommandCenterEventBase {
  schemaVersion: 1;
  redactionVersion: 1;
  globalSeq: number;
  ts: number;
}

export interface CommandCenterSessionEvent extends CommandCenterEventBase {
  type: "session.lifecycle";
  sessionId: CommandCenterSafeId;
  lifecycle: CommandCenterSessionLifecycle;
  source?: "user" | "automation" | "heartbeat" | "workflow-run" | "workspace" | "unknown";
  backendOrigin?: "copilot" | "gateway";
}

export interface CommandCenterRelationshipEvent extends CommandCenterEventBase {
  type: "relationship.upsert";
  relationshipId: CommandCenterSafeId;
  fromId: CommandCenterSafeId;
  toId: CommandCenterSafeId;
  kind: "parent-child" | "session-run" | "session-artifact" | "session-file";
}

export interface CommandCenterToolEvent extends CommandCenterEventBase {
  type: "tool.observed";
  toolCallId: CommandCenterSafeId;
  sessionId: CommandCenterSafeId;
  toolName: string;
  kind: CommandCenterToolKind;
  status: CommandCenterToolStatus;
  serverName?: string;
  argKeys: string[];
  argsHash?: CommandCenterHash;
  resultHash?: CommandCenterHash;
  errorClass?: string;
}

export interface CommandCenterFileEvent extends CommandCenterEventBase {
  type: "file.observed";
  fileId: CommandCenterSafeId;
  sessionId: CommandCenterSafeId;
  fileLabel: string;
  fileKind: "file" | "directory" | "unknown";
}

export interface CommandCenterArtifactEvent extends CommandCenterEventBase {
  type: "artifact.observed";
  artifactId: CommandCenterSafeId;
  sessionId: CommandCenterSafeId;
  artifactKind: "image" | "document" | "workflow" | "unknown";
  artifactLabel: string;
}

export interface CommandCenterTodoEvent extends CommandCenterEventBase {
  type: "todo.upsert";
  todoId: CommandCenterSafeId;
  title: string;
  status: CommandCenterTodoStatus;
  sessionId?: CommandCenterSafeId;
  /** Identifier of the "goal" this todo belongs to. See
   *  CommandCenterTodoSummary.goalId. */
  goalId?: string;
  /** Human-friendly goal label (e.g. the originating user request).
   *  Stored on every upsert so the latest value wins after replay. */
  goalLabel?: string;
}

export interface CommandCenterTodoDeleteEvent extends CommandCenterEventBase {
  type: "todo.delete";
  todoId: CommandCenterSafeId;
}

export interface CommandCenterRunEvent extends CommandCenterEventBase {
  type: "run.upsert";
  runId: CommandCenterSafeId;
  sessionId?: CommandCenterSafeId;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  label: string;
}

export interface CommandCenterBlockerEvent extends CommandCenterEventBase {
  type: "blocker.upsert";
  blockerId: CommandCenterSafeId;
  status: CommandCenterBlockerStatus;
  severity: "info" | "warning" | "error";
  label: string;
  sessionId?: CommandCenterSafeId;
}

export type CommandCenterEvent =
  | CommandCenterSessionEvent
  | CommandCenterRelationshipEvent
  | CommandCenterToolEvent
  | CommandCenterFileEvent
  | CommandCenterArtifactEvent
  | CommandCenterTodoEvent
  | CommandCenterTodoDeleteEvent
  | CommandCenterRunEvent
  | CommandCenterBlockerEvent;

export type CommandCenterEventInput = CommandCenterEvent extends infer Event
  ? Event extends CommandCenterEvent
    ? Omit<Event, "globalSeq" | "ts"> & { ts?: number }
    : never
  : never;

export type CommandCenterEventClassification =
  | { kind: "supported"; event: CommandCenterEvent }
  | { kind: "unsupported"; globalSeq: number; ts: number }
  | { kind: "invalid" };

export function classifyCommandCenterEvent(raw: unknown): CommandCenterEventClassification {
  if (!isRecord(raw)) return { kind: "invalid" };
  const value = upgradeLegacyEventValues(raw);
  const metadata = readCommandCenterEventMetadata(value);
  if (!metadata) return { kind: "invalid" };
  if (metadata.schemaVersion !== 1 || metadata.redactionVersion !== 1) {
    return { kind: "unsupported", globalSeq: metadata.globalSeq, ts: metadata.ts };
  }
  const knownFields = commandCenterEventFields(metadata.type);
  if (!knownFields) {
    return { kind: "unsupported", globalSeq: metadata.globalSeq, ts: metadata.ts };
  }
  if (!hasValidCurrentEventPayload(value)) return { kind: "invalid" };
  if (!hasOnlyFields(value, knownFields)) {
    return { kind: "unsupported", globalSeq: metadata.globalSeq, ts: metadata.ts };
  }
  if (!isCommandCenterEvent(value)) return { kind: "invalid" };
  return { kind: "supported", event: value };
}

export function isCommandCenterEvent(value: unknown): value is CommandCenterEvent {
  if (!isRecord(value)) return false;
  const metadata = readCommandCenterEventMetadata(value);
  if (!metadata || metadata.schemaVersion !== 1 || metadata.redactionVersion !== 1) {
    return false;
  }
  const knownFields = commandCenterEventFields(metadata.type);
  return (
    knownFields !== null && hasOnlyFields(value, knownFields) && hasValidCurrentEventPayload(value)
  );
}

const BASE_EVENT_FIELDS = ["schemaVersion", "redactionVersion", "globalSeq", "ts", "type"] as const;
const SESSION_EVENT_FIELDS = new Set([
  ...BASE_EVENT_FIELDS,
  "sessionId",
  "lifecycle",
  "source",
  "backendOrigin",
]);
const RELATIONSHIP_EVENT_FIELDS = new Set([
  ...BASE_EVENT_FIELDS,
  "relationshipId",
  "fromId",
  "toId",
  "kind",
]);
const TOOL_EVENT_FIELDS = new Set([
  ...BASE_EVENT_FIELDS,
  "toolCallId",
  "sessionId",
  "toolName",
  "kind",
  "status",
  "serverName",
  "argKeys",
  "argsHash",
  "resultHash",
  "errorClass",
]);
const FILE_EVENT_FIELDS = new Set([
  ...BASE_EVENT_FIELDS,
  "fileId",
  "sessionId",
  "fileLabel",
  "fileKind",
]);
const ARTIFACT_EVENT_FIELDS = new Set([
  ...BASE_EVENT_FIELDS,
  "artifactId",
  "sessionId",
  "artifactKind",
  "artifactLabel",
]);
const TODO_EVENT_FIELDS = new Set([
  ...BASE_EVENT_FIELDS,
  "todoId",
  "title",
  "status",
  "sessionId",
  "goalId",
  "goalLabel",
]);
const TODO_DELETE_EVENT_FIELDS = new Set([...BASE_EVENT_FIELDS, "todoId"]);
const RUN_EVENT_FIELDS = new Set([...BASE_EVENT_FIELDS, "runId", "sessionId", "status", "label"]);
const BLOCKER_EVENT_FIELDS = new Set([
  ...BASE_EVENT_FIELDS,
  "blockerId",
  "status",
  "severity",
  "label",
  "sessionId",
]);

const SESSION_LIFECYCLES = [
  "created",
  "restored",
  "selected",
  "busy",
  "idle",
  "errored",
  "deleted",
  "renamed",
] as const;
const SESSION_SOURCES = [
  "user",
  "automation",
  "heartbeat",
  "workflow-run",
  "workspace",
  "unknown",
] as const;
const BACKEND_ORIGINS = ["copilot", "gateway"] as const;
const RELATIONSHIP_KINDS = [
  "parent-child",
  "session-run",
  "session-artifact",
  "session-file",
] as const;
const TOOL_KINDS = ["unknown", "generic", "file", "shell", "browser"] as const;
// Removed kinds/sources may still sit in persisted event logs; readers map them
// to the generic fallback instead of discarding the whole event.
const LEGACY_TOOL_KINDS: readonly string[] = ["kusto", "ado", "m365"];
const LEGACY_SESSION_SOURCES: readonly string[] = ["teams"];
const TOOL_STATUSES = ["started", "succeeded", "failed"] as const;
const FILE_KINDS = ["file", "directory", "unknown"] as const;
const ARTIFACT_KINDS = ["image", "document", "workflow", "unknown"] as const;
const TODO_STATUSES = ["pending", "in_progress", "done", "blocked"] as const;
const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
const BLOCKER_STATUSES = ["active", "cleared"] as const;
const BLOCKER_SEVERITIES = ["info", "warning", "error"] as const;

interface CommandCenterEventMetadata {
  schemaVersion: number;
  redactionVersion: number;
  globalSeq: number;
  ts: number;
  type: string;
}

function readCommandCenterEventMetadata(
  value: Record<string, unknown>,
): CommandCenterEventMetadata | null {
  if (
    typeof value.schemaVersion !== "number" ||
    !Number.isSafeInteger(value.schemaVersion) ||
    value.schemaVersion < 1 ||
    typeof value.redactionVersion !== "number" ||
    !Number.isSafeInteger(value.redactionVersion) ||
    value.redactionVersion < 1 ||
    typeof value.globalSeq !== "number" ||
    !Number.isSafeInteger(value.globalSeq) ||
    value.globalSeq < 0 ||
    typeof value.ts !== "number" ||
    !Number.isFinite(value.ts) ||
    typeof value.type !== "string"
  ) {
    return null;
  }
  return {
    schemaVersion: value.schemaVersion,
    redactionVersion: value.redactionVersion,
    globalSeq: value.globalSeq,
    ts: value.ts,
    type: value.type,
  };
}

function commandCenterEventFields(type: string): ReadonlySet<string> | null {
  switch (type) {
    case "session.lifecycle":
      return SESSION_EVENT_FIELDS;
    case "relationship.upsert":
      return RELATIONSHIP_EVENT_FIELDS;
    case "tool.observed":
      return TOOL_EVENT_FIELDS;
    case "file.observed":
      return FILE_EVENT_FIELDS;
    case "artifact.observed":
      return ARTIFACT_EVENT_FIELDS;
    case "todo.upsert":
      return TODO_EVENT_FIELDS;
    case "todo.delete":
      return TODO_DELETE_EVENT_FIELDS;
    case "run.upsert":
      return RUN_EVENT_FIELDS;
    case "blocker.upsert":
      return BLOCKER_EVENT_FIELDS;
    default:
      return null;
  }
}

function upgradeLegacyEventValues(value: Record<string, unknown>): Record<string, unknown> {
  if (
    value.type === "tool.observed" &&
    typeof value.kind === "string" &&
    LEGACY_TOOL_KINDS.includes(value.kind)
  ) {
    return { ...value, kind: typeof value.serverName === "string" ? "generic" : "unknown" };
  }
  if (
    value.type === "session.lifecycle" &&
    typeof value.source === "string" &&
    LEGACY_SESSION_SOURCES.includes(value.source)
  ) {
    return { ...value, source: "unknown" };
  }
  return value;
}

function hasValidCurrentEventPayload(value: Record<string, unknown>): boolean {
  switch (value.type) {
    case "session.lifecycle":
      return (
        typeof value.sessionId === "string" &&
        isOneOf(value.lifecycle, SESSION_LIFECYCLES) &&
        isOptionalOneOf(value.source, SESSION_SOURCES) &&
        isOptionalOneOf(value.backendOrigin, BACKEND_ORIGINS)
      );
    case "relationship.upsert":
      return (
        typeof value.relationshipId === "string" &&
        typeof value.fromId === "string" &&
        typeof value.toId === "string" &&
        isOneOf(value.kind, RELATIONSHIP_KINDS)
      );
    case "tool.observed":
      return (
        typeof value.toolCallId === "string" &&
        typeof value.sessionId === "string" &&
        typeof value.toolName === "string" &&
        isOneOf(value.kind, TOOL_KINDS) &&
        isOneOf(value.status, TOOL_STATUSES) &&
        isOptionalString(value.serverName) &&
        Array.isArray(value.argKeys) &&
        value.argKeys.every((key) => typeof key === "string") &&
        isOptionalString(value.argsHash) &&
        isOptionalString(value.resultHash) &&
        isOptionalString(value.errorClass)
      );
    case "file.observed":
      return (
        typeof value.fileId === "string" &&
        typeof value.sessionId === "string" &&
        typeof value.fileLabel === "string" &&
        isOneOf(value.fileKind, FILE_KINDS)
      );
    case "artifact.observed":
      return (
        typeof value.artifactId === "string" &&
        typeof value.sessionId === "string" &&
        typeof value.artifactLabel === "string" &&
        isOneOf(value.artifactKind, ARTIFACT_KINDS)
      );
    case "todo.upsert":
      return (
        typeof value.todoId === "string" &&
        typeof value.title === "string" &&
        isOneOf(value.status, TODO_STATUSES) &&
        isOptionalString(value.sessionId) &&
        isOptionalString(value.goalId) &&
        isOptionalString(value.goalLabel)
      );
    case "todo.delete":
      return typeof value.todoId === "string";
    case "run.upsert":
      return (
        typeof value.runId === "string" &&
        isOptionalString(value.sessionId) &&
        isOneOf(value.status, RUN_STATUSES) &&
        typeof value.label === "string"
      );
    case "blocker.upsert":
      return (
        typeof value.blockerId === "string" &&
        isOneOf(value.status, BLOCKER_STATUSES) &&
        isOneOf(value.severity, BLOCKER_SEVERITIES) &&
        typeof value.label === "string" &&
        isOptionalString(value.sessionId)
      );
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => fields.has(key));
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.some((candidate) => candidate === value);
}

function isOptionalOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T | undefined {
  return value === undefined || isOneOf(value, allowed);
}
