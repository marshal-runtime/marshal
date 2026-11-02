import { normalizeOrphans } from "../mdastParser";

export interface PendingEditAction {
  /** Character offset in raw markdown where the edit starts. */
  mdStart: number;
  /** Character offset in raw markdown where the edit ends. */
  mdEnd: number;
  /** Text to replace the selected range with (empty string = delete). */
  replaceWith: string;
}

/**
 * Validate offsets and apply a pending edit action against a segment's raw
 * markdown value.  Returns `null` (with a console warning) when the offsets
 * are stale — e.g. if the segment re-rendered between the keypress and the
 * textarea mount — so the caller can fall through safely.
 */
export function applyPendingEdit(
  value: string,
  segMdStart: number,
  editAction: PendingEditAction,
): { newValue: string; cursorPos: number } | null {
  const relStart = editAction.mdStart - segMdStart;
  const relEnd = editAction.mdEnd - segMdStart;
  if (relStart < 0 || relEnd > value.length) {
    // oxlint-disable-next-line no-console -- Intentional diagnostic: stale offsets mean the edit is silently dropped; this is the only signal for debugging.
    console.warn("[useSegmentEditor] pendingEditAction offsets out of range — edit dropped", {
      relStart,
      relEnd,
      valueLength: value.length,
      editAction,
    });
    return null;
  }
  const before = value.slice(0, relStart);
  const after = value.slice(relEnd);
  const rawVal = before + editAction.replaceWith + after;
  const newValue = normalizeOrphans(rawVal);
  const cursorPos = Math.min(relStart + editAction.replaceWith.length, newValue.length);
  return { newValue, cursorPos };
}
