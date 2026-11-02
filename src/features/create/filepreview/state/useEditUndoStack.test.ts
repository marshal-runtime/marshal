// Marshal-owned module.
import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { useEditUndoStack } from "./useEditUndoStack";

describe("useEditUndoStack", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null on undo when at initial state", () => {
    const { result } = renderHook(() => useEditUndoStack());
    result.current.init("hello");
    expect(result.current.undo()).toBeNull();
    expect(result.current.isAtInitial()).toBe(true);
  });

  it("returns null on redo when nothing undone", () => {
    const { result } = renderHook(() => useEditUndoStack());
    result.current.init("hello");
    expect(result.current.redo()).toBeNull();
  });

  // ── Word boundary grouping ─────────────────────────────────

  it("groups continuous letter typing into one undo step", () => {
    const { result } = renderHook(() => useEditUndoStack());
    result.current.init("");

    // Type "abc" one char at a time — no word boundaries, so no intermediate snapshots
    result.current.record("a", 1);
    result.current.record("ab", 2);
    result.current.record("abc", 3);

    // Undo should jump all the way back to initial
    expect(result.current.undo()?.text).toBe("");
    expect(result.current.isAtInitial()).toBe(true);
  });

  it("breaks undo group at space (word boundary)", () => {
    const { result } = renderHook(() => useEditUndoStack());
    result.current.init("");

    // Type "hi " — space triggers a snapshot including the space
    result.current.record("h", 1);
    result.current.record("hi", 2);
    result.current.record("hi ", 3); // space = word boundary

    // Continue typing "yo"
    result.current.record("hi y", 4);
    result.current.record("hi yo", 5);

    // First undo: reverts to "hi " (the snapshot pushed at space)
    expect(result.current.undo()?.text).toBe("hi ");

    // Second undo: reverts to initial
    expect(result.current.undo()?.text).toBe("");
    expect(result.current.isAtInitial()).toBe(true);
  });

  // ── Typing pause ───────────────────────────────────────────

  it("pushes snapshot after typing pause", () => {
    const { result } = renderHook(() => useEditUndoStack());
    result.current.init("");

    result.current.record("abc", 3);
    // Advance past the pause timer
    vi.advanceTimersByTime(600);

    // Type more
    result.current.record("abcd", 4);

    // Undo should go back to "abc" (pause-pushed snapshot)
    expect(result.current.undo()?.text).toBe("abc");
  });

  // ── Operation type change ──────────────────────────────────

  it("breaks undo group when switching from insert to delete", () => {
    const { result } = renderHook(() => useEditUndoStack());
    result.current.init("");

    // Insert
    result.current.record("ab", 2);
    // Delete (backspace)
    result.current.record("a", 1);

    // Undo should restore "ab" (snapshot before delete)
    expect(result.current.undo()?.text).toBe("ab");
  });

  // ── Paste (snapshot) ───────────────────────────────────────

  it("snapshot creates a discrete undo step", () => {
    const { result } = renderHook(() => useEditUndoStack());
    result.current.init("start");

    // Simulate paste: snapshot before, then set new value
    result.current.snapshot("start", 5);
    result.current.record("start pasted text", 17);

    // Undo: back to "start"
    expect(result.current.undo()?.text).toBe("start");
  });

  // ── Redo ───────────────────────────────────────────────────

  it("redo restores undone state", () => {
    const { result } = renderHook(() => useEditUndoStack());
    result.current.init("");

    result.current.record("hello ", 6); // space = boundary
    result.current.record("hello world", 11);

    // Undo "world"
    expect(result.current.undo()?.text).toBe("hello ");

    // Redo should restore "hello world"
    expect(result.current.redo()?.text).toBe("hello world");
  });

  it("redo stack is truncated on new edit after undo", () => {
    const { result } = renderHook(() => useEditUndoStack());
    result.current.init("");

    result.current.record("abc ", 4);
    result.current.record("abc def", 7);

    // Undo
    result.current.undo();
    // New edit — should truncate redo
    result.current.record("abc xyz", 7);

    expect(result.current.redo()).toBeNull();
  });

  // ── isAtInitial ────────────────────────────────────────────

  it("isAtInitial is true only at the beginning of the stack", () => {
    const { result } = renderHook(() => useEditUndoStack());
    result.current.init("original");
    expect(result.current.isAtInitial()).toBe(true);

    result.current.record("original!", 9);
    vi.advanceTimersByTime(600);
    expect(result.current.isAtInitial()).toBe(false);

    result.current.undo();
    expect(result.current.isAtInitial()).toBe(true);
  });

  // ── Clear ──────────────────────────────────────────────────

  it("clear resets all state", () => {
    const { result } = renderHook(() => useEditUndoStack());
    result.current.init("text");
    result.current.record("text!", 5);
    result.current.clear();

    expect(result.current.undo()).toBeNull();
    expect(result.current.redo()).toBeNull();
    // After clear, stack is empty — isAtInitial is true (nothing to undo)
    expect(result.current.isAtInitial()).toBe(true);
  });

  // ── Cursor jump ────────────────────────────────────────────

  it("breaks undo group on cursor jump during insert", () => {
    const { result } = renderHook(() => useEditUndoStack());
    result.current.init("abcxyz");

    // Type at position 3 (sequential)
    result.current.record("abcdxyz", 4);
    result.current.record("abcdexyz", 5);
    // Jump cursor to position 8 and type there
    result.current.record("abcdexyz!", 9);

    // Undo: should get snapshot at jump point
    expect(result.current.undo()?.text).toBe("abcdexyz");
  });
});
