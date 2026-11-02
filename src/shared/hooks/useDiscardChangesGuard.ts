// Ownership: shared hooks.
import { useCallback, useState } from "react";

/**
 * Two-click discard guard for form dialogs.
 *
 * When the form is dirty, the first close attempt changes the button to
 * "Discard?" (warning state). The second click actually closes. Interacting
 * with the form resets the confirm state.
 */
export function useDiscardGuard(isDirty: boolean, onClose: () => void) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const handleClose = useCallback(() => {
    if (!isDirty || confirmDiscard) {
      onClose();
      return;
    }
    setConfirmDiscard(true);
  }, [isDirty, confirmDiscard, onClose]);

  const resetConfirm = useCallback(() => setConfirmDiscard(false), []);

  return { confirmDiscard, handleClose, resetConfirm };
}
