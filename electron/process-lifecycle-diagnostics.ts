import * as fs from "node:fs";
import * as path from "node:path";

import { getAppDataDir } from "./app-paths";
import { sanitizeForTelemetry } from "./marshal-value-sanitization";

const LOG_FILENAME = "marshal-process-lifecycle.jsonl";
const OLD_LOG_FILENAME = "marshal-process-lifecycle.jsonl.old";
const MAX_LOG_BYTES = 2 * 1024 * 1024;

let installedExitHooks = false;

export function writeProcessLifecycleEventSync(
  event: string,
  details: Record<string, unknown> = {},
): void {
  try {
    const appDataDir = getAppDataDir();
    fs.mkdirSync(appDataDir, { recursive: true, mode: 0o700 });
    const logPath = path.join(appDataDir, LOG_FILENAME);
    rotateIfNeeded(logPath);
    const entry = {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      event: sanitizeForTelemetry(event),
      details: sanitizeDetails(details),
    };
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(logPath, 0o600);
    } catch {
      /* best effort */
    }
  } catch {
    /* Last-ditch diagnostics must never be the reason shutdown crashes. */
  }
}

export function installProcessExitHooks(): void {
  if (installedExitHooks) return;
  installedExitHooks = true;

  process.on("beforeExit", (code) => {
    writeProcessLifecycleEventSync("process.beforeExit", { code });
  });
  process.on("exit", (code) => {
    writeProcessLifecycleEventSync("process.exit", { code });
  });
  process.on("warning", (warning) => {
    writeProcessLifecycleEventSync("process.warning", { error: summarizeError(warning) });
  });
}

export function summarizeError(error: unknown, depth = 0): Record<string, unknown> {
  if (depth >= 4) return { message: "Nested error limit reached." };
  if (error instanceof Error) {
    const code =
      "code" in error && typeof error.code === "string" ? error.code.slice(0, 128) : undefined;
    const nested =
      error instanceof AggregateError
        ? error.errors
        : error.cause !== undefined
          ? [error.cause]
          : [];
    return {
      name: error.name,
      ...(code ? { code } : {}),
      message: error.message.slice(0, 1_024),
      stack: error.stack?.split("\n").slice(0, 12).join("\n").slice(0, 4_096),
      ...(nested.length > 0
        ? { errors: nested.slice(0, 12).map((entry) => summarizeError(entry, depth + 1)) }
        : {}),
    };
  }
  return { message: String(error).slice(0, 1_024) };
}

export function stackPreview(): string | undefined {
  return new Error().stack?.split("\n").slice(2, 10).join("\n");
}

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details).slice(0, 60)) {
    safe[sanitizeForTelemetry(key)] = sanitizeValue(value, 0);
  }
  return safe;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value == null) return value;
  if (typeof value === "string") return sanitizeForTelemetry(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return sanitizeDetails(summarizeError(value));
  if (depth >= 3) return sanitizeForTelemetry(value);
  if (Array.isArray(value))
    return value.slice(0, 40).map((child) => sanitizeValue(child, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, 40)) {
      out[sanitizeForTelemetry(key)] = sanitizeValue(child, depth + 1);
    }
    return out;
  }
  return sanitizeForTelemetry(value);
}

function rotateIfNeeded(logPath: string): void {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size < MAX_LOG_BYTES) return;
    const oldPath = path.join(path.dirname(logPath), OLD_LOG_FILENAME);
    try {
      fs.rmSync(oldPath, { force: true });
    } catch {
      /* best effort */
    }
    fs.renameSync(logPath, oldPath);
  } catch {
    /* file may not exist yet */
  }
}
