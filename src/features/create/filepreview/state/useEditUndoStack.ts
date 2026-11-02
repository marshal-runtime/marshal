import { useCallback, useEffect, useMemo, useRef } from "react";

import { getEditOperation, isEditBoundaryCharacter, type EditOperation } from "../helpers/editUndo";

// ── VS Code-like undo grouping for in-segment text editing ────
//
// Native browser textarea undo operates one character at a time because
// React's controlled re-renders break Chromium's coalescing heuristic.
// This hook provides a custom undo/redo stack that groups edits by:
//
// 1. Word boundaries — space/punctuation after word chars starts a new group
// 2. Typing pauses — idle for PAUSE_MS pushes a snapshot
// 3. Operation type changes — switching between insert/delete/replace
// 4. Cursor jumps — non-contiguous cursor position changes
// 5. Paste — always a discrete undo step

const PAUSE_MS = 500;
const MAX_STACK = 100;

export interface UndoResult {
  text: string;
  cursor: number;
}

export interface EditUndoHandle {
  /** Initialize the stack with the segment's original text. Call on activation. */
  init: (text: string) => void;
  /** Record a new edit value. Applies grouping heuristics before pushing. */
  record: (value: string, cursorPos: number) => void;
  /** Force-push current value as a snapshot (e.g. before paste). */
  snapshot: (value: string, cursorPos: number) => void;
  /** Pop one undo step. Returns the text + cursor to restore, or null if at initial state. */
  undo: () => UndoResult | null;
  /** Pop one redo step. Returns the text + cursor to restore, or null if nothing to redo. */
  redo: () => UndoResult | null;
  /** Whether the stack is at the initial (activation) state — next undo should go document-level. */
  isAtInitial: () => boolean;
  /** Whether the redo stack has entries. */
  canRedo: () => boolean;
  /** Clear all state (call on deactivation / commit). */
  clear: () => void;
}

export function useEditUndoStack(): EditUndoHandle {
  const stackRef = useRef<{ text: string; cursor: number }[]>([]);
  const indexRef = useRef(-1);
  const lastOpRef = useRef<EditOperation>("none");
  const lastCursorRef = useRef(0);
  const pauseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastValueRef = useRef("");

  const pushSnapshot = useCallback((value: string, cursor: number) => {
    const stack = stackRef.current;
    const idx = indexRef.current;
    // Text matches current entry — just update cursor (e.g. snapshot before paste
    // when text hasn't changed yet but cursor position is now known)
    if (idx >= 0 && stack[idx].text === value) {
      stack[idx] = { text: value, cursor };
      return;
    }
    // Truncate any redo entries
    stack.length = idx + 1;
    stack.push({ text: value, cursor });
    if (stack.length > MAX_STACK) stack.shift();
    indexRef.current = stack.length - 1;
    lastValueRef.current = value;
  }, []);

  const init = useCallback((text: string) => {
    clearTimeout(pauseTimerRef.current);
    stackRef.current = [{ text, cursor: 0 }];
    indexRef.current = 0;
    lastOpRef.current = "none";
    lastCursorRef.current = 0;
    lastValueRef.current = text;
  }, []);

  const record = useCallback(
    (value: string, cursorPos: number) => {
      const prev = lastValueRef.current;
      if (value === prev) return;

      // On the very first edit, update the initial entry's cursor to reflect
      // where the user actually started typing (click position), not 0.
      const stack = stackRef.current;
      const idx = indexRef.current;
      if (idx === 0 && stack.length === 1 && lastOpRef.current === "none") {
        // For a single-char insert at pos N, the pre-edit cursor was at N-1.
        const initialCursor = value.length === prev.length + 1 ? cursorPos - 1 : cursorPos;
        stack[0] = { text: stack[0].text, cursor: initialCursor };
      }

      if (idx >= 0 && idx < stack.length - 1) {
        stack.length = idx + 1;
        indexRef.current = stack.length - 1;
      }

      const op = getEditOperation(prev, value);
      const prevOp = lastOpRef.current;

      let shouldPush = false;
      // What to push: usually prev (state before this edit), but word-boundary
      // chars belong to the *previous* group so we push value (including the char)
      let pushValue = prev;

      // 1. Operation type changed (insert → delete, etc.)
      if (op !== prevOp && prevOp !== "none") shouldPush = true;

      // 2. Paste or multi-char replace — always a new step
      if (op === "replace") shouldPush = true;

      // 3. Word boundary: if the newly typed char is whitespace/punctuation
      if (op === "insert" && value.length === prev.length + 1) {
        const newChar = value[cursorPos - 1] ?? "";
        if (isEditBoundaryCharacter(newChar)) {
          shouldPush = true;
          pushValue = value; // include boundary char in previous group
        }
      }

      // 4. Cursor jump: non-contiguous position change (e.g., clicked elsewhere)
      //    Takes priority over word boundary — checkpoint at pre-jump state
      if (op === "insert") {
        const expectedCursor = lastCursorRef.current + 1;
        if (cursorPos !== expectedCursor && prevOp !== "none") {
          shouldPush = true;
          pushValue = prev;
        }
      }
      if (op === "delete") {
        // For backspace, cursor decrements by 1; for forward delete, cursor stays
        const expectedBack = lastCursorRef.current - 1;
        const expectedFwd = lastCursorRef.current;
        if (cursorPos !== expectedBack && cursorPos !== expectedFwd && prevOp !== "none") {
          shouldPush = true;
          pushValue = prev;
        }
      }

      if (shouldPush) {
        pushSnapshot(pushValue, lastCursorRef.current);
      }

      lastOpRef.current = op;
      lastCursorRef.current = cursorPos;
      lastValueRef.current = value;

      // Reset pause timer — if user stops typing, push a snapshot
      clearTimeout(pauseTimerRef.current);
      pauseTimerRef.current = setTimeout(() => {
        pushSnapshot(value, cursorPos);
        lastOpRef.current = "none";
      }, PAUSE_MS);
    },
    [pushSnapshot],
  );

  const snapshot = useCallback(
    (value: string, cursorPos: number) => {
      clearTimeout(pauseTimerRef.current);
      pushSnapshot(value, cursorPos);
      lastOpRef.current = "none";
    },
    [pushSnapshot],
  );

  const undo = useCallback((): UndoResult | null => {
    clearTimeout(pauseTimerRef.current);
    // If the current value isn't on the stack yet, push it first
    const currentValue = lastValueRef.current;
    const stack = stackRef.current;
    const idx = indexRef.current;
    if (idx >= 0 && stack[idx].text !== currentValue) {
      pushSnapshot(currentValue, lastCursorRef.current);
    }

    const newIdx = indexRef.current;
    if (newIdx > 0) {
      indexRef.current = newIdx - 1;
      const entry = stack[indexRef.current];
      lastValueRef.current = entry.text;
      lastOpRef.current = "none";
      return entry;
    }
    return null;
  }, [pushSnapshot]);

  const redo = useCallback((): UndoResult | null => {
    clearTimeout(pauseTimerRef.current);
    const stack = stackRef.current;
    if (indexRef.current < stack.length - 1) {
      indexRef.current++;
      const entry = stack[indexRef.current];
      lastValueRef.current = entry.text;
      lastOpRef.current = "none";
      return entry;
    }
    return null;
  }, []);

  const isAtInitial = useCallback((): boolean => {
    // Returns true at index 0 with no divergent edits AND for cleared stacks
    // (index = -1). Callers in the bridge guard with `activeSegIdx !== null`,
    // so the cleared-stack case is not reached on the keystroke path.
    if (indexRef.current > 0) return false;
    if (indexRef.current < 0) return true;
    return lastValueRef.current === stackRef.current[0].text;
  }, []);

  const canRedo = useCallback((): boolean => {
    return indexRef.current < stackRef.current.length - 1;
  }, []);

  const clear = useCallback(() => {
    clearTimeout(pauseTimerRef.current);
    stackRef.current = [];
    indexRef.current = -1;
    lastOpRef.current = "none";
    lastCursorRef.current = 0;
    lastValueRef.current = "";
  }, []);

  useEffect(() => () => clearTimeout(pauseTimerRef.current), []);

  return useMemo(
    () => ({ init, record, snapshot, undo, redo, isAtInitial, canRedo, clear }),
    [init, record, snapshot, undo, redo, isAtInitial, canRedo, clear],
  );
}
