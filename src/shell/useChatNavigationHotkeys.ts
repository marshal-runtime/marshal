import { useHotkeys, type HotkeyCallback, type UseHotkeyDefinition } from "@tanstack/react-hotkeys";
import { useCallback, useMemo } from "react";

import {
  isEditableHotkeyTarget,
  isHotkeyOwnedByActiveOverlay,
  isPlainTextHotkeyTarget,
} from "@/features/hotkeys";
import type { SessionMetadata } from "@/types/electron";

interface UseChatNavigationHotkeysOptions {
  sessions: SessionMetadata[];
  activeSessionId: string | null;
  /** Keep callbacks stable so TanStack can update registrations without unnecessary churn. */
  handleNewChat: () => void | Promise<void>;
  handleSessionSelect: (sessionId: string) => void | Promise<void>;
  handleSessionRename: (sessionId: string) => void | Promise<void>;
  renameEnabled: boolean;
  enabled: boolean;
}

function isModifiedLetterVariant(event: KeyboardEvent): boolean {
  return event.altKey || event.shiftKey;
}

export function useChatNavigationHotkeys({
  sessions,
  activeSessionId,
  handleNewChat,
  handleSessionSelect,
  handleSessionRename,
  renameEnabled,
  enabled,
}: UseChatNavigationHotkeysOptions): void {
  const normalSessions = useMemo(
    () =>
      sessions.filter(
        (session) => session.source !== "workspace" && session.source !== "workflow-run",
      ),
    [sessions],
  );

  const handleModT = useCallback<HotkeyCallback>(
    (event) => {
      if (isModifiedLetterVariant(event) || isPlainTextHotkeyTarget(event)) return;
      event.preventDefault();
      void handleNewChat();
    },
    [handleNewChat],
  );

  const selectRelativeSession = useCallback(
    (event: KeyboardEvent, direction: 1 | -1) => {
      if (event.altKey || isPlainTextHotkeyTarget(event)) return;
      if (normalSessions.length < 2 || !activeSessionId) return;

      const currentIndex = normalSessions.findIndex((session) => session.id === activeSessionId);
      if (currentIndex === -1) return;

      event.preventDefault();
      const nextIndex = (currentIndex + direction + normalSessions.length) % normalSessions.length;
      void handleSessionSelect(normalSessions[nextIndex].id);
    },
    [activeSessionId, handleSessionSelect, normalSessions],
  );

  const handleNextSession = useCallback<HotkeyCallback>(
    (event) => selectRelativeSession(event, 1),
    [selectRelativeSession],
  );

  const handlePreviousSession = useCallback<HotkeyCallback>(
    (event) => selectRelativeSession(event, -1),
    [selectRelativeSession],
  );

  const handleRenameCurrentSession = useCallback<HotkeyCallback>(
    (event) => {
      if (
        !renameEnabled ||
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isEditableHotkeyTarget(event) ||
        isHotkeyOwnedByActiveOverlay(event) ||
        !activeSessionId
      ) {
        return;
      }

      const activeSession = sessions.find((session) => session.id === activeSessionId);
      if (
        !activeSession ||
        activeSession.source === "workspace" ||
        activeSession.source === "workflow-run"
      ) {
        return;
      }

      event.preventDefault();
      void handleSessionRename(activeSession.id);
    },
    [activeSessionId, handleSessionRename, renameEnabled, sessions],
  );

  const hotkeys = useMemo<UseHotkeyDefinition[]>(
    () => [
      { hotkey: "Mod+T", callback: handleModT },
      { hotkey: "Control+Tab", callback: handleNextSession },
      { hotkey: "Control+Shift+Tab", callback: handlePreviousSession },
      { hotkey: "F2", callback: handleRenameCurrentSession },
    ],
    [handleModT, handleNextSession, handlePreviousSession, handleRenameCurrentSession],
  );

  useHotkeys(hotkeys, {
    enabled,
    ignoreInputs: false,
    preventDefault: false,
    stopPropagation: false,
    target: document,
  });
}
