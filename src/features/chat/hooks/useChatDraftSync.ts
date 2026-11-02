// File ownership: chat draft synchronization.

/** Saves drafts on unmount/session switch and restores them for the active session. */

import { useEffect, useEffectEvent, useRef } from "react";

import { consumeSuppressNextPreviousSave, getDraft, saveDraft } from "../state/sessionDrafts";

interface UseDraftSyncArgs {
  sessionId: string | null | undefined;
  input: string;
  setInputAndEditor: (text: string) => void;
  onSessionChange: () => void;
}

export function useDraftSync({
  sessionId,
  input,
  setInputAndEditor,
  onSessionChange,
}: UseDraftSyncArgs): void {
  const saveCurrentDraft = useEffectEvent(() => {
    if (sessionId) saveDraft(sessionId, input);
  });
  const savePreviousDraft = useEffectEvent((prevId: string) => {
    saveDraft(prevId, input);
  });

  useEffect(() => {
    return () => saveCurrentDraft();
  }, []);

  useEffect(() => {
    if (window.marshalRemote && sessionId) saveDraft(sessionId, input);
  }, [sessionId, input]);

  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return;
    const prevId = prevSessionIdRef.current;
    // migrateDraft (in state/sessionDrafts) sets a one-shot flag we
    // consume here: when armed, skip saving the previous id's draft so
    // the upcoming switch doesn't resurrect the orphan migrate just
    // cleared (input state is still the pre-migrate value on this tick).
    const skipPrevSave = consumeSuppressNextPreviousSave();
    if (prevId && !skipPrevSave) savePreviousDraft(prevId);
    setInputAndEditor(getDraft(sessionId ?? "") ?? "");
    onSessionChange();
    prevSessionIdRef.current = sessionId;
  }, [sessionId, setInputAndEditor, onSessionChange]);
}
