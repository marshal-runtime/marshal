// common/workflows-contract/ui-extras.ts
//
// UI/IPC-only helper types that the workflows panel and ipc-contract need
// but which are not part of the engine's wire-format contracts (events,
// run-record, manifest, snapshot). Centralised here so the engine's core
// contract files stay focused on the persisted/event-log shapes.
//
// Many of these types are richer-than-engine projections used by the
// renderer. The engine reducer populates the canonical subset; fields the
// engine doesn't emit are left optional / undefined and consumers fall
// back gracefully (the renderer was authored with this expectation).
//
// Added during REV-IMPL integration to reconcile IMPL-UI's single-file
// `workflows-contract.ts` with IMPL-ENGINE's split folder contract.

import type { WorkflowEvent } from "./events";
import type { InstalledSource, WorkflowManifest } from "./manifest";
import type { WorkflowScheduleCursor } from "./operational";
import type { RunStatus } from "./run-record";

// ── Status aliases ─────────────────────────────────────────────────────

/** Renderer-facing alias of `RunStatus`. */
export type WorkflowRunStatus = RunStatus;

/** Authoring-time provenance of a workflow on disk (r1-fixes A12). */
export type WorkflowSource = InstalledSource["source"];

/** Per-unit (per-fanOut-item) status surfaced in the default renderer. */
export type ExecutionUnitStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

// ── Renderer-facing summaries ─────────────────────────────────────────

export interface FanOutUnit {
  readonly handleId: string;
  readonly itemKey: string;
  readonly itemSummary?: string;
  readonly status: ExecutionUnitStatus;
  readonly sessionId: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export interface RunError {
  readonly message: string;
  readonly stepId?: string;
  readonly handleId?: string;
  readonly errorClass?: string;
}

/**
 * UI-facing capacity view. Engine emits its own `CapacityView` shape
 * (`used` / `cap` / `queueLength`) on `RunSnapshot.capacity`; this richer
 * shape is reserved for top-bar telemetry that comes via the
 * `workflows:run-tick` IPC event.
 */
export interface RunCapacitySnapshot {
  readonly activeSubagents: number;
  readonly globalLimit: number;
  readonly perRunLimit: number;
  readonly queued: number;
}

/**
 * Renderer-facing artifact reference. The engine's persistence layer
 * stores artifacts via `ArtifactRefSummary` (key/storageKey/mime/...);
 * this is the inflated view passed to renderers and embedded HTML
 * previews. Optional fields are populated lazily.
 */
export interface ArtifactRef {
  readonly key: string;
  readonly name: string;
  readonly path: string;
  readonly contentType:
    | "text/markdown"
    | "text/plain"
    | "application/json"
    | "text/html"
    | "application/octet-stream";
  readonly sizeBytes: number;
  readonly sha256?: string;
  readonly stepId?: string;
  readonly producedAt: number;
}

// ── JSON-Schema subset used by the install form ───────────────────────

/** Minimal JSON-Schema shape used by the input form (Zod 4 `z.toJSONSchema()`). */
export type WorkflowJSONSchema = {
  type?: string;
  properties?: Record<string, WorkflowJSONSchema>;
  items?: WorkflowJSONSchema;
  required?: string[];
  enum?: ReadonlyArray<string | number | boolean | null>;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  anyOf?: WorkflowJSONSchema[];
  oneOf?: WorkflowJSONSchema[];
  [k: string]: unknown;
};

// ── Library list / history projections ────────────────────────────────

export interface WorkflowSummary {
  /** Stable UI key. For repo-local workflows this includes the repo scope. */
  readonly key?: string;
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly source: WorkflowSource;
  readonly version: string;
  readonly schemaVersion: number;
  readonly installedAt: number;
  readonly hasRenderer: boolean;
  readonly repoPath?: string | null;
  readonly workspaceName?: string;
  readonly projectName?: string;
  readonly defaultSchedule?: string;
  readonly schedule?: WorkflowScheduleSummary;
  readonly inputSchema?: WorkflowJSONSchema;
  readonly extensions?: WorkflowManifest["extensions"];
  readonly lastRun?: {
    readonly runId: string;
    readonly status: WorkflowRunStatus;
    readonly finishedAt?: number;
  };
}

export interface WorkflowScheduleSummary {
  readonly key: string;
  readonly workflowId: string;
  readonly naturalLanguage: string;
  readonly enabled: boolean;
  readonly parser?: "electron/automations/parseSchedule";
  readonly normalized?: string;
  readonly kind?: "single" | "interval" | "multi";
  readonly input?: unknown;
  readonly nextRunAt?: number;
  readonly incremental?: WorkflowScheduleCursor;
  readonly lastCheckedAt?: number;
  readonly lastTriggeredAt?: number;
  readonly lastOccurrenceAt?: number;
  readonly lastRunId?: string;
}

export interface WorkflowStateEntrySummary {
  readonly workflowId: string;
  readonly key: string;
  readonly sizeBytes: number;
  readonly writtenAt: number;
  readonly ttlMs?: number;
  readonly expiresAt?: number;
  readonly runId?: string;
}

export interface WorkflowStateValueSnapshot extends WorkflowStateEntrySummary {
  readonly value: unknown;
}

export interface WorkflowStateCompactionResult {
  readonly workflowId: string;
  readonly scanned: number;
  readonly deleted: number;
  readonly bytesFreed: number;
  readonly deletedKeys: ReadonlyArray<string>;
}

export interface WorkflowArtifactSummary {
  readonly runId: string;
  readonly workflowId: string;
  readonly runStartedAt: number;
  readonly runEndedAt?: number | null;
  readonly key: string;
  readonly storageKey: string;
  readonly namespace: "run" | "fanout";
  readonly mime: string;
  readonly sizeBytes: number;
  readonly writtenAt: number;
  readonly stepKey?: string;
  readonly sha256?: string;
}

export type WorkflowNotificationDestination = "email";

export type WorkflowNotificationDetailLevel = "generic" | "title-only" | "summary" | "detailed";

export type WorkflowNotificationUrgency = "low" | "normal" | "high" | "critical";

export interface WorkflowNotificationRoutePolicy {
  readonly approvalRequired: boolean;
  readonly detailLevel: WorkflowNotificationDetailLevel;
  readonly dedupeWindowMs: number;
  readonly minimumUrgency: WorkflowNotificationUrgency;
  readonly externalWriteMode: "propose" | "allow";
}

export interface WorkflowNotificationOutboxItem {
  readonly id: string;
  readonly title: string;
  readonly destination: WorkflowNotificationDestination;
  readonly target: string;
  readonly preparedBy: string;
  readonly author?: string;
  readonly detailLevel: WorkflowNotificationDetailLevel;
  readonly content: {
    readonly summary: string;
    readonly body: string;
    readonly incidentId?: string;
    readonly sourceArtifactKey?: string;
  };
  readonly approval: {
    readonly status: "pending" | "approved" | "rejected" | "sent" | "cancelled";
    readonly approvedBy?: string;
    readonly decidedAt?: number;
    readonly attempt?: number;
  };
  readonly provenance?: {
    readonly runId?: string;
    readonly stepKey?: string;
    readonly preparedAt?: number;
  };
}

export type WorkflowActionDispatchStatus =
  | "proposed"
  | "pending"
  | "running"
  | "active"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowActionCenterStatusFilter =
  | "all"
  | "pending-proposed"
  | "active-running"
  | "completed"
  | "failed-cancelled";

export interface WorkflowActionDispatchState {
  readonly status: WorkflowActionDispatchStatus;
  readonly linkedSessionId?: string;
  readonly attempt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly lastError?: string;
}

export interface WorkflowActionCenterItem {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly workflowId: string;
  readonly runId?: string;
  readonly incidentId?: string;
  readonly dispatch: WorkflowActionDispatchState;
  readonly itemApproval?: {
    readonly status: "pending" | "approved" | "rejected";
    readonly decidedAt?: number;
    readonly decidedBy?: string;
  };
}

export interface WorkflowActionDispatchRequest {
  readonly workflowId: string;
  readonly itemId: string;
  readonly title: string;
  readonly prompt: string;
  readonly repoPath?: string | null;
  readonly workspaceName?: string;
  readonly retry?: boolean;
  readonly runId?: string;
  readonly incidentId?: string;
}

export interface WorkflowActionDispatchResult {
  readonly status: "started" | "already-active";
  readonly item: WorkflowActionCenterItem;
}

export interface WorkflowNotificationApprovalRequest {
  readonly workflowId: string;
  readonly item: WorkflowNotificationOutboxItem;
  readonly repoPath?: string | null;
  readonly workspaceName?: string;
  readonly approvedBy?: string;
}

export interface RunHistoryEntry {
  readonly runId: string;
  readonly runFamilyId: string;
  readonly workflowId: string;
  readonly repoPath?: string | null;
  readonly workspaceName?: string;
  readonly status: WorkflowRunStatus;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly parentRunId?: string;
  /**
   * Session that initiated this run (chat session whose `Run workflow`
   * action / `workflowRun` self-tool kicked it off). Populated from
   * `RunIndexEntry.initiatorSessionId`, optional because schedule- and
   * automation-triggered runs may have no initiator.
   *
   * Renderers (e.g. SessionActivityPanel) use this to filter the per-
   * session "Workflows" section to runs initiated by the current
   * session tree.
   */
  readonly initiatorSessionId?: string;
}

export interface WorkflowArtifactReadResult {
  readonly mime: string;
  readonly encoding: "utf8" | "base64";
  readonly content: string;
}

export interface WorkflowStateReadResult {
  readonly key: string;
  readonly found: boolean;
  readonly value?: unknown;
}

export interface WorkflowStateClearRequest {
  readonly workflowId: string;
  readonly repoPath?: string | null;
  readonly workspaceName?: string;
  readonly keys?: ReadonlyArray<string>;
  readonly prefixes?: ReadonlyArray<string>;
  readonly includeConfig?: boolean;
}

export interface WorkflowStateClearError {
  readonly key?: string;
  readonly prefix?: string;
  readonly message: string;
}

export interface WorkflowStateClearResult {
  readonly workflowId: string;
  readonly scanned: number;
  readonly deleted: number;
  readonly deletedKeys: ReadonlyArray<string>;
  readonly preservedConfigKeys: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<WorkflowStateClearError>;
}

// ── IPC push payloads ────────────────────────────────────────────────

export interface WorkflowEventBase {
  readonly seq: number;
  readonly ts: number;
}

/** Batched event delivery (~30 Hz from main). */
export interface WorkflowRunEventBatch {
  readonly runId: string;
  readonly batch: ReadonlyArray<WorkflowEvent>;
}

/** Coarse status-change push fired on terminal-state transitions. */
export interface WorkflowRunStatusEvent {
  readonly runId: string;
  readonly status: WorkflowRunStatus;
  readonly finishedAt?: number;
  readonly error?: RunError | null;
}

/** Top-bar tick — cheap and constant 1 Hz, never touches the reducer. */
export interface WorkflowRunTickEvent {
  readonly runId: string;
  readonly activeSubagents: number;
  readonly queued: number;
  readonly progressPct: number;
  readonly elapsedMs: number;
}

export interface WorkflowRendererBundle {
  readonly key: string;
  readonly workflowId: string;
  readonly source: WorkflowSource;
  readonly code: string;
  readonly installedAt: number;
}

// ── Permission-card dual-route (r1-fixes A10) ─────────────────────────

export interface WorkflowPermissionRequestEvent {
  readonly runId: string;
  readonly subagentSessionId: string;
  /** Opaque card payload; renderer hands it to the existing permission UI. */
  readonly cardPayload: unknown;
  readonly receivedAt: number;
}

export interface WorkflowPermissionResponse {
  readonly runId: string;
  readonly subagentSessionId: string;
  readonly cardId: string;
  readonly allow: boolean;
  readonly overridePattern?: string;
}

// ── Renderer action surface ──────────────────────────────────────────

/** Imperative actions a renderer can invoke on its run. */
export interface RunActions {
  cancel(reason?: string): Promise<void>;
  retryFromStep(stepId: string): Promise<{ newRunId: string; runFamilyId: string }>;
  openSubagentChat(sessionId: string): void;
}
