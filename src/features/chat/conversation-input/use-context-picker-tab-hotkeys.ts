import { useHotkeys, type HotkeyCallback, type UseHotkeyDefinition } from "@tanstack/react-hotkeys";
import { useMemo } from "react";

import { getVisibleTabs, type TabId } from "../context-picker/context-picker-tabs";

const MAX_CONTEXT_PICKER_TAB_SHORTCUTS = 9;

function shouldIgnoreContextPickerShortcut(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]') !==
      null &&
    target.closest('[data-context-picker-menu="true"]') === null
  );
}

export function useContextPickerTabHotkeys(
  visibleTabs: ReturnType<typeof getVisibleTabs>,
  onActiveTabChange: (tab: TabId) => void,
): void {
  const hotkeys = useMemo<UseHotkeyDefinition[]>(
    () =>
      visibleTabs.slice(0, MAX_CONTEXT_PICKER_TAB_SHORTCUTS).flatMap((tab, index) => {
        const tabNumber = index + 1;
        const callback: HotkeyCallback = (event) => {
          if (shouldIgnoreContextPickerShortcut(event.target)) return;
          if (event.altKey || event.shiftKey) return;

          event.preventDefault();
          event.stopPropagation();
          onActiveTabChange(tab.id);
        };

        return [{ hotkey: { key: `${tabNumber}`, mod: true }, callback }];
      }),
    [onActiveTabChange, visibleTabs],
  );

  useHotkeys(hotkeys, {
    // The legacy listener only cancelled handled in-range shortcuts. Let the
    // callback decide so external overlays and out-of-range numbers pass through.
    target: document,
    preventDefault: false,
    stopPropagation: false,
  });
}
