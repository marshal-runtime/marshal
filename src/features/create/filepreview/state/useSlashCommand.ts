import { useState, useCallback, useRef, useMemo } from "react";

import { createSlashCommands, type SlashCommandItem } from "../commands/command-catalog";

export interface SlashCommandState {
  /** Whether the slash menu is currently open */
  isOpen: boolean;
  /** Filter text after "/" (e.g., "hea" from "/hea") */
  filterText: string;
  /** The segment index where "/" was typed */
  segmentIndex: number | null;
  /** Index of the highlighted item in the filtered list */
  selectedIndex: number;
}

interface UseSlashCommandReturn {
  state: SlashCommandState;
  /** The filtered list of commands matching the current filter text */
  filteredItems: SlashCommandItem[];
  /** Call when editValue changes to detect "/" */
  onEditValueChange: (value: string, segWasBlank: boolean) => void;
  /** Close the menu */
  close: () => void;
  /** Handle command selection — returns the chosen command */
  select: (item: SlashCommandItem) => SlashCommandItem;
  /** Set the selected index (e.g., on hover) */
  setSelectedIndex: (index: number) => void;
  /**
   * Handle keyboard event when menu is open.
   * Returns true if the event was consumed (caller should preventDefault).
   */
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
}

function matchesFilter(item: SlashCommandItem, filter: string): boolean {
  if (!filter) return true;
  const lower = filter.toLowerCase();
  return (
    item.label.toLowerCase().includes(lower) ||
    item.keywords.some((k) => k.toLowerCase().includes(lower))
  );
}

export function useSlashCommand(
  activeSegIdx: number | null,
  onSelectCallback: (item: SlashCommandItem) => void,
): UseSlashCommandReturn {
  const [state, setState] = useState<SlashCommandState>({
    isOpen: false,
    filterText: "",
    segmentIndex: null,
    selectedIndex: 0,
  });

  const filteredItems = useMemo(
    () => createSlashCommands.filter((cmd) => matchesFilter(cmd, state.filterText)),
    [state.filterText],
  );

  // Track whether the segment was blank before user started typing "/"
  const wasBlankRef = useRef(false);

  const onEditValueChange = useCallback(
    (value: string, segWasBlank: boolean) => {
      if (value.startsWith("/") && (segWasBlank || state.isOpen)) {
        const filter = value.slice(1);
        setState((prev) => ({
          isOpen: true,
          filterText: filter,
          segmentIndex: activeSegIdx,
          // Reset selection when filter changes
          selectedIndex: filter !== prev.filterText ? 0 : prev.selectedIndex,
        }));
        if (!state.isOpen) {
          wasBlankRef.current = true;
        }
      } else if (state.isOpen) {
        setState({ isOpen: false, filterText: "", segmentIndex: null, selectedIndex: 0 });
        wasBlankRef.current = false;
      }
    },
    [activeSegIdx, state.isOpen],
  );

  const close = useCallback(() => {
    setState({ isOpen: false, filterText: "", segmentIndex: null, selectedIndex: 0 });
    wasBlankRef.current = false;
  }, []);

  const select = useCallback((item: SlashCommandItem) => {
    setState({ isOpen: false, filterText: "", segmentIndex: null, selectedIndex: 0 });
    wasBlankRef.current = false;
    return item;
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!state.isOpen) return false;

      if (e.key === "Escape") {
        close();
        return true;
      }

      if (e.key === "ArrowDown") {
        setState((prev) => ({
          ...prev,
          selectedIndex: prev.selectedIndex < filteredItems.length - 1 ? prev.selectedIndex + 1 : 0,
        }));
        return true;
      }

      if (e.key === "ArrowUp") {
        setState((prev) => ({
          ...prev,
          selectedIndex: prev.selectedIndex > 0 ? prev.selectedIndex - 1 : filteredItems.length - 1,
        }));
        return true;
      }

      if (e.key === "Enter") {
        const selected = filteredItems[state.selectedIndex];
        if (selected) {
          select(selected);
          onSelectCallback(selected);
        } else {
          close();
        }
        return true;
      }

      return false;
    },
    [state.isOpen, state.selectedIndex, filteredItems, close, select, onSelectCallback],
  );

  const setSelectedIndex = useCallback((index: number) => {
    setState((prev) => ({ ...prev, selectedIndex: index }));
  }, []);

  return {
    state,
    filteredItems,
    onEditValueChange,
    close,
    select,
    setSelectedIndex,
    handleKeyDown,
  };
}
