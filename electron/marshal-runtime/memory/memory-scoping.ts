import type { MemoryEntry } from "@common/marshal-ipc-contract";

import type { MemoryRecallOptions } from "../../backend/ports";

export const GLOBAL_MEMORY_APPLIES_TO = "global";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `"global"` for unscoped memories, else the project id stored on the entry. */
export function memoryAppliesTo(entry: Pick<MemoryEntry, "appliesTo">): string {
  const appliesTo = typeof entry.appliesTo === "string" ? entry.appliesTo.trim() : "";
  return appliesTo || GLOBAL_MEMORY_APPLIES_TO;
}

/** Global memories plus those scoped to `projectId` are prompt candidates. */
export function memoryAppliesToProject(
  entry: Pick<MemoryEntry, "appliesTo">,
  projectId: string | undefined,
): boolean {
  const appliesTo = memoryAppliesTo(entry);
  return appliesTo === GLOBAL_MEMORY_APPLIES_TO || (!!projectId && appliesTo === projectId);
}

function parseBound(value: string, bound: "since" | "until"): string {
  const trimmed = value.trim();
  if (DATE_ONLY.test(trimmed)) {
    const iso = `${trimmed}${bound === "since" ? "T00:00:00.000Z" : "T23:59:59.999Z"}`;
    if (!Number.isNaN(Date.parse(iso))) return iso;
  } else {
    const ms = Date.parse(trimmed);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  throw new RangeError(`${bound} must be an ISO date (YYYY-MM-DD) or datetime.`);
}

/**
 * Normalizes inclusive `since`/`until` input to ISO datetimes. A date-only
 * `until` covers that whole UTC day.
 */
export function normalizeRecallWindow(input: {
  since?: string;
  until?: string;
}): MemoryRecallOptions {
  const since = input.since ? parseBound(input.since, "since") : undefined;
  const until = input.until ? parseBound(input.until, "until") : undefined;
  if (since && until && since > until) {
    throw new RangeError("since must not be later than until.");
  }
  return { ...(since ? { since } : {}), ...(until ? { until } : {}) };
}

/** Predicate over `createdAt`; entries without a parseable date fall outside any bound. */
export function createdAtWithin(
  window: MemoryRecallOptions | undefined,
): (entry: Pick<MemoryEntry, "createdAt">) => boolean {
  const since = window?.since ? Date.parse(window.since) : Number.NaN;
  const until = window?.until ? Date.parse(window.until) : Number.NaN;
  const hasSince = !Number.isNaN(since);
  const hasUntil = !Number.isNaN(until);
  if (!hasSince && !hasUntil) return () => true;
  return (entry) => {
    const created = typeof entry.createdAt === "string" ? Date.parse(entry.createdAt) : Number.NaN;
    if (Number.isNaN(created)) return false;
    return (!hasSince || created >= since) && (!hasUntil || created <= until);
  };
}
