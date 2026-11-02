export const COMMAND_CENTER_SCHEMA_VERSION = 1;
export const COMMAND_CENTER_REDACTION_VERSION = 1;

export type CommandCenterSafeId = string;
export type CommandCenterHash = string;

export interface CommandCenterSafeRef {
  id: CommandCenterSafeId;
  label: string;
}

export type CommandCenterReplayStatus = "ok" | "rebuilding" | "degraded";

export type CommandCenterToolKind = "unknown" | "generic" | "file" | "shell" | "browser";

export type CommandCenterToolStatus = "started" | "succeeded" | "failed";

export type CommandCenterSessionLifecycle =
  | "created"
  | "restored"
  | "selected"
  | "busy"
  | "idle"
  | "errored"
  | "deleted"
  | "renamed";

export type CommandCenterTodoStatus = "pending" | "in_progress" | "done" | "blocked";

export type CommandCenterBlockerStatus = "active" | "cleared";

export interface CommandCenterSafeBackendEvent {
  type:
    | "tool-start"
    | "tool-result"
    | "status"
    | "metadata-updated"
    | "turn-error"
    | "idle"
    | "token-usage"
    | "llm-usage";
  sessionId: string;
  toolCallId?: string;
  toolName?: string;
  serverName?: string;
  argKeys?: string[];
  argsShapeHash?: CommandCenterHash;
  resultShapeHash?: CommandCenterHash;
  success?: boolean;
  errorClass?: string;
  model?: string;
  provider?: string;
}
