/**
 * Filesystem-backed local memory store.
 *
 * Persists to `~/.marshal/marshal-memory.json`.
 * Supports keyword search and manual category assignment.
 *
 * Selected directly by the local memory provider. Strategy selection remains
 * outside this store, so persistence has no provider branching here.
 */

import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

import type { MemoryEntry, MemoryCategory, MemorySettings } from "@common/marshal-ipc-contract";
import { z } from "zod";

import { createLogger } from "../common/marshal-logger";
import { getAppDataDir } from "./app-paths";
import type {
  IMemoryStore,
  MemoryAddOptions,
  MemoryPromptSelectionRequest,
  MemoryRecallOptions,
} from "./backend/ports";
import {
  planFallbackMemoryAdd,
  rankMemoriesByKeywords,
  touchMemory,
} from "./marshal-runtime/memory/fallback-memory-ops";
import { createdAtWithin } from "./marshal-runtime/memory/memory-scoping";
import { formatMemoryPromptFromStore } from "./marshal-runtime/memory/prompt-selection";
import { readEncryptedFileSync, writeEncryptedFile } from "./safe-storage-file";

export type { MemoryEntry, MemoryCategory, MemorySettings };

const log = createLogger("FilesystemMemoryStore");

// File paths (for file-based system)
const MEMORY_DIR = getAppDataDir();
const MEMORY_FILE = path.join(MEMORY_DIR, "marshal-memory.json");
const SETTINGS_FILE = path.join(MEMORY_DIR, "marshal-memory-settings.json");

// ── Zod Schemas ──────────────────────────────────────────────────────────────

const MemoryEntrySchema = z
  .object({
    id: z.string(),
    fact: z.string(),
    category: z.enum(["preference", "fact", "decision", "context"]).default("fact"),
    source: z.string(),
    createdAt: z.string(),
    lastAccessedAt: z.string(),
    accessCount: z.number(),
    appliesTo: z.string().optional(),
  })
  .strip();

const MemorySettingsSchema = z
  .object({
    maxMemories: z.number().default(200),
    decayDays: z.number().default(60),
  })
  .strip();

// Schema for the partial shape used during memory import
const ImportedMemorySchema = z
  .object({
    fact: z.string().min(1),
    category: z.enum(["preference", "fact", "decision", "context"]).optional(),
    source: z.string().optional(),
    createdAt: z.string().optional(),
  })
  .strip();

// Schema for the top-level export envelope (SF-4: drop unknown keys)
const MemoryExportSchema = z
  .object({
    memories: z.array(z.unknown()).default([]),
    settings: z.unknown().optional(),
    exportedAt: z.string().optional(),
  })
  .strip();

/** Candidate field names for the memory text, checked in priority order */
const FACT_FIELDS = ["fact", "content", "text", "memory", "description"] as const;
/** Candidate field names for category / tag. First matching tag wins for arrays. */
const CATEGORY_FIELDS = ["category", "tags", "type", "label", "kind"] as const;
/** Candidate field names for creation date */
const DATE_FIELDS = ["createdAt", "created_at", "timestamp", "date", "created"] as const;
/** Candidate field names for source / origin */
const SOURCE_FIELDS = ["source", "origin", "provider"] as const;

/** Well-known category synonyms from various AI assistants → Marshal category */
const CATEGORY_ALIAS_MAP: Record<string, MemoryCategory> = {
  preference: "preference",
  fact: "fact",
  decision: "decision",
  context: "context",
  profile: "context",
  personal: "context",
  instruction: "preference",
  rule: "decision",
  note: "fact",
  insight: "fact",
  observation: "fact",
};

/** Pick the first string-valued field from `obj` matching one of `keys`. */
function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return undefined;
}

type NormalizedMemory = {
  fact: string;
  category?: MemoryCategory;
  createdAt?: string;
  source?: string;
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

/**
 * Normalize a foreign memory entry into Marshal's ImportedMemory shape.
 * Handles exports from Claude, ChatGPT, Gemini, and other assistants by
 * probing well-known field names.
 * Returns null if the entry cannot be normalized (no recognizable fact text).
 */
function normalizeMemoryEntry(raw: unknown): NormalizedMemory | null {
  if (!isRecord(raw)) return null;

  const fact = pickString(raw, FACT_FIELDS);
  if (!fact) return null;

  const result: NormalizedMemory = { fact };

  let rawCategory: string | undefined;
  for (const k of CATEGORY_FIELDS) {
    const val = raw[k];
    if (typeof val === "string" && val.length > 0) {
      rawCategory = val;
      break;
    }
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === "string") {
      rawCategory = val[0];
      break;
    }
  }
  if (rawCategory) {
    const key = rawCategory.toLowerCase();
    result.category = Object.hasOwn(CATEGORY_ALIAS_MAP, key) ? CATEGORY_ALIAS_MAP[key] : "fact";
  }

  const date = pickString(raw, DATE_FIELDS);
  if (date) result.createdAt = date;

  const source = pickString(raw, SOURCE_FIELDS);
  if (source) result.source = source;

  return result;
}

const DEFAULT_SETTINGS: MemorySettings = {
  maxMemories: 200,
  decayDays: 60,
};

// ── File I/O ──────────────────────────────────────────────────────────────

function loadMemories(): MemoryEntry[] {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      // SF-4: validated against MemoryEntrySchema via safeParse below
      const data = JSON.parse(readEncryptedFileSync(MEMORY_FILE));
      if (!Array.isArray(data)) {
        log.warn("Memories file is not an array, using empty array");
        return [];
      }
      const memories: MemoryEntry[] = [];
      for (const entry of data) {
        const result = MemoryEntrySchema.safeParse(entry);
        if (result.success) {
          memories.push(result.data);
        } else {
          log.warn("Skipping invalid memory entry:", result.error.format());
        }
      }
      return memories;
    }
  } catch (err) {
    log.error("Failed to load memories:", err);
  }
  return [];
}

let pendingWrite: Promise<void> = Promise.resolve();

function saveMemories(memories: MemoryEntry[], rotateBackup = false) {
  const json = JSON.stringify(memories, null, 2);
  pendingWrite = pendingWrite
    .then(() => {
      try {
        const dir = path.dirname(MEMORY_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        log.warn("Failed to create memory dir:", err);
      }
    })
    .then(() => writeEncryptedFile(MEMORY_FILE, json))
    .then(() => (rotateBackup ? writeEncryptedFile(MEMORY_FILE, json) : undefined))
    .catch((err) => log.error("Failed to save memories:", err));
}

function loadMemorySettings(): MemorySettings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(readEncryptedFileSync(SETTINGS_FILE));
      const result = MemorySettingsSchema.safeParse(data);
      if (result.success) return result.data;
      log.warn("Memory settings invalid, using defaults:", result.error.format());
    }
  } catch (err) {
    log.error("Failed to load memory settings:", err);
  }
  return { ...DEFAULT_SETTINGS };
}

/** Resolves when any in-flight settings write completes. Call from before-quit. */
export function flushMemoryWrite(): Promise<void> {
  return pendingWrite;
}

// ──────────────────────────────────────────────────────────────────────────────

export interface FilesystemMemoryRuntimeAcceptanceControl {
  readonly addFailure?: string;
  readonly recallFailure?: string;
  readonly recallDelayMs?: number;
}

export interface FilesystemMemoryRuntimeAcceptanceDiagnostics {
  readonly [key: string]: number;
  readonly addAttempts: number;
  readonly recallStarted: number;
  readonly recallCompleted: number;
  readonly recallFailed: number;
  readonly recallPending: number;
}

export class FilesystemMemoryStore implements IMemoryStore {
  private memories: MemoryEntry[];
  private settings: MemorySettings;
  private runtimeAcceptanceControl: FilesystemMemoryRuntimeAcceptanceControl | null = null;
  private runtimeAcceptanceDiagnostics: FilesystemMemoryRuntimeAcceptanceDiagnostics = {
    addAttempts: 0,
    recallStarted: 0,
    recallCompleted: 0,
    recallFailed: 0,
    recallPending: 0,
  };

  constructor() {
    // Start from defaults — do NOT read from disk here. loadMemories/
    // loadMemorySettings go through safeStorage, and a first safeStorage access
    // before app.whenReady() locks the macOS keychain item name to "Chromium
    // Safe Storage" (Electron #45328). reload() performs the deferred read once,
    // post-app-ready (called from main.ts inside app.whenReady()).
    this.memories = [];
    this.settings = { ...DEFAULT_SETTINGS };
  }

  reload(): void {
    this.memories = loadMemories();
    this.settings = loadMemorySettings();
  }

  list(): MemoryEntry[] {
    return [...this.memories];
  }

  count(): number {
    return this.list().length;
  }

  configureRuntimeAcceptanceBoundary(
    control: FilesystemMemoryRuntimeAcceptanceControl | null,
  ): FilesystemMemoryRuntimeAcceptanceDiagnostics {
    this.runtimeAcceptanceControl = control;
    this.runtimeAcceptanceDiagnostics = {
      addAttempts: 0,
      recallStarted: 0,
      recallCompleted: 0,
      recallFailed: 0,
      recallPending: 0,
    };
    return this.getRuntimeAcceptanceDiagnostics();
  }

  getRuntimeAcceptanceDiagnostics(): FilesystemMemoryRuntimeAcceptanceDiagnostics {
    return { ...this.runtimeAcceptanceDiagnostics };
  }

  seedRuntimeAcceptanceRawMemory(
    fact: string,
    category: MemoryCategory,
    source: string,
  ): MemoryEntry {
    const normalized = fact.trim();
    if (normalized.length <= 500 || normalized.length > 2_048) {
      throw new RangeError("Raw acceptance memory must contain between 501 and 2,048 characters.");
    }
    if (!source.startsWith("marshal-runtime:v1:")) {
      throw new Error("Raw acceptance memory requires Marshal Runtime scope attribution.");
    }
    const entry = this.createMemoryEntry(normalized, category, source);
    this.memories.push(entry);
    this.enforceCapAndDecay();
    saveMemories(this.memories);
    return { ...entry };
  }

  add(
    fact: string,
    category: MemoryCategory = "fact",
    source: string = "session",
    options?: MemoryAddOptions,
  ): MemoryEntry | null {
    if (this.runtimeAcceptanceControl) {
      this.runtimeAcceptanceDiagnostics = {
        ...this.runtimeAcceptanceDiagnostics,
        addAttempts: this.runtimeAcceptanceDiagnostics.addAttempts + 1,
      };
      if (this.runtimeAcceptanceControl.addFailure) {
        throw Object.assign(new Error(this.runtimeAcceptanceControl.addFailure), {
          code: "operation_failed",
        });
      }
    }
    const normalized = fact.trim().slice(0, 500);
    if (!normalized) return null;
    const plan = planFallbackMemoryAdd(this.memories, normalized, options);
    this.memories = plan.memories;
    if (plan.duplicate) {
      touchMemory(plan.duplicate);
      saveMemories(this.memories);
      return { ...plan.duplicate };
    }

    const entry = this.createMemoryEntry(normalized, category, source);
    if (plan.appliesTo) entry.appliesTo = plan.appliesTo;
    this.memories.push(entry);
    this.enforceCapAndDecay();
    saveMemories(this.memories);

    return { ...entry };
  }

  async delete(id: string): Promise<boolean> {
    return (await this.deleteMany([id])) > 0;
  }

  async deleteMany(ids: readonly string[]): Promise<number> {
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => !ids.includes(m.id));
    if (this.memories.length < before) saveMemories(this.memories, true);
    return before - this.memories.length;
  }

  clear(): void {
    void this.deleteMany(this.memories.map((m) => m.id));
  }

  addBatch(entries: Array<{ fact: string; source?: string }>, source?: string): MemoryEntry[] {
    // Batch optimization: collect all entries, deduplicate once, then apply cap-and-decay once.
    // Prevents O(N²) sorts—each this.add() call previously invoked enforceCapAndDecay().
    const added: MemoryEntry[] = [];

    for (const entry of entries) {
      const normalized = entry.fact.trim().slice(0, 500);
      if (!normalized) continue;

      const key = normalized.toLowerCase();
      const existing = this.memories.find((m) => m.fact.toLowerCase() === key);

      if (existing) {
        // Touch existing entry
        existing.lastAccessedAt = new Date().toISOString();
        existing.accessCount++;
        added.push({ ...existing });
      } else {
        // Create new entry
        const newEntry = this.createMemoryEntry(
          normalized,
          "fact",
          entry.source ?? source ?? "batch",
        );
        this.memories.push(newEntry);
        added.push(newEntry);
      }
    }

    // Apply cap and decay ONCE after all entries added, then save ONCE
    if (added.length > 0) {
      this.enforceCapAndDecay();
      saveMemories(this.memories);
    }

    return added;
  }

  async recall(
    query: string,
    limit: number = 20,
    _source?: string,
    options?: MemoryRecallOptions,
  ): Promise<MemoryEntry[]> {
    const inWindow = createdAtWithin(options);
    const control = this.runtimeAcceptanceControl;
    if (control) {
      this.runtimeAcceptanceDiagnostics = {
        ...this.runtimeAcceptanceDiagnostics,
        recallStarted: this.runtimeAcceptanceDiagnostics.recallStarted + 1,
        recallPending: this.runtimeAcceptanceDiagnostics.recallPending + 1,
      };
      try {
        if (control.recallDelayMs && control.recallDelayMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, control.recallDelayMs));
        }
        if (control.recallFailure) {
          throw Object.assign(new Error(control.recallFailure), {
            code: "operation_failed",
          });
        }
      } catch (error) {
        this.runtimeAcceptanceDiagnostics = {
          ...this.runtimeAcceptanceDiagnostics,
          recallFailed: this.runtimeAcceptanceDiagnostics.recallFailed + 1,
          recallPending: this.runtimeAcceptanceDiagnostics.recallPending - 1,
        };
        throw error;
      }
    }
    const normalized = query.toLowerCase().split(/\s+/).filter(Boolean);

    const results =
      normalized.length === 0
        ? this.getRecent(this.memories.length).filter(inWindow).slice(0, limit)
        : rankMemoriesByKeywords(this.memories.filter(inWindow), normalized, limit);

    if (results.length > 0) {
      saveMemories(this.memories);
    }

    if (control) {
      this.runtimeAcceptanceDiagnostics = {
        ...this.runtimeAcceptanceDiagnostics,
        recallCompleted: this.runtimeAcceptanceDiagnostics.recallCompleted + 1,
        recallPending: this.runtimeAcceptanceDiagnostics.recallPending - 1,
      };
    }
    return results;
  }

  getRecent(n: number): MemoryEntry[] {
    const recentList = this.memories
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => {
        const timeA = new Date(b.entry.lastAccessedAt).getTime();
        const timeB = new Date(a.entry.lastAccessedAt).getTime();
        if (timeA !== timeB) return timeA - timeB;
        // Tiebreaker: use insertion order (later insertions are more recent)
        return b.index - a.index;
      })
      .map(({ entry }) => entry)
      .slice(0, n);
    return recentList;
  }

  async retrieveSemanticSubset(query: string, limit?: number): Promise<MemoryEntry[]> {
    // No-op: delegate to keyword search
    return this.recall(query, limit ?? 20);
  }

  export(): string {
    const exported = {
      memories: this.memories.map(
        ({ id, fact, category, source, createdAt, lastAccessedAt, accessCount }) => ({
          id,
          fact,
          category,
          source,
          createdAt,
          lastAccessedAt,
          accessCount,
        }),
      ),
      settings: this.settings,
      exportedAt: new Date().toISOString(),
    };
    return JSON.stringify(exported, null, 2);
  }

  import(jsonStr: string): { added: number; skipped: number } {
    // SF-4: validated against MemoryExportSchema via safeParse below
    let data = JSON.parse(jsonStr);
    if (Array.isArray(data)) {
      data = { memories: data };
    }

    const envelopeResult = MemoryExportSchema.safeParse(data);
    if (!envelopeResult.success) {
      throw new Error("Invalid memory export format");
    }

    const imported: unknown[] = envelopeResult.data.memories;
    let added = 0;
    let skipped = 0;

    for (const raw of imported) {
      const normalized = normalizeMemoryEntry(raw);
      if (!normalized) {
        skipped++;
        continue;
      }

      const parsedEntry = ImportedMemorySchema.safeParse(normalized);
      if (!parsedEntry.success) {
        skipped++;
        continue;
      }

      const entry = parsedEntry.data;
      const fact = entry.fact.trim().slice(0, 500);

      try {
        const isDuplicate = this.memories.some((m) => m.fact.toLowerCase() === fact.toLowerCase());
        if (isDuplicate) {
          skipped++;
          continue;
        }

        const created = this.add(fact, entry.category ?? "fact", entry.source ?? "import");
        if (created) {
          added++;
        } else {
          skipped++;
        }
      } catch (err) {
        log.warn("Failed to add imported memory:", err);
        skipped++;
      }
    }

    return { added, skipped };
  }

  async initializeSessionStart(_localMemories?: MemoryEntry[]): Promise<void> {
    // No-op: the filesystem store does not require remote bootstrap.
  }

  formatForSystemPrompt(request?: Partial<MemoryPromptSelectionRequest>): string {
    return formatMemoryPromptFromStore(this, request);
  }

  // ─────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────

  private enforceCapAndDecay(): void {
    const now = Date.now();
    const decayMs = this.settings.decayDays * 24 * 60 * 60 * 1000;

    this.memories = this.memories.filter((m) => {
      const age = now - new Date(m.lastAccessedAt).getTime();
      return age < decayMs;
    });

    if (this.memories.length > this.settings.maxMemories) {
      this.memories.sort(
        (a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime(),
      );
      this.memories = this.memories.slice(0, this.settings.maxMemories);
    }
  }

  private createMemoryEntry(fact: string, category: MemoryCategory, source: string): MemoryEntry {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      fact,
      category,
      source,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
    };
  }
}

export { loadMemorySettings };
