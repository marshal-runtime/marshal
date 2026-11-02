// common/workflows-contract/snapshot.ts
//
// `RunSnapshot` is the engine's derived view of a run, computed by
// reducing the event log via `common/workflows-reducer.ts`. Both the main
// process (for `workflows:getRun` IPC pull) and the renderer (for live
// event-stream tail) use the same reducer to produce the same snapshot.
//
// Renderers MAY extend via their own derived projections (see r1-fixes
// "renderer state path"). They cannot add fields to `RunSnapshot` itself.

import type {
  WorkflowActionCenterSnapshotItem,
  WorkflowInvestigationCompletion,
  WorkflowScheduleCursor,
  WorkflowStageContext,
} from "./operational";
import type { RunStatus, WorkflowRunScheduleContext } from "./run-record";
import type { ExecutionUnitStatus, FanOutUnit } from "./ui-extras";

export type StepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "skipped-replay";

export interface StepView {
  /** Unique step memo key (parentKey + callsiteIndex + label). */
  readonly id: string;
  readonly label: string;
  readonly parentStepKey: string;
  readonly status: StepStatus;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly result?: unknown;
  readonly error?: { message: string; stack?: string };

  // ── UI-facing optional projections (populated by enrich pass; engine
  // reducer does not emit these directly today — see r2-impl §6 D8) ────
  /** Nesting depth from root (0 = top-level). */
  readonly depth?: number;
  /** Step kind hint for the renderer. */
  readonly kind?: "sequential" | "fanOut" | "static-parallel";
  readonly retryCount?: number;
  readonly units?: ReadonlyArray<FanOutUnit>;
  readonly maxConcurrency?: number;
  readonly directAgents?: ReadonlyArray<string>;
  /** Per-step artifact key subset. The global list lives on `RunSnapshot.artifacts`. */
  readonly artifacts?: ReadonlyArray<string>;
}

export interface AgentHandleSummary {
  readonly handleId: string;
  readonly sessionId: string;
  readonly stepKey: string;
  readonly agentName?: string;
  readonly displayName?: string;
  readonly status:
    | "queued"
    | "spawning"
    | "running"
    | "waiting"
    | "completed"
    | "cancelled"
    | "failed";

  // ── UI-facing optional projections (not yet populated by the engine
  // reducer — see r2-impl §6 D8) ─────────────────────────────────────
  /** Display identity (typically `agentName ?? displayName ?? "agent"`). */
  readonly identity?: string;
  readonly turnCount?: number;
  readonly lastMessageAt?: number | null;
  readonly lastMessageSnippet?: string;
}

export interface ArtifactRefSummary {
  readonly key: string;
  readonly storageKey: string;
  readonly namespace: "run" | "fanout";
  readonly mime: string;
  readonly sizeBytes: number;
  readonly writtenAt: number;
  readonly stepKey?: string;
  /** Optional content hash. Engine does not populate today; see r2-impl §6 D8. */
  readonly sha256?: string;
}

export interface CapacityView {
  readonly used?: number;
  readonly cap?: number;
  readonly queueLength?: number;

  // ── UI-facing optional aliases (top-bar tick reads these from the
  // richer `workflows:run-tick` event; some test fixtures preserve them) ─
  readonly activeSubagents?: number;
  readonly globalLimit?: number;
  readonly perRunLimit?: number;
  readonly queued?: number;
}

export interface RunSnapshot {
  readonly runId: string;
  readonly runFamilyId: string;
  readonly parentRunId?: string;
  readonly workflowId: string;
  readonly repoPath?: string | null;
  readonly workspaceName?: string;
  readonly workflowVersion: string;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly steps: ReadonlyArray<StepView>;
  readonly agents: Readonly<Record<string, AgentHandleSummary>>;
  readonly artifacts: ReadonlyArray<ArtifactRefSummary>;
  readonly capacity: CapacityView;
  readonly events: { readonly lastSeq: number };
  readonly result?: unknown;
  readonly errorSummary?: { message: string; stack?: string; code?: string };

  // ── UI-facing optional projection ──────────────────────────────────
  /** Snapshot of the workflow input (mirrors `RunRecord.inputSnapshot`). */
  readonly input?: unknown;
  /** Schedule occurrence metadata when triggered by the workflow scheduler. */
  readonly schedule?: WorkflowRunScheduleContext;
  /** Latest workflow-committed schedule cursor for incremental scheduled runs. */
  readonly scheduleCursor?: WorkflowScheduleCursor;
  /** Stage-scoped reference bundles exposed by workflow code for lazy/on-demand context loading. */
  readonly stageContexts?: ReadonlyArray<WorkflowStageContext>;
  /** Per-incident completion gates. Bucketization should only advance once all are terminal. */
  readonly investigationCompletions?: Readonly<Record<string, WorkflowInvestigationCompletion>>;
  /** Rich workflow action-center items with expansion data and related chat/artifact links. */
  readonly actionCenterItems?: ReadonlyArray<WorkflowActionCenterSnapshotItem>;
  /** Per-status unit counter used by fanOut summaries (engine reducer does not yet populate — see r2-impl §6 D8). */
  readonly unitStatusCount?: Readonly<Record<ExecutionUnitStatus, number>>;
}
