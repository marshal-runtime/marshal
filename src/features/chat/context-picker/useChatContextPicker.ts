/**
 * useContextPicker — Trigger state management for the Context Picker.
 * File ownership: chat-specific context picker trigger state.
 *
 * Detects `/` typed after whitespace to activate entity search.
 * Does NOT trigger when the entire input is a slash command (that's the skill menu).
 *
 * Note: chip insertion / pill state lives in the parent (ChatInput) so the
 * editor can be the single source of truth. This hook only emits the trigger
 * state and forwards selection events to the parent via `onPickEntity`.
 */

import { useCallback, useState } from "react";

import type { ContextEntity } from "@/types/electron";

import type { TabId } from "./context-picker-tabs";

export interface ContextPickerState {
  active: boolean;
  query: string;
  triggerLength: number;
  isStartSlash: boolean;
  /**
   * cmdk's controlled value — the stable string id of the highlighted row
   * (entity referenceId for People/File, skill id for Skills). Empty
   * string when no row is highlighted; cmdk falls back to the first
   * matching item in that case.
   */
  pickerValue: string;
  activeTab: TabId;
  /**
   * Close the picker. Pass the input value the caller has set immediately
   * before closing (e.g., after stripping the trigger slash) so that
   * dismissal-suppression doesn't latch onto stale pre-update text.
   */
  handleClose: (valueAfterClose?: string) => void;
  handleSelect: (entity: ContextEntity) => void;
  /**
   * Open the picker programmatically (no slash trigger). When `tab` is
   * provided, the picker opens on that tab; otherwise it defaults to "People".
   */
  activate: (tab?: TabId) => void;
  setPickerValue: (value: string) => void;
  setActiveTab: (tab: TabId) => void;
}

interface UseContextPickerOptions {
  value: string;
  /** Called when the user picks an entity. Receives the count of characters
   * (including the leading slash and the typed query) to consume before
   * inserting the chip. */
  onPickEntity: (entity: ContextEntity, triggerLength: number) => void;
}

/**
 * Detect whether the caret is positioned after a `/` trigger.
 * All `/` triggers open the Context Picker. The `isStartSlash` flag
 * indicates whether the slash is at the beginning (→ default to Skills tab).
 */
export function detectTrigger(text: string): {
  active: boolean;
  query: string;
  triggerIndex: number;
  isStartSlash: boolean;
  trigger: "/" | "@" | null;
} {
  const lastSlashIdx = text.lastIndexOf("/");
  const lastAtIdx = text.lastIndexOf("@");
  const triggerIndex = Math.max(lastSlashIdx, lastAtIdx);
  if (triggerIndex < 0)
    return { active: false, query: "", triggerIndex: -1, isStartSlash: false, trigger: null };

  const trigger = text[triggerIndex] === "@" ? "@" : "/";

  if (triggerIndex === 0 || (triggerIndex > 0 && /\s/.test(text[triggerIndex - 1]))) {
    const afterTrigger = text.substring(triggerIndex + 1);
    // Only active if the text after the trigger has no spaces.
    if (!/\s/.test(afterTrigger)) {
      // Slash is a command/skill trigger wherever it appears after whitespace.
      // The historical name is retained for API compatibility, but it now
      // means "this picker was opened by slash" rather than column-zero only.
      const isStartSlash = trigger === "/";
      return { active: true, query: afterTrigger, triggerIndex, isStartSlash, trigger };
    }
  }

  return { active: false, query: "", triggerIndex: -1, isStartSlash: false, trigger: null };
}

export function useContextPicker({
  value,
  onPickEntity,
}: UseContextPickerOptions): ContextPickerState {
  const [pickerValue, setPickerValue] = useState("");
  const [forcedActive, setForcedActive] = useState(false);
  // When user dismisses (e.g., ESC) while a `/` trigger is in the input,
  // we suppress re-activation until the input value changes.
  const [dismissedValue, setDismissedValue] = useState<string | null>(null);
  if (dismissedValue !== null && dismissedValue !== value) {
    setDismissedValue(null);
  }

  const trigger = detectTrigger(value);
  const dismissed = dismissedValue !== null && dismissedValue === value;
  const active = (trigger.active || forcedActive) && !dismissed;
  const query = forcedActive && !trigger.active ? "" : trigger.query;
  const isStartSlash = trigger.isStartSlash && !forcedActive;
  const [activeTab, setActiveTab] = useState<TabId>("People");

  // Number of characters to consume before the chip — the trigger slash plus
  // everything typed after it (the live query). When the picker was opened via
  // `activate()` (no slash), nothing needs to be consumed.
  const triggerLength =
    trigger.active && trigger.triggerIndex >= 0 ? value.length - trigger.triggerIndex : 0;

  // Apply default tab + reset selection on the active edge using the
  // adjust-state-during-render pattern. `forcedActive` doubles as a
  // "skip defaults" flag for programmatic opens (activate() sets the tab
  // synchronously and is cleared by handleClose).
  const [prevActive, setPrevActive] = useState(false);
  if (prevActive !== active) {
    setPrevActive(active);
    if (active && !forcedActive) {
      setActiveTab(isStartSlash ? "Skills" : trigger.trigger === "@" ? "File" : "People");
      setPickerValue("");
    }
  }

  // Resetting pickerValue on tab change lets cmdk fall back to the first
  // item of the new tab. Empty string means "no controlled selection".
  const setActiveTabAndReset = useCallback((tab: TabId) => {
    setActiveTab(tab);
    setPickerValue("");
  }, []);

  const handleClose = useCallback(
    (valueAfterClose?: string) => {
      setForcedActive(false);
      // The caller may have just modified the input as part of closing
      // (e.g., stripping the trigger `/`). Use the post-update value so
      // dismissedValue suppresses re-activation only while the same buffer
      // is still in the input — not stale pre-strip text.
      setDismissedValue(valueAfterClose ?? value);
    },
    [value],
  );

  const handleSelect = useCallback(
    (entity: ContextEntity) => {
      onPickEntity(entity, triggerLength);
      setForcedActive(false);
      setPickerValue("");
      // Explicitly dismiss the picker for the current input snapshot. Without
      // this, the picker stays "active" (because the trigger `/` and the
      // typed query are still in `value`) until the editor.update inside
      // onPickEntity commits and propagates back through ChangeRelayPlugin.
      // During that window a second Enter or any subsequent re-render would
      // see the picker as still open. Marking the current value as dismissed
      // closes the picker immediately; the render-phase guard above clears
      // this one-shot dismissal once the editor value moves past the selected trigger.
      setDismissedValue(value);
    },
    [onPickEntity, triggerLength, value],
  );

  const activate = useCallback(
    (tab?: TabId) => {
      setForcedActive(true);
      setPickerValue("");
      // Explicit re-activation should win over any prior dismissal even if
      // the input value hasn't changed since.
      setDismissedValue(null);
      // Synchronously set the requested tab (or fall back to the
      // start-slash default) so consumers don't see a render frame with
      // the old tab. The render-pass default-tab branch above skips when
      // forcedActive is true, so this assignment isn't clobbered.
      setActiveTab(tab ?? (isStartSlash ? "Skills" : "People"));
    },
    [isStartSlash],
  );

  return {
    active,
    query,
    triggerLength,
    isStartSlash,
    pickerValue,
    activeTab,
    handleClose,
    handleSelect,
    activate,
    setPickerValue,
    setActiveTab: setActiveTabAndReset,
  };
}
