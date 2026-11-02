const sessionDrafts = new Map<string, string>();
export const MAX_DRAFTS = 100;

/**
 * One-shot signal to useDraftSync: skip the next save-of-previous-draft
 * pass on the very next session-id change. Set by `migrateDraft` and
 * consumed (read + reset) by useDraftSync. Lives at module scope so the
 * coordination doesn't leak through the hook's public API.
 */
let suppressNextPreviousSave = false;

export function saveDraft(id: string, text: string) {
  if (typeof window !== "undefined" && window.marshalRemote) {
    try {
      if (text) localStorage.setItem(`marshal.draft.${id}`, text);
      else localStorage.removeItem(`marshal.draft.${id}`);
    } catch {
      /* Keep the in-memory draft if storage is full. */
    }
  }
  if (text) {
    // Delete-then-set so re-saving an existing key moves it to the end of the
    // Map's insertion order — gives true LRU eviction (by last touch) instead
    // of FIFO (by first touch).
    sessionDrafts.delete(id);
    sessionDrafts.set(id, text);
    if (sessionDrafts.size > MAX_DRAFTS) {
      const oldest = sessionDrafts.keys().next().value;
      if (oldest !== undefined) sessionDrafts.delete(oldest);
    }
    return;
  }

  sessionDrafts.delete(id);
}

export function getDraft(id: string): string | undefined {
  if (typeof window !== "undefined" && window.marshalRemote) {
    try {
      return sessionDrafts.get(id) ?? localStorage.getItem(`marshal.draft.${id}`) ?? undefined;
    } catch {
      /* Storage unavailable. */
    }
  }
  return sessionDrafts.get(id);
}

export function clearDraft(targetSessionId: string) {
  sessionDrafts.delete(targetSessionId);
  if (typeof window !== "undefined" && window.marshalRemote) {
    try {
      localStorage.removeItem(`marshal.draft.${targetSessionId}`);
    } catch {
      /* Storage unavailable. */
    }
  }
}

export function clearAllDrafts() {
  sessionDrafts.clear();
}

/**
 * Seed the current input on another session. Move mode clears the source
 * and arms useDraftSync's one-shot previous-save guard; preserveSource
 * copies the draft so the predecessor remains unchanged.
 */
export function migrateDraft(
  fromId: string | null | undefined,
  toId: string,
  text: string,
  options?: { preserveSource?: boolean },
) {
  saveDraft(toId, text);
  if (!options?.preserveSource) {
    if (fromId) clearDraft(fromId);
    suppressNextPreviousSave = true;
  }
}

/** @internal Read + reset the suppress-previous-save flag. Consumer is
 * useDraftSync; tests may inspect it. Resetting on read makes it strictly
 * one-shot. */
export function consumeSuppressNextPreviousSave(): boolean {
  if (!suppressNextPreviousSave) return false;
  suppressNextPreviousSave = false;
  return true;
}

/** @internal Test-only — clear all stored drafts between test runs. */
export function _clearSessionDrafts() {
  clearAllDrafts();
  suppressNextPreviousSave = false;
}
