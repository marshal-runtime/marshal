import * as fs from "node:fs";
import * as path from "node:path";

import { createLogger } from "../../common/marshal-logger";
import type {
  WorkflowScheduleCursor,
  WorkflowScheduleSummary,
} from "../../common/workflows-contract";
import { getAppDataDir } from "../app-paths";
import type { StrictAutomationSchedule } from "../automations/domain/contracts";
import { formatScheduleNL, parseSchedule } from "../automations/schedule";
import {
  addLocalDays,
  findDueScheduleOccurrence,
  startOfLocalDay,
} from "../automations/triggering";
import { secureAtomicWriteFileSync } from "../platform-security";
import type { InstalledWorkflowEntry } from "./workflow-loader";
import type { RunStartResult } from "./workflow-run-manager";

const log = createLogger("WorkflowScheduler");
const SCHEDULES_FILE = "schedules.json";
const CHECK_INTERVAL_MS = 60_000;
const WORKFLOW_SCHEDULE_PARSER = "electron/automations/parseSchedule" as const;
const QUARANTINE_RETRY_DELAYS_MS = [0, 25, 75] as const;
const RESTORE_RETRY_INITIAL_DELAY_MS = 1_000;
const RESTORE_RETRY_MAX_DELAY_MS = 60_000;

class WorkflowScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowScheduleValidationError";
  }
}

export interface WorkflowScheduleRecord {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly workflowId: string;
  readonly repoPath?: string;
  readonly workspaceName?: string;
  readonly naturalLanguage: string;
  readonly schedule: StrictAutomationSchedule;
  readonly enabled: boolean;
  readonly input?: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastCheckedAt?: number;
  readonly lastTriggeredAt?: number;
  readonly lastOccurrenceAt?: number;
  readonly lastRunId?: string;
  readonly incremental?: WorkflowScheduleCursor;
}

const WORKFLOW_SCHEDULE_RECORD_KNOWN_FIELDS = new Set([
  "schemaVersion",
  "key",
  "workflowId",
  "repoPath",
  "workspaceName",
  "naturalLanguage",
  "schedule",
  "enabled",
  "input",
  "createdAt",
  "updatedAt",
  "lastCheckedAt",
  "lastTriggeredAt",
  "lastOccurrenceAt",
  "lastRunId",
  "incremental",
]);
const WORKFLOW_SCHEDULE_CURSOR_KNOWN_FIELDS = new Set([
  "shiftId",
  "shiftStartAt",
  "coveredThrough",
  "active",
  "lastRunId",
  "updatedAt",
  "data",
]);

export interface WorkflowScheduleTrigger {
  readonly occurrenceAt: number;
  readonly checkedAt: number;
}

export interface WorkflowScheduleStoreDeps {
  readonly rootDir?: string;
  readonly renameSync?: typeof fs.renameSync;
  readonly sleepSync?: (ms: number) => void;
  readonly readTextFileSync?: (filePath: string) => string;
  readonly atomicWriteFileSync?: typeof secureAtomicWriteFileSync;
}

interface WorkflowScheduleStoreState {
  readonly records: WorkflowScheduleRecord[];
  readonly unsupportedRows: unknown[];
  readonly unsupportedKeys: ReadonlySet<string>;
}

function rootOf(deps: WorkflowScheduleStoreDeps): string {
  return deps.rootDir ?? path.join(getAppDataDir(), "marshal-workflow-schedules");
}

function schedulePath(deps: WorkflowScheduleStoreDeps): string {
  return path.join(rootOf(deps), SCHEDULES_FILE);
}

export class WorkflowScheduleStore {
  constructor(private readonly deps: WorkflowScheduleStoreDeps = {}) {}

  list(options: { includeDisabled?: boolean } = {}): WorkflowScheduleRecord[] {
    const records = this.readState().records;
    return options.includeDisabled ? records : records.filter((record) => record.enabled);
  }

  get(key: string): WorkflowScheduleRecord | null {
    return this.list().find((record) => record.key === key) ?? null;
  }

  upsert(input: {
    key: string;
    workflowId: string;
    repoPath?: string;
    workspaceName?: string;
    naturalLanguage: string;
    input?: unknown;
    enabled?: boolean;
    resetIncremental?: boolean;
  }): WorkflowScheduleRecord {
    const schedule = parseSchedule(input.naturalLanguage);
    if (!schedule) {
      throw new WorkflowScheduleValidationError(
        `Could not parse schedule: "${input.naturalLanguage}"`,
      );
    }
    const state = this.readState();
    if (state.unsupportedKeys.has(input.key)) {
      throw new WorkflowScheduleValidationError(
        `Workflow schedule uses an unsupported schema version: ${input.key}`,
      );
    }
    const now = Date.now();
    const existing = state.records.find((record) => record.key === input.key);
    const record: WorkflowScheduleRecord = {
      schemaVersion: 1,
      key: input.key,
      workflowId: input.workflowId,
      repoPath: input.repoPath,
      workspaceName: input.workspaceName,
      naturalLanguage: input.naturalLanguage,
      schedule,
      enabled: input.enabled ?? existing?.enabled ?? true,
      input: input.input ?? existing?.input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastCheckedAt: existing?.lastCheckedAt,
      lastTriggeredAt: existing?.lastTriggeredAt,
      lastOccurrenceAt: existing?.lastOccurrenceAt,
      lastRunId: existing?.lastRunId,
      incremental: input.resetIncremental ? undefined : existing?.incremental,
    };
    this.save(
      [record, ...state.records.filter((row) => row.key !== record.key)],
      state.unsupportedRows,
    );
    return record;
  }

  patch(key: string, patch: Partial<WorkflowScheduleRecord>): WorkflowScheduleRecord | null {
    const state = this.readState();
    const rows = state.records;
    const idx = rows.findIndex((row) => row.key === key);
    if (idx === -1) return null;
    rows[idx] = { ...rows[idx], ...patch, updatedAt: Date.now() };
    this.save(rows, state.unsupportedRows);
    return rows[idx];
  }

  disable(key: string): WorkflowScheduleRecord | null {
    return this.patch(key, { enabled: false });
  }

  advanceIncrementalCursor(
    key: string,
    cursor: WorkflowScheduleCursor,
  ): { previous?: WorkflowScheduleCursor; next: WorkflowScheduleCursor } {
    const existing = this.get(key);
    if (!existing) throw new Error(`Workflow schedule not found: ${key}`);
    const next = { ...cursor, updatedAt: cursor.updatedAt ?? Date.now() };
    this.patch(key, { incremental: next });
    return { previous: existing.incremental, next };
  }

  syncManifestDefaults(entries: readonly InstalledWorkflowEntry[]): number {
    const entryScheduleByKey = new Map(
      entries.map((entry) => [entry.key, entry.manifest.schedule?.trim() ?? ""] as const),
    );
    const state = this.readState();
    const rows = state.records;
    const retainedRows = rows.filter(
      (row) => row.enabled || (entryScheduleByKey.get(row.key)?.length ?? 0) > 0,
    );
    if (retainedRows.length !== rows.length) {
      this.save(retainedRows, state.unsupportedRows);
    }
    const existing = new Set([...retainedRows.map((row) => row.key), ...state.unsupportedKeys]);
    let added = 0;
    for (const entry of entries) {
      const schedule = entryScheduleByKey.get(entry.key);
      if (!schedule || existing.has(entry.key)) continue;
      try {
        this.upsert({
          key: entry.key,
          workflowId: entry.id,
          repoPath: entry.repoPath,
          workspaceName: entry.workspaceName,
          naturalLanguage: schedule,
          enabled: true,
        });
        existing.add(entry.key);
        added++;
      } catch (error) {
        if (!(error instanceof WorkflowScheduleValidationError)) throw error;
        log.warn(`Ignoring invalid manifest schedule for ${entry.id}:`, error);
      }
    }
    return added;
  }

  private readState(): WorkflowScheduleStoreState {
    const file = schedulePath(this.deps);
    let content: string;
    try {
      content = this.deps.readTextFileSync?.(file) ?? fs.readFileSync(file, "utf-8");
    } catch (error) {
      if (isMissingFileError(error)) return emptyScheduleStoreState();
      log.error("Failed to read workflow schedule store:", error);
      throw new Error("Failed to read workflow schedule store", { cause: error });
    }
    try {
      if (content.trim().length === 0) {
        throw new Error("Workflow schedule store is empty");
      }
      // SF-4: the top-level array and every persisted row are validated before use.
      const raw = JSON.parse(content) as unknown;
      if (!Array.isArray(raw)) {
        throw new Error("Workflow schedule store must contain a JSON array");
      }
      const records: WorkflowScheduleRecord[] = [];
      const unsupportedRows: unknown[] = [];
      const unsupportedKeys = new Set<string>();
      for (const row of raw) {
        if (isUnsupportedScheduleRow(row)) {
          unsupportedRows.push(row);
          if (typeof row.key === "string") unsupportedKeys.add(row.key);
          continue;
        }
        const parsed = parseRecord(row);
        if (parsed) records.push(parsed);
      }
      return { records, unsupportedRows, unsupportedKeys };
    } catch (error) {
      this.recoverCorruptStore(file, error);
      return emptyScheduleStoreState();
    }
  }

  private save(
    records: readonly WorkflowScheduleRecord[],
    unsupportedRows: readonly unknown[],
  ): void {
    const atomicWriteFileSync = this.deps.atomicWriteFileSync ?? secureAtomicWriteFileSync;
    atomicWriteFileSync(
      schedulePath(this.deps),
      JSON.stringify([...records, ...unsupportedRows], null, 2),
      {
        encoding: "utf-8",
        mode: 0o600,
        directoryMode: 0o700,
      },
    );
  }

  private recoverCorruptStore(file: string, error: unknown): void {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const corruptPath = `${file}.corrupt-${timestamp}`;
    try {
      renameWithTransientRetries(
        this.deps.renameSync ?? fs.renameSync,
        this.deps.sleepSync ?? sleepSync,
        file,
        corruptPath,
      );
    } catch (archiveError) {
      log.error("Failed to archive unreadable workflow schedule store:", archiveError);
      throw new Error("Failed to archive unreadable workflow schedule store", {
        cause: archiveError,
      });
    }

    log.warn(
      `Archived unreadable workflow schedule store as ${path.basename(corruptPath)} and reset it:`,
      error,
    );
    try {
      this.save([], []);
    } catch (resetError) {
      log.error("Failed to reset workflow schedule store after archival:", resetError);
    }
  }
}

export interface WorkflowSchedulerDeps {
  readonly store?: WorkflowScheduleStore;
  readonly listEntries: () => InstalledWorkflowEntry[];
  readonly runScheduledWorkflow: (
    record: WorkflowScheduleRecord,
    trigger: WorkflowScheduleTrigger,
  ) => Promise<RunStartResult>;
  readonly hasActiveRunForKey: (key: string) => boolean;
}

export class WorkflowScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private restoreRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreRetryDelayMs = RESTORE_RETRY_INITIAL_DELAY_MS;
  private checking = false;
  private readonly inFlightKeys = new Set<string>();
  private readonly store: WorkflowScheduleStore;

  constructor(private readonly deps: WorkflowSchedulerDeps) {
    this.store = deps.store ?? new WorkflowScheduleStore();
  }

  restore(): void {
    try {
      this.store.syncManifestDefaults(this.deps.listEntries());
      this.clearRestoreRetry();
      if (this.store.list().some((record) => record.enabled)) this.start();
    } catch (error) {
      this.scheduleRestoreRetry();
      throw error;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.checkSchedules(), CHECK_INTERVAL_MS);
    log.info("Workflow scheduler started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearRestoreRetry();
  }

  list(): WorkflowScheduleSummary[] {
    return this.store.list().map(toSummary);
  }

  get(key: string): WorkflowScheduleSummary | null {
    const record = this.store.get(key);
    return record ? toSummary(record) : null;
  }

  update(args: {
    entry: InstalledWorkflowEntry;
    naturalLanguage: string;
    input?: unknown;
    enabled?: boolean;
  }): WorkflowScheduleSummary {
    const record = this.store.upsert({
      key: args.entry.key,
      workflowId: args.entry.id,
      repoPath: args.entry.repoPath,
      workspaceName: args.entry.workspaceName,
      naturalLanguage: args.naturalLanguage,
      input: args.input,
      enabled: args.enabled ?? true,
    });
    if (record.enabled) this.start();
    return toSummary(record);
  }

  disable(key: string): WorkflowScheduleSummary | null {
    const record = this.store.disable(key);
    return record ? toSummary(record) : null;
  }

  advanceIncrementalCursor(
    key: string,
    cursor: WorkflowScheduleCursor,
  ): { previous?: WorkflowScheduleCursor; next: WorkflowScheduleCursor } {
    const result = this.store.advanceIncrementalCursor(key, cursor);
    return result;
  }

  async checkSchedules(now = new Date()): Promise<RunStartResult[]> {
    if (this.checking) return [];
    this.checking = true;
    const started: RunStartResult[] = [];
    try {
      const records = this.store.list().filter((record) => record.enabled);
      const entryKeys = new Set(this.deps.listEntries().map((entry) => entry.key));
      for (const record of records) {
        const lastCheck = record.lastCheckedAt ? new Date(record.lastCheckedAt) : null;
        this.store.patch(record.key, { lastCheckedAt: now.getTime() });
        if (!entryKeys.has(record.key)) continue;
        const occurrence = findDueScheduleOccurrence(record.schedule, now, lastCheck);
        if (!occurrence) continue;
        if (this.inFlightKeys.has(record.key) || this.deps.hasActiveRunForKey(record.key)) continue;
        this.inFlightKeys.add(record.key);
        try {
          // eslint-disable-next-line no-await-in-loop -- schedule checks intentionally serialize start attempts so one bad workflow cannot fan out duplicate starts
          const result = await this.deps.runScheduledWorkflow(record, {
            occurrenceAt: occurrence.getTime(),
            checkedAt: now.getTime(),
          });
          this.store.patch(record.key, {
            lastTriggeredAt: now.getTime(),
            lastOccurrenceAt: occurrence.getTime(),
            lastRunId: result.runId,
          });
          started.push(result);
        } catch (err) {
          log.warn(`Scheduled workflow ${record.workflowId} failed to start:`, err);
        } finally {
          this.inFlightKeys.delete(record.key);
        }
      }
      return started;
    } finally {
      this.checking = false;
    }
  }

  private scheduleRestoreRetry(): void {
    if (this.restoreRetryTimer) return;
    const delayMs = this.restoreRetryDelayMs;
    this.restoreRetryDelayMs = Math.min(this.restoreRetryDelayMs * 2, RESTORE_RETRY_MAX_DELAY_MS);
    this.restoreRetryTimer = setTimeout(() => {
      this.restoreRetryTimer = null;
      try {
        this.restore();
      } catch (error) {
        log.warn("Workflow scheduler restore retry failed:", error);
      }
    }, delayMs);
  }

  private clearRestoreRetry(): void {
    if (this.restoreRetryTimer) {
      clearTimeout(this.restoreRetryTimer);
      this.restoreRetryTimer = null;
    }
    this.restoreRetryDelayMs = RESTORE_RETRY_INITIAL_DELAY_MS;
  }
}

function toSummary(record: WorkflowScheduleRecord): WorkflowScheduleSummary {
  return {
    key: record.key,
    workflowId: record.workflowId,
    naturalLanguage: record.naturalLanguage,
    enabled: record.enabled,
    parser: WORKFLOW_SCHEDULE_PARSER,
    normalized: summarizeSchedule(record.schedule),
    kind: record.schedule.kind,
    input: record.input,
    nextRunAt: record.enabled
      ? findNextScheduleOccurrence(record.schedule, new Date())?.getTime()
      : undefined,
    incremental: record.incremental,
    lastCheckedAt: record.lastCheckedAt,
    lastTriggeredAt: record.lastTriggeredAt,
    lastOccurrenceAt: record.lastOccurrenceAt,
    lastRunId: record.lastRunId,
  };
}

export function workflowScheduleRunContext(
  record: WorkflowScheduleRecord,
  trigger: WorkflowScheduleTrigger,
) {
  return {
    key: record.key,
    naturalLanguage: record.naturalLanguage,
    parser: WORKFLOW_SCHEDULE_PARSER,
    normalized: summarizeSchedule(record.schedule),
    kind: record.schedule.kind,
    occurrenceAt: trigger.occurrenceAt,
    checkedAt: trigger.checkedAt,
  };
}

function summarizeSchedule(schedule: StrictAutomationSchedule): string {
  switch (schedule.kind) {
    case "single":
      return formatScheduleNL(schedule.days, schedule.time.hour, schedule.time.minute);
    case "multi":
      return `${daysLabel(schedule.days)} at ${schedule.times.map(formatTime).join(", ")}`;
    case "interval":
      return `${intervalLabel(schedule.intervalMinutes)}${dayScopeSuffix(schedule.days)}`;
  }
  throw new Error("Unsupported workflow schedule kind");
}

function intervalLabel(intervalMinutes: number): string {
  if (intervalMinutes === 60) return "every hour";
  if (intervalMinutes % 60 === 0) return `every ${intervalMinutes / 60} hours`;
  return `every ${intervalMinutes} minutes`;
}

function daysLabel(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return "every day";
  if (arraysEqual(sorted, [1, 2, 3, 4, 5])) return "weekdays";
  if (arraysEqual(sorted, [0, 6])) return "weekends";
  const names = sorted.map(dayName);
  if (names.length <= 1) return names[0] ? `every ${names[0]}` : "every day";
  const last = names[names.length - 1];
  return `every ${names.slice(0, -1).join(", ")} and ${last}`;
}

function dayScopeSuffix(days: readonly number[]): string {
  const label = daysLabel(days);
  return label === "every day" ? "" : ` during ${label.replace(/^every\s+/, "")}`;
}

function formatTime(time: { hour: number; minute: number }): string {
  const period = time.hour < 12 ? "am" : "pm";
  const hour = time.hour === 0 ? 12 : time.hour > 12 ? time.hour - 12 : time.hour;
  return time.minute === 0
    ? `${hour}${period}`
    : `${hour}:${String(time.minute).padStart(2, "0")}${period}`;
}

function dayName(day: number): string {
  return ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][day] ?? "";
}

function arraysEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function parseRecord(value: unknown): WorkflowScheduleRecord | null {
  if (!isRecord(value)) return null;
  const row = pickKnownFields(value, WORKFLOW_SCHEDULE_RECORD_KNOWN_FIELDS);
  if (row.schemaVersion !== 1) return null;
  if (typeof row.key !== "string" || typeof row.workflowId !== "string") return null;
  if (typeof row.naturalLanguage !== "string") return null;
  const schedule = parseSchedule(row.naturalLanguage);
  if (!schedule) return null;
  return {
    schemaVersion: 1,
    key: row.key,
    workflowId: row.workflowId,
    repoPath: typeof row.repoPath === "string" ? row.repoPath : undefined,
    workspaceName: typeof row.workspaceName === "string" ? row.workspaceName : undefined,
    naturalLanguage: row.naturalLanguage,
    schedule,
    enabled: row.enabled !== false,
    input: row.input,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : Date.now(),
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : Date.now(),
    lastCheckedAt: typeof row.lastCheckedAt === "number" ? row.lastCheckedAt : undefined,
    lastTriggeredAt: typeof row.lastTriggeredAt === "number" ? row.lastTriggeredAt : undefined,
    lastOccurrenceAt: typeof row.lastOccurrenceAt === "number" ? row.lastOccurrenceAt : undefined,
    lastRunId: typeof row.lastRunId === "string" ? row.lastRunId : undefined,
    incremental: parseCursor(row.incremental),
  };
}

function emptyScheduleStoreState(): WorkflowScheduleStoreState {
  return {
    records: [],
    unsupportedRows: [],
    unsupportedKeys: new Set<string>(),
  };
}

function isUnsupportedScheduleRow(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.schemaVersion !== undefined && value.schemaVersion !== 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCursor(value: unknown): WorkflowScheduleCursor | undefined {
  if (!isRecord(value)) return undefined;
  const cursor = pickKnownFields(value, WORKFLOW_SCHEDULE_CURSOR_KNOWN_FIELDS);
  return {
    shiftId: typeof cursor.shiftId === "string" ? cursor.shiftId : undefined,
    shiftStartAt: typeof cursor.shiftStartAt === "number" ? cursor.shiftStartAt : undefined,
    coveredThrough: typeof cursor.coveredThrough === "number" ? cursor.coveredThrough : undefined,
    active: typeof cursor.active === "boolean" ? cursor.active : undefined,
    lastRunId: typeof cursor.lastRunId === "string" ? cursor.lastRunId : undefined,
    updatedAt: typeof cursor.updatedAt === "number" ? cursor.updatedAt : undefined,
    data: isRecord(cursor.data) ? cursor.data : undefined,
  };
}

function pickKnownFields(
  value: Record<string, unknown>,
  knownFields: ReadonlySet<string>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (knownFields.has(key)) picked[key] = field;
  }
  return picked;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function renameWithTransientRetries(
  renameSync: typeof fs.renameSync,
  sleep: (ms: number) => void,
  source: string,
  destination: string,
): void {
  for (let attempt = 0; attempt < QUARANTINE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const hasMoreAttempts = attempt + 1 < QUARANTINE_RETRY_DELAYS_MS.length;
      if (!hasMoreAttempts || !isTransientRenameError(error)) throw error;
      sleep(QUARANTINE_RETRY_DELAYS_MS[attempt + 1]);
    }
  }
}

function isTransientRenameError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES")
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function findNextScheduleOccurrence(schedule: StrictAutomationSchedule, now: Date): Date | null {
  if (schedule.days.length === 0) return null;
  let best: Date | null = null;
  const consider = (candidate: Date): void => {
    if (candidate.getTime() <= now.getTime()) return;
    if (best === null || candidate.getTime() < best.getTime()) best = candidate;
  };

  for (let offset = 0; offset <= 366; offset++) {
    const day = addLocalDays(startOfLocalDay(now), offset);
    if (!schedule.days.includes(day.getDay())) continue;
    if (schedule.kind === "interval") {
      const anchorMinutes = schedule.anchor.hour * 60 + schedule.anchor.minute;
      const latestSlot = Math.floor((1439 - anchorMinutes) / schedule.intervalMinutes);
      for (let slot = 0; slot <= latestSlot; slot++) {
        const slotMin = anchorMinutes + slot * schedule.intervalMinutes;
        consider(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, slotMin, 0, 0));
      }
    } else if (schedule.kind === "multi") {
      for (const time of schedule.times) {
        consider(
          new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.hour, time.minute, 0, 0),
        );
      }
    } else {
      const time = schedule.time ?? { hour: schedule.hour, minute: schedule.minute };
      consider(
        new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.hour, time.minute, 0, 0),
      );
    }
    if (best) return best;
  }
  return best;
}
