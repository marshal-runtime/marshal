// electron/workflows/types.ts
//
// Type-only port for the WorkflowRunManager surface consumed by
// `electron/self-tools.ts` (the `workflow*` handlers).
//
// IMPL-FOUNDATIONS shipped a deliberately loose `Promise<unknown>` shape
// so downstream branches could land without committing to a wire schema.
// IMPL-ENGINE narrows the return types to the actual contracts now that
// `common/workflows-contract/` is in place.

import type { SessionPermissionMode } from "../../common/marshal-ipc-contract";
import type {
  Binding,
  BindingsFile,
  RunSnapshot,
  TriggeredBy,
  WorkflowManifest,
  WorkflowArtifactSummary,
  WorkflowJSONSchema,
  WorkflowRendererBundle,
  WorkflowRunStatus,
  WorkflowScheduleSummary,
  WorkflowStateCompactionResult,
  WorkflowStateClearRequest,
  WorkflowStateClearResult,
  WorkflowStateEntrySummary,
  WorkflowStateValueSnapshot,
  WorkflowActionCenterItem,
  WorkflowActionDispatchRequest,
  WorkflowActionDispatchResult,
  WorkflowNotificationApprovalRequest,
} from "../../common/workflows-contract";

export { type RunSnapshot };
export type WorkflowSessionPermissionMode = Exclude<SessionPermissionMode, "read-only-reviewer">;

// Re-export from `workflows-contract` so this file is the engine port's
// authoritative type source.

export interface InstalledWorkflowSummary {
  readonly key: string;
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly source: "bundled" | "user-local" | "imported" | "repo-local";
  readonly installedAt: number;
  readonly schemaVersion: number;
  readonly version: string;
  readonly repoPath?: string;
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

export interface RunStartResult {
  readonly runId: string;
  readonly runFamilyId: string;
}

export interface RetryStartResult {
  readonly newRunId: string;
  readonly runFamilyId: string;
}

export interface InstallLocalResult {
  readonly workflowId: string;
  readonly installedAt: number;
  readonly compiledBytes: number;
  readonly warnings: ReadonlyArray<string>;
}

export interface InstallResult extends InstallLocalResult {
  readonly bindings: BindingsFile;
  readonly autoDerivedSlots: ReadonlyArray<string>;
  readonly createdAgentPaths: ReadonlyArray<string>;
}

/**
 * Surface returned by `describeWorkflow`. Mirrors what the installing
 * agent needs to author a binding map: the manifest title/description
 * plus the declared `agentRequirements`. Returned for both installed
 * workflows (by id) and on-disk source dirs (by `sourceDir`).
 */
export interface WorkflowDescription {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly version: string;
  readonly source?: "bundled" | "user-local" | "imported" | "repo-local";
  readonly extensions?: WorkflowManifest["extensions"];
  /** Path the description was read from. */
  readonly dir: string;
  /** Declared slots — the installing agent must produce a binding for each. */
  readonly agentRequirements: ReadonlyArray<{
    readonly slot: string;
    readonly role: string;
    readonly defaultPersonality?: string;
    readonly defaultAgent?: { readonly agentMdPath: string };
  }>;
  /** Existing bindings if any (for already-installed workflows). */
  readonly currentBindings?: BindingsFile;
}

/**
 * Port consumed by the `workflow*` self-tools. The concrete
 * implementation is `electron/workflows/workflow-run-manager.ts`; tests
 * may pass any object satisfying this shape.
 */
export interface WorkflowRunManager {
  /** Implements `workflowList`. */
  listWorkflows(args?: {
    repoPath?: string | null;
    workspaceName?: string;
  }): Promise<InstalledWorkflowSummary[]>;

  /** Implements `workflowRun`. */
  runWorkflow(args: {
    workflowId: string;
    repoPath?: string | null;
    workspaceName?: string;
    input?: unknown;
    initiatorSessionId?: string;
    permissionMode?: WorkflowSessionPermissionMode;
    triggeredBy?: TriggeredBy;
  }): Promise<RunStartResult>;

  /** Implements `workflowGetRun`. */
  getRun(args: { runId: string }): Promise<RunSnapshot | null>;

  /** Implements `workflowCancel`. */
  cancelRun(args: { runId: string; reason?: string }): Promise<{ ok: boolean; error?: string }>;

  /** Implements `workflowRetryFromStep`. */
  retryFromStep(args: { runId: string; stepId: string }): Promise<RetryStartResult>;

  /** Imports a workflow with auto-derived bindings. */
  installLocal(args: { sourceDir: string; overwrite?: boolean }): Promise<InstallLocalResult>;

  /**
   * Imports a workflow with an explicit binding map plus an optional target
   * repo path.
   */
  install(args: {
    sourceDir: string;
    overwrite?: boolean;
    targetRepoPath?: string | null;
    bindings?: Record<string, Binding>;
    createAgentBodies?: Record<string, string>;
  }): Promise<InstallResult>;

  /**
   * Implements `workflowDescribe` — surfaces the manifest and
   * `agentRequirements`; repo-local workflows can be scoped by repoPath
   * or workspaceName and do not need to be installed first.
   */
  describeWorkflow(args: {
    workflowId?: string;
    sourceDir?: string;
    repoPath?: string | null;
    workspaceName?: string;
  }): Promise<WorkflowDescription>;

  getScheduleForWorkflow(args: {
    workflowId: string;
    repoPath?: string | null;
    workspaceName?: string;
  }): WorkflowScheduleSummary | null;

  updateScheduleForWorkflow(args: {
    workflowId: string;
    schedule: string;
    input?: unknown;
    repoPath?: string | null;
    workspaceName?: string;
  }): WorkflowScheduleSummary;

  disableScheduleForWorkflow(args: {
    workflowId: string;
    repoPath?: string | null;
    workspaceName?: string;
  }): WorkflowScheduleSummary | null;

  getRendererBundle(args: {
    workflowId: string;
    repoPath?: string | null;
    workspaceName?: string;
  }): Promise<WorkflowRendererBundle | null>;

  readArtifact(args: {
    runId: string;
    storageKey: string;
  }): { mime: string; encoding: "utf8" | "base64"; content: string } | null;

  listArtifacts(args: {
    workflowId: string;
    repoPath?: string | null;
    workspaceName?: string;
    prefix?: string;
    limit?: number;
  }): WorkflowArtifactSummary[];

  listState(args: {
    workflowId: string;
    repoPath?: string | null;
    workspaceName?: string;
    prefix?: string;
  }): WorkflowStateEntrySummary[];

  readState(args: {
    workflowId: string;
    key: string;
    repoPath?: string | null;
    workspaceName?: string;
  }): WorkflowStateValueSnapshot | null;

  compactState(args: {
    workflowId: string;
    repoPath?: string | null;
    workspaceName?: string;
    prefix?: string;
    olderThanMs?: number;
    limit?: number;
  }): Promise<WorkflowStateCompactionResult>;

  clearWorkflowState(args: WorkflowStateClearRequest): Promise<WorkflowStateClearResult>;

  readArtifactByKey(args: {
    runId: string;
    key: string;
  }): { mime: string; encoding: "utf8" | "base64"; content: string } | null;

  getWorkflowStateValue(args: { workflowId: string; key: string }): {
    key: string;
    found: boolean;
    value?: unknown;
  };

  listWorkflowStateKeys(args: { workflowId: string; prefix?: string }): readonly string[];

  dispatchWorkflowAction(
    args: WorkflowActionDispatchRequest,
  ): Promise<WorkflowActionDispatchResult>;

  getWorkflowActionItem(args: {
    workflowId: string;
    itemId: string;
    repoPath?: string | null;
    workspaceName?: string;
  }): Promise<WorkflowActionCenterItem | null>;

  approveWorkflowNotification(
    args: WorkflowNotificationApprovalRequest,
  ): Promise<WorkflowActionDispatchResult>;

  saveArtifactFromSession(args: {
    sessionId: string;
    key: string;
    content: string;
    mime?: string;
  }): Promise<{
    key: string;
    storageKey: string;
    namespace: "run" | "fanout";
    mime: string;
    sizeBytes: number;
    writtenAt: number;
    stepKey?: string;
  }>;

  getRunIdForSession(sessionId: string): string | undefined;
}
