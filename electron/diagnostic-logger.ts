/**
 * Diagnostic logger — append structured JSONL entries to a shared log file.
 *
 * Used by crash handlers, MCP disconnect handlers, auth failures, and any
 * other main-process code that needs durable, inspectable logging.
 * The log file is attached to feedback emails for support investigations.
 *
 * File: ~/.marshal/marshal-diagnostics.jsonl (or ~/.marshal-dev/ in dev mode)
 * Rotation: on startup, if > 2MB, rename to .jsonl.old and start fresh.
 */

import * as fs from "fs";
import * as path from "path";

import { createLogger } from "../common/marshal-logger";
import { getAppDataDir } from "./app-paths";
import { sanitizeForTelemetry } from "./marshal-value-sanitization";
import { secureAppendFile } from "./platform-security";

const log = createLogger("DiagnosticLogger");

const LOG_FILENAME = "marshal-diagnostics.jsonl";
const LOG_FILENAME_OLD = "marshal-diagnostics.jsonl.old";
const MAX_LOG_SIZE = 2 * 1024 * 1024; // 2MB

// Gate: writes are denied until an explicit predicate is installed.
// Injected from main.ts at startup; enables unit testing without app wiring and
// mirrors the addLogSink pattern in common/marshal-logger.ts.
let enabledPredicate: (() => boolean) | null = null;

/**
 * Inject a predicate that gates all diagnostic writes. When the predicate
 * returns false (or no predicate has been set), `writeDiagnosticEntry` and
 * `writeDiagnosticEntrySync` become no-ops. Pass `null` to remove the
 * predicate (writes denied by default — safe for privacy).
 */
export function setDiagnosticsEnabledPredicate(predicate: (() => boolean) | null): void {
  enabledPredicate = predicate;
}

function isDiagnosticsEnabled(): boolean {
  return enabledPredicate !== null && enabledPredicate();
}

type DiagnosticLevel = "error" | "warn" | "info";

interface DiagnosticEntry {
  level: DiagnosticLevel;
  category: string;
  message: string;
  metadata?: Record<string, unknown>;
}

function getLogPath(): string {
  return path.join(getAppDataDir(), LOG_FILENAME);
}

/**
 * Rotate log file safely: rename current → .old, then delete previous .old.
 * Avoids deleting .old before rename succeeds (Windows lock safety).
 */
function rotateLog(logPath: string): void {
  const oldPath = path.join(path.dirname(logPath), LOG_FILENAME_OLD);
  const tmpOldPath = oldPath + ".tmp";
  // Clean up any stale .tmp from a previous failed rotation
  try {
    fs.unlinkSync(tmpOldPath);
  } catch {
    /* may not exist */
  }
  // Rename existing .old to .tmp first (safe if it doesn't exist)
  try {
    fs.renameSync(oldPath, tmpOldPath);
  } catch {
    /* .old may not exist */
  }
  try {
    fs.renameSync(logPath, oldPath);
    // Rename succeeded — clean up the tmp
    try {
      fs.unlinkSync(tmpOldPath);
    } catch {
      /* already gone */
    }
  } catch {
    // Rename failed — restore .old from tmp
    try {
      fs.renameSync(tmpOldPath, oldPath);
    } catch {
      /* best effort */
    }
  }
}

/** Rotate log file if it exceeds MAX_LOG_SIZE. Called once at startup. */
export function rotateIfNeeded(): void {
  const logPath = getLogPath();
  try {
    const stat = fs.statSync(logPath);
    if (stat.size >= MAX_LOG_SIZE) {
      rotateLog(logPath);
    }
  } catch {
    // File doesn't exist yet — nothing to rotate
  }
}

// Chain writes to avoid interleaved/EBUSY on Windows (same pattern as audit-log.ts)
let pendingWrite = Promise.resolve();

/**
 * Append a diagnostic entry to the log file.
 * All string values are sanitized (home paths redacted, emails redacted, truncated).
 * Rotates the log file if projected size exceeds MAX_LOG_SIZE.
 * No-op when diagnostics are disabled by the signed build profile.
 */
export function writeDiagnosticEntry(entry: DiagnosticEntry): void {
  if (!isDiagnosticsEnabled()) return;
  const sanitized = {
    timestamp: new Date().toISOString(),
    level: entry.level,
    category: sanitizeForTelemetry(entry.category),
    message: sanitizeForTelemetry(entry.message),
    ...(entry.metadata && {
      metadata: Object.fromEntries(
        Object.entries(entry.metadata).map(([k, v]) => [k, sanitizeForTelemetry(v)]),
      ),
    }),
  };

  let line: string;
  try {
    line = JSON.stringify(sanitized) + "\n";
  } catch {
    return;
  }

  const logPath = getLogPath();
  pendingWrite = pendingWrite
    .then(async () => {
      // Re-check at actual write time in case the predicate changed while queued.
      if (!isDiagnosticsEnabled()) return;
      // Rotate if projected size exceeds threshold
      try {
        const stat = fs.statSync(logPath);
        if (stat.size + Buffer.byteLength(line, "utf-8") >= MAX_LOG_SIZE) {
          rotateLog(logPath);
        }
      } catch {
        /* file may not exist yet */
      }
      await secureAppendFile(logPath, line, { mode: 0o600 });
    })
    .catch((err) => log.error("Write failed:", err));
}

/**
 * Synchronous one-shot write — bypasses the async pendingWrite chain.
 * Use in shutdown paths where app.exit(0) follows immediately and pending
 * async writes would be dropped.
 * No-op when diagnostics are disabled by the signed build profile.
 */
export function writeDiagnosticEntrySync(category: string, message: string): void {
  if (!isDiagnosticsEnabled()) return;
  try {
    const line =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        category: sanitizeForTelemetry(category),
        message: sanitizeForTelemetry(message),
      }) + "\n";
    fs.appendFileSync(getLogPath(), line, { mode: 0o600 });
  } catch {
    /* best effort — process is exiting */
  }
}

/** Resolves when all in-flight writes complete. Call from before-quit. */
export function flush(): Promise<void> {
  return pendingWrite;
}

/** Returns the log file path (for attaching to feedback emails). */
export function getLogFilePath(): string {
  return getLogPath();
}

/**
 * Read the tail of the diagnostics log file, capped at `maxBytes`. Returns an
 * empty string if the file does not exist. Used by the AI investigator
 * to capture recent context without blowing up the prompt.
 */
export function readLogTail(maxBytes = 64 * 1024): string {
  const logPath = getLogPath();
  try {
    const stat = fs.statSync(logPath);
    const size = stat.size;
    if (size === 0) return "";
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(logPath, "r");
    try {
      const length = size - start;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      let text = buf.toString("utf8");
      // If we truncated mid-line, drop the leading partial line.
      if (start > 0) {
        const nl = text.indexOf("\n");
        if (nl !== -1) text = text.slice(nl + 1);
      }
      return text;
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    log.warn("readLogTail failed:", err);
    return "";
  }
}
