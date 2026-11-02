// electron/workflows/workflow-engine.ts
//
// `WorkflowEngine` — one instance per active run. Owns the per-run
// `MemoStore`, `EventLog`, `AbortController`, async-context `stepCtx`,
// `callsiteCounter`, in-flight `SpawnedHandle` set, and the run-scoped
// compensator stack. Implements the `WorkflowContext` API by
// constructing a concrete `ctx` object and passing it to
// `definition.run(ctx)`.
//
// Concurrency model: Node single-threaded; mutations between awaits are
// atomic. `EventLog.append` serialises persistence per-instance.
//
// Step key derivation (r1-fixes A8, c-runtime §5.1):
//   stepKey := <parentStepKey>/<callsiteIndex>:<label>
// The label participates only as the trailing segment; two
// `ctx.step("compute", …)` calls in the same parent get distinct keys
// via the callsite counter.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, randomInt } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type {
  AgentHandle,
  AgentMessage,
  ArtifactRef,
  FanOutOptions,
  FanOutResult,
  RunOptions,
  SpawnOptions,
  WorkflowActionCenterItem as SdkWorkflowActionCenterItem,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowStageContext as SdkWorkflowStageContext,
  WorkflowLogger,
} from "@marshal/workflow-sdk";
import { CancelledError, StepFailedError } from "@marshal/workflow-sdk";
import type { z } from "zod";

import { createLogger } from "../../common/marshal-logger";
import type {
  ArtifactRefSummary,
  BindingsFile,
  RunRecord,
  WorkflowActionCenterSnapshotItem,
  WorkflowInvestigationCompletionState,
  WorkflowInvestigationCompletionUpdate,
  WorkflowScheduleCursor,
} from "../../common/workflows-contract";
import {
  EMPTY_BINDINGS,
  isValidInvestigationCompletionTransition,
  serializeError,
} from "../../common/workflows-contract";
import { appendWorkflowDiagnostic, type WorkflowDiagnosticHandle } from "./diagnostics";
import { EventLog } from "./event-log";
import { runFanOut } from "./fan-out";
import { MemoStore } from "./memo-store";
import type { ArtifactStore, WorkflowRunRepository } from "./repository";
import { sanitizeArtifactSegment } from "./sanitize-key";
import { resolveSlot, SlotResolutionError } from "./slot-resolver";
import type { SpawnAdapter, SpawnedHandle } from "./spawn-adapter";
import type { StoreWriteResult, WorkflowStateStore } from "./state-store";
import type { SubagentPool, ReleaseFn } from "./subagent-pool";

const log = createLogger("WorkflowEngine");

export type WorkflowRunStatus = RunRecord["status"];

export interface EngineDeps {
  readonly definition: WorkflowDefinition;
  readonly record: RunRecord;
  readonly repo: WorkflowRunRepository;
  readonly artifactStore: ArtifactStore;
  readonly stateStore: WorkflowStateStore;
  readonly pool: SubagentPool;
  readonly spawnAdapter: SpawnAdapter;
  /** Default permission mode for workflow-owned subagents, derived from manifest permissions.mode. */
  readonly permissionMode?: SpawnOptions["permissionMode"];
  readonly eventLog: EventLog;
  /** Pre-hydrated memo (for resume / retry-from-step paths). */
  readonly memo?: MemoStore;
  /** If true, the run is resuming from a crash; emit `resumeFromCrash`. */
  readonly resumeFromCrash?: boolean;
  /** When set, only steps with this key (or descendants) are eligible to
   *  re-run; everything before it returns from memo. Used by
   *  `retryFromStep`. */
  readonly replayFromStepKey?: string;
  /** Optional shell runner — defaults to a thin child_process exec
   *  wrapper. Tests may stub. */
  readonly shellRunner?: (
    command: string,
    opts?: { cwd?: string; timeoutMs?: number },
  ) => Promise<string>;
  /**
   * Absolute path of the workflow's install directory. Used by the slot
   * resolver to load shipped agent.md files. Defaults to the run dir
   * (which has no agent files) — pass the real install dir from
   * WorkflowRunManager so `shipped-agent` bindings resolve correctly.
   */
  readonly workflowDir?: string;
  /**
   * The run's binding map (loaded once at run start from
   * `<workflowDir>/bindings.json`). Defaults to `EMPTY_BINDINGS` for
   * legacy installs that pre-date FEAT-SLOTS.
   */
  readonly bindings?: BindingsFile;
  /** Repo root for repo-local workflows. Used as the default spawn repoPath. */
  readonly repoPath?: string;
  readonly externalGithubFolderPath?: string;
  readonly externalGithubFolderPathDefault?: boolean;
  readonly notifyParent?: (
    message: string,
    opts?: { waitForResponse?: boolean; timeoutMs?: number },
  ) => Promise<{
    delivered: boolean;
    status: "sent" | "responded" | "unavailable";
    response?: string;
  }>;
  readonly advanceScheduleCursor?: (cursor: WorkflowScheduleCursor) =>
    | Promise<{ previous?: WorkflowScheduleCursor; next: WorkflowScheduleCursor }>
    | {
        previous?: WorkflowScheduleCursor;
        next: WorkflowScheduleCursor;
      };
}

interface PendingCompensator {
  /** Step key the compensator was registered in (for diagnostics). */
  readonly stepKey: string;
  readonly fn: () => Promise<void>;
}

/**
 * Ambient per-async-context state carried through `stepCtx` (AsyncLocalStorage).
 * Flows automatically across `await`, so a step body — and any agent it spawns —
 * reads ITS OWN step key + fanOut item even while sibling fanOut units run
 * concurrently. Replaces the former shared `stepStack`/`currentFanOutItem`,
 * which interleaving units corrupted (nesting every unit's key inside the last).
 */
interface StepContext {
  /** Current step key ("" only at the root, where there is no store). */
  readonly stepKey: string;
  /** Set while executing inside a fanOut unit; inherited by nested steps. */
  readonly fanOutItem?: { stepKey: string; itemKey: string };
}

interface InFlightSpawn {
  readonly handleId: string;
  readonly handle: SpawnedHandle;
  release?: ReleaseFn;
  /**
   * For slot-bound spawns, the resolved preamble to prepend to the FIRST
   * user message sent via `ctx.send`. Consumed (set to undefined) after
   * the first send. `ctx.run` consumes it inline before calling
   * `spawnAdapter.spawnAndRun`.
   */
  pendingPreamble?: string;
}

/**
 * A prior-run artifact replayed into a retried run. On retry-from-step the
 * preserved steps replay from memo (their bodies never re-run, so they never
 * re-`saveArtifact`); the engine re-emits these so the run's artifact list +
 * preview surface everything the preserved steps produced. The matching files
 * are copied into the new run dir by `ArtifactStore.copyArtifacts`.
 */
export interface PriorArtifact {
  readonly key: string;
  readonly storageKey: string;
  readonly namespace: "run" | "fanout";
  readonly mime: string;
  readonly sizeBytes: number;
  readonly stepKey?: string;
}

export class WorkflowEngine {
  readonly runId: string;
  readonly hostSessionId: string;
  private readonly memo: MemoStore;
  private readonly abort = new AbortController();
  /**
   * Per-async-context step state. Each `runStep` runs its body inside
   * `stepCtx.run(...)`, so concurrent fanOut units each see THEIR OWN current
   * step key + fanOut item rather than racing on a shared stack/field. This is
   * what keeps `agent.spawned.stepKey/fanOutUnitKey` correctly attributed when
   * units run in parallel (the run-exec UI maps agents↔units off those).
   */
  private readonly stepCtx = new AsyncLocalStorage<StepContext>();
  /**
   * Last step key whose body threw while propagating out (set in `runStep`'s
   * catch). Used only for the run-level `failedStepKey` diagnostic, since the
   * async-context store has already unwound by the time `run()`'s catch runs.
   */
  private lastFailedStepKey: string | undefined;
  private readonly callsiteCounter = new Map<string, number>();
  /** Map of stepKey → memoised `now/uuid/random/idempotencyKey` outputs. */
  private readonly deterministicCache = new Map<string, Record<string, unknown>>();
  private currentFanOutScope: string | undefined;
  private readonly inFlight = new Map<string, InFlightSpawn>();
  private readonly compensators: PendingCompensator[] = [];
  private readonly investigationCompletionStates = new Map<
    string,
    WorkflowInvestigationCompletionState
  >();
  /** Pre-hydrated map of fanOut stepKey → itemKeys recorded by the prior run. */
  private readonly priorFanOutItemKeys = new Map<string, ReadonlyArray<string>>();
  /** Prior-run artifacts to re-surface when their producing step replays from
   *  memo (retry-from-step); deduped on emit via {@link emittedReplayArtifacts}. */
  private priorArtifacts: ReadonlyArray<PriorArtifact> = [];
  private readonly emittedReplayArtifacts = new Set<string>();
  private settled = false;

  constructor(private readonly deps: EngineDeps) {
    this.runId = deps.record.runId;
    this.hostSessionId = deps.record.hostSessionId;
    this.memo = deps.memo ?? new MemoStore();
  }

  /** AbortSignal exposed for tests / engine callers. */
  get signal(): AbortSignal {
    return this.abort.signal;
  }

  async saveRunArtifact(
    key: string,
    content: Uint8Array | string,
    opts: { mime?: string; useCurrentScope?: boolean } = {},
  ): Promise<ArtifactRefSummary> {
    this.checkAborted();
    const stored = this.deps.artifactStore.saveArtifact(this.runId, key, content, {
      mime: opts.mime,
      stepKey: opts.useCurrentScope ? this.currentStepKey() : undefined,
      fanOutScope: opts.useCurrentScope ? this.currentFanOutItem : undefined,
    });
    await this.deps.eventLog.append({
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
      await this.deps.eventLog.append({
        type: "artifact.credential-redacted",
        payload: { key: stored.ref.key, patternHits: stored.scrubHits },
      });
    }
    return stored.ref;
  }

  /** Cooperatively cancel the run. */
  async cancel(reason = "cancelled"): Promise<void> {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    this.deps.pool.cancelRun(this.runId);
    // Best-effort: cancel every in-flight subagent. Sequential cancel keeps
    // the loop bounded (cancellations are usually <100ms each).
    for (const inflight of this.inFlight.values()) {
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential cancel is fine; bounded by in-flight count
        await this.deps.spawnAdapter.cancel(inflight.handle);
      } catch {
        /* best-effort */
      }
      if (inflight.release) {
        try {
          inflight.release();
        } catch {
          /* best-effort */
        }
      }
      // eslint-disable-next-line no-await-in-loop -- sequential dispose is fine; bounded by in-flight count
      await this.disposeSpawnedHandle(inflight);
    }
    log.info(`Workflow run ${this.runId} cancellation requested: ${reason}`);
  }

  /**
   * Execute `definition.run(ctx)` once and persist terminal events.
   * Returns the workflow's result (or rejects on failure).
   */
  async run(): Promise<unknown> {
    const startedAt = Date.now();
    this.trace("engine.run.start", {
      resumeFromCrash: this.deps.resumeFromCrash === true,
      replayFromStepKey: this.deps.replayFromStepKey,
    });
    await this.deps.eventLog.append({
      type: "run.started",
      payload: {
        workflowId: this.deps.definition.id,
        workflowVersion: "1.0.0", // version is captured in run.json; event echoes runtime placeholder
        workflowDistHash: this.deps.record.workflowDistHash,
        runFamilyId: this.deps.record.runFamilyId,
        parentRunId: this.deps.record.parentRunId,
        input: this.deps.record.inputSnapshot,
        schedule: this.deps.record.schedule,
        startedAt,
        resumeFromCrash: this.deps.resumeFromCrash,
        replayFromStepKey: this.deps.replayFromStepKey,
      },
    });
    await this.deps.repo.updateRun(this.runId, { status: "running" });

    const ctx = this.buildContext();
    try {
      const result = await this.deps.definition.run(ctx);
      const durationMs = Date.now() - startedAt;
      this.trace("engine.run.succeeded", { durationMs });
      await this.deps.eventLog.append({
        type: "run.completed",
        payload: { result, durationMs },
      });
      await this.deps.repo.updateRun(this.runId, {
        status: "succeeded",
        endedAt: Date.now(),
        durationMs,
        nextEventSeq: this.deps.eventLog.getNextSeq(),
      });
      this.settled = true;
      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      if (err instanceof CancelledError || this.abort.signal.aborted) {
        this.traceError("engine.run.cancelled", err, { durationMs });
        await this.deps.eventLog.append({
          type: "run.cancelled",
          payload: {
            reason: err instanceof CancelledError ? err.message : "cancelled",
            durationMs,
          },
        });
        await this.deps.repo.updateRun(this.runId, {
          status: "cancelled",
          endedAt: Date.now(),
          durationMs,
          nextEventSeq: this.deps.eventLog.getNextSeq(),
        });
      } else {
        const failedStepKey = this.lastFailedStepKey;
        this.traceError("engine.run.failed", err, { durationMs, failedStepKey });
        await this.deps.eventLog.append({
          type: "run.failed",
          payload: { error: serializeError(err), failedStepKey, durationMs },
        });
        await this.deps.repo.updateRun(this.runId, {
          status: "failed",
          endedAt: Date.now(),
          durationMs,
          errorSummary: {
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            stepKey: failedStepKey,
          },
          nextEventSeq: this.deps.eventLog.getNextSeq(),
        });
      }
      // Run compensators in LIFO order (r1-fixes "compensator scope").
      await this.drainCompensators();
      this.settled = true;
      throw err;
    } finally {
      this.trace("engine.run.cleanup.start");
      await this.cleanupInFlightHandles();
      this.deps.pool.releaseRun(this.runId);
      this.trace("engine.run.cleanup.end");
    }
  }

  /** Top-level snapshot for `workflowGetRun`. */
  isSettled(): boolean {
    return this.settled;
  }

  // ── Context construction ─────────────────────────────────────────────

  private buildContext(): WorkflowContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- captured by ctx closures so methods reach the engine
    const engine = this;
    const ctxLogger: WorkflowLogger = {
      debug: (m, p) => log.info(`[wf:${engine.runId}] ${m}`, p),
      info: (m, p) => log.info(`[wf:${engine.runId}] ${m}`, p),
      warn: (m, p) => log.warn(`[wf:${engine.runId}] ${m}`, p),
      error: (m, p) => log.error(`[wf:${engine.runId}] ${m}`, p),
    };
    const ctx: WorkflowContext = {
      runId: engine.runId,
      runFamilyId: engine.deps.record.runFamilyId,
      workflowId: engine.deps.definition.id,
      input: engine.deps.record.inputSnapshot,
      externalContext: engine.deps.externalGithubFolderPath
        ? { githubFolderPath: engine.deps.externalGithubFolderPath }
        : undefined,
      repoPath: engine.deps.repoPath,
      schedule: engine.deps.record.schedule,
      store: {
        get: async <T = unknown>(key: string, schema?: z.ZodType<T>) => {
          const value = engine.deps.stateStore.get<T>(engine.deps.definition.id, key, schema);
          await engine.deps.eventLog.append({
            type: "state.read",
            payload: { key, found: value !== undefined, stepKey: engine.currentStepKey() },
          });
          return value;
        },
        getEntry: async <T = unknown>(key: string, schema?: z.ZodType<T>) => {
          const entry = engine.deps.stateStore.getEntry<T>(engine.deps.definition.id, key, schema);
          await engine.deps.eventLog.append({
            type: "state.read",
            payload: { key, found: entry !== undefined, stepKey: engine.currentStepKey() },
          });
          return entry;
        },
        put: async (key, value, opts) => {
          await engine.runStep("state.put", async () => {
            const write = await engine.deps.stateStore.put(engine.deps.definition.id, key, value, {
              ttlMs: opts?.ttlMs,
              runId: engine.runId,
            });
            await engine.emitStateWriteEvents(write);
          });
        },
        patch: async (key, fn, schema, opts) =>
          engine.runStep("state.patch", async () => {
            const result = await engine.deps.stateStore.patch(
              engine.deps.definition.id,
              key,
              fn,
              schema,
              {
                ttlMs: opts?.ttlMs,
                runId: engine.runId,
              },
            );
            await engine.emitStateWriteEvents(result.write);
            return result.value;
          }),
        delete: async (key) => {
          await engine.runStep("state.delete", async () => {
            await engine.deps.stateStore.delete(engine.deps.definition.id, key);
            await engine.deps.eventLog.append({
              type: "state.deleted",
              payload: { key, stepKey: engine.currentStepKey() },
            });
          });
        },
        listKeys: async (prefix) =>
          engine.deps.stateStore.listKeys(engine.deps.definition.id, prefix),
        listEntries: async (prefix) =>
          engine.deps.stateStore.listEntries(engine.deps.definition.id, prefix),
        compact: async (opts) => {
          const result = await engine.deps.stateStore.compact(engine.deps.definition.id, opts);
          for (const key of result.deletedKeys) {
            // eslint-disable-next-line no-await-in-loop -- deletion events must preserve state-store order.
            await engine.deps.eventLog.append({
              type: "state.deleted",
              payload: { key, stepKey: engine.currentStepKey() },
            });
          }
          return result;
        },
      },
      cancelled: engine.abort.signal,
      log: ctxLogger,

      step: (id, fn) => engine.runStep(id, fn),
      try: async (id, fn) => {
        try {
          const value = await engine.runStep(id, fn);
          return { ok: true as const, value };
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err : new Error(String(err)) };
        }
      },
      now: () => engine.deterministic("__now", () => Date.now()),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      random: () => engine.deterministic("__random", () => randomInt(0, 2 ** 31 - 1) / 2 ** 31),
      uuid: () => engine.deterministic("__uuid", () => randomUUID()) as string,
      idempotencyKey: (scope) =>
        engine.deterministic(`__idempotency:${scope}`, () => randomUUID()) as string,

      spawn: (opts) => engine.spawnAndTrack(opts, undefined),
      send: (handle, text, opts) => engine.sendToHandle(handle, text, opts),
      waitForReply: async (handle, opts) => {
        engine.trace("agent.wait-for-reply.start", {
          handleId: handle.handleId,
          sessionId: handle.sessionId,
          timeoutMs: opts?.timeoutMs,
        });
        const startedAt = Date.now();
        let reply: string;
        try {
          reply = await engine.deps.spawnAdapter.waitForReply(
            { handleId: handle.handleId, sessionId: handle.sessionId },
            opts,
          );
        } catch (err) {
          engine.traceError("agent.wait-for-reply.failed", err, {
            handleId: handle.handleId,
            sessionId: handle.sessionId,
            durationMs: Date.now() - startedAt,
          });
          throw err;
        }
        engine.trace("agent.wait-for-reply.succeeded", {
          handleId: handle.handleId,
          sessionId: handle.sessionId,
          durationMs: Date.now() - startedAt,
          replyLength: reply.length,
        });
        return { text: reply } satisfies AgentMessage;
      },
      waitForIdle: async () => {
        /* SessionManager has no public waitForIdle today; covered by waitForReply */
      },
      run: <TOutput = unknown>(opts: SpawnOptions, prompt: string, opts2?: RunOptions<TOutput>) =>
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runSubagent returns the parsed schema output typed as unknown
        engine.runSubagent(opts, prompt, opts2) as Promise<TOutput>,

      fanOut: <TItem, TOut>(
        items: readonly TItem[],
        fn: (item: TItem, idx: number) => Promise<TOut>,
        opts?: FanOutOptions<TItem, TOut>,
      ): Promise<FanOutResult<TOut>> => engine.runFanOut(items, fn, opts),
      all: (promises) =>
        Promise.all(promises) as Promise<{
          -readonly [P in keyof typeof promises]: Awaited<(typeof promises)[P]>;
        }>,
      race: (promises) => Promise.race(promises),

      saveArtifact: async (key, content, opts) => {
        const stored = await engine.saveRunArtifact(key, content, {
          mime: opts?.mime,
          useCurrentScope: true,
        });
        const ref: ArtifactRef = {
          key: stored.key,
          mime: stored.mime,
          sizeBytes: stored.sizeBytes,
          writtenAt: stored.writtenAt,
          namespace: stored.namespace,
        };
        return ref;
      },
      readArtifact: async (key) => {
        const sanitized = sanitizeArtifactSegment(key);
        const bytes = engine.deps.artifactStore.readArtifact(
          engine.runId,
          `artifacts/${sanitized}`,
        );
        if (!bytes) throw new Error(`Artifact ${key} not found`);
        return bytes;
      },
      listArtifacts: async (prefix) =>
        engine.deps.artifactStore
          .listArtifacts(engine.runId, prefix ? `artifacts/${prefix}` : undefined)
          .map((a) => ({
            key: a.key,
            mime: a.mime,
            sizeBytes: a.sizeBytes,
            writtenAt: a.writtenAt,
            namespace: a.namespace,
          })),

      shell: async (command, opts) => {
        if (engine.deps.shellRunner) return engine.deps.shellRunner(command, opts);
        return defaultShell(command, opts);
      },

      onUndo: (fn) => {
        // Compensator scope is run-wide LIFO (r1-fixes "compensator scope").
        // We capture the active step key for diagnostics only.
        engine.compensators.push({
          stepKey: engine.currentStepKey() ?? "<root>",
          fn,
        });
      },

      emit: (name, data) => {
        // Fire-and-forget — emit events are diagnostic. Failure to persist
        // shouldn't bubble into the author's run body.
        void engine.deps.eventLog
          .append({ type: "ctx.emit", payload: { name, data } })
          .catch((err) => log.warn(`ctx.emit failed`, err));
      },
      advanceScheduleCursor: async (cursor) =>
        engine.runStep("schedule.cursor.advance", async () => {
          if (!engine.deps.advanceScheduleCursor) {
            throw new Error("This workflow run is not associated with a scheduled cursor.");
          }
          const result = await engine.deps.advanceScheduleCursor(cursor);
          await engine.deps.eventLog.append({
            type: "schedule.cursor-advanced",
            payload: {
              key: engine.deps.record.schedule?.key ?? "",
              previous: result.previous,
              next: result.next,
              runId: engine.runId,
            },
          });
          return result.next;
        }),
      exposeStageContext: async (context) =>
        engine.runStep("stage.context.expose", async () => {
          await engine.exposeStageContext(context);
        }),
      transitionInvestigationCompletion: async (update) =>
        engine.runStep("investigation.completion.transition", async () => {
          await engine.transitionInvestigationCompletion(update);
        }),
      setActionCenterItems: async (items, opts) =>
        engine.runStep("action-center.items.set", async () => {
          await engine.setActionCenterItems(items, opts);
        }),
      notifyParent: async (message, opts) => {
        return engine.runStep("notification.parent", async () => {
          if (!engine.deps.notifyParent) return { delivered: false, status: "unavailable" };
          const result = await engine.deps.notifyParent(message, opts);
          await engine.deps.eventLog.append({
            type: "ctx.emit",
            payload: {
              name: "workflow.parent-notification",
              data: {
                delivered: result.delivered,
                status: result.status,
                waitForResponse: opts?.waitForResponse === true,
              },
            },
          });
          return result;
        });
      },
    };
    return ctx;
  }

  // ── Internal helpers exposed to the fanOut module ────────────────────

  /** Active fanOut item for the CURRENT async context (artifact namespacing +
   *  agent↔unit attribution). Reads from `stepCtx`, so concurrent units don't
   *  clobber each other. */
  private get currentFanOutItem(): { stepKey: string; itemKey: string } | undefined {
    return this.stepCtx.getStore()?.fanOutItem;
  }

  currentStepKey(): string | undefined {
    return this.stepCtx.getStore()?.stepKey;
  }

  checkAborted(): void {
    if (this.abort.signal.aborted) {
      throw new CancelledError("Workflow run cancelled");
    }
  }

  private deterministic<T>(name: string, compute: () => T): T {
    const stepKey = this.currentStepKey() ?? "";
    const cacheKey = `${stepKey}:${this.nextCallsiteId(stepKey)}:${name}`;
    const slot = this.deterministicCache.get(cacheKey);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- cache slots are keyed per-call and store typed compute() outputs
    if (slot && "value" in slot) return slot.value as T;
    const value = compute();
    this.deterministicCache.set(cacheKey, { value });
    return value;
  }

  private nextCallsiteId(parentStepKey: string): number {
    const prev = this.callsiteCounter.get(parentStepKey) ?? 0;
    this.callsiteCounter.set(parentStepKey, prev + 1);
    return prev;
  }

  /** Public — used by `fan-out.ts` to build the per-unit step. */
  async runStep<T>(
    label: string,
    fn: () => Promise<T>,
    opts?: {
      /** Deterministic key override (fanOut units pass `<fanOut>/<idx>:[item]`
       *  so unit keys are stable siblings regardless of completion order). */
      explicitKey?: string;
      /** FanOut item to expose to this step + its descendants/agents. */
      fanOutItem?: { stepKey: string; itemKey: string };
    },
  ): Promise<T> {
    this.checkAborted();
    const parentCtx = this.stepCtx.getStore();
    const parent = parentCtx?.stepKey ?? "";
    const key = opts?.explicitKey ?? `${parent}/${this.nextCallsiteId(parent)}:${label}`;

    const cached = this.memo.get(key);
    const eligibleToReplay = !this.deps.replayFromStepKey || !this.isStepAtOrAfterReplayCut(key);
    if (cached && eligibleToReplay) {
      this.trace("step.replay", { stepKey: key, label });
      await this.deps.eventLog.append({
        type: "step.skipped-replay",
        payload: { stepKey: key, label, result: cached.result },
      });
      // A replayed step's body never runs, so re-surface the artifacts it (and
      // its replayed descendants) produced in the prior run — otherwise the
      // retried run's artifact list/preview is missing them.
      await this.reEmitReplayedArtifacts(key);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- memo stores results keyed by the same fn invocation
      return cached.result as T;
    }

    // Run the body inside this step's own async-context frame. Concurrent
    // fanOut units therefore each read their own `key`/`fanOutItem` (and so
    // attribute spawned agents correctly) instead of racing a shared stack.
    const childCtx: StepContext = {
      stepKey: key,
      fanOutItem: opts?.fanOutItem ?? parentCtx?.fanOutItem,
    };
    return this.stepCtx.run(childCtx, async () => {
      const startedAt = Date.now();
      this.trace("step.start", { stepKey: key, label, parentStepKey: parent });
      await this.deps.eventLog.append({
        type: "step.started",
        payload: { stepKey: key, label, parentStepKey: parent, startedAt },
      });
      try {
        const value = await fn();
        const durationMs = Date.now() - startedAt;
        this.memo.set(key, { result: value, completedAt: Date.now() });
        this.trace("step.succeeded", { stepKey: key, label, durationMs });
        await this.deps.eventLog.append({
          type: "step.completed",
          payload: { stepKey: key, label, result: value, durationMs },
        });
        return value;
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        // Record for the run-level diagnostic before the context unwinds.
        this.lastFailedStepKey = key;
        this.traceError("step.failed", err, { stepKey: key, label, durationMs });
        await this.deps.eventLog.append({
          type: "step.failed",
          payload: { stepKey: key, label, error: serializeError(err), durationMs },
        });
        // Wrap non-Error throws with StepFailedError so the workflow's catch
        // gets a stable type.
        if (err instanceof Error) throw err;
        throw new StepFailedError(key, err);
      }
    });
  }

  /**
   * Run a single fanOut unit's body. Establishes a DETERMINISTIC unit step key
   * (`<fanOutStepKey>/<idx>:[item]`) and the unit's fanOut item in a fresh async
   * context — so parallel units never read each other's step key (the bug that
   * nested every unit inside the previous one) and retry memo keys stay stable.
   */
  async runFanOutUnit<T>(
    fanOutStepKey: string,
    itemKey: string,
    idx: number,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.runStep(label, fn, {
      explicitKey: `${fanOutStepKey}/${idx}:${label}`,
      fanOutItem: { stepKey: fanOutStepKey, itemKey },
    });
  }

  private isStepAtOrAfterReplayCut(stepKey: string): boolean {
    const cut = this.deps.replayFromStepKey;
    if (!cut) return false;
    return stepKey === cut || stepKey.startsWith(`${cut}/`);
  }

  /**
   * Re-emit prior-run artifacts whose producing step is `stepKey` or a
   * descendant of it. A replayed parent step never runs its children, so their
   * artifacts must be surfaced when the parent replays. Deduped on storageKey
   * so each prior artifact is re-emitted at most once across the run.
   */
  private async reEmitReplayedArtifacts(stepKey: string): Promise<void> {
    if (this.priorArtifacts.length === 0) return;
    for (const a of this.priorArtifacts) {
      if (this.emittedReplayArtifacts.has(a.storageKey)) continue;
      const owner = a.stepKey;
      if (owner === stepKey || (owner != null && owner.startsWith(`${stepKey}/`))) {
        this.emittedReplayArtifacts.add(a.storageKey);
        // eslint-disable-next-line no-await-in-loop -- event-log appends are ordered
        await this.deps.eventLog.append({
          type: "artifact.saved",
          payload: {
            key: a.key,
            storageKey: a.storageKey,
            namespace: a.namespace,
            mime: a.mime,
            sizeBytes: a.sizeBytes,
            stepKey: a.stepKey,
          },
        });
      }
    }
  }

  private async drainCompensators(): Promise<void> {
    while (this.compensators.length > 0) {
      const c = this.compensators.pop();
      if (!c) break;
      try {
        // eslint-disable-next-line no-await-in-loop -- compensators run LIFO; sequential is required
        await Promise.race([
          c.fn(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("compensator timeout")), 30_000)),
        ]);
      } catch (err) {
        log.warn(`Compensator for ${c.stepKey} threw:`, err);
      }
    }
  }

  // ── Spawn primitives ────────────────────────────────────────────────

  async acquirePoolSlot(): Promise<ReleaseFn> {
    this.trace("pool.acquire.start", { fanOutScope: this.currentFanOutScope });
    const startedAt = Date.now();
    const release = await this.deps.pool.acquire({
      runId: this.runId,
      fanOutScope: this.currentFanOutScope,
    });
    this.trace("pool.acquire.succeeded", {
      fanOutScope: this.currentFanOutScope,
      durationMs: Date.now() - startedAt,
    });
    return release;
  }

  setFanOutScope(scope: string | undefined): void {
    this.currentFanOutScope = scope;
  }

  /**
   * `ctx.spawn` — create a session, register an in-flight handle, emit
   * lifecycle events. The caller is responsible for `ctx.send` /
   * `ctx.waitForReply` follow-up.
   *
   * When `opts.slot` is set, resolves the slot via the workflow's
   * bindings map before delegating to the spawn adapter. For shipped /
   * default bindings that produce a preamble, the engine stashes it on
   * the in-flight record so the FIRST `ctx.send` (or the inline prompt
   * for `ctx.run`) prepends it.
   */
  private async spawnAndTrack(
    opts: SpawnOptions,
    prompt: string | undefined,
  ): Promise<AgentHandle> {
    this.checkAborted();
    const { resolvedOpts, promptPreamble } = this.resolveSpawn(opts);
    const handleId = randomUUID();
    // Read the spawning step + fanOut item from this call's async context.
    // Because `stepCtx` flows per-await, a fanOut unit reads ITS OWN step/item
    // here even while sibling units spawn concurrently — so the reducer
    // attributes each agent to the right step + unit. Captured up-front for
    // clarity (the values are context-stable across the awaits below).
    const spawnStepKey = this.currentStepKey() ?? "";
    const spawnFanOutItem = this.currentFanOutItem;
    this.trace("agent.spawn.requested", {
      handleId,
      agentName: resolvedOpts.agentName,
      displayName: resolvedOpts.displayName,
      slot: opts.slot,
      hasPrompt: prompt !== undefined,
      hasPreamble: !!promptPreamble,
    });
    const release = await this.acquirePoolSlot();
    await this.deps.eventLog.append({
      type: "agent.spawn-requested",
      payload: {
        handleId,
        stepKey: spawnStepKey,
        agentName: resolvedOpts.agentName,
        displayName: resolvedOpts.displayName,
        slot: opts.slot,
        fanOutStepKey: spawnFanOutItem?.stepKey,
        fanOutUnitKey: spawnFanOutItem?.itemKey,
      },
    });
    try {
      // For ctx.run (prompt !== undefined), prepend the preamble inline —
      // the run path goes through spawnAndRun which sends the prompt
      // atomically with session creation.
      const effectivePrompt =
        prompt !== undefined && promptPreamble ? `${promptPreamble}\n${prompt}` : prompt;
      this.trace("agent.spawn.adapter-start", {
        handleId,
        adapterMethod: effectivePrompt === undefined ? "spawn" : "spawnAndRun",
        agentName: resolvedOpts.agentName,
        displayName: resolvedOpts.displayName,
        slot: opts.slot,
      });
      const adapterStartedAt = Date.now();
      const spawned =
        effectivePrompt === undefined
          ? await this.deps.spawnAdapter.spawn({
              ...resolvedOpts,
              hostSessionId: this.hostSessionId,
            })
          : await this.deps.spawnAdapter.spawnAndRun(
              { ...resolvedOpts, hostSessionId: this.hostSessionId },
              effectivePrompt,
            );
      this.trace("agent.spawn.adapter-succeeded", {
        handleId,
        sessionId: spawned.sessionId,
        durationMs: Date.now() - adapterStartedAt,
        // Resolved spawn forensics — captured here because the subagent
        // session is disposed at run end, so this is the only durable record
        // of which model/reasoning/persona a run actually used. `model`/
        // `reasoningEffort` undefined ⇒ the host/tier default (ModelManager).
        requestedModel: resolvedOpts.model ?? null,
        requestedReasoningEffort: resolvedOpts.reasoningEffort ?? null,
        sessionModel: spawned.model ?? null,
        sessionReasoningEffort: spawned.reasoningEffort ?? null,
        repositoryAgent: spawned.repositoryAgentName ?? null,
        skills: resolvedOpts.skills ? Array.from(resolvedOpts.skills) : null,
      });
      await this.deps.eventLog.append({
        type: "agent.spawned",
        payload: {
          handleId,
          sessionId: spawned.sessionId,
          agentName: resolvedOpts.agentName,
          stepKey: spawnStepKey,
          fanOutStepKey: spawnFanOutItem?.stepKey,
          fanOutUnitKey: spawnFanOutItem?.itemKey,
        },
      });
      const inflight: InFlightSpawn = { handleId, handle: spawned, release };
      // ctx.spawn path: stash preamble for the first ctx.send to consume.
      if (prompt === undefined && promptPreamble) {
        inflight.pendingPreamble = promptPreamble;
      }
      this.inFlight.set(handleId, inflight);
      return { handleId, sessionId: spawned.sessionId };
    } catch (err) {
      this.traceError("agent.spawn.failed", err, { handleId, slot: opts.slot });
      release();
      await this.deps.eventLog.append({
        type: "agent.spawn-failed",
        payload: { handleId, error: serializeError(err) },
      });
      throw err;
    }
  }

  /**
   * Apply slot → binding resolution. Pure delegate around
   * `slot-resolver.resolveSlot` so the engine can centralise the
   * `deps.bindings`/`deps.workflowDir`/`deps.definition.agentRequirements`
   * wiring in one place. Wraps `SlotResolutionError` to attach the run
   * id and emits a dedicated `agent.slot-resolution-failed` event for
   * post-mortem.
   */
  private resolveSpawn(opts: SpawnOptions): {
    resolvedOpts: SpawnOptions;
    promptPreamble?: string;
  } {
    try {
      const resolved = resolveSlot(opts, {
        workflowDir: this.deps.workflowDir ?? "",
        requirements: this.deps.definition.agentRequirements ?? [],
        bindings: this.deps.bindings ?? EMPTY_BINDINGS,
        externalGithubFolderPath: this.deps.externalGithubFolderPath,
      });
      return {
        ...resolved,
        resolvedOpts: this.applyWorkflowPermissionDefaults(
          this.applyWorkflowModelDefaults(this.applyRepoLocalSpawnDefaults(resolved.resolvedOpts)),
        ),
      };
    } catch (err) {
      if (err instanceof SlotResolutionError) {
        void this.deps.eventLog
          .append({
            type: "agent.spawn-failed",
            payload: {
              handleId: "(pre-spawn)",
              error: serializeError(err),
              slot: err.slot,
            },
          })
          .catch(() => {
            /* best-effort */
          });
      }
      throw err;
    }
  }

  /** Apply the workflow-level default model + reasoning effort to a spawn that
   *  doesn't set its own. Per-spawn `SpawnOptions` win; when neither the spawn
   *  nor the workflow specifies a value, it's left undefined so SessionManager
   *  resolves the workflow tier default (Settings) → system default (High). */
  private applyWorkflowModelDefaults(opts: SpawnOptions): SpawnOptions {
    const defaultModel = this.deps.definition.defaultModel;
    const defaultReasoningEffort = this.deps.definition.defaultReasoningEffort;
    if (defaultModel === undefined && defaultReasoningEffort === undefined) return opts;
    return {
      ...opts,
      model: opts.model ?? defaultModel,
      reasoningEffort: opts.reasoningEffort ?? defaultReasoningEffort,
    };
  }

  private applyWorkflowPermissionDefaults(opts: SpawnOptions): SpawnOptions {
    if (this.deps.permissionMode !== "allow-all" || opts.permissionMode !== undefined) return opts;
    return { ...opts, permissionMode: "allow-all" };
  }

  private applyRepoLocalSpawnDefaults(opts: SpawnOptions): SpawnOptions {
    const githubRepoPath = opts.githubFolderPath
      ? repoPathFromGithubFolder(opts.githubFolderPath)
      : undefined;
    const defaultExternalRepoPath =
      this.deps.externalGithubFolderPathDefault && this.deps.externalGithubFolderPath
        ? repoPathFromGithubFolder(this.deps.externalGithubFolderPath)
        : undefined;
    const repoPath =
      opts.repoPath ??
      githubRepoPath ??
      (opts.workspaceName ? undefined : (defaultExternalRepoPath ?? this.deps.repoPath));
    const phaseSkills = this.skillsForCurrentPhase(repoPath);
    const explicitSkills = opts.skills
      ? this.expandRepoSkillWildcard(opts.skills, repoPath)
      : undefined;
    if (!repoPath && !phaseSkills && !explicitSkills) return opts;
    const { githubFolderPath: _dropGithubFolderPath, ...rest } = opts;
    return {
      ...rest,
      repoPath: opts.repoPath ?? repoPath,
      skills: phaseSkills ?? explicitSkills,
    };
  }

  private skillsForCurrentPhase(repoPath: string | undefined): readonly string[] | undefined {
    const bindings = this.deps.bindings?.skillPhaseBindings;
    if (!bindings) return undefined;
    const label = this.currentStepLabel();
    if (!label) return undefined;
    const configured = bindings[label];
    return configured ? this.expandRepoSkillWildcard(configured, repoPath) : undefined;
  }

  private expandRepoSkillWildcard(
    skills: readonly string[],
    repoPath: string | undefined,
  ): readonly string[] {
    if (!skills.includes("*")) return skills;
    return listRepoLocalSkillNames(repoPath);
  }

  private async exposeStageContext(context: SdkWorkflowStageContext): Promise<void> {
    await this.deps.eventLog.append({
      type: "stage.context-exposed",
      payload: {
        stageId: context.stageId,
        label: context.label,
        summary: context.summary,
        artifactFolders: [...(context.artifactFolders ?? [])],
        artifacts: [...(context.artifacts ?? [])],
        files: [...(context.files ?? [])],
        agentContext: context.agentContext,
      },
    });
  }

  private async transitionInvestigationCompletion(
    update: WorkflowInvestigationCompletionUpdate,
  ): Promise<void> {
    const previous = this.investigationCompletionStates.get(update.incidentId);
    if (!isValidInvestigationCompletionTransition(previous, update.state)) {
      throw new Error(
        `Invalid investigation completion transition for ${update.incidentId}: ${previous ?? "none"} -> ${update.state}`,
      );
    }
    this.investigationCompletionStates.set(update.incidentId, update.state);
    await this.deps.eventLog.append({
      type: "investigation.completion-transitioned",
      payload: {
        incidentId: update.incidentId,
        state: update.state,
        previousState: previous,
        reason: update.reason,
        actor: update.actor,
        markdownArtifactKey: update.markdownArtifactKey,
        jsonArtifactKey: update.jsonArtifactKey,
        chatLinks: [...(update.chatLinks ?? [])],
        updatedAt: Date.now(),
      },
    });
  }

  private async setActionCenterItems(
    items: ReadonlyArray<SdkWorkflowActionCenterItem>,
    opts?: { replace?: boolean },
  ): Promise<void> {
    await this.deps.eventLog.append({
      type: "action-center.items-set",
      payload: { items: items.map(normalizeActionCenterItem), replace: opts?.replace !== false },
    });
  }

  private async emitStateWriteEvents(write: StoreWriteResult): Promise<void> {
    await this.deps.eventLog.append({
      type: "state.written",
      payload: {
        key: write.key,
        sizeBytes: write.sizeBytes,
        hash: write.hash,
        stepKey: this.currentStepKey(),
      },
    });
    if (Object.keys(write.scrubHits).length > 0) {
      await this.deps.eventLog.append({
        type: "state.credential-redacted",
        payload: { key: write.key, patternHits: write.scrubHits },
      });
    }
  }

  private currentStepLabel(): string | undefined {
    const key = this.currentStepKey();
    if (!key) return undefined;
    const colon = key.lastIndexOf(":");
    return colon >= 0 ? key.slice(colon + 1) : key;
  }

  /**
   * `ctx.send` wrapper that consumes the pending preamble (if any) on the
   * first dispatch to a slot-bound handle. After consumption, subsequent
   * sends pass through untouched.
   */
  private async sendToHandle(
    handle: AgentHandle,
    text: string,
    opts?: { deliveryMode?: import("./spawn-adapter").DeliveryMode },
  ): Promise<void> {
    const inflight = this.inFlight.get(handle.handleId);
    let payload = text;
    if (inflight?.pendingPreamble) {
      payload = `${inflight.pendingPreamble}\n${text}`;
      inflight.pendingPreamble = undefined;
    }
    this.trace("agent.send.start", {
      handleId: handle.handleId,
      sessionId: handle.sessionId,
      deliveryMode: opts?.deliveryMode,
      messageLength: payload.length,
    });
    const startedAt = Date.now();
    try {
      await this.deps.spawnAdapter.send(
        { handleId: handle.handleId, sessionId: handle.sessionId },
        payload,
        opts,
      );
      this.trace("agent.send.succeeded", {
        handleId: handle.handleId,
        sessionId: handle.sessionId,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      this.traceError("agent.send.failed", err, {
        handleId: handle.handleId,
        sessionId: handle.sessionId,
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  /**
   * `ctx.run` — spawn + send + wait + parse + release.
   *
   * Race-safety contract: we use **deferred spawn + sendAndCollect** instead
   * of `spawnAndRun + waitForReply`. `sendAndCollect` subscribes to the
   * session's turn-event stream BEFORE dispatching the user message, so a
   * fast-replying subagent (one whose `turn:idle` fires synchronously or in
   * the same microtask as the send) cannot complete its first turn before
   * the engine starts listening. The previous `spawnAndRun + waitForReply`
   * shape had a subscribe-after-send window that caused stalls and empty
   * reply capture in workflow steps.
   *
   * Parent-message contract: while a step is in flight we install a
   * scoped listener on the subagent session id. Parent messages are valid
   * progress/final handoff messages; if the normal assistant reply is
   * missing, the latest parent message becomes the ctx.run reply.
   */
  private async runSubagent(
    opts: SpawnOptions,
    prompt: string,
    runOpts?: RunOptions,
  ): Promise<unknown> {
    this.checkAborted();
    const startedAt = Date.now();
    this.trace("agent.run.start", {
      agentName: opts.agentName,
      displayName: opts.displayName,
      slot: opts.slot,
      timeoutMs: runOpts?.timeoutMs,
      promptLength: prompt.length,
    });
    // Deferred spawn (no autostart) so we can subscribe before sending.
    const handle = await this.spawnAndTrack(opts, undefined);
    const inflight = this.inFlight.get(handle.handleId);
    // Consume any preamble registered on the in-flight record by the slot
    // resolver — same behavior as the first ctx.send.
    let effectivePrompt = prompt;
    if (inflight?.pendingPreamble) {
      effectivePrompt = `${inflight.pendingPreamble}\n${prompt}`;
      inflight.pendingPreamble = undefined;
    }
    this.trace("agent.run.spawned", {
      handleId: handle.handleId,
      sessionId: handle.sessionId,
      effectivePromptLength: effectivePrompt.length,
    });
    // Scoped parent-message listener: only fires for THIS subagent's
    // session id, and is removed in the finally block regardless of
    // success/failure.
    let latestParentMessage: string | undefined;
    const unsubscribeParentMsg = this.deps.spawnAdapter.onSubagentParentMessage
      ? this.deps.spawnAdapter.onSubagentParentMessage(handle.sessionId, (info) => {
          latestParentMessage = info.message;
          this.trace("agent.parent-message", {
            handleId: handle.handleId,
            sessionId: handle.sessionId,
            messageLength: info.message.length,
          });
          // Surface via ctx.emit so it lands in the event log without
          // requiring a new entry in the closed WorkflowEvent union.
          void this.deps.eventLog
            .append({
              type: "ctx.emit",
              payload: {
                name: "agent.parent-message",
                data: {
                  handleId: handle.handleId,
                  sessionId: handle.sessionId,
                  stepKey: this.currentStepKey(),
                  messagePreview: info.message.slice(0, 200),
                },
              },
            })
            .catch(() => {
              /* best-effort */
            });
        })
      : undefined;
    try {
      this.trace("agent.send-and-collect.start", {
        handleId: handle.handleId,
        sessionId: handle.sessionId,
        timeoutMs: runOpts?.timeoutMs,
        promptLength: effectivePrompt.length,
      });
      const assistantReply = await this.deps.spawnAdapter
        .sendAndCollect(
          { handleId: handle.handleId, sessionId: handle.sessionId },
          effectivePrompt,
          { timeoutMs: runOpts?.timeoutMs },
        )
        .catch((err: unknown) => {
          if (latestParentMessage !== undefined && this.canUseParentMessageAsReply(err)) {
            this.trace("agent.send-and-collect.using-parent-message", {
              handleId: handle.handleId,
              sessionId: handle.sessionId,
              parentMessageLength: latestParentMessage.length,
            });
            return latestParentMessage;
          }
          throw err;
        });
      const reply =
        assistantReply.trim().length > 0 ? assistantReply : (latestParentMessage ?? assistantReply);
      this.trace("agent.send-and-collect.succeeded", {
        handleId: handle.handleId,
        sessionId: handle.sessionId,
        durationMs: Date.now() - startedAt,
        replyLength: reply.length,
      });
      await this.deps.eventLog.append({
        type: "agent.message",
        payload: { handleId: handle.handleId, role: "assistant", content: reply },
      });
      const durationMs = Date.now() - startedAt;
      await this.deps.eventLog.append({
        type: "agent.replied",
        payload: { handleId: handle.handleId, reply, durationMs },
      });
      await this.deps.eventLog.append({
        type: "agent.spawn-complete",
        payload: { handleId: handle.handleId, durationMs },
      });
      const parsed = runOpts?.schema ? runOpts.schema.parse(safeJsonParse(reply)) : reply;
      return parsed;
    } catch (err) {
      this.traceError("agent.run.failed", err, {
        handleId: handle.handleId,
        sessionId: handle.sessionId,
        durationMs: Date.now() - startedAt,
        sawParentMessage: latestParentMessage !== undefined,
      });
      await this.deps.eventLog.append({
        type: "agent.spawn-failed",
        payload: { handleId: handle.handleId, error: serializeError(err) },
      });
      throw err;
    } finally {
      this.trace("agent.run.cleanup.start", {
        handleId: handle.handleId,
        sessionId: handle.sessionId,
      });
      unsubscribeParentMsg?.();
      this.inFlight.delete(handle.handleId);
      if (inflight?.release) inflight.release();
      if (inflight) await this.disposeSpawnedHandle(inflight);
      this.trace("agent.run.cleanup.end", {
        handleId: handle.handleId,
        sessionId: handle.sessionId,
      });
    }
  }

  private canUseParentMessageAsReply(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /Timed out waiting for the subagent's reply|Subagent turn completed without an assistant reply/i.test(
      message,
    );
  }

  private async disposeSpawnedHandle(inflight: InFlightSpawn): Promise<void> {
    if (!this.deps.spawnAdapter.dispose) return;
    try {
      this.trace("agent.dispose.start", {
        handleId: inflight.handleId,
        sessionId: inflight.handle.sessionId,
      });
      await this.deps.spawnAdapter.dispose(inflight.handle);
      this.trace("agent.dispose.succeeded", {
        handleId: inflight.handleId,
        sessionId: inflight.handle.sessionId,
      });
    } catch (err) {
      this.traceError("agent.dispose.failed", err, {
        handleId: inflight.handleId,
        sessionId: inflight.handle.sessionId,
      });
      log.warn(`Failed to dispose workflow subagent ${inflight.handle.sessionId}:`, err);
    }
  }

  private async cleanupInFlightHandles(): Promise<void> {
    const inflights = Array.from(this.inFlight.values());
    this.trace("agent.cleanup-inflight.start", { count: inflights.length });
    for (const inflight of inflights) {
      try {
        this.trace("agent.cleanup-inflight.cancel-start", {
          handleId: inflight.handleId,
          sessionId: inflight.handle.sessionId,
        });
        // eslint-disable-next-line no-await-in-loop -- bounded by workflow-owned live handles
        await this.deps.spawnAdapter.cancel(inflight.handle);
        this.trace("agent.cleanup-inflight.cancel-succeeded", {
          handleId: inflight.handleId,
          sessionId: inflight.handle.sessionId,
        });
      } catch {
        this.trace("agent.cleanup-inflight.cancel-failed", {
          handleId: inflight.handleId,
          sessionId: inflight.handle.sessionId,
        });
        /* best-effort */
      }
      if (inflight.release) {
        try {
          inflight.release();
        } catch {
          /* best-effort */
        }
      }
      // eslint-disable-next-line no-await-in-loop -- bounded by workflow-owned live handles
      await this.disposeSpawnedHandle(inflight);
      this.inFlight.delete(inflight.handleId);
    }
    this.trace("agent.cleanup-inflight.end", { count: inflights.length });
  }

  private trace(operation: string, details: Record<string, unknown> = {}): void {
    appendWorkflowDiagnostic({
      operation,
      runId: this.runId,
      workflowId: this.deps.definition.id,
      runFamilyId: this.deps.record.runFamilyId,
      hostSessionId: this.hostSessionId,
      stepKey: this.currentStepKey(),
      details,
      inFlightHandles: this.inFlightSummary(),
    });
  }

  private traceError(
    operation: string,
    error: unknown,
    details: Record<string, unknown> = {},
  ): void {
    appendWorkflowDiagnostic({
      operation,
      runId: this.runId,
      workflowId: this.deps.definition.id,
      runFamilyId: this.deps.record.runFamilyId,
      hostSessionId: this.hostSessionId,
      stepKey: this.currentStepKey(),
      details,
      error,
      inFlightHandles: this.inFlightSummary(),
    });
  }

  private inFlightSummary(): WorkflowDiagnosticHandle[] {
    return Array.from(this.inFlight.values()).map((inflight) => ({
      handleId: inflight.handleId,
      sessionId: inflight.handle.sessionId,
    }));
  }

  /** FanOut delegates to `fan-out.ts` (kept here as method for ctx wiring). */
  private async runFanOut<TItem, TOut>(
    items: readonly TItem[],
    fn: (item: TItem, idx: number) => Promise<TOut>,
    opts?: FanOutOptions<TItem, TOut>,
  ): Promise<FanOutResult<TOut>> {
    return runFanOut<TItem, TOut>(this, items, fn, opts);
  }

  // ── Pool exposure for fan-out module ────────────────────────────────

  openFanOutScope(scope: string, max: number): void {
    this.deps.pool.openScope(scope, max);
  }

  closeFanOutScope(scope: string): void {
    this.deps.pool.closeScope(scope);
  }

  /** Public helper for fan-out to write events without re-exposing the log. */
  async emitEvent(partial: Parameters<EventLog["append"]>[0]): Promise<void> {
    await this.deps.eventLog.append(partial);
  }

  /** Used by `runFanOut` for drift detection. */
  getPriorFanOutItemKeys(stepKey: string): ReadonlyArray<string> | undefined {
    return this.priorFanOutItemKeys.get(stepKey);
  }

  /** Engine-internal: feed prior `fanOut.started` payloads on reattach. */
  hydratePriorFanOutItemKeys(
    entries: Iterable<{ stepKey: string; itemKeys: ReadonlyArray<string> }>,
  ): void {
    for (const e of entries) this.priorFanOutItemKeys.set(e.stepKey, e.itemKeys);
  }

  /** Engine-internal: feed prior `artifact.saved` payloads so steps replayed
   *  from memo re-surface the artifacts they produced (retry-from-step). */
  hydratePriorArtifacts(items: ReadonlyArray<PriorArtifact>): void {
    this.priorArtifacts = items;
  }
}

function listRepoLocalSkillNames(repoPath: string | undefined): string[] {
  if (!repoPath) return [];
  const skillsDir = path.join(repoPath, ".github", "skills");
  if (!fs.existsSync(skillsDir)) return [];
  const names: string[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith(".")) {
      continue;
    }
    const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    const raw = fs.readFileSync(skillFile, "utf-8");
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    const frontmatter = match?.[1] ?? "";
    const name = frontmatter
      .match(/^name:\s*(.+)$/m)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "");
    names.push(name || entry.name);
  }
  return names;
}

function repoPathFromGithubFolder(githubFolderPath: string): string {
  const resolved = path.resolve(githubFolderPath);
  return path.basename(resolved).toLowerCase() === ".github" ? path.dirname(resolved) : resolved;
}

function normalizeActionCenterItem(
  item: SdkWorkflowActionCenterItem,
): WorkflowActionCenterSnapshotItem {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    why: item.why,
    evidence: (item.evidence ?? []).map((evidence) => ({
      label: evidence.label,
      detail: evidence.detail,
      artifacts: [...(evidence.artifacts ?? [])],
      chats: [...(evidence.chats ?? [])],
      files: [...(evidence.files ?? [])],
    })),
    supportingDetails: [...(item.supportingDetails ?? [])],
    artifacts: [...(item.artifacts ?? [])],
    chats: [...(item.chats ?? [])],
    safeToSend: item.safeToSend,
    ownerAlias: item.ownerAlias,
  };
}

function safeJsonParse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return text;
  // Try to extract a JSON block from the reply; fall back to raw text.
  // Look for both `{...}` (object) and `[...]` (array). Pick whichever
  // delimiter appears first in the trimmed text — that selects the
  // top-level JSON value the agent emitted, even when the surrounding
  // prose includes other braces/brackets.
  const objStart = trimmed.indexOf("{");
  const arrStart = trimmed.indexOf("[");
  let start = -1;
  let lastClose = -1;
  if (arrStart >= 0 && (objStart < 0 || arrStart < objStart)) {
    start = arrStart;
    lastClose = trimmed.lastIndexOf("]");
  } else if (objStart >= 0) {
    start = objStart;
    lastClose = trimmed.lastIndexOf("}");
  }
  if (start >= 0 && lastClose > start) {
    try {
      return JSON.parse(trimmed.slice(start, lastClose + 1)) as unknown;
    } catch {
      /* fall through */
    }
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}

import { exec as nodeExec } from "node:child_process";

async function defaultShell(
  command: string,
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    nodeExec(
      command,
      { cwd: opts?.cwd, timeout: opts?.timeoutMs ?? 60_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${err.message}\n${stderr}`));
        else resolve(stdout);
      },
    );
  });
}
