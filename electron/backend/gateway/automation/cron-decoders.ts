/**
 * Pure decoders for marshal `cron.*` RPC payloads. Throw on shape mismatch
 * so a server contract drift surfaces at the RPC boundary, not as a deep
 * `undefined.foo` TypeError inside the mapper.
 */

import { isRecord } from "../record-guard";
import type {
  CronJob,
  CronJobCreate,
  CronPayload,
  CronRunLogEntry,
  CronSchedule,
  CronSessionTarget,
} from "./map";

/** Spread to widen `CronJobCreate` to the loose record shape RpcClient.request expects. */
export function cronJobCreateToParams(body: CronJobCreate): Record<string, unknown> {
  return { ...body };
}

export function parseCronJobList(raw: unknown): CronJob[] {
  if (!isRecord(raw) || !Array.isArray(raw.jobs)) {
    throw new Error("gateway-automation-backend: expected { jobs: [...] } from cron.list");
  }
  return raw.jobs.map(recordToCronJob);
}

export function parseCronRunLogEntries(raw: unknown): CronRunLogEntry[] {
  if (!isRecord(raw) || !Array.isArray(raw.entries)) {
    throw new Error("gateway-automation-backend: expected { entries: [...] } from cron.runs");
  }
  return raw.entries.map(recordToCronRunLogEntry);
}

export function parseCronJobId(raw: unknown): string {
  if (!isRecord(raw) || typeof raw.id !== "string") {
    throw new Error("gateway-automation-backend: expected { id: string } from cron.add/update");
  }
  return raw.id;
}

export function recordToCronJob(item: unknown): CronJob {
  if (!isRecord(item)) {
    throw new Error("gateway-automation-backend: expected CronJob object");
  }
  const id = typeof item.id === "string" ? item.id : null;
  const name = typeof item.name === "string" ? item.name : null;
  const enabled = typeof item.enabled === "boolean" ? item.enabled : null;
  const createdAtMs = typeof item.createdAtMs === "number" ? item.createdAtMs : null;
  const updatedAtMs = typeof item.updatedAtMs === "number" ? item.updatedAtMs : null;
  const schedule = parseCronSchedule(item.schedule);
  const sessionTarget = parseCronSessionTarget(item.sessionTarget);
  const wakeMode = parseCronWakeMode(item.wakeMode);
  const payload = parseCronPayload(item.payload);
  const state = isRecord(item.state) ? item.state : null;
  if (
    id === null ||
    name === null ||
    enabled === null ||
    createdAtMs === null ||
    updatedAtMs === null ||
    state === null
  ) {
    throw new Error("gateway-automation-backend: CronJob missing required fields");
  }
  const job: CronJob = {
    id,
    name,
    enabled,
    createdAtMs,
    updatedAtMs,
    schedule,
    sessionTarget,
    wakeMode,
    payload,
    state,
  };
  if (typeof item.description === "string") job.description = item.description;
  if (typeof item.deleteAfterRun === "boolean") job.deleteAfterRun = item.deleteAfterRun;
  if (isRecord(item.delivery)) {
    const mode = item.delivery.mode;
    if (mode === "none" || mode === "announce" || mode === "webhook") {
      job.delivery = { ...item.delivery, mode };
    }
  }
  return job;
}

export function parseCronSchedule(raw: unknown): CronSchedule {
  if (!isRecord(raw)) {
    throw new Error("gateway-automation-backend: schedule must be an object");
  }
  if (raw.kind === "at" && typeof raw.at === "string") {
    return { kind: "at", at: raw.at };
  }
  if (raw.kind === "every" && typeof raw.everyMs === "number") {
    const s: CronSchedule = { kind: "every", everyMs: raw.everyMs };
    if (typeof raw.anchorMs === "number") s.anchorMs = raw.anchorMs;
    return s;
  }
  if (raw.kind === "cron" && typeof raw.expr === "string") {
    const s: CronSchedule = { kind: "cron", expr: raw.expr };
    if (typeof raw.tz === "string") s.tz = raw.tz;
    if (typeof raw.staggerMs === "number") s.staggerMs = raw.staggerMs;
    return s;
  }
  throw new Error(`gateway-automation-backend: unknown schedule kind "${String(raw.kind)}"`);
}

export function parseCronSessionTarget(raw: unknown): CronSessionTarget {
  if (raw === "main" || raw === "isolated" || raw === "current") return raw;
  if (typeof raw === "string" && isDynamicSessionTarget(raw)) return raw;
  throw new Error(`gateway-automation-backend: invalid sessionTarget "${String(raw)}"`);
}

function isDynamicSessionTarget(s: string): s is `session:${string}` {
  return s.startsWith("session:");
}

export function parseCronWakeMode(raw: unknown): "next-heartbeat" | "now" {
  if (raw === "next-heartbeat" || raw === "now") return raw;
  // Forward-compat: unknown string values fall back to "now" so a new marshal
  // wake mode doesn't break the whole listAutomations unwrap. Non-string is a
  // genuine shape mismatch and throws.
  if (typeof raw !== "string") {
    throw new Error(`gateway-automation-backend: wakeMode must be a string, got ${typeof raw}`);
  }
  return "now";
}

export function parseCronPayload(raw: unknown): CronPayload {
  if (!isRecord(raw)) {
    throw new Error("gateway-automation-backend: payload must be an object");
  }
  if (raw.kind === "systemEvent" && typeof raw.text === "string") {
    return { kind: "systemEvent", text: raw.text };
  }
  if (raw.kind === "agentTurn" && typeof raw.message === "string") {
    const p: CronPayload = { kind: "agentTurn", message: raw.message };
    if (typeof raw.model === "string") p.model = raw.model;
    if (Array.isArray(raw.fallbacks)) {
      p.fallbacks = raw.fallbacks.filter((x): x is string => typeof x === "string");
    }
    if (typeof raw.thinking === "string") p.thinking = raw.thinking;
    if (typeof raw.timeoutSeconds === "number") p.timeoutSeconds = raw.timeoutSeconds;
    if (Array.isArray(raw.toolsAllow)) {
      p.toolsAllow = raw.toolsAllow.filter((x): x is string => typeof x === "string");
    }
    return p;
  }
  throw new Error(`gateway-automation-backend: unknown payload kind "${String(raw.kind)}"`);
}

export function recordToCronRunLogEntry(item: unknown): CronRunLogEntry {
  if (!isRecord(item)) {
    throw new Error("gateway-automation-backend: expected CronRunLogEntry object");
  }
  const ts = typeof item.ts === "number" ? item.ts : null;
  const status = item.status;
  if (ts === null || (status !== "ok" && status !== "error" && status !== "skipped")) {
    throw new Error("gateway-automation-backend: CronRunLogEntry missing required fields");
  }
  const entry: CronRunLogEntry = { ts, status };
  if (typeof item.runAtMs === "number") entry.runAtMs = item.runAtMs;
  if (typeof item.sessionId === "string") entry.sessionId = item.sessionId;
  if (typeof item.sessionKey === "string") entry.sessionKey = item.sessionKey;
  if (typeof item.summary === "string") entry.summary = item.summary;
  if (typeof item.error === "string") entry.error = item.error;
  if (typeof item.durationMs === "number") entry.durationMs = item.durationMs;
  if (typeof item.model === "string") entry.model = item.model;
  return entry;
}
