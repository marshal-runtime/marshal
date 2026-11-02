import { useHotkeys, type HotkeyCallback, type UseHotkeyDefinition } from "@tanstack/react-hotkeys";
import { useMemo } from "react";

import type { MessageQuestion } from "@/types/electron";

import { inlineQuestionAnswerLabel, MAX_INLINE_QUESTION_SHORTCUTS } from "./answer-label";

function isEditableSurfaceFocused(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    (active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.isContentEditable)
  );
}

export function useInlineQuestionAnswerHotkeys(
  answers: MessageQuestion["answers"],
  onSelect: (answer: string) => void,
  enabled: boolean,
): void {
  const hotkeys = useMemo<UseHotkeyDefinition[]>(() => {
    if (!enabled) return [];

    return answers.slice(0, MAX_INLINE_QUESTION_SHORTCUTS).flatMap((answer, index) => {
      const letter = inlineQuestionAnswerLabel(index);
      const callback: HotkeyCallback = (event) => {
        if (isEditableSurfaceFocused()) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key.length !== 1 || event.key.toUpperCase() !== letter) return;

        event.preventDefault();
        onSelect(`${letter}. ${answer.title}`);
      };

      return [
        { hotkey: { key: letter }, callback },
        { hotkey: { key: letter, shift: true }, callback },
      ];
    });
  }, [answers, enabled, onSelect]);

  useHotkeys(hotkeys, {
    enabled,
    ignoreInputs: false,
    preventDefault: false,
    stopPropagation: false,
  });
}
