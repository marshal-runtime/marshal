// electron/workflows/state-store.ts
//
// Durable workflow-scoped key/value storage. Values outlive individual runs
// and are namespaced by workflow id.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import { getAppDataDir } from "../app-paths";
import { readEncryptedFileSync, writeEncryptedFileSync } from "../safe-storage-file";
import { scrubCredentials } from "./credential-scrubber";
import { sanitizeArtifactSegment } from "./sanitize-key";

export class WorkflowStoreSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowStoreSchemaError";
  }
}

export class StoreQuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreQuotaExceededError";
  }
}

interface StateIndexEntry {
  readonly hash: string;
  readonly sizeBytes: number;
  readonly writtenAt: number;
  readonly ttlMs?: number;
  readonly runId?: string;
}

interface StateIndex {
  readonly schemaVersion: 1;
  readonly entries: Record<string, StateIndexEntry>;
}

interface StateValueFile {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly value: unknown;
  readonly writtenAt: number;
  readonly ttlMs?: number;
  readonly runId?: string;
  readonly hash: string;
}

const StateIndexEntrySchema = z.object({
  hash: z.string(),
  sizeBytes: z.number(),
  writtenAt: z.number(),
  ttlMs: z.number().optional(),
  runId: z.string().optional(),
});

const StateIndexSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.record(z.string(), StateIndexEntrySchema),
});

const StateValueFileSchema = z.object({
  schemaVersion: z.literal(1),
  key: z.string(),
  value: z.unknown(),
  writtenAt: z.number(),
  ttlMs: z.number().optional(),
  runId: z.string().optional(),
  hash: z.string(),
});

export interface StoreWriteResult {
  readonly key: string;
  readonly sizeBytes: number;
  readonly hash: string;
  readonly scrubHits: Readonly<Record<string, number>>;
}

export interface WorkflowStateEntry {
  readonly key: string;
  readonly sizeBytes: number;
  readonly writtenAt: number;
  readonly ttlMs?: number;
  readonly expiresAt?: number;
  readonly runId?: string;
}

export interface WorkflowStateValue<T = unknown> extends WorkflowStateEntry {
  readonly value: T;
}

export interface WorkflowStateCompactionOptions {
  readonly prefix?: string;
  readonly olderThanMs?: number;
  readonly limit?: number;
}

export interface WorkflowStateCompactionResult {
  readonly scanned: number;
  readonly deleted: number;
  readonly bytesFreed: number;
  readonly deletedKeys: ReadonlyArray<string>;
}

export interface WorkflowStateStoreDeps {
  readonly rootDir?: string;
}

const VALUE_LIMIT_BYTES = 256 * 1024;
const WORKFLOW_LIMIT_BYTES = 64 * 1024 * 1024;

export class WorkflowStateStore {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: WorkflowStateStoreDeps = {}) {}

  get<T = unknown>(workflowId: string, key: string, schema?: z.ZodType<T>): T | undefined {
    const index = this.loadIndex(workflowId);
    const entry = index.entries[key];
    if (!entry) return undefined;
    if (isExpired(entry)) {
      this.deleteFromIndex(workflowId, key, entry, index);
      return undefined;
    }
    const valuePath = this.valuePath(workflowId, entry.hash);
    if (!fs.existsSync(valuePath)) return undefined;
    const decoded: unknown = JSON.parse(readEncryptedFileSync(valuePath));
    const validated = StateValueFileSchema.safeParse(decoded);
    if (!validated.success) return undefined;
    const parsed: StateValueFile = validated.data;
    if (parsed.key !== key) return undefined;
    if (isExpired(parsed)) {
      this.deleteFromIndex(workflowId, key, entry, index);
      return undefined;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the schema-less generic overload is a caller-selected deserialization contract
    if (!schema) return parsed.value as T;
    const result = schema.safeParse(parsed.value);
    if (!result.success) {
      throw new WorkflowStoreSchemaError(
        `Persistent workflow state key '${key}' failed schema validation: ${result.error.message}`,
      );
    }
    return result.data;
  }

  getEntry<T = unknown>(
    workflowId: string,
    key: string,
    schema?: z.ZodType<T>,
  ): WorkflowStateValue<T> | undefined {
    const value = this.get<T>(workflowId, key, schema);
    if (value === undefined) return undefined;
    const entry = this.loadIndex(workflowId).entries[key];
    if (!entry || isExpired(entry)) return undefined;
    return { ...toEntrySummary(key, entry), value };
  }

  async put(
    workflowId: string,
    key: string,
    value: unknown,
    opts: { ttlMs?: number; runId?: string } = {},
  ): Promise<StoreWriteResult> {
    return this.enqueue(workflowId, key, () => this.writeValue(workflowId, key, value, opts));
  }

  async patch<T = unknown>(
    workflowId: string,
    key: string,
    fn: (prev: T | undefined) => T,
    schema?: z.ZodType<T>,
    opts: { ttlMs?: number; runId?: string } = {},
  ): Promise<{ value: T; write: StoreWriteResult }> {
    return this.enqueue(workflowId, key, async () => {
      const previous = this.get<T>(workflowId, key, schema);
      const value = fn(previous);
      const write = await this.writeValue(workflowId, key, value, opts);
      return { value, write };
    });
  }

  async delete(workflowId: string, key: string): Promise<void> {
    await this.enqueue(workflowId, key, async () => {
      const index = this.loadIndex(workflowId);
      const entry = index.entries[key];
      if (!entry) return;
      const nextEntries = { ...index.entries };
      delete nextEntries[key];
      this.saveIndex(workflowId, { schemaVersion: 1, entries: nextEntries });
      try {
        fs.rmSync(this.valuePath(workflowId, entry.hash), { force: true });
      } catch {
        /* ignore stale file cleanup */
      }
    });
  }

  listKeys(workflowId: string, prefix?: string): readonly string[] {
    return this.listEntries(workflowId, prefix).map((entry) => entry.key);
  }

  listEntries(workflowId: string, prefix?: string): readonly WorkflowStateEntry[] {
    const index = this.loadIndex(workflowId);
    const now = Date.now();
    const expired: Array<[string, StateIndexEntry]> = [];
    const entries: WorkflowStateEntry[] = [];
    for (const [key, entry] of Object.entries(index.entries)) {
      if (isExpiredAt(entry, now)) {
        expired.push([key, entry]);
        continue;
      }
      if (prefix && !key.startsWith(prefix)) continue;
      entries.push(toEntrySummary(key, entry));
    }
    if (expired.length > 0) this.deleteEntriesFromIndex(workflowId, expired, index);
    return entries.sort((a, b) => a.key.localeCompare(b.key));
  }

  async compact(
    workflowId: string,
    opts: WorkflowStateCompactionOptions = {},
  ): Promise<WorkflowStateCompactionResult> {
    return this.enqueue(workflowId, "__compact__", () => {
      const index = this.loadIndex(workflowId);
      const now = Date.now();
      const olderThanCutoff =
        opts.olderThanMs !== undefined ? now - Math.max(0, opts.olderThanMs) : undefined;
      const matched = Object.entries(index.entries).filter(([key]) =>
        opts.prefix ? key.startsWith(opts.prefix) : true,
      );
      const toDelete: Array<[string, StateIndexEntry]> = [];
      for (const [key, entry] of matched) {
        if (opts.limit !== undefined && toDelete.length >= opts.limit) break;
        if (
          isExpiredAt(entry, now) ||
          (olderThanCutoff !== undefined && entry.writtenAt < olderThanCutoff)
        ) {
          toDelete.push([key, entry]);
        }
      }
      this.deleteEntriesFromIndex(workflowId, toDelete, index);
      return {
        scanned: matched.length,
        deleted: toDelete.length,
        bytesFreed: toDelete.reduce((sum, [, entry]) => sum + entry.sizeBytes, 0),
        deletedKeys: toDelete.map(([key]) => key),
      };
    });
  }

  private async writeValue(
    workflowId: string,
    key: string,
    value: unknown,
    opts: { ttlMs?: number; runId?: string },
  ): Promise<StoreWriteResult> {
    const hash = hashKey(key);
    const writtenAt = Date.now();
    const scrubbed = scrubStateValue(value);
    const body: StateValueFile = {
      schemaVersion: 1,
      key,
      value: scrubbed.value,
      writtenAt,
      ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      hash,
    };
    const serialized = JSON.stringify(body, null, 2);
    const sizeBytes = Buffer.byteLength(serialized, "utf-8");
    if (sizeBytes > VALUE_LIMIT_BYTES) {
      throw new StoreQuotaExceededError(
        `Persistent workflow state key '${key}' is ${sizeBytes} bytes; limit is ${VALUE_LIMIT_BYTES}.`,
      );
    }
    const index = this.loadIndex(workflowId);
    const nextEntries: Record<string, StateIndexEntry> = {
      ...index.entries,
      [key]: {
        hash,
        sizeBytes,
        writtenAt,
        ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
        ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      },
    };
    const total = Object.values(nextEntries).reduce((sum, entry) => sum + entry.sizeBytes, 0);
    if (total > WORKFLOW_LIMIT_BYTES) {
      throw new StoreQuotaExceededError(
        `Persistent workflow state for '${workflowId}' would use ${total} bytes; limit is ${WORKFLOW_LIMIT_BYTES}.`,
      );
    }
    fs.mkdirSync(this.valuesDir(workflowId), { recursive: true, mode: 0o700 });
    writeEncryptedFileSync(this.valuePath(workflowId, hash), serialized);
    this.saveIndex(workflowId, { schemaVersion: 1, entries: nextEntries });
    return { key, sizeBytes, hash, scrubHits: scrubbed.scrubHits };
  }

  private enqueue<T>(workflowId: string, key: string, fn: () => Promise<T> | T): Promise<T> {
    const queueKey = `${workflowId}:${key}`;
    const previous = this.queues.get(queueKey) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const stored = next.catch(() => undefined);
    this.queues.set(
      queueKey,
      stored.finally(() => {
        if (this.queues.get(queueKey) === stored) this.queues.delete(queueKey);
      }),
    );
    return next;
  }

  private workflowDir(workflowId: string): string {
    return path.join(this.rootDir(), sanitizeArtifactSegment(workflowId));
  }

  private valuesDir(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), "values");
  }

  private valuePath(workflowId: string, hash: string): string {
    return path.join(this.valuesDir(workflowId), `${hash}.json`);
  }

  private indexPath(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), "index.json");
  }

  private rootDir(): string {
    if (!this.deps.rootDir) return path.join(getAppDataDir(), "marshal-workflow-state");
    return path.join(path.dirname(this.deps.rootDir), "marshal-workflow-state");
  }

  private loadIndex(workflowId: string): StateIndex {
    const file = this.indexPath(workflowId);
    if (!fs.existsSync(file)) return { schemaVersion: 1, entries: {} };
    try {
      const decoded: unknown = JSON.parse(readEncryptedFileSync(file));
      const parsed = StateIndexSchema.safeParse(decoded);
      return parsed.success ? parsed.data : { schemaVersion: 1, entries: {} };
    } catch {
      return { schemaVersion: 1, entries: {} };
    }
  }

  private saveIndex(workflowId: string, index: StateIndex): void {
    fs.mkdirSync(this.workflowDir(workflowId), { recursive: true, mode: 0o700 });
    writeEncryptedFileSync(this.indexPath(workflowId), JSON.stringify(index, null, 2));
  }

  private deleteFromIndex(
    workflowId: string,
    key: string,
    entry: StateIndexEntry,
    index: StateIndex,
  ): void {
    this.deleteEntriesFromIndex(workflowId, [[key, entry]], index);
  }

  private deleteEntriesFromIndex(
    workflowId: string,
    entries: ReadonlyArray<readonly [string, StateIndexEntry]>,
    index: StateIndex,
  ): void {
    if (entries.length === 0) return;
    const nextEntries = { ...index.entries };
    for (const [key] of entries) delete nextEntries[key];
    this.saveIndex(workflowId, { schemaVersion: 1, entries: nextEntries });
    for (const [, entry] of entries) {
      try {
        fs.rmSync(this.valuePath(workflowId, entry.hash), { force: true });
      } catch {
        /* ignore stale file cleanup */
      }
    }
  }
}

function hashKey(key: string): string {
  return createHash("sha1").update(key).digest("hex");
}

function isExpired(entry: { writtenAt: number; ttlMs?: number }): boolean {
  return isExpiredAt(entry, Date.now());
}

function isExpiredAt(entry: { writtenAt: number; ttlMs?: number }, now: number): boolean {
  return entry.ttlMs !== undefined && now > entry.writtenAt + entry.ttlMs;
}

function toEntrySummary(key: string, entry: StateIndexEntry): WorkflowStateEntry {
  return {
    key,
    sizeBytes: entry.sizeBytes,
    writtenAt: entry.writtenAt,
    ...(entry.ttlMs !== undefined
      ? { ttlMs: entry.ttlMs, expiresAt: entry.writtenAt + entry.ttlMs }
      : {}),
    ...(entry.runId !== undefined ? { runId: entry.runId } : {}),
  };
}

function scrubStateValue(value: unknown): {
  value: unknown;
  scrubHits: Readonly<Record<string, number>>;
} {
  if (typeof value !== "string") return { value, scrubHits: {} };
  const scrubbed = scrubCredentials(value);
  return { value: scrubbed.text, scrubHits: scrubbed.hits };
}
