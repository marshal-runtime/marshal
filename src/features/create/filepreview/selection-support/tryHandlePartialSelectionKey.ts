/**
 * Pure function that handles partial-selection keyboard events.
 *
 * Extracts the "destructive key on partial selection" and "Cmd+C on partial
 * selection" logic from the main keyboard handler so both code paths use the
 * same `detectPartialSelection` helper for consistent detection semantics.
 *
 * Returns `true` if the event was handled, `false` otherwise.
 */

import { detectPartialSelection } from "./detectPartialSelection";
import type { Segment } from "../markdownParser";
import type { MarkdownRange } from "./rangeToMarkdownRange";

export interface PartialSelectionKeyDeps {
  editor: HTMLDivElement;
  segments: Segment[];
  activeSegIdx: number | null;
  dispatchPartialEdit: (mdRange: MarkdownRange, replaceWith: string, segIdx: number) => void;
  dispatchPartialEditFromClipboard: (mdRange: MarkdownRange, segIdx: number) => Promise<void>;
}

export function tryHandlePartialSelectionKey(
  e: KeyboardEvent,
  deps: PartialSelectionKeyDeps,
): boolean {
  const { editor, segments, activeSegIdx, dispatchPartialEdit, dispatchPartialEditFromClipboard } =
    deps;
  if (activeSegIdx !== null) return false;

  const mod = e.metaKey || e.ctrlKey;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return false;

  // Cmd+C — let browser handle partial-selection copy natively (rendered text,
  // not raw markdown).  Uses the same detectPartialSelection path as
  // destructive keys so detection semantics can't diverge.
  if (mod && e.key === "c") {
    const info = detectPartialSelection(sel, editor, segments);
    if (info?.isPartial) {
      return true; // let browser default copy handle it
    }
    return false; // fall through to raw-markdown copy
  }

  // Destructive keys — apply the operation to the raw markdown using offsets
  const isDestructiveKey =
    e.key === "Backspace" ||
    e.key === "Delete" ||
    e.key === "Enter" ||
    (mod && e.key === "x") ||
    (mod && e.key === "v") ||
    (e.key.length === 1 && !mod && !e.altKey);

  if (!isDestructiveKey) return false;

  const info = detectPartialSelection(sel, editor, segments);
  if (!info?.isPartial || !info.mdRange) return false;

  e.preventDefault();
  e.stopPropagation();

  let replaceWith = "";
  if (e.key === "Enter") {
    replaceWith = "\n";
  } else if (e.key.length === 1 && !mod && !e.altKey) {
    replaceWith = e.key;
  }

  if (mod && e.key === "x") {
    const selectedText = sel.toString();
    void navigator.clipboard.writeText(selectedText);
  }

  if (mod && e.key === "v") {
    void dispatchPartialEditFromClipboard(info.mdRange, info.startSeg);
    return true;
  }

  dispatchPartialEdit(info.mdRange, replaceWith, info.startSeg);
  return true;
}
