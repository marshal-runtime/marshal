import {
  useCallback,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type { TabId } from "../context-picker/context-picker-tabs";

/**
 * One row currently visible in the picker. The id matches cmdk's `value`
 * for that row; commit() runs the row's selection callback (chip insert
 * for entities, skill pill insert for skills).
 */
export interface PickerVisibleItem {
  id: string;
  commit: () => void;
}

interface UsePickerKeyboardOptions {
  active: boolean;
  activeTab: TabId;
  /** Visible tabs in display order (computed from `isStartSlash` upstream). */
  visibleTabs: ReadonlyArray<TabId>;
  /**
   * Rows currently rendered in the listbox, in display order. The hook
   * computes the next selection by id from this list rather than by
   * numeric arithmetic, so what's highlighted in cmdk is always what
   * commits on Enter / Tab.
   */
  visibleItems: PickerVisibleItem[];
  /** cmdk's controlled value — the highlighted row's id, or "". */
  pickerValue: string;
  setPickerValue: (value: string) => void;
  setActiveTab: (tab: TabId) => void;
  onClose: () => void;
}

export function usePickerKeyboard({
  active,
  activeTab,
  visibleTabs,
  visibleItems,
  pickerValue,
  setPickerValue,
  setActiveTab,
  onClose,
}: UsePickerKeyboardOptions) {
  const pickerKeyHandledRef = useRef<"Enter" | "Tab" | null>(null);
  const latestOptionsRef = useRef({
    active,
    activeTab,
    visibleTabs,
    visibleItems,
    pickerValue,
    setPickerValue,
    setActiveTab,
    onClose,
  });

  useLayoutEffect(() => {
    latestOptionsRef.current = {
      active,
      activeTab,
      visibleTabs,
      visibleItems,
      pickerValue,
      setPickerValue,
      setActiveTab,
      onClose,
    };
  });

  const commitCurrent = useCallback((): boolean => {
    const options = latestOptionsRef.current;
    if (!options.active || options.visibleItems.length === 0) return false;
    const item = options.visibleItems.find((it) => it.id === options.pickerValue);
    if (!item) return false;
    item.commit();
    return true;
  }, []);

  const moveSelection = useCallback((delta: 1 | -1) => {
    const options = latestOptionsRef.current;
    if (options.visibleItems.length === 0) return;
    const currentIdx = options.visibleItems.findIndex((it) => it.id === options.pickerValue);
    const baseIdx = currentIdx < 0 ? 0 : currentIdx;
    const nextIdx = (baseIdx + delta + options.visibleItems.length) % options.visibleItems.length;
    options.setPickerValue(options.visibleItems[nextIdx].id);
  }, []);

  const onPickerKeyIntercept = useCallback(
    (key: "Enter" | "Tab" | "Escape" | "ArrowUp" | "ArrowDown") => {
      const options = latestOptionsRef.current;
      // Suppress prompt-history navigation (PromptHistoryPlugin runs at
      // COMMAND_PRIORITY_LOW and would otherwise overwrite the editor with
      // a previous/next user message). Selection movement is still done by
      // the React onKeyDown path — this is a Lexical-level suppressor only.
      if (key === "ArrowUp" || key === "ArrowDown") return options.active;

      if (key === "Escape") {
        if (!options.active) return false;
        options.onClose();
        return true;
      }
      const handled = commitCurrent();
      if (handled) pickerKeyHandledRef.current = key;
      return handled;
    },
    [commitCurrent],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const options = latestOptionsRef.current;
      // Dedup: if the Lexical-side intercept already committed this key,
      // the React onKeyDown sees the same event afterwards. Suppress the
      // default and bail without re-committing.
      if (pickerKeyHandledRef.current === e.key) {
        pickerKeyHandledRef.current = null;
        e.preventDefault();
        return true;
      }

      if (!options.active) return false;

      if (options.visibleItems.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          moveSelection(1);
          return true;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          moveSelection(-1);
          return true;
        }
        if ((e.key === "Enter" || e.key === "Tab") && commitCurrent()) {
          e.preventDefault();
          return true;
        }
      }

      // D3: Left/Right cycle through visible tabs while picker is open.
      // Always claim these (even when visibleItems.length === 0) so Lexical
      // doesn't move the caret while the picker has the keyboard.
      if (options.visibleTabs.length > 1 && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        const currentIdx = options.visibleTabs.indexOf(options.activeTab);
        // Fall back to first tab if activeTab somehow isn't in visibleTabs
        // (e.g., transient state during isStartSlash flips).
        const baseIdx = currentIdx < 0 ? 0 : currentIdx;
        const delta = e.key === "ArrowRight" ? 1 : -1;
        const nextIdx = (baseIdx + delta + options.visibleTabs.length) % options.visibleTabs.length;
        e.preventDefault();
        options.setActiveTab(options.visibleTabs[nextIdx]);
        return true;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        options.onClose();
        return true;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        return true;
      }

      return false;
    },
    [commitCurrent, moveSelection],
  );

  return {
    handleKeyDown,
    onPickerKeyIntercept,
  };
}
