import type { MemoryPurgeResult } from "../../backend/ports";

/** A Brain index slot owner id: `@marshal/brain:<kind>:<hex digest>`. */
const SLOT_ID = /^@marshal\/brain:[a-z-]+:[0-9a-f]{8,64}$/;
const MAX_SLOT_ID_LENGTH = 128;

const COUNT_FIELDS = ["removedProjections", "indexRemovalsPending", "pendingRepositories"] as const;
const FLAG_FIELDS = ["vacuumed", "walTruncated"] as const;
const ENUM_FIELDS = {
  scopeKind: ["user", "workspace", "project"],
  compaction: ["pending", "done"],
  repositorySweepState: ["pending", "done", "unavailable"],
  workspaceOverlays: ["pending", "done"],
} as const;
/** Why a Brain workspace overlay still owes compaction (`OverlayPendingReason` plus `upgrade`). */
const WORKSPACE_OVERLAY_REASONS: ReadonlySet<string> = new Set([
  "not-built",
  "busy",
  "unavailable",
  "no-overlay",
  "base-moved",
  "parser-changed",
  "unsupported",
  "failed",
  "not-republished",
  "not-open",
  "queued",
  "upgrade",
]);
const MAX_PENDING_OVERLAYS = 64;

/**
 * Tool result of a complete forget. Only allowlisted status keys pass, and
 * only as counts, booleans, known enum values or slot ids of the fixed Brain shape,
 * so no memory text (purgedFacts or any future text field) can reach the tool
 * output.
 */
export function forgetCompletelyResult(purged: MemoryPurgeResult): Record<string, unknown> {
  const result: Record<string, unknown> = {
    success: true,
    completely: true,
    purgedRevisions: purged.purgedIds.length,
  };
  if (Array.isArray(purged.skippedIds)) result.skippedRevisions = purged.skippedIds.length;
  for (const key of COUNT_FIELDS) {
    const value: unknown = purged[key];
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
  for (const key of FLAG_FIELDS) {
    const value: unknown = purged[key];
    if (typeof value === "boolean") result[key] = value;
  }
  for (const [key, allowed] of Object.entries(ENUM_FIELDS)) {
    const value: unknown = Reflect.get(purged, key);
    if (typeof value === "string" && (allowed as readonly string[]).includes(value))
      result[key] = value;
  }
  if (Array.isArray(purged.pendingSlots)) {
    result.pendingSlots = purged.pendingSlots.filter(
      (slot) => typeof slot === "string" && slot.length <= MAX_SLOT_ID_LENGTH && SLOT_ID.test(slot),
    );
  }
  if (Array.isArray(purged.pendingWorkspaceOverlays)) {
    const reasons = purged.pendingWorkspaceOverlays
      .map((entry: unknown) =>
        typeof entry === "object" && entry !== null ? Reflect.get(entry, "reason") : undefined,
      )
      .filter(
        (reason): reason is string =>
          typeof reason === "string" && WORKSPACE_OVERLAY_REASONS.has(reason),
      );
    result.pendingWorkspaceOverlays = reasons.slice(0, MAX_PENDING_OVERLAYS);
  }
  const lifecycle = purged.lifecycleResults;
  if (typeof lifecycle?.available === "boolean" && Number.isFinite(lifecycle.removed)) {
    result.lifecycleResults = { available: lifecycle.available, removed: lifecycle.removed };
  }
  return result;
}
