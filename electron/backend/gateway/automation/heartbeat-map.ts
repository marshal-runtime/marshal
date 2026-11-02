// electron/backend/gateway/automation/heartbeat-map.ts
//
// Pure functions translating between m's HeartbeatSettings/HeartbeatStatus
// and marshal's `agents.defaults.heartbeat` config subtree (plus the
// `last-heartbeat` event shape).
//
// All functions here are pure — no I/O, no clock reads except the running
// recency window in mapLastHeartbeatToStatus (which intentionally uses
// Date.now() as the spec calls for a derived running flag).
//
// Spec: docs/specs/gateway-heartbeat-phase-3a-1-design.md §3.3

import type { HeartbeatSettings, HeartbeatStatus } from "../../../../common/marshal-ipc-contract";

export type IntervalMinutes = 15 | 30 | 60 | 120;

const VALID_INTERVALS: readonly IntervalMinutes[] = [15, 30, 60, 120];

const DEFAULT_INTERVAL_MINUTES: IntervalMinutes = 60;
const DEFAULT_WORK_START_HOUR = 9;
const DEFAULT_WORK_END_HOUR = 17;
const DEFAULT_WORK_DAYS = [1, 2, 3, 4, 5] as const;

/**
 * ~30s window in which we treat a heartbeat as "still running".
 *
 * This is a heuristic, not a true running indicator: marshal emits a single
 * `last-heartbeat` event per fire (start vs end is not surfaced). A poll that
 * lands within this window of the most recent fire reports `running: true`;
 * outside the window we assume the run completed. Long heartbeats (> 30s) and
 * fast clock drift can both lie. Lobster issue tracks adding a real running
 * indicator server-side.
 */
const HEARTBEAT_RUNNING_WINDOW_MS = 30_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Path to the heartbeat subtree inside marshal's RuntimeConfig. Surface
 *  this as a constant so both the read-side (extract) and write-side (wrap)
 *  reference the same source of truth — if marshal moves the path (e.g.
 *  per-agent overrides at `agents.<id>.heartbeat`) only this file changes. */
const HEARTBEAT_CONFIG_PATH = ["agents", "defaults", "heartbeat"] as const;

/**
 * Pluck `agents.defaults.heartbeat` out of marshal's `config.get` response.
 * The response is a `ConfigFileSnapshot` with a top-level `config` field
 * (RuntimeConfig) plus `hash`. Returns undefined if any node along the path
 * is missing or non-record-shaped — `mapMarshalHeartbeatToSettings` then
 * falls back to defaults.
 */
export function extractHeartbeatSubtree(configResp: unknown): unknown {
  if (!isRecord(configResp)) return undefined;
  let cursor: unknown = configResp.config;
  for (const segment of HEARTBEAT_CONFIG_PATH) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/**
 * Wrap a heartbeat merge-patch into the marshal config-tree path so the
 * mapper owns both directions of the marshal shape (read via
 * `extractHeartbeatSubtree`, write via this). Returns the JSON merge-patch
 * object — the caller is responsible for `JSON.stringify` (marshal's
 * `config.patch` `raw` parameter is a JSON5 string).
 */
export function wrapHeartbeatPatchAtConfigPath(
  patch: Record<string, unknown>,
): Record<string, unknown> {
  // Build outwards: { agents: { defaults: { heartbeat: patch } } }
  let wrapped: Record<string, unknown> = patch;
  for (let i = HEARTBEAT_CONFIG_PATH.length - 1; i >= 0; i--) {
    wrapped = { [HEARTBEAT_CONFIG_PATH[i]]: wrapped };
  }
  return wrapped;
}

export function intervalMinutesToEveryString(n: IntervalMinutes): string {
  if (n === 60) return "1h";
  if (n === 120) return "2h";
  return `${n}m`;
}

export function everyStringToIntervalMinutes(every: string): IntervalMinutes {
  const match = /^(\d+)([mh])$/.exec(every);
  if (!match) return DEFAULT_INTERVAL_MINUTES;
  const value = parseInt(match[1] ?? "", 10);
  const unit = match[2];
  if (!Number.isFinite(value)) return DEFAULT_INTERVAL_MINUTES;
  const minutes = unit === "h" ? value * 60 : value;
  // Round to nearest valid value
  let nearest: IntervalMinutes = DEFAULT_INTERVAL_MINUTES;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const candidate of VALID_INTERVALS) {
    const delta = Math.abs(candidate - minutes);
    if (delta < bestDelta) {
      bestDelta = delta;
      nearest = candidate;
    }
  }
  return nearest;
}

export function scheduleToActiveHours(
  settings: Pick<HeartbeatSettings, "schedule" | "workStartHour" | "workEndHour">,
): { start: string; end: string } | undefined {
  if (settings.schedule === "always") return undefined;
  const start = settings.workStartHour ?? DEFAULT_WORK_START_HOUR;
  const end = settings.workEndHour ?? DEFAULT_WORK_END_HOUR;
  return {
    start: `${String(start).padStart(2, "0")}:00`,
    end: `${String(end).padStart(2, "0")}:00`,
  };
}

export function activeHoursToSchedule(
  hours: { start: string; end: string } | undefined,
): "work-hours" | "always" {
  return hours ? "work-hours" : "always";
}

export function mapMarshalHeartbeatToSettings(subtree: unknown): HeartbeatSettings {
  if (!isRecord(subtree)) {
    return {
      enabled: false,
      intervalMinutes: DEFAULT_INTERVAL_MINUTES,
      schedule: "always",
      prompt: "",
      workDays: [...DEFAULT_WORK_DAYS],
      workStartHour: DEFAULT_WORK_START_HOUR,
      workEndHour: DEFAULT_WORK_END_HOUR,
    };
  }
  const every = typeof subtree.every === "string" ? subtree.every : "1h";
  const activeHoursRaw = subtree.activeHours;
  const activeHours =
    isRecord(activeHoursRaw) &&
    typeof activeHoursRaw.start === "string" &&
    typeof activeHoursRaw.end === "string"
      ? { start: activeHoursRaw.start, end: activeHoursRaw.end }
      : undefined;
  const prompt = typeof subtree.prompt === "string" ? subtree.prompt : "";
  const workStartHourParsed = activeHours
    ? parseInt(activeHours.start.slice(0, 2), 10)
    : DEFAULT_WORK_START_HOUR;
  const workEndHourParsed = activeHours
    ? parseInt(activeHours.end.slice(0, 2), 10)
    : DEFAULT_WORK_END_HOUR;
  return {
    // NOTE: `enabled` here is NOT authoritative for gateway mode — marshal's
    // `HeartbeatSchema` has no `enabled` field, so the runtime toggle state
    // lives only in `set-heartbeats` / `last-heartbeat`. Callers that need
    // the live toggle MUST read `getHeartbeatStatus().enabled`. We default
    // to `true` here only so a populated subtree renders the configured
    // schedule — `HeartbeatPanel.tsx` sources its toggle from `status.enabled`,
    // not `settings.enabled`. (Tracked: drop `enabled` from
    // `HeartbeatSettings` in a follow-up so the type system enforces this.)
    enabled: true,
    intervalMinutes: everyStringToIntervalMinutes(every),
    schedule: activeHoursToSchedule(activeHours),
    prompt,
    workDays: [...DEFAULT_WORK_DAYS],
    workStartHour: Number.isFinite(workStartHourParsed)
      ? workStartHourParsed
      : DEFAULT_WORK_START_HOUR,
    workEndHour: Number.isFinite(workEndHourParsed) ? workEndHourParsed : DEFAULT_WORK_END_HOUR,
  };
}

export function mapHeartbeatPatchToMarshalPatch(
  patch: Partial<HeartbeatSettings>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.intervalMinutes !== undefined) {
    out.every = intervalMinutesToEveryString(patch.intervalMinutes);
  }
  if (patch.schedule === "always") {
    // merge-patch null clears the key
    out.activeHours = null;
  } else if (
    patch.schedule === "work-hours" ||
    (patch.workStartHour !== undefined && patch.workEndHour !== undefined)
  ) {
    // marshal's `config.patch` does whole-object replacement on `activeHours`
    // (it's a leaf object in the merge-patch). If we synthesized activeHours
    // from a single-field patch, the missing side would default to m's
    // hardcoded 9/17 and silently overwrite whatever the server held. Two
    // valid synthesis paths:
    //   1. Caller is explicitly setting schedule to "work-hours"  — defaults
    //      for the unspecified hour are appropriate (it's a fresh switch).
    //   2. Caller passes BOTH hours — the patch is atomic.
    // Renderer's `handleWorkHourChange` always sends both hours; this branch
    // is defense in depth for future callers / tests.
    const start = patch.workStartHour ?? DEFAULT_WORK_START_HOUR;
    const end = patch.workEndHour ?? DEFAULT_WORK_END_HOUR;
    out.activeHours = {
      start: `${String(start).padStart(2, "0")}:00`,
      end: `${String(end).padStart(2, "0")}:00`,
    };
  }
  if (patch.prompt !== undefined) {
    out.prompt = patch.prompt;
  }
  return out;
}

export function mapLastHeartbeatToStatus(event: unknown): HeartbeatStatus {
  if (!isRecord(event) || typeof event.ts !== "number") {
    return { enabled: false, lastRun: null, nextRun: null, running: false };
  }
  const status = typeof event.status === "string" ? event.status : "";
  const reason = typeof event.reason === "string" ? event.reason : "";
  const enabled = !(status === "skipped" && reason === "disabled");
  const isoTs = new Date(event.ts).toISOString();
  const running = Date.now() - event.ts < HEARTBEAT_RUNNING_WINDOW_MS;
  return {
    enabled,
    lastRun: isoTs,
    // marshal doesn't surface this; m can't compute without knowing the
    // every schedule. Lobster issue tracks adding it server-side.
    nextRun: null,
    running,
  };
}
