// marshal-owned renderer test
import { describe, it, expect, vi } from "vitest";

import {
  getListContinuationPrefix,
  getLineInsertedAbove,
  applyPendingEdit,
} from "./useSegmentEditor";

describe("getListContinuationPrefix", () => {
  // ── Unordered lists ─────────────────────────────────────────
  it("continues dash bullet", () => {
    expect(getListContinuationPrefix("- some text")).toBe("- ");
  });

  it("continues asterisk bullet", () => {
    expect(getListContinuationPrefix("* some text")).toBe("* ");
  });

  it("continues plus bullet", () => {
    expect(getListContinuationPrefix("+ some text")).toBe("+ ");
  });

  it("preserves indentation on nested bullet", () => {
    expect(getListContinuationPrefix("  - nested")).toBe("  - ");
  });

  it("preserves deep indentation", () => {
    expect(getListContinuationPrefix("    * deeply nested")).toBe("    * ");
  });

  // ── Ordered lists ──────────────────────────────────────────
  it("increments ordered list number", () => {
    expect(getListContinuationPrefix("1. first item")).toBe("2. ");
  });

  it("increments from higher number", () => {
    expect(getListContinuationPrefix("3. third item")).toBe("4. ");
  });

  it("preserves indentation on ordered list", () => {
    expect(getListContinuationPrefix("  1. indented ordered")).toBe("  2. ");
  });

  // ── Task lists ─────────────────────────────────────────────
  it("continues unchecked task list", () => {
    expect(getListContinuationPrefix("- [ ] buy milk")).toBe("- [ ] ");
  });

  it("continues checked task with unchecked prefix", () => {
    expect(getListContinuationPrefix("- [x] done item")).toBe("- [ ] ");
  });

  it("continues uppercase checked task", () => {
    expect(getListContinuationPrefix("- [X] done item")).toBe("- [ ] ");
  });

  // ── Empty bullets (exit list) ──────────────────────────────
  it("returns empty string for empty dash bullet", () => {
    expect(getListContinuationPrefix("- ")).toBe("");
  });

  it("returns empty string for empty asterisk bullet", () => {
    expect(getListContinuationPrefix("* ")).toBe("");
  });

  it("returns empty string for empty ordered item", () => {
    expect(getListContinuationPrefix("1. ")).toBe("");
  });

  it("returns empty string for empty task item", () => {
    expect(getListContinuationPrefix("- [ ] ")).toBe("");
  });

  // ── Partial lines (mid-line Enter splits) ───────────────────
  it("continues dash bullet with partial text (mid-line split)", () => {
    expect(getListContinuationPrefix("- some")).toBe("- ");
  });

  it("continues ordered list with partial text", () => {
    expect(getListContinuationPrefix("1. fir")).toBe("2. ");
  });

  it("continues task list with partial text", () => {
    expect(getListContinuationPrefix("- [ ] buy")).toBe("- [ ] ");
  });

  it("continues indented bullet with partial text", () => {
    expect(getListContinuationPrefix("  - nes")).toBe("  - ");
  });

  // ── Non-list lines ─────────────────────────────────────────
  it("returns null for plain paragraph", () => {
    expect(getListContinuationPrefix("hello world")).toBeNull();
  });

  it("returns null for heading", () => {
    expect(getListContinuationPrefix("# Heading")).toBeNull();
  });

  it("returns null for empty line", () => {
    expect(getListContinuationPrefix("")).toBeNull();
  });

  it("returns null for blockquote", () => {
    expect(getListContinuationPrefix("> quote")).toBeNull();
  });
});

describe("getLineInsertedAbove (Enter at position 0)", () => {
  // ── List items: inserts an empty bullet above ──────────────
  it("inserts dash bullet above for dash list item", () => {
    expect(getLineInsertedAbove("- some text")).toBe("- ");
  });

  it("inserts asterisk bullet above for asterisk list item", () => {
    expect(getLineInsertedAbove("* some text")).toBe("* ");
  });

  it("inserts plus bullet above for plus list item", () => {
    expect(getLineInsertedAbove("+ some text")).toBe("+ ");
  });

  it("inserts indented bullet above for nested list item", () => {
    expect(getLineInsertedAbove("  - nested item")).toBe("  - ");
  });

  it("inserts same-numbered bullet above for ordered list item", () => {
    expect(getLineInsertedAbove("1. first item")).toBe("1. ");
  });

  it("preserves higher number when inserting above", () => {
    expect(getLineInsertedAbove("3. third item")).toBe("3. ");
  });

  it("preserves indentation on ordered list inserted above", () => {
    expect(getLineInsertedAbove("  1. indented ordered")).toBe("  1. ");
  });

  it("inserts task prefix above for task list item", () => {
    expect(getLineInsertedAbove("- [ ] buy milk")).toBe("- [ ] ");
  });

  // ── Empty bullets: inserts blank line (list exit) ──────────
  it("inserts blank line for empty dash bullet", () => {
    expect(getLineInsertedAbove("- ")).toBe("");
  });

  it("inserts blank line for empty ordered item", () => {
    expect(getLineInsertedAbove("1. ")).toBe("");
  });

  it("inserts blank line for empty task item", () => {
    expect(getLineInsertedAbove("- [ ] ")).toBe("");
  });

  // ── Non-list lines: inserts blank line ─────────────────────
  it("inserts blank line for plain paragraph", () => {
    expect(getLineInsertedAbove("hello world")).toBe("");
  });

  it("inserts blank line for heading", () => {
    expect(getLineInsertedAbove("# Heading")).toBe("");
  });

  it("inserts blank line for empty line", () => {
    expect(getLineInsertedAbove("")).toBe("");
  });

  it("inserts blank line for blockquote", () => {
    expect(getLineInsertedAbove("> quote")).toBe("");
  });
});

// ── applyPendingEdit ────────────────────────────────────────────

describe("applyPendingEdit", () => {
  it("applies a valid delete within range", () => {
    // Segment starts at offset 10 in the document, value = "hello world"
    const result = applyPendingEdit("hello world", 10, {
      mdStart: 16, // rel 6 ("w")
      mdEnd: 21, // rel 11 ("world")
      replaceWith: "",
    });
    expect(result).toEqual({ newValue: "hello ", cursorPos: 6 });
  });

  it("returns null and warns when relEnd exceeds value length", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = applyPendingEdit("short", 0, {
      mdStart: 0,
      mdEnd: 999,
      replaceWith: "",
    });
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "[useSegmentEditor] pendingEditAction offsets out of range — edit dropped",
      expect.objectContaining({ relEnd: 999, valueLength: 5 }),
    );
    warnSpy.mockRestore();
  });

  it("returns null and warns when relStart is negative", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = applyPendingEdit("hello", 100, {
      mdStart: 50,
      mdEnd: 105,
      replaceWith: "",
    });
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "[useSegmentEditor] pendingEditAction offsets out of range — edit dropped",
      expect.objectContaining({ relStart: -50 }),
    );
    warnSpy.mockRestore();
  });

  it("applies a paste replacement and positions cursor after inserted text", () => {
    const result = applyPendingEdit("hello world", 0, {
      mdStart: 5,
      mdEnd: 6,
      replaceWith: " beautiful ",
    });
    expect(result).toEqual({
      newValue: "hello beautiful world",
      cursorPos: 16, // 5 + " beautiful ".length
    });
  });

  it("runs normalizeOrphans on the result", () => {
    // Deleting content from "**bold text**" → "****" → normalizeOrphans → ""
    const result = applyPendingEdit("**bold text**", 0, {
      mdStart: 2,
      mdEnd: 11,
      replaceWith: "",
    });
    expect(result).not.toBeNull();
    expect(result!.newValue).toBe("");
  });
});
