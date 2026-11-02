import { describe, it, expect } from "vitest";

import { makeIntentTitleFallback, makeQuickTitle } from "./marshal-quick-title";

describe("makeQuickTitle", () => {
  it("returns short text unchanged", () => {
    expect(makeQuickTitle("Hello world")).toBe("Hello world");
  });

  describe("makeIntentTitleFallback", () => {
    it("keeps at most four normalized words", () => {
      expect(makeIntentTitleFallback("  Implement   OAuth login for React apps  ")).toBe(
        "Implement OAuth login for",
      );
    });

    it("returns empty string for blank input", () => {
      expect(makeIntentTitleFallback("   ")).toBe("");
    });
  });

  it("returns text at exactly 120 chars unchanged", () => {
    const text = "a".repeat(120);
    expect(makeQuickTitle(text)).toBe(text);
  });

  it("truncates text over 120 chars with ellipsis", () => {
    const text = "a".repeat(150);
    expect(makeQuickTitle(text)).toBe("a".repeat(120) + "\u2026");
  });

  it("collapses multiple whitespace and newlines to single spaces", () => {
    expect(makeQuickTitle("hello\n\nworld  foo")).toBe("hello world foo");
  });

  it("trims leading and trailing whitespace", () => {
    expect(makeQuickTitle("  hello world  ")).toBe("hello world");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(makeQuickTitle("   ")).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(makeQuickTitle("")).toBe("");
  });

  it("does not leave trailing whitespace before ellipsis", () => {
    // 119 chars of text + space at position 120 (the cut point) + more text
    const text = "a".repeat(119) + " bbbbbbbbbbbbbbbbbbbbb";
    const result = makeQuickTitle(text);
    expect(result).toBe("a".repeat(119) + "\u2026");
    expect(result).not.toMatch(/\s\u2026$/);
  });
});
