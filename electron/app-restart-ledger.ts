import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createLogger } from "../common/marshal-logger";

const log = createLogger("AppRestartLedger");

export const LEDGER_FILENAME = "marshal-app-restart-ledger.jsonl";
const OLD_LEDGER_FILENAME = "marshal-app-restart-ledger.jsonl.old";
const MAX_LEDGER_BYTES = 1 * 1024 * 1024;

export type RestartLedgerStatus = "pending" | "completed" | "refused";

export interface RestartLedgerEntry {
  id: string;
  timestamp: string;
  requesterSessionId: string;
  reason: string;
  force: boolean;
  status: RestartLedgerStatus;
  /** Sessions that were busy and blocked the restart — refusal entries only. */
  busySessionIds?: string[];
  /** Set on the boot-time completion record. */
  completedAt?: string;
}

export interface RestartLedgerInput {
  requesterSessionId: string;
  reason: string;
  force: boolean;
}

/**
 * Append an agent-requested-restart entry with status "pending". Called
 * immediately before app.relaunch()/app.quit() — synchronous so the write is
 * on disk before the process exits. Returns null (never throws) on failure:
 * a broken ledger must not block the restart itself.
 */
export function recordPendingRestartSync(
  dir: string,
  input: RestartLedgerInput,
): RestartLedgerEntry | null {
  return appendEntrySync(dir, { ...input, status: "pending" });
}

/** Append a refusal entry (guard blocked the restart). Never throws. */
export function recordRestartRefusalSync(
  dir: string,
  input: RestartLedgerInput & { busySessionIds: string[] },
): RestartLedgerEntry | null {
  return appendEntrySync(dir, { ...input, status: "refused" });
}

/**
 * Boot-time pass: any "pending" entry without a matching "completed" record
 * means the app went down for an agent-requested restart and is now back.
 * Appends a completion record per unresolved entry and returns the completed
 * entries so boot code can surface a visible notice. Never throws.
 */
export function resolvePendingRestartsOnBootSync(dir: string): RestartLedgerEntry[] {
  const entries = readRestartLedgerEntries(dir);
  const completedIds = new Set(
    entries.filter((entry) => entry.status === "completed").map((entry) => entry.id),
  );
  const unresolved = entries.filter(
    (entry) => entry.status === "pending" && !completedIds.has(entry.id),
  );

  const completed: RestartLedgerEntry[] = [];
  for (const entry of unresolved) {
    const record = appendEntrySync(
      dir,
      {
        requesterSessionId: entry.requesterSessionId,
        reason: entry.reason,
        force: entry.force,
        status: "completed",
      },
      { id: entry.id, completedAt: new Date().toISOString() },
    );
    if (record) completed.push(record);
  }
  return completed;
}

/** Read all ledger entries, skipping malformed lines. Never throws. */
export function readRestartLedgerEntries(dir: string): RestartLedgerEntry[] {
  let content: string;
  try {
    content = fs.readFileSync(path.join(dir, LEDGER_FILENAME), "utf-8");
  } catch {
    return [];
  }
  const entries: RestartLedgerEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isLedgerEntry(parsed)) entries.push(parsed);
    } catch {
      // Skip malformed lines — self-written JSONL, corruption is non-fatal.
    }
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLedgerEntry(value: unknown): value is RestartLedgerEntry {
  if (!isRecord(value)) return false;
  const entry = value;
  return (
    typeof entry.id === "string" &&
    typeof entry.timestamp === "string" &&
    typeof entry.requesterSessionId === "string" &&
    typeof entry.reason === "string" &&
    typeof entry.force === "boolean" &&
    (entry.status === "pending" || entry.status === "completed" || entry.status === "refused")
  );
}

function appendEntrySync(
  dir: string,
  input: RestartLedgerInput & { status: RestartLedgerStatus; busySessionIds?: string[] },
  overrides: Partial<Pick<RestartLedgerEntry, "id" | "completedAt">> = {},
): RestartLedgerEntry | null {
  const entry: RestartLedgerEntry = {
    id: overrides.id ?? randomUUID(),
    timestamp: new Date().toISOString(),
    requesterSessionId: input.requesterSessionId,
    reason: input.reason,
    force: input.force,
    status: input.status,
    ...(input.busySessionIds ? { busySessionIds: input.busySessionIds } : {}),
    ...(overrides.completedAt ? { completedAt: overrides.completedAt } : {}),
  };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ledgerPath = path.join(dir, LEDGER_FILENAME);
    rotateIfNeeded(ledgerPath);
    fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  } catch (error) {
    log.error("Ledger write failed:", error);
    return null;
  }
}

function rotateIfNeeded(ledgerPath: string): void {
  try {
    const stat = fs.statSync(ledgerPath);
    if (stat.size < MAX_LEDGER_BYTES) return;
    const oldPath = path.join(path.dirname(ledgerPath), OLD_LEDGER_FILENAME);
    fs.rmSync(oldPath, { force: true });
    fs.renameSync(ledgerPath, oldPath);
  } catch {
    // File may not exist yet — rotation is best effort.
  }
}
