import { useCallback, useRef } from "react";

import { applyPendingEdit, type PendingEditAction } from "../helpers/pendingEdit";

/**
 * Encapsulates the pending-edit-action channel used to carry partial-selection
 * edit intent from keyboard/context-menu handlers into the textarea mount
 * effect.  The raw ref never leaves this hook — callers interact through
 * `queuePendingEditAction` (producers) and `consumePendingEditAction`
 * (single consumer in the mount effect).
 */
export function usePendingEditAction() {
  const ref = useRef<PendingEditAction | null>(null);

  /** Queue a pending edit action to be applied when the segment textarea mounts. */
  const queuePendingEditAction = useCallback((action: PendingEditAction) => {
    ref.current = action;
  }, []);

  /**
   * Consume and apply the pending edit action against the segment's raw value.
   * Returns `{ newValue, cursorPos }` on success, or `null` if no action is
   * pending or offsets are stale (with a console.warn for diagnostics).
   */
  const consumePendingEditAction = useCallback((value: string, segMdStart: number) => {
    const action = ref.current;
    ref.current = null;
    if (!action) return null;
    return applyPendingEdit(value, segMdStart, action);
  }, []);

  return { queuePendingEditAction, consumePendingEditAction };
}
