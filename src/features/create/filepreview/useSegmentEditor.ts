import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

import type { Segment } from "./markdownParser";
import { detectPartialSelection } from "./selection-support/detectPartialSelection";
import { useEditUndoStack } from "./state/useEditUndoStack";
import { usePendingEditAction } from "./state/usePendingEditAction";

export { applyPendingEdit, type PendingEditAction } from "./helpers/pendingEdit";

// Apply an in-segment undo/redo result. flushSync forces React to commit the
// new value to the textarea DOM before we set the cursor — without it, under
// React 19 concurrent rendering setSelectionRange can fire against the stale
// pre-undo value and the browser silently clamps to 0. Also bumps the bridge
// flag so the global Cmd+Z handler skips doc-level undo this tick.
function applyEditUndoResult(
  result: { text: string; cursor: number },
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  setEditValue: (v: string) => void,
  handledRef: RefObject<boolean>,
): void {
  handledRef.current = true;
  flushSync(() => setEditValue(result.text));
  const el = inputRef.current;
  if (!el) return;
  el.focus();
  const pos = Math.min(result.cursor, result.text.length);
  el.setSelectionRange(pos, pos);
  if (el instanceof HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }
}

// ── Click-to-cursor helper ────────────────────────────────────
// Given a textarea and click coordinates, compute the character offset
// at that point using canvas text measurement.
function getCaretOffsetFromPoint(
  textarea: HTMLTextAreaElement,
  clientX: number,
  clientY: number,
): number {
  const text = textarea.value;
  if (!text) return 0;

  // Use a hidden mirror div that matches the textarea's exact styling to map
  // (x, y) click coordinates to a character offset. This handles visual line
  // wrapping correctly (unlike splitting by \n which only handles logical lines).
  const mirror = document.createElement("div");
  const style = getComputedStyle(textarea);

  // Copy all relevant styles from the textarea
  mirror.style.cssText = `
    position: absolute; left: -9999px; top: -9999px; visibility: hidden;
    white-space: pre-wrap; word-break: break-word; overflow-wrap: break-word;
    font: ${style.font}; font-size: ${style.fontSize}; font-family: ${style.fontFamily};
    font-weight: ${style.fontWeight}; line-height: ${style.lineHeight};
    letter-spacing: ${style.letterSpacing}; word-spacing: ${style.wordSpacing};
    padding: ${style.padding}; border: ${style.border};
    box-sizing: ${style.boxSizing};
    width: ${textarea.getBoundingClientRect().width}px;
  `;

  // Build mirror with one <span> per character so we can measure each one
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      mirror.appendChild(document.createElement("br"));
    } else {
      const span = document.createElement("span");
      span.textContent = ch;
      mirror.appendChild(span);
    }
  }
  document.body.appendChild(mirror);

  // Calculate click position relative to textarea
  const taRect = textarea.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();
  const offsetX = taRect.left - mirrorRect.left;
  const offsetY = taRect.top - mirrorRect.top;
  const targetX = clientX - offsetX;
  const targetY = clientY - offsetY;

  // Find the closest character to the click point
  let bestIdx = text.length;
  let bestDist = Infinity;
  let charIdx = 0;
  for (let i = 0; i < mirror.childNodes.length; i++) {
    const node = mirror.childNodes[i];
    if (node.nodeName === "BR") {
      charIdx++;
      continue;
    }
    if (!(node instanceof Element)) {
      charIdx++;
      continue;
    }
    const r = node.getBoundingClientRect();
    // Check left edge (before this char) and right edge (after this char)
    const midY = r.top + r.height / 2;
    const dy = targetY - midY;
    // Only consider characters on lines close to the click Y
    if (Math.abs(dy) < r.height) {
      const dxLeft = targetX - r.left;
      const dxRight = targetX - r.right;
      if (Math.abs(dxLeft) < bestDist) {
        bestDist = Math.abs(dxLeft);
        bestIdx = charIdx;
      }
      if (Math.abs(dxRight) < bestDist) {
        bestDist = Math.abs(dxRight);
        bestIdx = charIdx + 1;
      }
    }
    charIdx++;
  }

  document.body.removeChild(mirror);
  return Math.min(bestIdx, text.length);
}

// ── Types ──────────────────────────────────────────────────────
interface ContentMutators {
  undoStackPush: (value: string) => void;
  applyContent: (value: string) => void;
  debouncedSave: (value: string) => void;
}

interface UseSegmentEditorParams {
  segments: Segment[];
  lines: string[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  editorRef: RefObject<HTMLDivElement | null>;
  content: ContentMutators;
  getSelectionMarkdown: () => string | null;
}

// ── List continuation helper ──────────────────────────────────
// Returns the prefix for continuing a list on Enter, or null if the line is not a list item.
// For empty bullets (prefix only, no text), returns "" to signal the caller to exit the list.
const UL_RE = /^(\s*)([-*+])\s/;
const OL_RE = /^(\s*)(\d+)\.\s/;
const TASK_RE = /^(\s*[-*+])\s\[[ xX]\]\s/;

export function getListContinuationPrefix(line: string): string | null {
  // Task list: `- [ ] text` or `- [x] text`
  const taskMatch = line.match(TASK_RE);
  if (taskMatch) {
    const prefix = taskMatch[1] + " [ ] ";
    const textAfterPrefix = line.slice(taskMatch[0].length);
    return textAfterPrefix.length === 0 ? "" : prefix;
  }

  // Unordered list: `- text`, `* text`, `+ text` (with optional indent)
  const ulMatch = line.match(UL_RE);
  if (ulMatch) {
    const prefix = ulMatch[1] + ulMatch[2] + " ";
    const textAfterPrefix = line.slice(ulMatch[0].length);
    return textAfterPrefix.length === 0 ? "" : prefix;
  }

  // Ordered list: `1. text` (with optional indent)
  const olMatch = line.match(OL_RE);
  if (olMatch) {
    const nextNum = parseInt(olMatch[2], 10) + 1;
    const prefix = olMatch[1] + nextNum + ". ";
    const textAfterPrefix = line.slice(olMatch[0].length);
    return textAfterPrefix.length === 0 ? "" : prefix;
  }

  return null;
}

// ── Enter-at-start helper ─────────────────────────────────────
// When Enter is pressed at position 0, returns what to insert above.
// For list items: the continuation prefix (empty bullet above).
// For non-list or empty bullets: a blank line.
export function getLineInsertedAbove(editValue: string): string {
  const prefix = getListContinuationPrefix(editValue);
  if (prefix == null || prefix === "") return "";
  // For ordered lists, keep the same number — not the incremented continuation
  const olMatch = editValue.match(OL_RE);
  if (olMatch) return olMatch[1] + olMatch[2] + ". ";
  return prefix;
}

// ── Hook ───────────────────────────────────────────────────────
export function useSegmentEditor({
  segments,
  lines,
  inputRef,
  editorRef,
  content,
  getSelectionMarkdown,
}: UseSegmentEditorParams) {
  const { undoStackPush, applyContent, debouncedSave } = content;

  // Editor state
  const [activeSegIdx, setActiveSegIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [lockedHeight, setLockedHeight] = useState<number | null>(null);
  const editUndo = useEditUndoStack();
  // Set by the textarea Cmd+Z handler when it successfully handles an edit-level
  // undo/redo. The global handler reads and resets this to avoid double-firing.
  // We can't use e.defaultPrevented because we need preventDefault() to always
  // block native browser undo (which corrupts cursor state on controlled textareas).
  const editUndoHandledRef = useRef(false);
  const pendingActivateLineRef = useRef<number | null>(null);
  const pendingClickPosRef = useRef<{ x: number; y: number } | null>(null);
  const pendingCursorPosRef = useRef<"start" | "end" | "all" | number | null>(null);
  const { queuePendingEditAction, consumePendingEditAction } = usePendingEditAction();
  // Drag-to-select from edit mode: tracks the anchor segment when dragging
  const dragAnchorSegRef = useRef<number | null>(null);
  // Tracks whether a mousedown happened inside the editor (to suppress blur-triggered deactivation)
  const mouseDownInsideRef = useRef(false);

  // Deferred activation after content change (Enter/Backspace create new segments)
  useEffect(() => {
    const targetLine = pendingActivateLineRef.current;
    if (targetLine === null) return;
    pendingActivateLineRef.current = null;
    const idx = segments.findIndex((s) => s.start <= targetLine && s.end >= targetLine);
    if (idx >= 0) {
      const seg = segments[idx];
      // Never activate comment segments — they handle their own editing
      if (seg.type === "comment") return;
      const segText = lines.slice(seg.start, seg.end + 1).join("\n");
      editUndo.init(segText);
      setEditValue(segText);
      setActiveSegIdx(idx);
    }
  }, [segments, lines, editUndo, setEditValue, setActiveSegIdx]);

  // Activate a segment for editing
  const activateSegment = useCallback(
    (segIdx: number, cursorPos?: "start" | "end" | "all") => {
      if (segIdx < 0 || segIdx >= segments.length) return;
      const seg = segments[segIdx];
      // Never activate comment segments — they handle their own editing
      if (seg.type === "comment") return;
      const segText = lines.slice(seg.start, seg.end + 1).join("\n");

      // Measure rendered height to lock it during editing
      const editor = editorRef.current;
      if (editor) {
        const segEl = editor.children[segIdx];
        if (segEl instanceof Element) {
          setLockedHeight(segEl.getBoundingClientRect().height);
        }
      }

      // Set pending cursor position for the focus useEffect
      if (cursorPos) pendingCursorPosRef.current = cursorPos;

      editUndo.init(segText);
      setEditValue(segText);
      setActiveSegIdx(segIdx);
    },
    [segments, lines, editorRef, editUndo],
  );

  // Clear height lock when deactivating
  const clearHeightLock = useCallback(() => {
    setLockedHeight(null);
  }, []);

  // Commit current edit back to document
  const commitEdit = useCallback(
    (nextSegIdx?: number | null) => {
      if (activeSegIdx === null) return;
      editUndo.clear();
      const seg = segments[activeSegIdx];
      const newLines = [...lines];
      const editLines = editValue.split("\n");
      newLines.splice(seg.start, seg.end - seg.start + 1, ...editLines);
      const newValue = newLines.join("\n");
      undoStackPush(newValue);
      applyContent(newValue);
      debouncedSave(newValue);

      if (nextSegIdx == null) {
        setActiveSegIdx(null);
        clearHeightLock();
      }
    },
    [
      activeSegIdx,
      segments,
      lines,
      editValue,
      undoStackPush,
      applyContent,
      debouncedSave,
      editUndo,
      clearHeightLock,
    ],
  );

  // Commit edit and create a cross-segment selection (for Shift+Arrow from edit mode)
  const commitAndSelectAcross = useCallback(
    (currentSegIdx: number, direction: "down" | "up") => {
      commitEdit();
      setActiveSegIdx(null);
      clearHeightLock();
      requestAnimationFrame(() => {
        const editor = editorRef.current;
        if (!editor) return;
        const segEls = editor.querySelectorAll(".md-seg");
        const targetIdx = direction === "down" ? currentSegIdx + 1 : currentSegIdx - 1;
        if (targetIdx < 0 || targetIdx >= segEls.length) return;

        const sel = window.getSelection();
        if (!sel) return;
        sel.removeAllRanges();

        // Use collapse+extend so focusNode is INSIDE the target segment.
        // This allows the document-level Shift+Arrow handler to detect the
        // focus segment and extend further on subsequent presses.
        const anchorEl =
          segEls[direction === "down" ? currentSegIdx : currentSegIdx].querySelector(
            ".md-seg-rendered",
          ) || segEls[currentSegIdx];
        const focusEl = segEls[targetIdx].querySelector(".md-seg-rendered") || segEls[targetIdx];

        if (direction === "down") {
          // Anchor at start of current segment, extend to end of target
          const anchorNode = anchorEl.firstChild || anchorEl;
          sel.collapse(anchorNode, 0);
          let endNode: Node = focusEl;
          while (endNode.lastChild) endNode = endNode.lastChild;
          sel.extend(endNode, endNode.textContent?.length ?? 0);
        } else {
          // Anchor at end of current segment, extend to start of target (upward)
          let anchorNode: Node = anchorEl;
          while (anchorNode.lastChild) anchorNode = anchorNode.lastChild;
          sel.collapse(anchorNode, anchorNode.textContent?.length ?? 0);
          const focusNode = focusEl.firstChild || focusEl;
          sel.extend(focusNode, 0);
        }
      });
    },
    [commitEdit, clearHeightLock, editorRef],
  );

  // Commit edit and select entire document (for Cmd+A second-press from edit mode)
  const commitAndSelectAll = useCallback(() => {
    commitEdit();
    setActiveSegIdx(null);
    clearHeightLock();
    requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      const segEls = editor.querySelectorAll(".md-seg");
      if (!segEls.length) return;
      const sel = window.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      const range = document.createRange();
      range.setStartBefore(segEls[0]);
      range.setEndAfter(segEls[segEls.length - 1]);
      sel.addRange(range);
    });
  }, [commitEdit, clearHeightLock, editorRef]);

  useEffect(() => {
    if (activeSegIdx !== null) {
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();

        // Auto-resize textarea to fit wrapped content
        el.style.height = "auto";
        el.style.height = el.scrollHeight + "px";

        // Handle pending edit action (offset-based partial-selection edits).
        // The edit action specifies exact character offsets in the raw markdown
        // to delete or replace — no string-search heuristics needed.
        if (activeSegIdx !== null) {
          const seg = segments[activeSegIdx];
          if (seg?.mdStart != null) {
            const result = consumePendingEditAction(el.value, seg.mdStart);
            if (result) {
              setEditValue(result.newValue);
              requestAnimationFrame(() => {
                if (el !== inputRef.current) return;
                el.setSelectionRange(result.cursorPos, result.cursorPos);
                el.style.height = "auto";
                el.style.height = el.scrollHeight + "px";
              });
              return;
            }
          }
        }

        // Check for programmatic cursor position (ArrowLeft/Right, merge)
        const cursorPos = pendingCursorPosRef.current;
        pendingCursorPosRef.current = null;
        if (cursorPos !== null) {
          if (cursorPos === "all") {
            el.setSelectionRange(0, el.value.length);
          } else {
            const pos =
              typeof cursorPos === "number" ? cursorPos : cursorPos === "end" ? el.value.length : 0;
            el.setSelectionRange(pos, pos);
          }
          return;
        }

        const clickPos = pendingClickPosRef.current;
        pendingClickPosRef.current = null;
        if (clickPos) {
          const offset = getCaretOffsetFromPoint(el, clickPos.x, clickPos.y);
          el.setSelectionRange(offset, offset);
          return;
        }

        const len = el.value.length;
        el.setSelectionRange(len, len);
      });
    }
  }, [activeSegIdx, segments, inputRef, consumePendingEditAction]);

  // Wrap selection with markdown formatting (Cmd+B, Cmd+I)
  const wrapSelection = useCallback(
    (wrapper: string) => {
      const el = inputRef.current;
      if (!el) return;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? start;
      const before = editValue.substring(0, start);
      const selected = editValue.substring(start, end);
      const after = editValue.substring(end);

      // If selection is already wrapped, unwrap it
      if (before.endsWith(wrapper) && after.startsWith(wrapper)) {
        const newVal = before.slice(0, -wrapper.length) + selected + after.slice(wrapper.length);
        setEditValue(newVal);
        requestAnimationFrame(() =>
          el.setSelectionRange(start - wrapper.length, end - wrapper.length),
        );
      } else {
        const newVal = before + wrapper + selected + wrapper + after;
        setEditValue(newVal);
        requestAnimationFrame(() =>
          el.setSelectionRange(start + wrapper.length, end + wrapper.length),
        );
      }
    },
    [editValue, inputRef],
  );

  // Paste handler — if multiline, commit edit and splice into document
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const html = e.clipboardData.getData("text/html");
      const plain = e.clipboardData.getData("text/plain");
      const text = plain || html;
      if (!text) return;
      e.preventDefault();

      // Multiline paste: commit current edit, then splice pasted lines into document
      if (text.includes("\n") && activeSegIdx !== null) {
        const el = inputRef.current;
        const start = el?.selectionStart ?? 0;
        const end = el?.selectionEnd ?? start;
        const currentVal = editValue;
        const beforeCursor = currentVal.substring(0, start);
        const afterCursor = currentVal.substring(end);
        // Build the replacement: current line up to cursor + pasted text + rest of line
        const combined = beforeCursor + text + afterCursor;
        const seg = segments[activeSegIdx];
        if (seg) {
          const newLines = [...lines];
          const pastedLines = combined.split("\n");
          newLines.splice(seg.start, seg.end - seg.start + 1, ...pastedLines);
          const newValue = newLines.join("\n");
          undoStackPush(newValue);
          setActiveSegIdx(null);
          clearHeightLock();
          applyContent(newValue);
          debouncedSave(newValue);
          // Place cursor at end of last pasted line
          const lastPastedLine = seg.start + pastedLines.length - 1;
          pendingActivateLineRef.current = lastPastedLine;
          pendingCursorPosRef.current = "end";
        }
        return;
      }

      // Single-line paste: insert into current textarea
      const el = inputRef.current;
      if (!el) return;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? start;
      const newVal = editValue.substring(0, start) + text + editValue.substring(end);
      const newCursor = start + text.length;
      // Push pre-paste state, then post-paste state as discrete snapshots.
      // Using record() doesn't work because pushSnapshot deduplicates the
      // pre-paste text (it matches the existing stack entry).
      editUndo.snapshot(editValue, start);
      editUndo.snapshot(newVal, newCursor);
      setEditValue(newVal);
      requestAnimationFrame(() => {
        el.setSelectionRange(newCursor, newCursor);
        // Auto-resize to fit wrapped content (mirrors onChange handler)
        el.style.height = "auto";
        el.style.height = el.scrollHeight + "px";
      });
    },
    [
      editValue,
      editUndo,
      activeSegIdx,
      segments,
      lines,
      undoStackPush,
      applyContent,
      debouncedSave,
      clearHeightLock,
      inputRef,
    ],
  );

  // ── Shared navigation helpers ───────────────────────────────
  // These reduce the duplicated commit→rAF→activate pattern across handlers.

  /** Exit current segment vertically (ArrowUp/Down). Deactivates if at boundary. */
  const exitSegment = useCallback(
    (direction: "prev" | "next", segIdx: number) => {
      const nextIdx = direction === "next" ? segIdx + 1 : segIdx - 1;
      const inBounds = nextIdx >= 0 && nextIdx < segments.length;
      if (!inBounds) return; // Stay in current segment at document boundaries
      commitEdit(nextIdx);
      requestAnimationFrame(() => activateSegment(nextIdx, direction === "next" ? "start" : "end"));
    },
    [segments.length, commitEdit, activateSegment],
  );

  /** Navigate to adjacent segment horizontally (ArrowLeft/Right). Returns true if navigated. */
  const navigateToAdjacentSegment = useCallback(
    (direction: "prev" | "next", segIdx: number): boolean => {
      const nextIdx = direction === "next" ? segIdx + 1 : segIdx - 1;
      if (nextIdx < 0 || nextIdx >= segments.length) return false;
      commitEdit(nextIdx);
      requestAnimationFrame(() => activateSegment(nextIdx, direction === "next" ? "start" : "end"));
      return true;
    },
    [segments.length, commitEdit, activateSegment],
  );

  // Keyboard navigation for single-line segments
  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, segIdx: number) => {
      const input = e.currentTarget;
      const mod = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl+Z — custom undo/redo (word-boundary grouping)
      if (mod && (e.key === "z" || e.key === "Z")) {
        // Always prevent native undo — it corrupts cursor state on controlled textareas
        e.preventDefault();
        const result = e.shiftKey ? editUndo.redo() : editUndo.undo();
        if (result !== null) {
          applyEditUndoResult(result, inputRef, setEditValue, editUndoHandledRef);
        }
        // If result is null, edit stack is exhausted — the global handler will
        // see editUndoHandledRef=false and do document-level undo/redo.
        return;
      }

      // Cmd/Ctrl+B = bold, Cmd/Ctrl+I = italic
      if (mod && (e.key === "b" || e.key === "i")) {
        e.preventDefault();
        wrapSelection(e.key === "b" ? "**" : "*");
        return;
      }

      // Cmd+A: if all text is already selected, expand to full document
      if (mod && e.key === "a") {
        if (input.selectionStart === 0 && input.selectionEnd === input.value.length) {
          e.preventDefault();
          commitAndSelectAll();
          return;
        }
        // Otherwise let browser select all within the textarea
        return;
      }

      // Shift+ArrowDown at end of input → cross-segment selection
      if (e.shiftKey && e.key === "ArrowDown") {
        e.preventDefault();
        commitAndSelectAcross(segIdx, "down");
        return;
      }

      // Shift+ArrowUp at start of input → cross-segment selection
      if (e.shiftKey && e.key === "ArrowUp") {
        e.preventDefault();
        commitAndSelectAcross(segIdx, "up");
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        commitEdit();
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        if (activeSegIdx === null) return;
        const seg = segments[activeSegIdx];
        const newLines = [...lines];
        const cursorPos = input.selectionStart ?? 0;

        if (cursorPos === 0) {
          // Cursor at beginning: insert a line before, pushing content down.
          // For list items, insert an empty bullet to keep the list continuous.
          newLines.splice(seg.start, 0, getLineInsertedAbove(editValue));
          const newValue = newLines.join("\n");
          undoStackPush(newValue);
          applyContent(newValue);
          debouncedSave(newValue);
          setActiveSegIdx(null);
          clearHeightLock();
          pendingActivateLineRef.current = seg.start + 1;
          pendingCursorPosRef.current = "start";
        } else {
          // Cursor in middle/end: split at cursor, keep before on current line,
          // carry after to the new line (with list prefix when applicable)
          const beforeCursor = editValue.slice(0, cursorPos);
          const afterCursor = editValue.slice(cursorPos);

          const beforeLines = beforeCursor.split("\n");
          newLines.splice(seg.start, seg.end - seg.start + 1, ...beforeLines);
          const insertAt = seg.start + beforeLines.length;

          // List continuation: carry over bullet/number prefix
          const continuation = getListContinuationPrefix(beforeCursor);

          let activateLine: number;
          let cursorOffset: "start" | number = "start";
          if (continuation === "" && afterCursor.length === 0) {
            // Empty bullet with no trailing text — remove the prefix, exit the list
            newLines[seg.start] = "";
            activateLine = seg.start;
          } else if (continuation === "" && afterCursor.length > 0) {
            // Cursor is right at the prefix boundary with text remaining —
            // recompute from the full line so the carried text keeps its list prefix
            const fullContinuation = getListContinuationPrefix(editValue);
            if (fullContinuation && fullContinuation !== "") {
              cursorOffset = fullContinuation.length;
              newLines.splice(insertAt, 0, fullContinuation + afterCursor.trimStart());
            } else {
              newLines.splice(insertAt, 0, afterCursor.trimStart());
            }
            activateLine = insertAt;
          } else if (continuation != null) {
            cursorOffset = continuation.length;
            // List line: new bullet carries forward the remaining text
            newLines.splice(insertAt, 0, continuation + afterCursor.trimStart());
            activateLine = insertAt;
          } else {
            const afterText = afterCursor.trimStart();
            // Paragraphs only: insert a blank line between the split halves
            // so the mdast parser keeps them as separate paragraph segments
            // rather than merging them via a soft line break (CommonMark §6.8).
            // Headings/blockquotes/code etc. naturally split without this.
            if (seg.type === "paragraph" && afterText.length > 0) {
              newLines.splice(insertAt, 0, "", afterText);
              activateLine = insertAt + 1;
            } else {
              newLines.splice(insertAt, 0, afterText);
              activateLine = insertAt;
            }
          }

          const newValue = newLines.join("\n");
          undoStackPush(newValue);
          applyContent(newValue);
          debouncedSave(newValue);
          setActiveSegIdx(null);
          clearHeightLock();
          pendingActivateLineRef.current = activateLine;
          pendingCursorPosRef.current = cursorOffset;
        }
        return;
      }

      if (e.key === "Backspace" && input.value === "" && input.selectionStart === 0) {
        e.preventDefault();
        if (activeSegIdx === null) return;
        const seg = segments[activeSegIdx];
        const prevLine = Math.max(0, seg.start - 1);
        const newLines = [...lines];
        newLines.splice(seg.start, seg.end - seg.start + 1);
        if (newLines.length === 0) newLines.push("");
        const newValue = newLines.join("\n");
        undoStackPush(newValue);
        applyContent(newValue);
        debouncedSave(newValue);
        setActiveSegIdx(null);
        clearHeightLock();
        pendingActivateLineRef.current = prevLine;
        return;
      }

      // Backspace at position 0 on non-empty line → merge with previous segment
      if (
        e.key === "Backspace" &&
        input.selectionStart === 0 &&
        input.selectionStart === input.selectionEnd &&
        segIdx > 0
      ) {
        e.preventDefault();
        if (activeSegIdx === null) return;
        const seg = segments[activeSegIdx];
        const prevSeg = segments[segIdx - 1];
        if (!prevSeg || prevSeg.type === "comment" || prevSeg.type === "table") return;
        const prevText = lines.slice(prevSeg.start, prevSeg.end + 1).join("\n");
        const curText = editValue;
        const mergedText = prevText + curText;
        const newLines = [...lines];
        // Replace previous segment lines + current segment lines with merged
        newLines.splice(prevSeg.start, seg.end - prevSeg.start + 1, mergedText);
        const newValue = newLines.join("\n");
        undoStackPush(newValue);
        applyContent(newValue);
        debouncedSave(newValue);
        setActiveSegIdx(null);
        clearHeightLock();
        // Activate the merged segment with cursor at the join point
        pendingActivateLineRef.current = prevSeg.start;
        pendingCursorPosRef.current = prevText.length;
        return;
      }

      // Forward delete on empty segment → delete the segment (move to next)
      if (e.key === "Delete" && input.value === "" && input.selectionStart === 0) {
        e.preventDefault();
        if (activeSegIdx === null) return;
        const seg = segments[activeSegIdx];
        const nextLine = Math.min(seg.start, lines.length - 1);
        const newLines = [...lines];
        newLines.splice(seg.start, seg.end - seg.start + 1);
        if (newLines.length === 0) newLines.push("");
        const newValue = newLines.join("\n");
        undoStackPush(newValue);
        applyContent(newValue);
        debouncedSave(newValue);
        setActiveSegIdx(null);
        clearHeightLock();
        pendingActivateLineRef.current = Math.min(nextLine, newLines.length - 1);
        return;
      }

      // Forward delete at end of line → merge with next segment
      if (
        e.key === "Delete" &&
        input.selectionStart === input.value.length &&
        input.selectionStart === input.selectionEnd &&
        segIdx < segments.length - 1
      ) {
        e.preventDefault();
        if (activeSegIdx === null) return;
        const seg = segments[activeSegIdx];
        const nextSeg = segments[segIdx + 1];
        if (!nextSeg || nextSeg.type === "comment" || nextSeg.type === "table") return;
        const curText = editValue;
        const nextText = lines.slice(nextSeg.start, nextSeg.end + 1).join("\n");
        const mergedText = curText + nextText;
        const newLines = [...lines];
        newLines.splice(seg.start, nextSeg.end - seg.start + 1, mergedText);
        const newValue = newLines.join("\n");
        undoStackPush(newValue);
        applyContent(newValue);
        debouncedSave(newValue);
        setActiveSegIdx(null);
        clearHeightLock();
        pendingActivateLineRef.current = seg.start;
        pendingCursorPosRef.current = curText.length;
        return;
      }

      if (e.key === "Tab") {
        e.preventDefault();
        const start = input.selectionStart ?? 0;
        const end = input.selectionEnd ?? start;
        if (e.shiftKey) {
          // Dedent: remove up to 2 leading spaces
          const stripped = editValue.replace(/^ {1,2}/, "");
          const removed = editValue.length - stripped.length;
          setEditValue(stripped);
          requestAnimationFrame(() =>
            input.setSelectionRange(Math.max(0, start - removed), Math.max(0, end - removed)),
          );
        } else {
          const newVal = editValue.substring(0, start) + "  " + editValue.substring(end);
          setEditValue(newVal);
          requestAnimationFrame(() => input.setSelectionRange(start + 2, start + 2));
        }
        return;
      }

      // ArrowDown — for wrapped text, let browser navigate visual lines first.
      // Only exit to next segment if cursor doesn't move (already on last visual line).
      if (e.key === "ArrowDown" && !e.shiftKey) {
        const posBefore = input.selectionStart;
        // If text doesn't wrap (single visual line), exit immediately
        const lineH = parseFloat(getComputedStyle(input).lineHeight) || input.clientHeight;
        if (input.scrollHeight <= lineH * 1.5) {
          e.preventDefault();
          exitSegment("next", segIdx);
          return;
        }
        // Text wraps — let browser move cursor, then check if it moved
        requestAnimationFrame(() => {
          if (input.selectionStart === posBefore && input.selectionEnd === posBefore) {
            exitSegment("next", segIdx);
          }
        });
        return;
      }

      // ArrowUp — same pattern as ArrowDown
      if (e.key === "ArrowUp" && !e.shiftKey) {
        const posBefore = input.selectionStart;
        const lineH = parseFloat(getComputedStyle(input).lineHeight) || input.clientHeight;
        if (input.scrollHeight <= lineH * 1.5) {
          e.preventDefault();
          exitSegment("prev", segIdx);
          return;
        }
        requestAnimationFrame(() => {
          if (input.selectionStart === posBefore && input.selectionEnd === posBefore) {
            exitSegment("prev", segIdx);
          }
        });
        return;
      }

      // ArrowLeft at position 0 with no selection → go to previous segment (end)
      if (
        e.key === "ArrowLeft" &&
        !e.shiftKey &&
        input.selectionStart === 0 &&
        input.selectionStart === input.selectionEnd
      ) {
        if (navigateToAdjacentSegment("prev", segIdx)) e.preventDefault();
        return;
      }

      // ArrowRight at end with no selection → go to next segment (start)
      if (
        e.key === "ArrowRight" &&
        !e.shiftKey &&
        input.selectionEnd === input.value.length &&
        input.selectionStart === input.selectionEnd
      ) {
        if (navigateToAdjacentSegment("next", segIdx)) e.preventDefault();
        return;
      }
    },
    [
      activeSegIdx,
      segments,
      lines,
      editValue,
      editUndo,
      inputRef,
      undoStackPush,
      applyContent,
      debouncedSave,
      commitEdit,
      commitAndSelectAcross,
      commitAndSelectAll,
      wrapSelection,
      clearHeightLock,
      exitSegment,
      navigateToAdjacentSegment,
    ],
  );

  // Keyboard navigation for multi-line textarea
  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>, segIdx: number) => {
      const mod = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl+Z — custom undo/redo (word-boundary grouping)
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        const result = e.shiftKey ? editUndo.redo() : editUndo.undo();
        if (result !== null) {
          applyEditUndoResult(result, inputRef, setEditValue, editUndoHandledRef);
        }
        return;
      }

      if (mod && (e.key === "b" || e.key === "i")) {
        e.preventDefault();
        wrapSelection(e.key === "b" ? "**" : "*");
        return;
      }

      // Cmd+A: if all text is already selected, expand to full document
      if (mod && e.key === "a") {
        const ta = e.currentTarget;
        if (ta.selectionStart === 0 && ta.selectionEnd === ta.value.length) {
          e.preventDefault();
          commitAndSelectAll();
          return;
        }
        return;
      }

      // Shift+ArrowDown at end of textarea → cross-segment selection
      if (e.shiftKey && e.key === "ArrowDown") {
        const ta = e.currentTarget;
        if (ta.selectionStart === ta.value.length || ta.selectionEnd === ta.value.length) {
          e.preventDefault();
          commitAndSelectAcross(segIdx, "down");
          return;
        }
        return;
      }

      // Shift+ArrowUp at start of textarea → cross-segment selection
      if (e.shiftKey && e.key === "ArrowUp") {
        const ta = e.currentTarget;
        if (ta.selectionStart === 0) {
          e.preventDefault();
          commitAndSelectAcross(segIdx, "up");
          return;
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        commitEdit();
        return;
      }

      // Backspace on empty code block → delete the entire segment
      if (e.key === "Backspace" && activeSegIdx !== null) {
        const val = e.currentTarget.value;
        // Check if completely empty or just fence markers with no content
        const isEmptyBlock =
          val === "" ||
          (() => {
            const bl = val.split("\n");
            if (bl.length < 2 || !bl[0].startsWith("```")) return false;
            if (!bl[bl.length - 1].trimEnd().startsWith("```")) return false;
            return bl.slice(1, -1).every((l) => l.trim() === "");
          })();
        if (isEmptyBlock) {
          e.preventDefault();
          const seg = segments[activeSegIdx];
          const prevLine = Math.max(0, seg.start - 1);
          const newLines = [...lines];
          newLines.splice(seg.start, seg.end - seg.start + 1);
          if (newLines.length === 0) newLines.push("");
          const newValue = newLines.join("\n");
          undoStackPush(newValue);
          applyContent(newValue);
          debouncedSave(newValue);
          setActiveSegIdx(null);
          clearHeightLock();
          pendingActivateLineRef.current = prevLine;
          return;
        }
      }

      // Forward delete on empty code block → delete the entire segment
      if (e.key === "Delete" && activeSegIdx !== null) {
        const val = e.currentTarget.value;
        const isEmptyBlock =
          val === "" ||
          (() => {
            const bl = val.split("\n");
            if (bl.length < 2 || !bl[0].startsWith("```")) return false;
            if (!bl[bl.length - 1].trimEnd().startsWith("```")) return false;
            return bl.slice(1, -1).every((l) => l.trim() === "");
          })();
        if (isEmptyBlock) {
          e.preventDefault();
          const seg = segments[activeSegIdx];
          const nextLine = Math.min(seg.start, lines.length - 1);
          const newLines = [...lines];
          newLines.splice(seg.start, seg.end - seg.start + 1);
          if (newLines.length === 0) newLines.push("");
          const newValue = newLines.join("\n");
          undoStackPush(newValue);
          applyContent(newValue);
          debouncedSave(newValue);
          setActiveSegIdx(null);
          clearHeightLock();
          pendingActivateLineRef.current = Math.min(nextLine, newLines.length - 1);
          return;
        }
      }

      if (e.key === "Tab") {
        e.preventDefault();
        const ta = e.currentTarget;
        const start = ta.selectionStart ?? 0;
        const end = ta.selectionEnd ?? start;
        if (e.shiftKey) {
          // Dedent selected lines
          const before = editValue.substring(0, start);
          const sel = editValue.substring(start, end);
          const after = editValue.substring(end);
          const dedented = sel.replace(/^ {1,2}/gm, "");
          const removed = sel.length - dedented.length;
          setEditValue(before + dedented + after);
          requestAnimationFrame(() => ta.setSelectionRange(start, end - removed));
        } else {
          // Indent: insert 2 spaces at cursor or indent selected lines
          if (start === end) {
            const newVal = editValue.substring(0, start) + "  " + editValue.substring(end);
            setEditValue(newVal);
            requestAnimationFrame(() => ta.setSelectionRange(start + 2, start + 2));
          } else {
            const before = editValue.substring(0, start);
            const sel = editValue.substring(start, end);
            const after = editValue.substring(end);
            const indented = sel.replace(/^/gm, "  ");
            const added = indented.length - sel.length;
            setEditValue(before + indented + after);
            requestAnimationFrame(() => ta.setSelectionRange(start, end + added));
          }
        }
        return;
      }

      const ta = e.currentTarget;
      // ArrowDown — let browser navigate visual lines within the textarea.
      // Only exit to the next segment if the cursor doesn't move (last visual line).
      if (e.key === "ArrowDown" && !e.shiftKey) {
        // Quick check: if there's a newline after cursor, definitely not on last logical line
        if (ta.value.indexOf("\n", ta.selectionStart) !== -1) return;
        const posBefore = ta.selectionStart;
        requestAnimationFrame(() => {
          if (ta.selectionStart === posBefore && ta.selectionEnd === posBefore) {
            exitSegment("next", segIdx);
          }
        });
        return;
      }

      // ArrowUp — same: only exit if cursor doesn't move (first visual line).
      if (e.key === "ArrowUp" && !e.shiftKey) {
        // Quick check: if there's a newline before cursor, definitely not on first logical line
        if (ta.value.lastIndexOf("\n", ta.selectionStart - 1) !== -1) return;
        const posBefore = ta.selectionStart;
        requestAnimationFrame(() => {
          if (ta.selectionStart === posBefore && ta.selectionEnd === posBefore) {
            exitSegment("prev", segIdx);
          }
        });
        return;
      }

      // ArrowLeft at position 0 with no selection → go to previous segment (end)
      if (
        e.key === "ArrowLeft" &&
        !e.shiftKey &&
        ta.selectionStart === 0 &&
        ta.selectionStart === ta.selectionEnd
      ) {
        if (navigateToAdjacentSegment("prev", segIdx)) e.preventDefault();
        return;
      }

      // ArrowRight at end with no selection → go to next segment (start)
      if (
        e.key === "ArrowRight" &&
        !e.shiftKey &&
        ta.selectionEnd === ta.value.length &&
        ta.selectionStart === ta.selectionEnd
      ) {
        if (navigateToAdjacentSegment("next", segIdx)) e.preventDefault();
        return;
      }
    },
    [
      activeSegIdx,
      segments,
      lines,
      editUndo,
      inputRef,
      undoStackPush,
      applyContent,
      debouncedSave,
      clearHeightLock,
      commitEdit,
      commitAndSelectAcross,
      commitAndSelectAll,
      editValue,
      wrapSelection,
      exitSegment,
      navigateToAdjacentSegment,
    ],
  );

  // Mousedown handler — blur suppression for segment transitions.
  // Sets mouseDownInsideRef so the blur handler doesn't deactivate the old segment
  // between mousedown and click (which would cause a layout jump). Actual segment
  // activation is deferred to the click handler, which checks for drag selection
  // first — preserving click-drag text selection across segments.
  const handleSegMouseDown = useCallback(
    (segIdx: number, e: React.MouseEvent) => {
      // Set flag for blur suppression (prevents deactivation jump)
      mouseDownInsideRef.current = true;
      const onUp = () => {
        // If user dragged to make a cross-segment selection, deactivate the old
        // active segment so all segments show rendered text during the selection.
        const sel = window.getSelection();
        if (activeSegIdx !== null && activeSegIdx !== segIdx && sel && !sel.isCollapsed) {
          commitEdit();
        }
        setTimeout(() => {
          mouseDownInsideRef.current = false;
        }, 0);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mouseup", onUp);

      // Don't intercept link, checkbox, summary, or table clicks
      if (!(e.target instanceof Element)) return;
      const target = e.target;
      if (
        target.closest("a") ||
        target.closest("input[type=checkbox]") ||
        target.closest("summary") ||
        target.closest(".md-it-wrapper")
      )
        return;
      if (segments[segIdx]?.type === "table" || segments[segIdx]?.type === "comment") return;
      if (e.shiftKey) return; // shift+click handled in onClick
    },
    [activeSegIdx, commitEdit, segments],
  );

  // Click handler — handles first activation from rendered state, shift+click
  // selection, and drag-selection detection. Not triggered when mousedown handler
  // already activated the segment (activeSegIdx === segIdx guard).
  const handleSegClick = useCallback(
    (segIdx: number, e: React.MouseEvent) => {
      // Don't activate if clicking a link, checkbox, details summary, or inside interactive table
      if (!(e.target instanceof Element)) return;
      const target = e.target;
      if (
        target.closest("a") ||
        target.closest("input[type=checkbox]") ||
        target.closest("summary") ||
        target.closest(".md-it-wrapper")
      ) {
        return;
      }

      // Tables use InteractiveTable, not click-to-edit
      if (segments[segIdx]?.type === "table") return;

      // Comments handle their own inline editing
      if (segments[segIdx]?.type === "comment") return;

      // Shift+Click: create a cross-segment selection from anchor to clicked segment
      if (e.shiftKey) {
        // Determine anchor segment: active edit segment, or start of existing selection
        let anchorSeg = activeSegIdx;
        if (anchorSeg === null) {
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed && editorRef.current) {
            const segEls = editorRef.current.querySelectorAll(".md-seg");
            for (let i = 0; i < segEls.length; i++) {
              if (sel.containsNode(segEls[i], true)) {
                anchorSeg = i;
                break;
              }
            }
          }
        }
        if (anchorSeg !== null && anchorSeg !== segIdx) {
          if (activeSegIdx !== null) {
            commitEdit();
            setActiveSegIdx(null);
            clearHeightLock();
          }
          const fromSeg = Math.min(anchorSeg, segIdx);
          const toSeg = Math.max(anchorSeg, segIdx);
          requestAnimationFrame(() => {
            const editor = editorRef.current;
            if (!editor) return;
            const segEls = editor.querySelectorAll(".md-seg");
            const sel = window.getSelection();
            if (!sel) return;
            sel.removeAllRanges();
            const startEl = segEls[fromSeg]?.querySelector(".md-seg-rendered") || segEls[fromSeg];
            const endEl = segEls[toSeg]?.querySelector(".md-seg-rendered") || segEls[toSeg];
            if (!startEl || !endEl) return;
            const anchorNode = startEl.firstChild || startEl;
            sel.collapse(anchorNode, 0);
            let endNode: Node = endEl;
            while (endNode.lastChild) endNode = endNode.lastChild;
            sel.extend(endNode, endNode.textContent?.length ?? 0);
          });
          return;
        }
      }

      // Already active (mousedown handler activated it, or clicking same segment)
      if (activeSegIdx === segIdx) return;

      // If user dragged (made a selection), don't activate — they were selecting text
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;

      // First activation from rendered state (no prior active segment)
      if (activeSegIdx !== null) {
        commitEdit(segIdx);
      }

      // Store click position for cursor placement in textarea
      pendingClickPosRef.current = { x: e.clientX, y: e.clientY };

      activateSegment(segIdx);
    },
    [activeSegIdx, commitEdit, activateSegment, segments, clearHeightLock, editorRef],
  );

  // Blur handler — commit and deactivate
  const handleBlur = useCallback(
    (e: React.FocusEvent) => {
      // Don't deactivate if focus moves to another element within the editor
      const related = e.relatedTarget instanceof Element ? e.relatedTarget : null;
      if (related && editorRef.current?.contains(related)) return;
      // Don't deactivate if mousedown happened inside the editor — the click handler
      // will manage the transition (prevents layout shift between mousedown and mouseup)
      if (mouseDownInsideRef.current) return;
      commitEdit();
    },
    [commitEdit, editorRef],
  );

  // Copy handler — provide raw markdown when copying from rendered segments.
  // For partial single-segment selections, let browser default copy handle it
  // so only the actually-selected text is copied (not the full segment markdown).
  const handleCopy = useCallback(
    (e: React.ClipboardEvent) => {
      if (activeSegIdx !== null) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        const editor = editorRef.current;
        if (editor) {
          const info = detectPartialSelection(sel, editor, segments);
          if (info?.isPartial) {
            return; // Let browser handle copy natively
          }
        }
      }
      const md = getSelectionMarkdown();
      if (md) {
        e.clipboardData.setData("text/plain", md);
        e.preventDefault();
        // Also write to system clipboard for consistency
        void navigator.clipboard.writeText(md);
      }
    },
    [activeSegIdx, getSelectionMarkdown, editorRef, segments],
  );

  // Drag-to-select from edit mode: when mouse is pressed in an active segment's
  // textarea and dragged into a different segment, commit edit and create a
  // cross-segment selection that updates as the mouse moves.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return undefined;

    const findSegIdxAtY = (y: number): number | null => {
      const segEls = editor.querySelectorAll(".md-seg");
      for (let i = 0; i < segEls.length; i++) {
        const rect = segEls[i].getBoundingClientRect();
        if (y >= rect.top && y <= rect.bottom) return i;
      }
      // Beyond edges: clamp to first/last
      if (segEls.length > 0) {
        const firstRect = segEls[0].getBoundingClientRect();
        if (y < firstRect.top) return 0;
        return segEls.length - 1;
      }
      return null;
    };

    let committed = false;

    const onMouseMove = (e: MouseEvent) => {
      if (dragAnchorSegRef.current === null) return;
      if (!(e.buttons & 1)) {
        // Mouse button released without mouseup firing (e.g. lost focus)
        dragAnchorSegRef.current = null;
        return;
      }

      const hoveredSeg = findSegIdxAtY(e.clientY);
      if (hoveredSeg === null || hoveredSeg === dragAnchorSegRef.current) return;

      // Mouse is over a different segment — commit edit and create selection
      if (!committed) {
        commitEdit();
        setActiveSegIdx(null);
        clearHeightLock();
        committed = true;
      }

      // Create/update selection from anchor to hovered segment
      requestAnimationFrame(() => {
        const anchor = dragAnchorSegRef.current;
        if (anchor === null) return;
        const segEls = editor.querySelectorAll(".md-seg");
        const fromSeg = Math.min(anchor, hoveredSeg);
        const toSeg = Math.max(anchor, hoveredSeg);
        const startEl = segEls[fromSeg]?.querySelector(".md-seg-rendered") || segEls[fromSeg];
        const endEl = segEls[toSeg]?.querySelector(".md-seg-rendered") || segEls[toSeg];
        if (!startEl || !endEl) return;

        const sel = window.getSelection();
        if (!sel) return;
        sel.removeAllRanges();
        const anchorNode = startEl.firstChild || startEl;
        sel.collapse(anchorNode, 0);
        let endNode: Node = endEl;
        while (endNode.lastChild) endNode = endNode.lastChild;
        sel.extend(endNode, endNode.textContent?.length ?? 0);
      });
    };

    const onMouseUp = () => {
      dragAnchorSegRef.current = null;
      committed = false;
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [commitEdit, clearHeightLock, editorRef]);

  return {
    activeSegIdx,
    setActiveSegIdx,
    editValue,
    setEditValue,
    editUndo,
    editUndoHandledRef,
    lockedHeight,
    clearHeightLock,
    pendingActivateLineRef,
    pendingCursorPosRef,
    queuePendingEditAction,
    dragAnchorSegRef,
    activateSegment,
    commitEdit,
    commitAndSelectAcross,
    commitAndSelectAll,
    handleInputKeyDown,
    handleTextareaKeyDown,
    handleSegMouseDown,
    handleSegClick,
    handleBlur,
    handlePaste,
    handleCopy,
  };
}
