import type {
  CommandCenterBlockerStatus,
  CommandCenterReplayStatus,
  CommandCenterSafeId,
  CommandCenterTodoStatus,
  CommandCenterToolKind,
  CommandCenterToolStatus,
} from "./privacy";

export interface CommandCenterReplayState {
  status: CommandCenterReplayStatus;
  lastDurableSeq: number;
  skippedEvents: number;
  degradedReason?: string;
}

export interface CommandCenterSessionSummary {
  id: CommandCenterSafeId;
  label: string;
  lifecycle: string;
  updatedAt: number;
  source?: string;
  backendOrigin?: string;
}

export interface CommandCenterRelationshipSummary {
  id: CommandCenterSafeId;
  fromId: CommandCenterSafeId;
  toId: CommandCenterSafeId;
  kind: string;
  updatedAt: number;
}

export interface CommandCenterToolSummary {
  id: CommandCenterSafeId;
  sessionId: CommandCenterSafeId;
  toolName: string;
  kind: CommandCenterToolKind;
  status: CommandCenterToolStatus;
  serverName?: string;
  argKeys: string[];
  errorClass?: string;
  updatedAt: number;
}

export interface CommandCenterFileSummary {
  id: CommandCenterSafeId;
  sessionId: CommandCenterSafeId;
  label: string;
  kind: string;
  updatedAt: number;
}

export interface CommandCenterArtifactSummary {
  id: CommandCenterSafeId;
  sessionId: CommandCenterSafeId;
  label: string;
  kind: string;
  updatedAt: number;
}

export interface CommandCenterTodoSummary {
  id: CommandCenterSafeId;
  title: string;
  status: CommandCenterTodoStatus;
  sessionId?: CommandCenterSafeId;
  /** Stable identifier for the "goal" this todo belongs to. One progress
   *  list per goal; agents start a new goal when the user objective
   *  shifts. Optional for pre-goal historical events. */
  goalId?: string;
  /** Human-friendly label for the goal (e.g. the originating user
   *  request). Shown in the Progress panel header. */
  goalLabel?: string;
  updatedAt: number;
}

export interface CommandCenterRunSummary {
  id: CommandCenterSafeId;
  label: string;
  status: string;
  sessionId?: CommandCenterSafeId;
  updatedAt: number;
}

export interface CommandCenterBlockerSummary {
  id: CommandCenterSafeId;
  label: string;
  severity: "info" | "warning" | "error";
  status: CommandCenterBlockerStatus;
  sessionId?: CommandCenterSafeId;
  updatedAt: number;
}

export interface CommandCenterSessionActivityFileChange {
  id: string;
  sessionId: string;
  path: string;
  label: string;
  toolName: string;
  additions: number;
  deletions: number;
  diff?: string;
  diffTruncated?: boolean;
  diffUnavailableReason?: "not-captured" | "source-too-large";
  diffContextLines?: number;
  updatedAt: number;
}

export interface CommandCenterSessionActivitySource {
  id: string;
  sessionId: string;
  kind: "pr" | "email" | "other";
  label: string;
  toolName: string;
  url?: string;
  query?: string;
  updatedAt: number;
}

export interface CommandCenterSessionActivityDetails {
  rootSessionId: string;
  sessionIds: string[];
  safeSessionIds: string[];
  fileChanges: CommandCenterSessionActivityFileChange[];
  sources: CommandCenterSessionActivitySource[];
}

export interface CommandCenterSnapshot {
  replay: CommandCenterReplayState;
  sessions: CommandCenterSessionSummary[];
  relationships: CommandCenterRelationshipSummary[];
  tools: CommandCenterToolSummary[];
  files: CommandCenterFileSummary[];
  artifacts: CommandCenterArtifactSummary[];
  todos: CommandCenterTodoSummary[];
  runs: CommandCenterRunSummary[];
  blockers: CommandCenterBlockerSummary[];
}
