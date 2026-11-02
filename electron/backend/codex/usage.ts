import {
  clampUsedPercent,
  type RuntimeAccountUsage,
  type RuntimeUsageWindow,
  type RuntimeUsageWindowKind,
} from "../../../common/runtime-account-usage";
import { isRecord, type UnknownRecord } from "./protocol";

const FIVE_HOUR_MINUTES = 5 * 60;
const WEEK_MINUTES = 7 * 24 * 60;

function windowKind(minutes: number | undefined): {
  kind: RuntimeUsageWindowKind;
  label?: string;
} {
  if (minutes === FIVE_HOUR_MINUTES) return { kind: "five_hour" };
  if (minutes === WEEK_MINUTES) return { kind: "weekly" };
  if (minutes === undefined) return { kind: "other" };
  return {
    kind: "other",
    label: minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`,
  };
}

function toWindow(raw: UnknownRecord, source: RuntimeUsageWindow["source"], now: number) {
  const used = raw["usedPercent"];
  if (typeof used !== "number") return null;
  const minutes = raw["windowDurationMins"];
  const resetsAt = raw["resetsAt"];
  return {
    ...windowKind(typeof minutes === "number" ? minutes : undefined),
    usedPercent: clampUsedPercent(used),
    ...(typeof resetsAt === "number" ? { resetsAt: resetsAt * 1000 } : {}),
    source,
    fetchedAt: now,
  } satisfies RuntimeUsageWindow;
}

/** Normalizes a Codex `RateLimitSnapshot` (`resetsAt` in unix seconds) into plan usage. */
export function codexUsageFromRateLimits(
  snapshot: unknown,
  options: { plan?: string | undefined; source: RuntimeUsageWindow["source"]; now?: number },
): RuntimeAccountUsage {
  const now = options.now ?? Date.now();
  const windows: RuntimeUsageWindow[] = [];
  if (isRecord(snapshot)) {
    for (const key of ["primary", "secondary"]) {
      const raw = snapshot[key];
      const window = isRecord(raw) ? toWindow(raw, options.source, now) : null;
      if (window) windows.push(window);
    }
  }
  return {
    available: true,
    ...(options.plan ? { plan: options.plan.toLowerCase() } : {}),
    windows,
    fetchedAt: now,
  };
}
