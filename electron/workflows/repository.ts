// electron/workflows/repository.ts
//
// File-backed persistence for workflow runs and artifacts. Mirrors
// `LocalSessionStore` in shape: one encrypted index file + per-run
// directories. The repository owns the on-disk format; the engine reads
// and writes through this interface only.
//
// Per-run dir layout (c-persist §1):
//   marshal-workflow-runs/<runId>/
//     run.json            — encrypted RunRecord
//     events.ndjson       — encrypted-per-line append-only log
//     workflow.compiled.js — pinned dist (r1-fixes A5)
//     artifacts/<key>     — per-artifact files
//     artifacts/fanout/<itemKey>/<key>
//
// Schema: r1-fixes A12 (.installed.json sidecar is owned by
// `installed-source-store.ts`, not by this module).

import * as fs from "node:fs";
import * as path from "node:path";

import { createLogger } from "../../common/marshal-logger";
import {
  type ArtifactRefSummary,
  RunIndexEntrySchema,
  type RunIndexEntry,
  RunRecordSchema,
  type RunRecord,
  WorkflowRunsIndexSchema,
  type WorkflowRunsIndex,
} from "../../common/workflows-contract";
import { getAppDataDir } from "../app-paths";
import { readEncryptedFileSync, writeEncryptedFileSync } from "../safe-storage-file";
import { scrubCredentials } from "./credential-scrubber";
import { sanitizeArtifactSegment } from "./sanitize-key";

const log = createLogger("WorkflowRepo");
const INDEX_FILE = "index.json";

export interface RepositoryDeps {
  /** Absolute path to `~/.marshal/marshal-workflow-runs/`. Defaults to the standard
   *  app-data location; tests pass a tmpdir. */
  readonly rootDir?: string;
}

function rootOf(deps: RepositoryDeps): string {
  return deps.rootDir ?? path.join(getAppDataDir(), "marshal-workflow-runs");
}

function runDir(deps: RepositoryDeps, runId: string): string {
  return path.join(rootOf(deps), runId);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// ─── WorkflowRunRepository ─────────────────────────────────────────────

export interface CreateRunInput {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowRepoPath?: string;
  readonly workflowWorkspaceName?: string;
  readonly workflowVersion: string;
  readonly workflowDistHash: string;
  readonly runFamilyId: string;
  readonly parentRunId?: string;
  readonly inputSnapshot: unknown;
  readonly triggeredBy: RunRecord["triggeredBy"];
  readonly schedule?: RunRecord["schedule"];
  readonly initiatorSessionId?: string;
  readonly hostSessionId: string;
  readonly title: string;
}

export class WorkflowRunRepository {
  private indexCache: WorkflowRunsIndex | null = null;
  private indexLock: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RepositoryDeps = {}) {}

  /** Path to the run-local events.ndjson — used by the engine's `EventLog`. */
  eventsPathFor(runId: string): string {
    return path.join(runDir(this.deps, runId), "events.ndjson");
  }

  /** Path to the pinned workflow.compiled.js — written at `start()`. */
  compiledPathFor(runId: string): string {
    return path.join(runDir(this.deps, runId), "workflow.compiled.js");
  }

  runDirFor(runId: string): string {
    return runDir(this.deps, runId);
  }

  /** Atomic write of a fresh `RunRecord` and index entry. */
  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const now = Date.now();
    const record: RunRecord = {
      schemaVersion: 1,
      runId: input.runId,
      workflowId: input.workflowId,
      workflowRepoPath: input.workflowRepoPath,
      workflowWorkspaceName: input.workflowWorkspaceName,
      workflowVersion: input.workflowVersion,
      workflowDistHash: input.workflowDistHash,
      runFamilyId: input.runFamilyId,
      parentRunId: input.parentRunId,
      inputSnapshot: input.inputSnapshot,
      status: "pending",
      startedAt: now,
      endedAt: null,
      durationMs: null,
      source: "workflow-run",
      triggeredBy: input.triggeredBy,
      schedule: input.schedule,
      initiatorSessionId: input.initiatorSessionId,
      hostSessionId: input.hostSessionId,
      errorSummary: null,
      totals: { steps: 0, subagents: 0, artifacts: 0, errors: 0 },
      nextEventSeq: 0,
    };
    ensureDir(runDir(this.deps, input.runId));
    this.writeRunRecord(record);
    await this.withIndexLock(async () => {
      const index = this.loadIndex();
      const entry: RunIndexEntry = {
        runId: record.runId,
        workflowId: record.workflowId,
        workflowRepoPath: record.workflowRepoPath,
        workflowWorkspaceName: record.workflowWorkspaceName,
        workflowVersion: record.workflowVersion,
        runFamilyId: record.runFamilyId,
        parentRunId: record.parentRunId,
        title: input.title,
        status: record.status,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        source: record.source,
        triggeredBy: record.triggeredBy,
        initiatorSessionId: record.initiatorSessionId,
        hostSessionId: record.hostSessionId || undefined,
        totals: record.totals,
      };
      const next: WorkflowRunsIndex = {
        schemaVersion: 1,
        runs: [entry, ...index.runs.filter((r) => r.runId !== entry.runId)],
      };
      this.saveIndex(next);
    });
    return record;
  }

  loadRun(runId: string): RunRecord | null {
    const file = path.join(runDir(this.deps, runId), "run.json");
    if (!fs.existsSync(file)) return null;
    try {
      const raw = readEncryptedFileSync(file);
      const parsed = RunRecordSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        log.warn(`run.json schema mismatch for ${runId}:`, parsed.error.issues);
        return null;
      }
      return parsed.data;
    } catch (err) {
      log.warn(`Failed to read run.json for ${runId}:`, err);
      return null;
    }
  }

  async updateRun(runId: string, patch: Partial<RunRecord>): Promise<RunRecord> {
    const existing = this.loadRun(runId);
    if (!existing) throw new Error(`Run ${runId} not found`);
    const next: RunRecord = { ...existing, ...patch };
    this.writeRunRecord(next);
    await this.withIndexLock(async () => {
      const index = this.loadIndex();
      const rest = index.runs.filter((r) => r.runId !== runId);
      const entry: RunIndexEntry = {
        runId: next.runId,
        workflowId: next.workflowId,
        workflowRepoPath: next.workflowRepoPath,
        workflowWorkspaceName: next.workflowWorkspaceName,
        workflowVersion: next.workflowVersion,
        runFamilyId: next.runFamilyId,
        parentRunId: next.parentRunId,
        title: index.runs.find((r) => r.runId === runId)?.title ?? next.workflowId,
        status: next.status,
        startedAt: next.startedAt,
        endedAt: next.endedAt,
        source: next.source,
        triggeredBy: next.triggeredBy,
        initiatorSessionId: next.initiatorSessionId,
        hostSessionId: next.hostSessionId || undefined,
        totals: next.totals,
      };
      this.saveIndex({ schemaVersion: 1, runs: [entry, ...rest] });
    });
    return next;
  }

  listRuns(): RunIndexEntry[] {
    return this.loadIndex().runs;
  }

  findResumableRuns(): RunIndexEntry[] {
    return this.loadIndex().runs.filter((r) => r.status === "running" || r.status === "pending");
  }

  /** Mark every still-`running` run as `crashed` — used during boot recovery. */
  async markStaleAsCrashed(reason: string): Promise<RunIndexEntry[]> {
    const stale = this.findResumableRuns();
    for (const entry of stale) {
      const record = this.loadRun(entry.runId);
      if (!record) continue;
      // eslint-disable-next-line no-await-in-loop -- sequential updates serialise on the per-instance index lock anyway
      await this.updateRun(entry.runId, {
        status: "crashed",
        endedAt: Date.now(),
        durationMs: Date.now() - record.startedAt,
        errorSummary: { message: reason, code: "ENGINE_RESTART" },
      });
    }
    return stale;
  }

  // ── internals ────────────────────────────────────────────────────────

  private writeRunRecord(record: RunRecord): void {
    ensureDir(runDir(this.deps, record.runId));
    writeEncryptedFileSync(
      path.join(runDir(this.deps, record.runId), "run.json"),
      JSON.stringify(record, null, 2),
    );
  }

  private loadIndex(): WorkflowRunsIndex {
    if (this.indexCache) return this.indexCache;
    const file = path.join(rootOf(this.deps), INDEX_FILE);
    if (!fs.existsSync(file)) {
      const empty: WorkflowRunsIndex = { schemaVersion: 1, runs: [] };
      this.indexCache = empty;
      return empty;
    }
    try {
      const raw = readEncryptedFileSync(file);
      const parsedJson = JSON.parse(raw) as unknown;
      const parsed = WorkflowRunsIndexSchema.safeParse(parsedJson);
      if (!parsed.success) {
        // Drop one bad row at a time rather than fail the whole index.
        const obj =
          parsedJson && typeof parsedJson === "object"
            ? // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- recovery path; per-row Zod parses below
              (parsedJson as { runs?: unknown[] })
            : { runs: [] as unknown[] };
        const good: RunIndexEntry[] = [];
        for (const r of obj.runs ?? []) {
          const row = RunIndexEntrySchema.safeParse(r);
          if (row.success) good.push(row.data);
        }
        this.indexCache = { schemaVersion: 1, runs: good };
        log.warn(
          `Workflow index schema mismatch; recovered ${good.length} of ${(obj.runs ?? []).length} rows.`,
        );
        return this.indexCache;
      }
      this.indexCache = parsed.data;
      return parsed.data;
    } catch (err) {
      log.warn("Failed to read workflow runs index:", err);
      const empty: WorkflowRunsIndex = { schemaVersion: 1, runs: [] };
      this.indexCache = empty;
      return empty;
    }
  }

  private saveIndex(index: WorkflowRunsIndex): void {
    ensureDir(rootOf(this.deps));
    writeEncryptedFileSync(
      path.join(rootOf(this.deps), INDEX_FILE),
      JSON.stringify(index, null, 2),
    );
    this.indexCache = index;
  }

  private async withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.indexLock;
    let release: (() => void) | undefined;
    this.indexLock = new Promise<void>((r) => (release = r));
    try {
      await prev;
      return await fn();
    } finally {
      release?.();
    }
  }
}

// ─── ArtifactStore ─────────────────────────────────────────────────────

export interface ArtifactWriteOptions {
  readonly mime?: string;
  readonly stepKey?: string;
  readonly fanOutScope?: { stepKey: string; itemKey: string };
}

export interface StoredArtifact {
  readonly ref: ArtifactRefSummary;
  readonly storagePath: string;
  readonly scrubHits: Readonly<Record<string, number>>;
}

export class ArtifactStore {
  constructor(private readonly deps: RepositoryDeps = {}) {}

  /**
   * Persist an artifact. Text content (or `string` input) is run through
   * the credential scrubber before write; binary `Uint8Array` content
   * passes through verbatim.
   *
   * The returned storagePath is relative to the run directory so callers
   * can serialise it without leaking absolute paths.
   */
  saveArtifact(
    runId: string,
    key: string,
    content: Uint8Array | string,
    opts: ArtifactWriteOptions = {},
  ): StoredArtifact {
    const sanitizedKey = sanitizeArtifactSegment(key);
    const namespace: "run" | "fanout" = opts.fanOutScope ? "fanout" : "run";
    const subdir = opts.fanOutScope
      ? path.join(
          "artifacts",
          "fanout",
          sanitizeArtifactSegment(opts.fanOutScope.stepKey, "fanout-step"),
          sanitizeArtifactSegment(opts.fanOutScope.itemKey, "unit"),
        )
      : "artifacts";
    const absDir = path.join(runDir(this.deps, runId), subdir);
    ensureDir(absDir);

    let bytes: Buffer;
    let scrubHits: Record<string, number> = {};
    if (typeof content === "string") {
      const { text, hits } = scrubCredentials(content);
      scrubHits = hits;
      bytes = Buffer.from(text, "utf-8");
    } else {
      bytes = Buffer.from(content);
    }

    const absPath = path.join(absDir, sanitizedKey);
    fs.writeFileSync(absPath, bytes, { mode: 0o600 });
    const storagePath = path.relative(runDir(this.deps, runId), absPath).replace(/\\/g, "/");

    return {
      storagePath,
      scrubHits,
      ref: {
        key,
        storageKey: storagePath,
        namespace,
        mime: opts.mime ?? guessMime(typeof content === "string" ? "text" : "binary", key),
        sizeBytes: bytes.byteLength,
        writtenAt: Date.now(),
        stepKey: opts.stepKey ?? opts.fanOutScope?.stepKey,
      },
    };
  }

  /**
   * Copy every artifact file from one run into another. Used by
   * retry-from-step: the retried run replays preserved steps from memo (their
   * bodies never re-run, so they never re-`saveArtifact`), so without this the
   * new run's artifact dir is missing everything the preserved steps produced.
   * Storage keys are run-relative (no runId baked in), so copied files land at
   * the same relative paths and `readArtifact(newRunId, storageKey)` resolves.
   */
  copyArtifacts(fromRunId: string, toRunId: string): void {
    const src = path.join(runDir(this.deps, fromRunId), "artifacts");
    if (!fs.existsSync(src)) return;
    const dst = path.join(runDir(this.deps, toRunId), "artifacts");
    ensureDir(dst);
    walk(src, (abs) => {
      const rel = path.relative(src, abs);
      const target = path.join(dst, rel);
      ensureDir(path.dirname(target));
      fs.copyFileSync(abs, target);
    });
  }

  readArtifact(runId: string, storageKey: string): Uint8Array | null {
    const normalized = path.normalize(storageKey);
    if (
      path.isAbsolute(normalized) ||
      normalized.startsWith(`..${path.sep}`) ||
      normalized === ".."
    ) {
      return null;
    }
    const absPath = path.join(runDir(this.deps, runId), normalized);
    if (!fs.existsSync(absPath)) return null;
    return fs.readFileSync(absPath);
  }

  listArtifacts(runId: string, prefix?: string): ArtifactRefSummary[] {
    const root = path.join(runDir(this.deps, runId), "artifacts");
    if (!fs.existsSync(root)) return [];
    const refs: ArtifactRefSummary[] = [];
    walk(root, (abs) => {
      const storageKey = path.relative(runDir(this.deps, runId), abs).replace(/\\/g, "/");
      if (prefix && !storageKey.startsWith(prefix)) return;
      const stat = fs.statSync(abs);
      const namespace: "run" | "fanout" = storageKey.includes("/fanout/") ? "fanout" : "run";
      refs.push({
        key: path.basename(abs),
        storageKey,
        namespace,
        mime: guessMime("text", abs),
        sizeBytes: stat.size,
        writtenAt: stat.mtimeMs,
      });
    });
    return refs;
  }
}

function walk(dir: string, visit: (absPath: string) => void): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, visit);
    else if (entry.isFile()) visit(abs);
  }
}

function guessMime(_default: "text" | "binary", filename: string): string {
  if (filename.endsWith(".json")) return "application/json";
  if (filename.endsWith(".md")) return "text/markdown";
  if (filename.endsWith(".html")) return "text/html";
  if (filename.endsWith(".txt")) return "text/plain";
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
  return _default === "text" ? "text/plain" : "application/octet-stream";
}
