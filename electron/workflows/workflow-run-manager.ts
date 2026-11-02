// electron/workflows/workflow-run-manager.ts
//
// `WorkflowRunManager` — process-singleton owning the live engine map,
// the subagent pool, the persistence layer, and the load/install
// surfaces. Implements the port interface in `electron/workflows/types.ts`
// so the `workflow*` self-tools delegate through one slot.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ReasoningEffort } from "../../common/marshal-ipc-contract";
import { createLogger } from "../../common/marshal-logger";
import type {
  BindingsFile,
  InstalledSource,
  RunError,
  RunIndexEntry,
  RunRecord,
  TriggeredBy,
  WorkflowEvent,
  WorkflowArtifactSummary,
  WorkflowJSONSchema,
  WorkflowManifest,
  WorkflowRendererBundle,
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
  WorkflowRunScheduleContext,
  WorkflowRunStatusEvent,
  WorkflowScheduleCursor,
} from "../../common/workflows-contract";
import type { RunSnapshot } from "../../common/workflows-contract";
import type { WorkflowRunStatus } from "../../common/workflows-contract";
import { replaySnapshot } from "../../common/workflows-reducer";
import {
  appendWorkflowDiagnostic,
  beginWorkflowDiagnosticRun,
  endWorkflowDiagnosticRun,
} from "./diagnostics";
import { BackendUnsupportedError, WorkflowInstallError } from "./errors";
import { EventLog, readEventLines } from "./event-log";
import {
  install,
  installLocal,
  resolveBindings,
  type InstallLocalResult,
  type InstallResult,
} from "./install-local";
import { MemoStore } from "./memo-store";
import { ArtifactStore, WorkflowRunRepository, type RepositoryDeps } from "./repository";
import type { SpawnAdapter } from "./spawn-adapter";
import { WorkflowStateStore } from "./state-store";
import { SubagentPool } from "./subagent-pool";
import type { WorkflowDescription, WorkflowSessionPermissionMode } from "./types";
import {
  compileCommandCenterWithEsbuild,
  compileRendererWithEsbuild,
  compileWithEsbuild,
} from "./workflow-compiler";
import { WorkflowEngine } from "./workflow-engine";
import type { PriorArtifact } from "./workflow-engine";
import { loadDefinitionFromCompiled } from "./workflow-introspect";
import {
  WorkflowLoader,
  readBindingsFile,
  type InstalledWorkflowEntry,
  type LoaderDeps,
  workflowEntryKey,
} from "./workflow-loader";
import {
  WorkflowScheduleStore,
  WorkflowScheduler,
  workflowScheduleRunContext,
  type WorkflowScheduleRecord,
  type WorkflowScheduleTrigger,
} from "./workflow-scheduler";

const log = createLogger("WorkflowRunManager");
const STALE_RUN_RECOVERY_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 60_000] as const;

/**
 * Reserved namespace for UI-owned config a workflow's command center writes via
 * `workflows:putConfigValue`. Confining renderer writes to this prefix keeps
 * engine-owned operational state (cursors, portfolio, shift state) safe from
 * the renderer. The workflow reads config back via `ctx.store.get("config/…")`.
 */
const CONFIG_KEY_PREFIX = "config/";

export interface WorkflowRunManagerDeps {
  readonly spawnAdapter: SpawnAdapter;
  /** Lazy fetch of the synthetic "workflow-run" host session id for a runId. */
  readonly hostSessionFactory: (args: {
    runId: string;
    workflowId: string;
    workflowTitle: string;
    /** Workflow-level default model for the host orchestrator (overrides the
     *  workflow tier default from Settings). */
    model?: string;
    /** Workflow-level default reasoning effort for the host orchestrator. */
    reasoningEffort?: ReasoningEffort;
    /** Permission mode derived from manifest permissions.mode. */
    permissionMode?: WorkflowSessionPermissionMode;
  }) => Promise<string>;
  readonly hostSessionDisposer?: (sessionId: string) => Promise<void>;
  readonly repository?: WorkflowRunRepository;
  readonly artifactStore?: ArtifactStore;
  readonly stateStore?: WorkflowStateStore;
  readonly loader?: WorkflowLoader;
  readonly pool?: SubagentPool;
  readonly scheduleStore?: WorkflowScheduleStore;
  readonly backendOrigin?: () => string;
  readonly workspaceResolver?: (workspaceName: string) => string | undefined;
  readonly workspaceLister?: () => ReadonlyArray<{ name: string; path: string }>;
  readonly repoOverrides?: RepositoryDeps;
  readonly loaderOverrides?: LoaderDeps;
  /** Optional shell runner override for `ctx.shell`. Useful for tests. */
  readonly shellRunner?: ConstructorParameters<typeof WorkflowEngine>[0]["shellRunner"];
  readonly sendWorkflowParentMessage?: (args: {
    sessionId: string;
    message: string;
    waitForResponse?: boolean;
    timeoutMs?: number;
  }) => Promise<{ delivered: boolean; status: "sent" | "responded"; response?: string }>;
  readonly launchActionSession?: (args: {
    readonly title: string;
    readonly prompt: string;
    readonly repoPath?: string | null;
    readonly workspaceName?: string;
  }) => Promise<{ readonly sessionId: string; readonly title: string }>;
  readonly getActionSessionState?: (sessionId: string) => "busy" | "idle" | "missing";
  readonly cancelActionSession?: (sessionId: string) => Promise<void>;
}

export interface RunStartResult {
  readonly runId: string;
  readonly runFamilyId: string;
}

export interface RetryStartResult {
  readonly newRunId: string;
  readonly runFamilyId: string;
}

export interface InstalledWorkflowSummary {
  readonly key: string;
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly source: InstalledSource["source"];
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

export class WorkflowRunManager {
  private readonly engines = new Map<string, WorkflowEngine>();
  private readonly repository: WorkflowRunRepository;
  private readonly artifactStore: ArtifactStore;
  private readonly stateStore: WorkflowStateStore;
  private readonly loader: WorkflowLoader;
  private readonly pool: SubagentPool;
  private readonly scheduler: WorkflowScheduler;
  private readonly sessionRunIndex = new Map<string, string>();
  private persistedHostSessionRunIndex: Map<string, string> | null = null;
  private readonly runEventUnsubscribers = new Map<string, () => void>();
  private broadcast: ((channel: string, payload: unknown) => void) | undefined;
  private staleRunRecoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private staleRunRecoveryRetryIndex = 0;
  private staleRunRecoveryRetriesExhausted = false;
  private staleRunRecoveryPromise: Promise<void> | null = null;

  constructor(private readonly deps: WorkflowRunManagerDeps) {
    this.repository = deps.repository ?? new WorkflowRunRepository(deps.repoOverrides);
    this.artifactStore = deps.artifactStore ?? new ArtifactStore(deps.repoOverrides);
    this.stateStore = deps.stateStore ?? new WorkflowStateStore(deps.repoOverrides);
    this.loader = deps.loader ?? new WorkflowLoader(deps.loaderOverrides);
    this.pool =
      deps.pool ??
      new SubagentPool({
        globalMax: 30,
        defaultPerRunMax: 16,
        defaultPerFanOutMax: 8,
      });
    this.scheduler = new WorkflowScheduler({
      store: deps.scheduleStore,
      listEntries: () => this.listAllEntries(),
      hasActiveRunForKey: (key) => this.hasActiveRunForKey(key),
      runScheduledWorkflow: (record, trigger) => this.runScheduledWorkflow(record, trigger),
    });
  }

  /** Boot-time recovery: mark stale `running` rows as crashed. */
  async bootAndReattachInflight(): Promise<void> {
    let schedulerRestoreError: unknown;
    try {
      this.scheduler.restore();
    } catch (error) {
      schedulerRestoreError = error;
    }
    await this.recoverStaleRuns();
    if (schedulerRestoreError) throw schedulerRestoreError;
  }

  private recoverStaleRuns(): Promise<void> {
    if (this.staleRunRecoveryPromise) return this.staleRunRecoveryPromise;
    const recovery = this.runStaleRunRecovery();
    this.staleRunRecoveryPromise = recovery;
    return recovery.finally(() => {
      if (this.staleRunRecoveryPromise === recovery) {
        this.staleRunRecoveryPromise = null;
      }
    });
  }

  private async runStaleRunRecovery(): Promise<void> {
    // V1: we don't actually resume; the engine documentation calls for
    // resumeFromCrash mode but the WSR-class semantics it enables are
    // out of scope for this branch. We mark stale rows as crashed so the
    // UI can show them and the operator can `retryFromStep`.
    try {
      const stale = await this.repository.markStaleAsCrashed(
        "App restarted while run was active — V1 has no auto-resume.",
      );
      this.clearStaleRunRecoveryRetry();
      if (stale.length > 0) {
        log.info(`Marked ${stale.length} stale workflow run(s) as crashed.`);
      }
    } catch (error) {
      log.warn("Failed to reconcile stale workflow runs; retrying:", error);
      this.scheduleStaleRunRecoveryRetry();
    }
  }

  private scheduleStaleRunRecoveryRetry(): void {
    if (this.staleRunRecoveryRetryTimer) return;
    const delayMs = STALE_RUN_RECOVERY_RETRY_DELAYS_MS[this.staleRunRecoveryRetryIndex];
    if (delayMs === undefined) {
      if (!this.staleRunRecoveryRetriesExhausted) {
        this.staleRunRecoveryRetriesExhausted = true;
        log.error("Stale workflow-run recovery retries exhausted");
      }
      return;
    }
    this.staleRunRecoveryRetryIndex++;
    this.staleRunRecoveryRetryTimer = setTimeout(() => {
      this.staleRunRecoveryRetryTimer = null;
      void this.recoverStaleRuns();
    }, delayMs);
  }

  private clearStaleRunRecoveryRetry(): void {
    if (this.staleRunRecoveryRetryTimer) {
      clearTimeout(this.staleRunRecoveryRetryTimer);
      this.staleRunRecoveryRetryTimer = null;
    }
    this.staleRunRecoveryRetryIndex = 0;
    this.staleRunRecoveryRetriesExhausted = false;
  }

  // ── Public API (mirrors the workflow* tools) ─────────────────

  async listWorkflows(
    args: {
      repoPath?: string | null;
      workspaceName?: string;
    } = {},
  ): Promise<InstalledWorkflowSummary[]> {
    const repoPath = this.resolveRepoPath(args);
    const entries = repoPath
      ? this.loader.listRepoWorkflows(repoPath, args.workspaceName)
      : this.listAllEntries();
    const runs = this.repository.listRuns();
    const schedules = new Map(this.scheduler.list().map((schedule) => [schedule.key, schedule]));
    return Promise.all(
      entries.map(async (e) => ({
        key: e.key,
        id: e.id,
        displayName: e.title,
        description: e.description,
        source: e.source,
        installedAt: e.installedAt,
        schemaVersion: 1,
        version: e.version,
        repoPath: e.repoPath,
        workspaceName: e.workspaceName,
        projectName: e.repoPath ? path.basename(e.repoPath) : undefined,
        defaultSchedule: e.manifest.schedule,
        schedule: schedules.get(e.key),
        inputSchema: await this.inputSchemaForEntry(e),
        extensions: e.manifest.extensions,
        lastRun: this.lastRunForEntry(e, runs),
      })),
    );
  }

  async runWorkflow(args: {
    workflowId: string;
    repoPath?: string | null;
    workspaceName?: string;
    input?: unknown;
    initiatorSessionId?: string;
    permissionMode?: WorkflowSessionPermissionMode;
    triggeredBy?: TriggeredBy;
  }): Promise<RunStartResult> {
    this.assertBackendSupported();
    const repoPath = this.resolveRepoPath(args);
    const entry = this.loader.getEntry({
      workflowId: args.workflowId,
      repoPath,
      workspaceName: args.workspaceName,
    });
    const runId = randomUUID();
    return this.createAndStartRun({
      runId,
      runFamilyId: runId,
      parentRunId: undefined,
      entry,
      repoPath,
      workspaceName: args.workspaceName,
      input: args.input,
      initiatorSessionId: args.initiatorSessionId,
      permissionMode: args.permissionMode,
      triggeredBy: args.triggeredBy ?? "self-tool",
    });
  }

  async getRun(args: { runId: string }): Promise<RunSnapshot | null> {
    const record = this.repository.loadRun(args.runId);
    if (!record) return null;
    const events = Array.from(readEventLines(this.repository.eventsPathFor(args.runId)));
    const snapshot = replaySnapshot({ runId: args.runId, workflowId: record.workflowId }, events);
    return {
      ...snapshot,
      input: record.inputSnapshot,
      schedule: record.schedule,
      repoPath: record.workflowRepoPath ?? null,
      workspaceName: record.workflowWorkspaceName,
    };
  }

  async cancelRun(args: {
    runId: string;
    reason?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    const engine = this.engines.get(args.runId);
    if (!engine) {
      // Already terminal — update on-disk record if it claims running.
      const record = this.repository.loadRun(args.runId);
      if (record && (record.status === "running" || record.status === "pending")) {
        await this.repository.updateRun(args.runId, {
          status: "cancelled",
          endedAt: Date.now(),
          durationMs: Date.now() - record.startedAt,
        });
      }
      return { ok: true };
    }
    try {
      await engine.cancel(args.reason);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async retryFromStep(args: { runId: string; stepId: string }): Promise<RetryStartResult> {
    this.assertBackendSupported();
    const source = this.repository.loadRun(args.runId);
    if (!source) throw new Error(`Run ${args.runId} not found`);
    const entry = this.loader.getEntry({
      workflowId: source.workflowId,
      repoPath: source.workflowRepoPath,
      workspaceName: source.workflowWorkspaceName,
    });
    const newRunId = randomUUID();
    const result = await this.createAndStartRun({
      runId: newRunId,
      runFamilyId: source.runFamilyId,
      parentRunId: source.runId,
      entry,
      repoPath: source.workflowRepoPath,
      workspaceName: source.workflowWorkspaceName,
      input: source.inputSnapshot,
      initiatorSessionId: source.initiatorSessionId,
      triggeredBy: "self-tool",
      replayFromStepKey: args.stepId,
      seedMemoFrom: source.runId,
    });
    return { newRunId: result.runId, runFamilyId: result.runFamilyId };
  }

  async installLocal(args: {
    sourceDir: string;
    overwrite?: boolean;
  }): Promise<InstallLocalResult> {
    return installLocal(args, { loader: this.loader });
  }

  async install(args: {
    sourceDir: string;
    overwrite?: boolean;
    targetRepoPath?: string | null;
    bindings?: Record<string, import("../../common/workflows-contract").Binding>;
    createAgentBodies?: Record<string, string>;
  }): Promise<InstallResult> {
    return install(args, { loader: this.loader });
  }

  getScheduleForWorkflow(args: {
    workflowId: string;
    repoPath?: string | null;
    workspaceName?: string;
  }): WorkflowScheduleSummary | null {
    const repoPath = this.resolveRepoPath(args);
    const entry = this.loader.getEntry({
      workflowId: args.workflowId,
      repoPath,
      workspaceName: args.workspaceName,
    });
    return this.scheduler.get(entry.key);
  }

  updateScheduleForWorkflow(args: {
    workflowId: string;
    schedule: string;
    input?: unknown;
    repoPath?: string | null;
    workspaceName?: string;
  }): WorkflowScheduleSummary {
    const repoPath = this.resolveRepoPath(args);
    const entry = this.loader.getEntry({
      workflowId: args.workflowId,
      repoPath,
      workspaceName: args.workspaceName,
    });
    return this.scheduler.update({ entry, naturalLanguage: args.schedule, input: args.input });
  }

  disableScheduleForWorkflow(args: {
    workflowId: string;
    repoPath?: string | null;
    workspaceName?: string;
  }): WorkflowScheduleSummary | null {
    const repoPath = this.resolveRepoPath(args);
    const entry = this.loader.getEntry({
      workflowId: args.workflowId,
      repoPath,
      workspaceName: args.workspaceName,
    });
    return this.scheduler.disable(entry.key);
  }

  async getRendererBundle(args: {
    workflowId: string;
    repoPath?: string | null;
    workspaceName?: string;
  }): Promise<WorkflowRendererBundle | null> {
    const repoPath = this.resolveRepoPath(args);
    const entry = this.loader.getEntry({
      workflowId: args.workflowId,
      repoPath,
      workspaceName: args.workspaceName,
    });
    if (entry.source === "bundled") return null;
    const compiled = path.join(entry.dir, "dist", "renderer.js");
    let code: string | null = null;
    if (fs.existsSync(compiled)) {
      code = fs.readFileSync(compiled, "utf-8");
    } else {
      const source = path.join(entry.dir, "renderer.tsx");
      if (entry.source === "repo-local" && fs.existsSync(source)) {
        code = await compileRendererWithEsbuild(source, entry.id);
      }
    }
    if (!code) return null;
    return {
      key: entry.key,
      workflowId: entry.id,
      source: entry.source,
      code,
      installedAt: entry.installedAt,
    };
  }

  /**
   * Load a workflow's optional workflow-LEVEL command center bundle
   * (`dist/command-center.js`, or compiled on the fly from
   * `command-center.tsx` for repo-local workflows). Mirrors
   * `getRendererBundle`; returns null when the workflow ships none.
   */
  async getCommandCenterBundle(args: {
    workflowId: string;
    repoPath?: string | null;
    workspaceName?: string;
  }): Promise<WorkflowRendererBundle | null> {
    const repoPath = this.resolveRepoPath(args);
    const entry = this.loader.getEntry({
      workflowId: args.workflowId,
      repoPath,
      workspaceName: args.workspaceName,
    });
    if (entry.source === "bundled") {
      log.info(`getCommandCenterBundle(${args.workflowId}): source=bundled → null (no custom CC)`);
      return null;
    }
    const compiled = path.join(entry.dir, "dist", "command-center.js");
    const source = path.join(entry.dir, "command-center.tsx");
    log.info(
      `getCommandCenterBundle(${args.workflowId}): source=${entry.source} dir=${entry.dir} compiledExists=${fs.existsSync(compiled)} tsxExists=${fs.existsSync(source)}`,
    );
    let code: string | null = null;
    if (fs.existsSync(compiled)) {
      code = fs.readFileSync(compiled, "utf-8");
    } else if (entry.source === "repo-local" && fs.existsSync(source)) {
      try {
        code = await compileCommandCenterWithEsbuild(source, entry.id);
      } catch (err) {
        log.error(
          `getCommandCenterBundle(${args.workflowId}): command-center.tsx compile FAILED`,
          err,
        );
        throw err;
      }
    }
    if (!code) {
      log.info(`getCommandCenterBundle(${args.workflowId}): no code resolved → null`);
      return null;
    }
    log.info(
      `getCommandCenterBundle(${args.workflowId}): returning bundle, codeLen=${code.length}`,
    );
    return {
      key: entry.key,
      workflowId: entry.id,
      source: entry.source,
      code,
      installedAt: entry.installedAt,
    };
  }

  readArtifact(args: {
    runId: string;
    storageKey: string;
  }): { mime: string; encoding: "utf8" | "base64"; content: string } | null {
    const snapshot = this.repository.loadRun(args.runId);
    if (!snapshot) return null;
    const events = Array.from(readEventLines(this.repository.eventsPathFor(args.runId)));
    const runSnapshot = replaySnapshot(
      { runId: args.runId, workflowId: snapshot.workflowId },
      events,
    );
    const artifact = runSnapshot.artifacts.find((a) => a.storageKey === args.storageKey);
    if (!artifact) return null;
    const bytes = this.artifactStore.readArtifact(args.runId, args.storageKey);
    if (!bytes) return null;
    const isText = /^text\//.test(artifact.mime) || artifact.mime === "application/json";
    return {
      mime: artifact.mime,
      encoding: isText ? "utf8" : "base64",
      content: Buffer.from(bytes).toString(isText ? "utf-8" : "base64"),
    };
  }

  listArtifacts(args: {
    workflowId: string;
    repoPath?: string | null;
    workspaceName?: string;
    prefix?: string;
    limit?: number;
  }): WorkflowArtifactSummary[] {
    const repoPath = this.resolveRepoPath(args);
    const runs = this.repository
      .listRuns()
      .filter((run) => this.runMatchesWorkflow(run, args.workflowId, repoPath, args.workspaceName))
      .sort((a, b) => b.startedAt - a.startedAt);
    const out: WorkflowArtifactSummary[] = [];
    for (const run of runs) {
      const events = Array.from(readEventLines(this.repository.eventsPathFor(run.runId)));
      const snapshot = replaySnapshot({ runId: run.runId, workflowId: run.workflowId }, events);
      for (const artifact of snapshot.artifacts) {
        if (args.prefix && !artifact.key.startsWith(args.prefix)) continue;
        out.push({
          runId: run.runId,
          workflowId: run.workflowId,
          runStartedAt: run.startedAt,
          runEndedAt: run.endedAt,
          key: artifact.key,
          storageKey: artifact.storageKey,
          namespace: artifact.namespace,
          mime: artifact.mime,
          sizeBytes: artifact.sizeBytes,
          writtenAt: artifact.writtenAt,
          stepKey: artifact.stepKey,
          sha256: artifact.sha256,
        });
        if (args.limit !== undefined && out.length >= args.limit) return out;
      }
    }
    return out;
  }

  listState(args: {
    workflowId: string;
    repoPath?: string | null;
    workspaceName?: string;
    prefix?: string;
  }): WorkflowStateEntrySummary[] {
    const entry = this.resolveEntry(args);
    return this.stateStore.listEntries(entry.id, args.prefix).map((state) => ({
      workflowId: entry.id,
      key: state.key,
      sizeBytes: state.sizeBytes,
      writtenAt: state.writtenAt,
      ttlMs: state.ttlMs,
      expiresAt: state.expiresAt,
      runId: state.runId,
    }));
  }

  readState(args: {
    workflowId: string;
    key: string;
    repoPath?: string | null;
    workspaceName?: string;
  }): WorkflowStateValueSnapshot | null {
    const entry = this.resolveEntry(args);
    const state = this.stateStore.getEntry(entry.id, args.key);
    if (!state) return null;
    return {
      workflowId: entry.id,
      key: state.key,
      sizeBytes: state.sizeBytes,
      writtenAt: state.writtenAt,
      ttlMs: state.ttlMs,
      expiresAt: state.expiresAt,
      runId: state.runId,
      value: state.value,
    };
  }

  async compactState(args: {
    workflowId: string;
    repoPath?: string | null;
    workspaceName?: string;
    prefix?: string;
    olderThanMs?: number;
    limit?: number;
  }): Promise<WorkflowStateCompactionResult> {
    const entry = this.resolveEntry(args);
    const result = await this.stateStore.compact(entry.id, {
      prefix: args.prefix,
      olderThanMs: args.olderThanMs,
      limit: args.limit,
    });
    return { workflowId: entry.id, ...result };
  }

  async clearWorkflowState(args: WorkflowStateClearRequest): Promise<WorkflowStateClearResult> {
    const entry = this.resolveEntry(args);
    const entries = this.stateStore.listEntries(entry.id);
    const requestedKeys = args.keys?.map((key) => key.trim()).filter(Boolean);
    const requestedPrefixes = args.prefixes?.map((prefix) => prefix.trim()).filter(Boolean);
    const usesExplicitSelectors = Boolean(requestedKeys?.length || requestedPrefixes?.length);
    const keys = requestedKeys ?? (usesExplicitSelectors ? [] : ["command-center-state"]);
    const prefixes =
      requestedPrefixes ??
      (usesExplicitSelectors
        ? []
        : [
            "incident-incident-investigation/",
            "system/action-center/",
            "system/notification-outbox/",
          ]);
    const selects = (key: string): boolean =>
      keys.includes(key) || prefixes.some((prefix) => key.startsWith(prefix));
    if (
      !args.includeConfig &&
      (keys.some((key) => key.startsWith(CONFIG_KEY_PREFIX)) ||
        prefixes.some((prefix) =>
          prefix.length === 0
            ? true
            : CONFIG_KEY_PREFIX.startsWith(prefix) || prefix.startsWith(CONFIG_KEY_PREFIX),
        ))
    ) {
      throw new Error("Clearing config state requires includeConfig: true.");
    }

    const deletedKeys: string[] = [];
    const preservedConfigKeys: string[] = [];
    const errors: Array<{ key?: string; prefix?: string; message: string }> = [];
    for (const state of entries) {
      if (state.key.startsWith(CONFIG_KEY_PREFIX) && !args.includeConfig) {
        preservedConfigKeys.push(state.key);
        continue;
      }
      if (!selects(state.key)) continue;
      try {
        // Each delete updates the shared workflow index; preserve ordering to avoid lost updates.
        // oxlint-disable-next-line eslint/no-await-in-loop
        await this.stateStore.delete(entry.id, state.key);
        deletedKeys.push(state.key);
      } catch (error) {
        errors.push({
          key: state.key,
          message: error instanceof Error ? error.message : "State deletion failed.",
        });
      }
    }
    return {
      workflowId: entry.id,
      scanned: entries.length,
      deleted: deletedKeys.length,
      deletedKeys,
      preservedConfigKeys,
      errors,
    };
  }

  readArtifactByKey(args: {
    runId: string;
    key: string;
  }): { mime: string; encoding: "utf8" | "base64"; content: string } | null {
    const record = this.repository.loadRun(args.runId);
    if (!record) return null;
    const events = Array.from(readEventLines(this.repository.eventsPathFor(args.runId)));
    const runSnapshot = replaySnapshot(
      { runId: args.runId, workflowId: record.workflowId },
      events,
    );
    const artifact = [...runSnapshot.artifacts].reverse().find((a) => a.key === args.key);
    if (!artifact) return null;
    return this.readArtifact({ runId: args.runId, storageKey: artifact.storageKey });
  }

  getWorkflowStateValue(args: { workflowId: string; key: string }): {
    key: string;
    found: boolean;
    value?: unknown;
  } {
    const value = this.stateStore.get(args.workflowId, args.key);
    if (value === undefined) return { key: args.key, found: false };
    return { key: args.key, found: true, value };
  }

  listWorkflowStateKeys(args: { workflowId: string; prefix?: string }): readonly string[] {
    return this.stateStore.listKeys(args.workflowId, args.prefix);
  }

  /**
   * Persist a UI-owned config value written by a workflow's command center.
   * Confined to the reserved `config/` namespace so the renderer can never
   * clobber engine-owned operational state (cursors, portfolio, shift state).
   * The workflow reads it back via `ctx.store.get("config/<key>")`.
   */
  async putWorkflowConfigValue(args: {
    workflowId: string;
    repoPath?: string | null;
    workspaceName?: string;
    key: string;
    value: unknown;
  }): Promise<void> {
    const rawKey = args.key.trim();
    if (rawKey.length === 0) throw new Error("Config key must be non-empty");
    if (rawKey.includes("..")) throw new Error("Config key must not contain '..'");
    // Normalise to exactly one `config/` prefix regardless of caller input.
    const suffix = rawKey.startsWith(CONFIG_KEY_PREFIX)
      ? rawKey.slice(CONFIG_KEY_PREFIX.length)
      : rawKey;
    if (suffix.length === 0) throw new Error("Config key must be non-empty");
    const key = `${CONFIG_KEY_PREFIX}${suffix}`;
    // Resolve through the loader so repo-local workflows key state by their id.
    const repoPath = this.resolveRepoPath(args);
    const entry = this.loader.getEntry({
      workflowId: args.workflowId,
      repoPath,
      workspaceName: args.workspaceName,
    });
    await this.stateStore.put(entry.id, key, args.value);
  }

  async dispatchWorkflowAction(
    args: WorkflowActionDispatchRequest,
  ): Promise<WorkflowActionDispatchResult> {
    const entry = this.resolveEntry(args);
    const stateKey = actionCenterStateKey(args.itemId);
    const existing = workflowActionCenterItem(this.stateStore.get(entry.id, stateKey));
    const reconciled = existing ? await this.reconcileWorkflowActionItem(entry.id, existing) : null;
    if (
      reconciled &&
      (reconciled.dispatch.status === "active" || reconciled.dispatch.status === "running") &&
      !args.retry
    ) {
      return { status: "already-active", item: reconciled };
    }
    if (!this.deps.launchActionSession) {
      throw new Error("Workflow action session launcher is unavailable.");
    }
    if (args.retry && reconciled?.dispatch.linkedSessionId && this.deps.cancelActionSession) {
      await this.deps.cancelActionSession(reconciled.dispatch.linkedSessionId);
    }
    const launched = await this.deps.launchActionSession({
      title: args.title,
      prompt: args.prompt,
      repoPath: args.repoPath,
      workspaceName: args.workspaceName,
    });
    const now = Date.now();
    const item: WorkflowActionCenterItem = {
      id: args.itemId,
      title: args.title,
      summary: args.prompt,
      workflowId: entry.id,
      runId: args.runId,
      incidentId: args.incidentId,
      dispatch: {
        status: "active",
        linkedSessionId: launched.sessionId,
        attempt: (reconciled?.dispatch.attempt ?? 0) + 1,
        startedAt: now,
      },
    };
    await this.stateStore.put(entry.id, stateKey, item, { runId: args.runId });
    return { status: "started", item };
  }

  async getWorkflowActionItem(args: {
    workflowId: string;
    itemId: string;
    repoPath?: string | null;
    workspaceName?: string;
  }): Promise<WorkflowActionCenterItem | null> {
    const entry = this.resolveEntry(args);
    const item = workflowActionCenterItem(
      this.stateStore.get(entry.id, actionCenterStateKey(args.itemId)),
    );
    return item ? this.reconcileWorkflowActionItem(entry.id, item) : null;
  }

  async approveWorkflowNotification(
    args: WorkflowNotificationApprovalRequest,
  ): Promise<WorkflowActionDispatchResult> {
    const result = await this.dispatchWorkflowAction({
      workflowId: args.workflowId,
      itemId: `notification:${args.item.id}`,
      title: args.item.title,
      prompt: args.item.content.body,
      repoPath: args.repoPath,
      workspaceName: args.workspaceName,
    });
    const approved: WorkflowActionCenterItem = {
      ...result.item,
      itemApproval: {
        status: "approved",
        decidedAt: Date.now(),
        decidedBy: args.approvedBy,
      },
    };
    const entry = this.resolveEntry(args);
    await this.stateStore.put(entry.id, actionCenterStateKey(approved.id), approved);
    return { ...result, item: approved };
  }

  /** Test-only state seeding for exercising cleanup behavior through the public manager surface. */
  async _putStateForTests(workflowId: string, key: string, value: unknown): Promise<void> {
    await this.stateStore.put(workflowId, key, value);
  }

  private async reconcileWorkflowActionItem(
    workflowId: string,
    item: WorkflowActionCenterItem,
  ): Promise<WorkflowActionCenterItem> {
    const sessionId = item.dispatch.linkedSessionId;
    if (
      !sessionId ||
      !this.deps.getActionSessionState ||
      this.deps.getActionSessionState(sessionId) !== "idle" ||
      (item.dispatch.status !== "active" && item.dispatch.status !== "running")
    ) {
      return item;
    }
    const completed: WorkflowActionCenterItem = {
      ...item,
      dispatch: { ...item.dispatch, status: "completed", finishedAt: Date.now() },
    };
    await this.stateStore.put(workflowId, actionCenterStateKey(item.id), completed, {
      runId: item.runId,
    });
    return completed;
  }

  async saveArtifactFromSession(args: {
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
  }> {
    const runId = this.getRunIdForSession(args.sessionId);
    if (!runId) {
      throw new Error("No workflow run is associated with the calling session.");
    }
    const record = this.repository.loadRun(runId);
    if (!record) throw new Error(`Workflow run ${runId} not found.`);
    const engine = this.engines.get(runId);
    if (engine) {
      return engine.saveRunArtifact(args.key, args.content, { mime: args.mime });
    }
    const priorEvents = Array.from(readEventLines(this.repository.eventsPathFor(runId)));
    const nextSeq = priorEvents.reduce((max, event) => Math.max(max, event.seq + 1), 0);
    const eventLog = new EventLog(this.repository.eventsPathFor(runId), nextSeq);
    const stored = this.artifactStore.saveArtifact(runId, args.key, args.content, {
      mime: args.mime,
    });
    await eventLog.append({
      type: "artifact.saved",
      payload: {
        key: stored.ref.key,
        storageKey: stored.ref.storageKey,
        namespace: stored.ref.namespace,
        mime: stored.ref.mime,
        sizeBytes: stored.ref.sizeBytes,
        stepKey: stored.ref.stepKey,
      },
    });
    if (Object.keys(stored.scrubHits).length > 0) {
      await eventLog.append({
        type: "artifact.credential-redacted",
        payload: { key: stored.ref.key, patternHits: stored.scrubHits },
      });
    }
    return stored.ref;
  }

  /**
   * `workflowDescribe` — surface manifest + agentRequirements. Accepts
   * either a listed `workflowId` (optionally repo-scoped) or an on-disk
   * `sourceDir`.
   */
  async describeWorkflow(args: {
    workflowId?: string;
    sourceDir?: string;
    repoPath?: string | null;
    workspaceName?: string;
  }): Promise<WorkflowDescription> {
    if (!args.workflowId && !args.sourceDir) {
      throw new Error("describeWorkflow requires either workflowId or sourceDir");
    }
    if (args.workflowId) {
      const repoPath = this.resolveRepoPath(args);
      const entry = this.loader.getEntry({
        workflowId: args.workflowId,
        repoPath,
        workspaceName: args.workspaceName,
      });
      const compiledBytes = await this.compiledSourceForEntry(entry);
      const def = await loadDefinitionFromCompiled(compiledBytes, entry.id, entry.dir);
      const currentBindings = readBindingsFile(entry.dir);
      return {
        id: entry.id,
        displayName: entry.title,
        description: entry.description,
        version: entry.version,
        source: entry.source,
        dir: entry.dir,
        agentRequirements: (def.agentRequirements ?? []).map((r) => ({
          slot: r.slot,
          role: r.role,
          ...(r.defaultPersonality !== undefined
            ? { defaultPersonality: r.defaultPersonality }
            : {}),
          ...(r.defaultAgent !== undefined
            ? { defaultAgent: { agentMdPath: r.defaultAgent.agentMdPath } }
            : {}),
        })),
        currentBindings,
      };
    }
    // sourceDir path: read manifest + workflow.ts directly (must be
    // compiled or have a prebuilt dist; we delegate to esbuild via the
    // install pipeline's compile helper).
    const sourceDir = path.resolve(args.sourceDir!);
    const fsMod = await import("node:fs");
    const manifestPath = path.join(sourceDir, "manifest.json");
    if (!fsMod.existsSync(manifestPath)) {
      throw new Error(`manifest.json missing from ${sourceDir}`);
    }
    const manifestRawUnknown = JSON.parse(fsMod.readFileSync(manifestPath, "utf-8")) as unknown;
    if (typeof manifestRawUnknown !== "object" || manifestRawUnknown === null) {
      throw new Error(`manifest.json in ${sourceDir} is not an object`);
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- typeof guard above; we only read string fields below
    const manifestRaw = manifestRawUnknown as Record<string, unknown>;
    delete manifestRaw.source;
    const prebuilt = path.join(sourceDir, "dist", "workflow.js");
    let compiled: string;
    if (fsMod.existsSync(prebuilt)) {
      compiled = fsMod.readFileSync(prebuilt, "utf-8");
    } else {
      compiled = await compileWithEsbuild(path.join(sourceDir, "workflow.ts"));
    }
    const id = typeof manifestRaw.id === "string" ? manifestRaw.id : "(unknown)";
    const def = await loadDefinitionFromCompiled(compiled, id, sourceDir);
    return {
      id,
      displayName: (typeof manifestRaw.title === "string" ? manifestRaw.title : undefined) ?? id,
      description:
        typeof manifestRaw.description === "string" ? manifestRaw.description : undefined,
      version: typeof manifestRaw.version === "string" ? manifestRaw.version : "0.0.0",
      dir: sourceDir,
      agentRequirements: (def.agentRequirements ?? []).map((r) => ({
        slot: r.slot,
        role: r.role,
        ...(r.defaultPersonality !== undefined ? { defaultPersonality: r.defaultPersonality } : {}),
        ...(r.defaultAgent !== undefined
          ? { defaultAgent: { agentMdPath: r.defaultAgent.agentMdPath } }
          : {}),
      })),
    };
  }

  /** Direct accessor for repository — used by IPC handlers (UI). */
  listRuns(): RunIndexEntry[] {
    return this.repository.listRuns();
  }

  /** Read persisted events for a run, optionally from a given seq onward. */
  getEvents(args: { runId: string; fromSeq?: number }): WorkflowEvent[] {
    const eventsPath = this.repository.eventsPathFor(args.runId);
    const all = Array.from(readEventLines(eventsPath));
    if (args.fromSeq === undefined) return all;
    const cutoff = args.fromSeq;
    return all.filter((e) => e.seq >= cutoff);
  }

  /** Returns true if the bundled/installed workflow folder ships a renderer.tsx. */
  hasRenderer(workflowId: string, repoPath?: string | null): boolean {
    try {
      const entry = this.loader.getEntry({ workflowId, repoPath });
      return (
        fs.existsSync(path.join(entry.dir, "renderer.tsx")) ||
        fs.existsSync(path.join(entry.dir, "dist", "renderer.js"))
      );
    } catch {
      return false;
    }
  }

  getRunIdForSession(sessionId: string): string | undefined {
    return this.sessionRunIndex.get(sessionId);
  }

  getRunIdForHostSession(hostSessionId: string): string | undefined {
    const activeRunId = this.sessionRunIndex.get(hostSessionId);
    if (activeRunId) return activeRunId;

    if (!this.persistedHostSessionRunIndex) {
      this.persistedHostSessionRunIndex = new Map();
      for (const entry of this.repository.listRuns()) {
        const indexedHostSessionId = entry.hostSessionId;
        if (indexedHostSessionId) {
          this.persistedHostSessionRunIndex.set(indexedHostSessionId, entry.runId);
          continue;
        }
        const legacyHostSessionId = this.repository.loadRun(entry.runId)?.hostSessionId;
        if (legacyHostSessionId) {
          this.persistedHostSessionRunIndex.set(legacyHostSessionId, entry.runId);
        }
      }
    }
    return this.persistedHostSessionRunIndex.get(hostSessionId);
  }

  /**
   * Wire a renderer-facing event broadcaster. Each new engine's event log is
   * subscribed so persisted events fan out on `workflows:run-events:<runId>`,
   * and terminal-state transitions emit on `workflows:run-status:<runId>`.
   * V1 hotfix: per-event delivery (no batching) and no tick timer.
   */
  attachBroadcaster(broadcast: (channel: string, payload: unknown) => void): void {
    this.broadcast = broadcast;
  }

  // ── Internals ───────────────────────────────────────────────────────

  private assertBackendSupported(): void {
    const origin = this.deps.backendOrigin?.() ?? "copilot";
    if (origin !== "copilot") {
      throw new BackendUnsupportedError(
        origin,
        `Dynamic workflows require the Copilot backend. Current backend: "${origin}".`,
      );
    }
  }

  private resolveRepoPath(args: {
    repoPath?: string | null;
    workspaceName?: string;
  }): string | null {
    if (args.repoPath?.trim()) return path.resolve(args.repoPath.trim());
    if (args.workspaceName?.trim()) {
      const resolved = this.deps.workspaceResolver?.(args.workspaceName.trim());
      if (!resolved) throw new Error(`Workspace not found: ${args.workspaceName}`);
      return path.resolve(resolved);
    }
    return null;
  }

  private resolveEntry(args: {
    workflowId: string;
    repoPath?: string | null;
    workspaceName?: string;
  }): InstalledWorkflowEntry {
    const repoPath = this.resolveRepoPath(args);
    return this.loader.getEntry({
      workflowId: args.workflowId,
      repoPath,
      workspaceName: args.workspaceName,
    });
  }

  private listWorkspaceRepoWorkflows(): InstalledWorkflowEntry[] {
    const workspaces = this.deps.workspaceLister?.() ?? [];
    const seen = new Set<string>();
    const out: InstalledWorkflowEntry[] = [];
    for (const workspace of workspaces) {
      const repoPath = path.resolve(workspace.path);
      if (seen.has(repoPath)) continue;
      seen.add(repoPath);
      out.push(...this.loader.listRepoWorkflows(repoPath, workspace.name));
    }
    return out;
  }

  private async createAndStartRun(args: {
    runId: string;
    runFamilyId: string;
    parentRunId?: string;
    entry: InstalledWorkflowEntry;
    repoPath?: string | null;
    workspaceName?: string;
    input: unknown;
    initiatorSessionId?: string;
    permissionMode?: WorkflowSessionPermissionMode;
    triggeredBy: TriggeredBy;
    schedule?: WorkflowRunScheduleContext;
    scheduleKeyForCursor?: string;
    replayFromStepKey?: string;
    seedMemoFrom?: string;
  }): Promise<RunStartResult> {
    appendWorkflowDiagnostic({
      operation: "manager.create-run.start",
      runId: args.runId,
      workflowId: args.entry.id,
      runFamilyId: args.runFamilyId,
      details: {
        source: args.entry.source,
        triggeredBy: args.triggeredBy,
        hasRepoPath: !!args.repoPath,
        hasWorkspaceName: !!args.workspaceName,
        replayFromStepKey: args.replayFromStepKey,
      },
    });
    // 1. Validate input via the workflow's params schema (if any).
    let parsedInput: unknown = args.input ?? {};
    // The compiled workflow's paramsSchema is on the definition we'll load,
    // but we need the runId to copy the dist first. Two-step: hash + create
    // record, then load + validate.

    // 2. Pin the compiled JS into the run dir.
    const tmpRecord = await this.repository.createRun({
      runId: args.runId,
      workflowId: args.entry.id,
      workflowRepoPath: args.repoPath ?? undefined,
      workflowWorkspaceName: args.workspaceName,
      workflowVersion: args.entry.version,
      workflowDistHash: args.entry.distHash,
      runFamilyId: args.runFamilyId,
      parentRunId: args.parentRunId,
      inputSnapshot: parsedInput,
      triggeredBy: args.triggeredBy,
      schedule: args.schedule,
      initiatorSessionId: args.initiatorSessionId,
      hostSessionId: "", // overwritten after host session is created
      title: args.entry.title,
    });
    void tmpRecord;
    const compiledPath = this.repository.compiledPathFor(args.runId);
    let distHash: string;
    try {
      distHash = await this.loader.pinCompiledForRun(
        {
          workflowId: args.entry.id,
          repoPath: args.repoPath,
          workspaceName: args.workspaceName,
        },
        compiledPath,
      );
    } catch (err) {
      await this.markRunStartFailed(args.runId, tmpRecord.startedAt, err);
      throw err;
    }

    // 3. Load + validate input.
    const definition = this.loader.loadFromRunPin(compiledPath);
    if (definition.paramsSchema) {
      const parsed = definition.paramsSchema.safeParse(parsedInput);
      if (!parsed.success) {
        await this.repository.updateRun(args.runId, {
          status: "failed",
          endedAt: Date.now(),
          durationMs: 0,
          errorSummary: { message: `Invalid input: ${parsed.error.message}`, code: "BAD_INPUT" },
        });
        throw new Error(`Invalid input for workflow ${args.entry.id}: ${parsed.error.message}`);
      }
      parsedInput = parsed.data;
    }

    // 4. Create host session.
    const permissionMode: WorkflowSessionPermissionMode =
      args.permissionMode ??
      (args.entry.manifest.permissions.mode === "allow-all" ? "allow-all" : "default");
    const hostSessionId = await this.deps.hostSessionFactory({
      runId: args.runId,
      workflowId: args.entry.id,
      workflowTitle: args.entry.title,
      model: definition.defaultModel,
      reasoningEffort: definition.defaultReasoningEffort,
      permissionMode,
    });
    appendWorkflowDiagnostic({
      operation: "manager.host-session.created",
      runId: args.runId,
      workflowId: args.entry.id,
      runFamilyId: args.runFamilyId,
      hostSessionId,
    });

    // 5. Persist updated record with the resolved hashes + host session id.
    this.sessionRunIndex.set(hostSessionId, args.runId);
    const record = await this.repository
      .updateRun(args.runId, {
        workflowDistHash: distHash,
        hostSessionId,
        inputSnapshot: parsedInput,
      })
      .catch((error) => {
        this.sessionRunIndex.delete(hostSessionId);
        throw error;
      });
    this.persistedHostSessionRunIndex?.set(hostSessionId, args.runId);

    // 6. Pre-seed memo if retrying from a prior run.
    let memo: MemoStore | undefined;
    let priorFanOutItemKeys: Array<{ stepKey: string; itemKeys: ReadonlyArray<string> }> = [];
    const priorArtifacts: PriorArtifact[] = [];
    if (args.seedMemoFrom) {
      memo = new MemoStore();
      const priorEvents = Array.from(
        readEventLines(this.repository.eventsPathFor(args.seedMemoFrom)),
      );
      memo.hydrateFromEvents(priorEvents);
      if (args.replayFromStepKey) memo.invalidateFromStep(args.replayFromStepKey);
      priorFanOutItemKeys = priorEvents
        .filter((e) => e.type === "fanOut.started")
        .map((e) => {
          const payload = e.payload as { stepKey: string; itemKeys: string[] };
          return { stepKey: payload.stepKey, itemKeys: payload.itemKeys };
        });
      // Copy the prior run's artifact files into the new run so replayed steps'
      // artifacts resolve, and collect their `artifact.saved` payloads so the
      // engine re-emits them when those steps replay from memo.
      this.artifactStore.copyArtifacts(args.seedMemoFrom, args.runId);
      for (const e of priorEvents) {
        if (e.type === "artifact.saved") {
          priorArtifacts.push({
            key: e.payload.key,
            storageKey: e.payload.storageKey,
            namespace: e.payload.namespace,
            mime: e.payload.mime,
            sizeBytes: e.payload.sizeBytes,
            stepKey: e.payload.stepKey,
          });
        }
      }
    }

    // 7. Wire up event log + engine.
    const eventLog = new EventLog(this.repository.eventsPathFor(args.runId));
    const bindings = this.resolveBindingsForRun(args.entry, definition, args.repoPath ?? null);
    const externalGithubFolderPath = this.resolveExternalGithubFolderPath(definition, bindings);
    const engine = new WorkflowEngine({
      definition,
      record,
      repo: this.repository,
      artifactStore: this.artifactStore,
      stateStore: this.stateStore,
      pool: this.pool,
      spawnAdapter: this.deps.spawnAdapter,
      permissionMode,
      eventLog,
      memo,
      replayFromStepKey: args.replayFromStepKey,
      shellRunner: this.deps.shellRunner,
      workflowDir: args.entry.dir,
      bindings,
      repoPath: args.repoPath ?? undefined,
      externalGithubFolderPath,
      externalGithubFolderPathDefault: definition.externalContext?.applyAsDefault === true,
      notifyParent: (message, opts) => this.notifyInitiator(record, message, opts),
      advanceScheduleCursor: args.scheduleKeyForCursor
        ? (cursor) => this.advanceScheduleCursor(args.scheduleKeyForCursor!, args.runId, cursor)
        : undefined,
    });
    if (priorFanOutItemKeys.length > 0) {
      engine.hydratePriorFanOutItemKeys(priorFanOutItemKeys);
    }
    if (priorArtifacts.length > 0) {
      engine.hydratePriorArtifacts(priorArtifacts);
    }
    this.engines.set(args.runId, engine);
    beginWorkflowDiagnosticRun({
      runId: args.runId,
      workflowId: args.entry.id,
      runFamilyId: args.runFamilyId,
      hostSessionId: record.hostSessionId,
    });
    this.wireRunBroadcast(args.runId, eventLog);
    const stopTick = this.startRunTick(args.runId, record.startedAt);

    // 8. Kick off — caller does NOT wait for completion.
    appendWorkflowDiagnostic({
      operation: "manager.engine-run.invoke",
      runId: args.runId,
      workflowId: args.entry.id,
      runFamilyId: args.runFamilyId,
      hostSessionId: record.hostSessionId,
    });
    void engine
      .run()
      .then(() => {
        appendWorkflowDiagnostic({
          operation: "manager.engine-run.resolved",
          runId: args.runId,
          workflowId: args.entry.id,
          runFamilyId: args.runFamilyId,
          hostSessionId: record.hostSessionId,
          status: "succeeded",
        });
      })
      .catch((err) => {
        appendWorkflowDiagnostic({
          operation: "manager.engine-run.rejected",
          runId: args.runId,
          workflowId: args.entry.id,
          runFamilyId: args.runFamilyId,
          hostSessionId: record.hostSessionId,
          status: "failed",
          error: err,
        });
        log.warn(`Workflow run ${args.runId} terminated with error:`, err);
      })
      .finally(async () => {
        appendWorkflowDiagnostic({
          operation: "manager.engine-run.finally.start",
          runId: args.runId,
          workflowId: args.entry.id,
          runFamilyId: args.runFamilyId,
          hostSessionId: record.hostSessionId,
        });
        stopTick();
        await this.disposeHostSession(args.runId, record.hostSessionId);
        const latestRecord = this.repository.loadRun(args.runId);
        endWorkflowDiagnosticRun({
          runId: args.runId,
          status: latestRecord?.status ?? "unknown",
        });
        appendWorkflowDiagnostic({
          operation: "manager.engine-run.finally.end",
          runId: args.runId,
          workflowId: args.entry.id,
          runFamilyId: args.runFamilyId,
          hostSessionId: record.hostSessionId,
          status: latestRecord?.status,
        });
        this.cleanupRunRuntimeState(args.runId);
        // Retain the engine briefly for UI snapshot pull; in production
        // this could be a TTL eviction. V1 just drops on terminal.
        setTimeout(() => this.engines.delete(args.runId), 30_000);
      });

    return { runId: args.runId, runFamilyId: args.runFamilyId };
  }

  private async disposeHostSession(runId: string, hostSessionId: string): Promise<void> {
    if (!this.deps.hostSessionDisposer) return;
    try {
      appendWorkflowDiagnostic({
        operation: "manager.host-session.dispose.start",
        runId,
        hostSessionId,
      });
      await this.deps.hostSessionDisposer(hostSessionId);
      appendWorkflowDiagnostic({
        operation: "manager.host-session.dispose.succeeded",
        runId,
        hostSessionId,
      });
    } catch (err) {
      appendWorkflowDiagnostic({
        operation: "manager.host-session.dispose.failed",
        runId,
        hostSessionId,
        error: err,
      });
      log.warn(`Failed to dispose workflow host session for run ${runId}:`, err);
    }
  }

  private resolveBindingsForRun(
    entry: InstalledWorkflowEntry,
    definition: {
      readonly agentRequirements?: ReadonlyArray<{
        readonly slot: string;
        readonly role: string;
        readonly defaultPersonality?: string;
        readonly defaultAgent?: { readonly agentMdPath: string };
      }>;
      readonly externalContext?: { readonly githubFolderPath: string };
    },
    repoPath: string | null,
  ): BindingsFile {
    const bindings = readBindingsFile(entry.dir);
    const hasPersistedBindings = Object.keys(bindings.bindings).length > 0;
    if (entry.source !== "repo-local" || hasPersistedBindings) return bindings;

    const requirements = definition.agentRequirements ?? [];
    if (requirements.length === 0) return bindings;

    const targetRepoPath = repoPath ?? entry.repoPath ?? null;
    const resolved = resolveBindings({
      requirements,
      explicitBindings: undefined,
      targetRepoPath,
      externalContextPath: this.resolveExternalGithubFolderPath(definition, bindings) ?? null,
      workflowSrcDir: entry.dir,
      createAgentBodies: {},
    });
    log.info(
      `Auto-derived ${resolved.autoDerivedSlots.length} binding(s) for repo-local workflow ${entry.id}`,
    );
    return resolved.bindingsFile;
  }

  private resolveExternalGithubFolderPath(
    definition: { readonly externalContext?: { readonly githubFolderPath: string } },
    bindings: BindingsFile,
  ): string | undefined {
    const candidate = bindings.externalContextPath ?? definition.externalContext?.githubFolderPath;
    if (!candidate) return undefined;
    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Workflow externalContext.githubFolderPath is not accessible: ${resolved}`);
    }
    if (path.basename(resolved).toLowerCase() !== ".github") {
      throw new Error(
        `Workflow externalContext.githubFolderPath must point at a .github folder: ${resolved}`,
      );
    }
    return resolved;
  }

  private async notifyInitiator(
    record: RunRecord,
    message: string,
    opts?: { waitForResponse?: boolean; timeoutMs?: number },
  ): Promise<{
    delivered: boolean;
    status: "sent" | "responded" | "unavailable";
    response?: string;
  }> {
    if (!record.initiatorSessionId || !this.deps.sendWorkflowParentMessage) {
      return { delivered: false, status: "unavailable" };
    }
    return this.deps.sendWorkflowParentMessage({
      sessionId: record.initiatorSessionId,
      message: `Workflow ${record.workflowId} (${record.runId.slice(0, 8)}):\n\n${message}`,
      waitForResponse: opts?.waitForResponse,
      timeoutMs: opts?.timeoutMs,
    });
  }

  private advanceScheduleCursor(
    scheduleKey: string,
    runId: string,
    cursor: WorkflowScheduleCursor,
  ): { previous?: WorkflowScheduleCursor; next: WorkflowScheduleCursor } {
    return this.scheduler.advanceIncrementalCursor(scheduleKey, {
      ...cursor,
      lastRunId: cursor.lastRunId ?? runId,
    });
  }

  /** Test-only: synchronous accessor for the in-memory engine map. */
  _getEngine(runId: string): WorkflowEngine | undefined {
    return this.engines.get(runId);
  }

  /** Test-only: drive the scheduled-run path without waiting for the timer. */
  _runScheduledWorkflowForTests(
    record: WorkflowScheduleRecord,
    trigger: WorkflowScheduleTrigger,
  ): Promise<RunStartResult> {
    return this.runScheduledWorkflow(record, trigger);
  }

  /** Test-only: inspect bounded runtime state without exposing internals to production callers. */
  _getRuntimeDebugState(): {
    engineCount: number;
    runEventSubscriptionCount: number;
    sessionRunIndexSize: number;
  } {
    return {
      engineCount: this.engines.size,
      runEventSubscriptionCount: this.runEventUnsubscribers.size,
      sessionRunIndexSize: this.sessionRunIndex.size,
    };
  }

  private async markRunStartFailed(runId: string, startedAt: number, err: unknown): Promise<void> {
    try {
      await this.repository.updateRun(runId, {
        status: "failed",
        endedAt: Date.now(),
        durationMs: Math.max(0, Date.now() - startedAt),
        errorSummary: {
          message: err instanceof Error ? err.message : String(err),
          code: "START_FAILED",
        },
      });
    } catch (updateErr) {
      log.warn(`Failed to mark workflow run ${runId} start failure:`, updateErr);
    }
  }

  /** Per-run subscription that fans events out on the renderer-facing IPC channels. */
  private wireRunBroadcast(runId: string, eventLog: EventLog): void {
    const send = this.broadcast;
    if (!send) return;
    this.runEventUnsubscribers.get(runId)?.();
    const eventChannel = `workflows:run-events:${runId}`;
    const statusChannel = `workflows:run-status:${runId}`;
    const unsubscribe = eventLog.subscribe((event) => {
      try {
        send(eventChannel, { runId, batch: [event] });
        if (event.type === "agent.spawned") {
          this.sessionRunIndex.set(event.payload.sessionId, runId);
        }
        const status = terminalStatusFromEvent(event);
        if (status !== null) {
          const error = extractTerminalError(event);
          const payload: WorkflowRunStatusEvent = {
            runId,
            status,
            finishedAt: event.ts,
            ...(error !== null ? { error } : {}),
          };
          send(statusChannel, payload);
        }
      } catch (err) {
        log.warn(`Run-event broadcast failed for ${runId}:`, err);
      }
    });
    this.runEventUnsubscribers.set(runId, unsubscribe);
  }

  private cleanupRunRuntimeState(runId: string): void {
    const unsubscribe = this.runEventUnsubscribers.get(runId);
    if (unsubscribe) {
      unsubscribe();
      this.runEventUnsubscribers.delete(runId);
    }
    for (const [sessionId, mappedRunId] of this.sessionRunIndex) {
      if (mappedRunId === runId) this.sessionRunIndex.delete(sessionId);
    }
  }

  private startRunTick(runId: string, startedAt: number): () => void {
    const send = this.broadcast;
    if (!send) return () => {};
    const tickChannel = `workflows:run-tick:${runId}`;
    const emit = () => {
      const metrics = this.pool.metrics(runId);
      send(tickChannel, {
        runId,
        activeSubagents: metrics.runUsed,
        queued: metrics.queueLength,
        progressPct: 0,
        elapsedMs: Math.max(0, Date.now() - startedAt),
      });
    };
    const timer = setInterval(emit, 1_000);
    emit();
    return () => clearInterval(timer);
  }

  private listAllEntries(): InstalledWorkflowEntry[] {
    return [...this.loader.listInstalled(), ...this.listWorkspaceRepoWorkflows()];
  }

  private hasActiveRunForKey(key: string): boolean {
    return this.repository.listRuns().some((run) => {
      if (run.status !== "pending" && run.status !== "running") return false;
      return this.runEntryKey(run) === key;
    });
  }

  private async runScheduledWorkflow(
    record: WorkflowScheduleRecord,
    trigger: WorkflowScheduleTrigger,
  ): Promise<RunStartResult> {
    const entry = this.loader.getEntry({
      workflowId: record.workflowId,
      repoPath: record.repoPath,
      workspaceName: record.workspaceName,
    });
    const runId = randomUUID();
    return this.createAndStartRun({
      runId,
      runFamilyId: runId,
      parentRunId: undefined,
      entry,
      repoPath: record.repoPath,
      workspaceName: record.workspaceName,
      input: record.input,
      triggeredBy: "schedule",
      schedule: {
        ...workflowScheduleRunContext(record, trigger),
        incremental: {
          previous: record.incremental,
          windowStartAt: record.incremental?.coveredThrough ?? trigger.occurrenceAt,
          windowEndAt: trigger.checkedAt,
        },
      },
      scheduleKeyForCursor: record.key,
    });
  }

  private runEntryKey(run: RunIndexEntry): string {
    return workflowEntryKey({
      workflowId: run.workflowId,
      source: run.workflowRepoPath ? "repo-local" : "user-local",
      repoPath: run.workflowRepoPath,
    });
  }

  private lastRunForEntry(
    entry: InstalledWorkflowEntry,
    runs: readonly RunIndexEntry[],
  ): InstalledWorkflowSummary["lastRun"] {
    const last = runs.find((run) => this.runMatchesEntry(run, entry));
    if (!last) return undefined;
    return {
      runId: last.runId,
      status: last.status,
      finishedAt: last.endedAt ?? undefined,
    };
  }

  private runMatchesEntry(run: RunIndexEntry, entry: InstalledWorkflowEntry): boolean {
    if (run.workflowId !== entry.id) return false;
    if (entry.repoPath)
      return path.resolve(run.workflowRepoPath ?? "") === path.resolve(entry.repoPath);
    return !run.workflowRepoPath;
  }

  private runMatchesWorkflow(
    run: RunIndexEntry,
    workflowId: string,
    repoPath?: string | null,
    workspaceName?: string,
  ): boolean {
    if (run.workflowId !== workflowId) return false;
    if (repoPath) return path.resolve(run.workflowRepoPath ?? "") === path.resolve(repoPath);
    if (workspaceName) return run.workflowWorkspaceName === workspaceName;
    return !run.workflowRepoPath;
  }

  // Cache derived input schemas per workflow directory, keyed by the source/dist
  // file mtime. listWorkflows() runs this for EVERY entry on EVERY call, and
  // repo-local workflows (no prebuilt dist/workflow.js) get esbuild-compiled AND
  // executed each time. When the Workflows UI polls the list this became hundreds
  // of compiles, pegging the main process and starving the renderer — the window
  // paints but its content stays blank for minutes. Caching makes repeats free;
  // an mtime change (install/edit) invalidates the entry so updates still apply.
  private readonly inputSchemaCache = new Map<
    string,
    { mtimeMs: number; schema: WorkflowJSONSchema | undefined }
  >();

  private inputSchemaSourceMtimeMs(entry: InstalledWorkflowEntry): number {
    try {
      const distPath = path.join(entry.dir, "dist", "workflow.js");
      const srcPath = path.join(entry.dir, "workflow.ts");
      const statPath = fs.existsSync(distPath) ? distPath : srcPath;
      return fs.existsSync(statPath) ? fs.statSync(statPath).mtimeMs : 0;
    } catch {
      return 0;
    }
  }

  private async inputSchemaForEntry(
    entry: InstalledWorkflowEntry,
  ): Promise<WorkflowJSONSchema | undefined> {
    const mtimeMs = this.inputSchemaSourceMtimeMs(entry);
    const cached = this.inputSchemaCache.get(entry.dir);
    if (cached && cached.mtimeMs === mtimeMs) return cached.schema;

    let schema: WorkflowJSONSchema | undefined;
    try {
      const compiled = await this.compiledSourceForEntry(entry);
      const definition = await loadDefinitionFromCompiled(compiled, entry.id, entry.dir);
      if (definition.paramsSchema) {
        const zod = await import("zod");
        schema = workflowJsonSchemaFromUnknown(zod.z.toJSONSchema(definition.paramsSchema));
      }
    } catch (err) {
      log.warn(`Failed to derive input schema for workflow ${entry.id}:`, err);
      schema = undefined;
    }
    // Cache successes AND failures so a workflow that can't introspect (e.g. a
    // repo-local one missing its prompt assets) isn't recompiled on every poll.
    this.inputSchemaCache.set(entry.dir, { mtimeMs, schema });
    return schema;
  }

  private async compiledSourceForEntry(entry: InstalledWorkflowEntry): Promise<string> {
    const compiledPath = path.join(entry.dir, "dist", "workflow.js");
    if (fs.existsSync(compiledPath)) {
      return fs.readFileSync(compiledPath, "utf-8");
    }
    const sourcePath = path.join(entry.dir, "workflow.ts");
    if (entry.source === "repo-local" && fs.existsSync(sourcePath)) {
      return compileWithEsbuild(sourcePath);
    }
    throw new WorkflowInstallError(
      "MISSING_WORKFLOW_TS",
      entry.source === "repo-local"
        ? `Workflow '${entry.id}' has neither dist/workflow.js nor workflow.ts at ${entry.dir}.`
        : `Workflow ${entry.id} has no dist/workflow.js — build or import it through the workflow authoring UI/CLI.`,
    );
  }

  /** Test-only: wait for a run to terminate. */
  async _waitForRunTermination(runId: string, timeoutMs = 30_000): Promise<RunRecord> {
    const start = Date.now();
    while (true) {
      const record = this.repository.loadRun(runId);
      if (record && record.status !== "running" && record.status !== "pending") return record;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Run ${runId} did not terminate within ${timeoutMs}ms`);
      }
      // eslint-disable-next-line no-await-in-loop -- test polling loop; intentional
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

function actionCenterStateKey(itemId: string): string {
  const normalized = itemId.trim();
  if (!normalized) throw new Error("Workflow action item id must be non-empty.");
  return `system/action-center/${normalized}`;
}

function workflowActionCenterItem(value: unknown): WorkflowActionCenterItem | undefined {
  const record = recordFromUnknown(value);
  if (!record) return undefined;
  const dispatch = recordFromUnknown(record.dispatch);
  const status = actionDispatchStatus(dispatch?.status);
  if (
    typeof record.id !== "string" ||
    typeof record.title !== "string" ||
    typeof record.summary !== "string" ||
    typeof record.workflowId !== "string" ||
    !dispatch ||
    !status ||
    typeof dispatch.attempt !== "number"
  ) {
    return undefined;
  }
  const approval = recordFromUnknown(record.itemApproval);
  const approvalStatus = approval?.status;
  return {
    id: record.id,
    title: record.title,
    summary: record.summary,
    workflowId: record.workflowId,
    ...(typeof record.runId === "string" ? { runId: record.runId } : {}),
    ...(typeof record.incidentId === "string" ? { incidentId: record.incidentId } : {}),
    dispatch: {
      status,
      attempt: dispatch.attempt,
      ...(typeof dispatch.linkedSessionId === "string"
        ? { linkedSessionId: dispatch.linkedSessionId }
        : {}),
      ...(typeof dispatch.startedAt === "number" ? { startedAt: dispatch.startedAt } : {}),
      ...(typeof dispatch.finishedAt === "number" ? { finishedAt: dispatch.finishedAt } : {}),
      ...(typeof dispatch.lastError === "string" ? { lastError: dispatch.lastError } : {}),
    },
    ...(approval &&
    (approvalStatus === "pending" || approvalStatus === "approved" || approvalStatus === "rejected")
      ? {
          itemApproval: {
            status: approvalStatus,
            ...(typeof approval.decidedAt === "number" ? { decidedAt: approval.decidedAt } : {}),
            ...(typeof approval.decidedBy === "string" ? { decidedBy: approval.decidedBy } : {}),
          },
        }
      : {}),
  };
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function actionDispatchStatus(
  value: unknown,
): WorkflowActionCenterItem["dispatch"]["status"] | undefined {
  return value === "proposed" ||
    value === "pending" ||
    value === "running" ||
    value === "active" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
    ? value
    : undefined;
}

function workflowJsonSchemaFromUnknown(value: unknown): WorkflowJSONSchema | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const schema: WorkflowJSONSchema = {};
  for (const [key, entry] of Object.entries(value)) {
    schema[key] = entry;
  }
  return schema;
}

function terminalStatusFromEvent(event: WorkflowEvent): WorkflowRunStatus | null {
  switch (event.type) {
    case "run.completed":
      return "succeeded";
    case "run.failed":
      return "failed";
    case "run.cancelled":
      return "cancelled";
    case "run.crashed":
      return "crashed";
    default:
      return null;
  }
}

function extractTerminalError(event: WorkflowEvent): RunError | null {
  if (event.type !== "run.failed" && event.type !== "run.crashed") return null;
  // SerializedError → RunError shape (message + optional errorClass).
  const payload = event.payload as { error: { name?: string; message: string } };
  return {
    message: payload.error.message,
    ...(payload.error.name !== undefined ? { errorClass: payload.error.name } : {}),
  };
}
