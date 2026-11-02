import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildSearchRegex, useFileSearch } from "./useFileSearch";

function createRefs() {
  const previewDiv = document.createElement("div");
  document.body.appendChild(previewDiv);
  const previewRef = { current: previewDiv };
  return { previewRef, previewDiv };
}

describe("useFileSearch", () => {
  let refs: ReturnType<typeof createRefs>;

  beforeEach(() => {
    refs = createRefs();
  });

  afterEach(() => {
    refs.previewDiv.remove();
  });

  function renderSearch() {
    return renderHook(() => useFileSearch(refs.previewRef));
  }

  it("starts closed", () => {
    const { result } = renderSearch();
    expect(result.current.state.isOpen).toBe(false);
  });

  it("opens search bar", () => {
    const { result } = renderSearch();
    act(() => result.current.open());
    expect(result.current.state.isOpen).toBe(true);
  });

  it("closes and resets state", () => {
    const { result } = renderSearch();
    act(() => result.current.open());
    act(() => result.current.setQuery("hello"));
    act(() => result.current.close());
    expect(result.current.state.isOpen).toBe(false);
    expect(result.current.state.query).toBe("");
    expect(result.current.state.matchCount).toBe(0);
    expect(result.current.state.currentMatch).toBe(-1);
  });

  it("updates query in state", () => {
    const { result } = renderSearch();
    act(() => result.current.open());
    act(() => result.current.setQuery("test"));
    expect(result.current.state.query).toBe("test");
  });

  it("finds matches in preview DOM", async () => {
    refs.previewDiv.textContent = "hello world hello";
    const { result } = renderSearch();
    act(() => result.current.open());
    act(() => result.current.setQuery("hello"));
    await vi.waitFor(() => {
      expect(result.current.state.matchCount).toBe(2);
    });
    expect(result.current.state.currentMatch).toBe(0);
  });

  it("inserts mark elements for matches", async () => {
    refs.previewDiv.textContent = "foo bar foo";
    const { result } = renderSearch();
    act(() => result.current.open());
    act(() => result.current.setQuery("foo"));
    await vi.waitFor(() => {
      expect(result.current.state.matchCount).toBe(2);
    });
    // eslint-disable-next-line testing-library/no-node-access -- testing DOM mutation internals
    const marks = refs.previewDiv.querySelectorAll("mark.md-search-highlight");
    expect(marks.length).toBe(2);
    expect(marks[0].textContent).toBe("foo");
  });

  it("navigates to next match", async () => {
    refs.previewDiv.textContent = "aaa bbb aaa bbb aaa";
    const { result } = renderSearch();
    act(() => result.current.open());
    act(() => result.current.setQuery("aaa"));
    await vi.waitFor(() => expect(result.current.state.matchCount).toBe(3));
    expect(result.current.state.currentMatch).toBe(0);
    act(() => result.current.nextMatch());
    expect(result.current.state.currentMatch).toBe(1);
    act(() => result.current.nextMatch());
    expect(result.current.state.currentMatch).toBe(2);
    act(() => result.current.nextMatch());
    expect(result.current.state.currentMatch).toBe(0);
  });

  it("navigates to previous match with wrapping", async () => {
    refs.previewDiv.textContent = "xx yy xx";
    const { result } = renderSearch();
    act(() => result.current.open());
    act(() => result.current.setQuery("xx"));
    await vi.waitFor(() => expect(result.current.state.matchCount).toBe(2));
    expect(result.current.state.currentMatch).toBe(0);
    act(() => result.current.prevMatch());
    expect(result.current.state.currentMatch).toBe(1);
  });

  it("reports 0 matches when no text matches", async () => {
    refs.previewDiv.textContent = "hello world";
    const { result } = renderSearch();
    act(() => result.current.open());
    act(() => result.current.setQuery("zzz"));
    await vi.waitFor(() => {
      expect(result.current.state.matchCount).toBe(0);
    });
    expect(result.current.state.currentMatch).toBe(-1);
  });

  it("case-sensitive search", async () => {
    refs.previewDiv.textContent = "Hello hello HELLO";
    const { result } = renderSearch();
    act(() => result.current.open());
    act(() => result.current.toggleOption("caseSensitive"));
    act(() => result.current.setQuery("Hello"));
    await vi.waitFor(() => {
      expect(result.current.state.matchCount).toBe(1);
    });
  });

  it("whole word search", async () => {
    refs.previewDiv.textContent = "testing test tested";
    const { result } = renderSearch();
    act(() => result.current.open());
    act(() => result.current.toggleOption("wholeWord"));
    act(() => result.current.setQuery("test"));
    await vi.waitFor(() => {
      expect(result.current.state.matchCount).toBe(1);
    });
  });

  it("regex search", async () => {
    refs.previewDiv.textContent = "cat bat hat mat";
    const { result } = renderSearch();
    act(() => result.current.open());
    act(() => result.current.toggleOption("useRegex"));
    act(() => result.current.setQuery("[ch]at"));
    await vi.waitFor(() => {
      expect(result.current.state.matchCount).toBe(2);
    });
  });

  it("invalid regex sets error", async () => {
    refs.previewDiv.textContent = "text";
    const { result } = renderSearch();
    act(() => result.current.open());
    act(() => result.current.toggleOption("useRegex"));
    act(() => result.current.setQuery("[invalid"));
    await vi.waitFor(() => {
      expect(result.current.state.regexError).toBeTruthy();
    });
    expect(result.current.state.matchCount).toBe(0);
  });

  it("removes mark elements on close", async () => {
    refs.previewDiv.textContent = "abc abc abc";
    const { result } = renderSearch();
    act(() => result.current.open());
    act(() => result.current.setQuery("abc"));
    await vi.waitFor(() => expect(result.current.state.matchCount).toBe(3));
    // eslint-disable-next-line testing-library/no-node-access -- testing DOM mutation internals
    expect(refs.previewDiv.querySelectorAll("mark").length).toBe(3);
    act(() => result.current.close());
    // eslint-disable-next-line testing-library/no-node-access -- testing DOM mutation internals
    expect(refs.previewDiv.querySelectorAll("mark").length).toBe(0);
    expect(refs.previewDiv.textContent).toBe("abc abc abc");
  });

  it("matchLimitHit is false when under limit", async () => {
    refs.previewDiv.textContent = "aa bb aa";
    const { result } = renderSearch();
    act(() => result.current.open());
    act(() => result.current.setQuery("aa"));
    await vi.waitFor(() => expect(result.current.state.matchCount).toBe(2));
    expect(result.current.state.matchLimitHit).toBe(false);
  });

  it("debounces search — intermediate queries do not trigger highlights", async () => {
    refs.previewDiv.textContent = "hello world hello";
    const { result } = renderSearch();
    act(() => result.current.open());
    // Type rapidly — each call resets the debounce timer
    act(() => result.current.setQuery("h"));
    act(() => result.current.setQuery("he"));
    act(() => result.current.setQuery("hel"));
    act(() => result.current.setQuery("hello"));

    // Query state updates immediately
    expect(result.current.state.query).toBe("hello");
    // But matchCount is still 0 — debounce hasn't fired yet
    expect(result.current.state.matchCount).toBe(0);

    // After debounce (240ms) + DOM tick, highlights appear
    await vi.waitFor(() => expect(result.current.state.matchCount).toBe(2));
  });
});

describe("buildSearchRegex", () => {
  const defaults = { caseSensitive: false, wholeWord: false, useRegex: false };

  it("returns null regex for empty query", () => {
    const result = buildSearchRegex("", defaults);
    expect(result.regex).toBeNull();
    expect(result.error).toBeNull();
  });

  it("builds case-insensitive regex by default", () => {
    const result = buildSearchRegex("hello", defaults);
    expect(result.regex?.flags).toContain("i");
    expect(result.regex?.test("Hello")).toBe(true);
  });

  it("builds case-sensitive regex when enabled", () => {
    const result = buildSearchRegex("Hello", { ...defaults, caseSensitive: true });
    expect(result.regex?.flags).not.toContain("i");
    expect(result.regex?.test("hello")).toBe(false);
    expect(result.regex?.test("Hello")).toBe(true);
  });

  it("adds word boundaries for wholeWord", () => {
    const result = buildSearchRegex("test", { ...defaults, wholeWord: true });
    expect(result.regex?.test("test")).toBe(true);
    expect(result.regex?.test("testing")).toBe(false);
  });

  it("escapes special regex characters in plain mode", () => {
    const result = buildSearchRegex("foo.bar", defaults);
    expect(result.regex?.test("foo.bar")).toBe(true);
    expect(result.regex?.test("fooXbar")).toBe(false);
  });

  it("uses raw pattern in regex mode", () => {
    const result = buildSearchRegex("[ch]at", { ...defaults, useRegex: true });
    expect(result.regex).not.toBeNull();
    expect("cat").toMatch(result.regex!);
    expect("hat").toMatch(result.regex!);
    expect("bat").not.toMatch(result.regex!);
  });

  it("returns error for invalid regex", () => {
    const result = buildSearchRegex("[invalid", { ...defaults, useRegex: true });
    expect(result.regex).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("handles wholeWord + useRegex together", () => {
    const result = buildSearchRegex("\\d+", { ...defaults, wholeWord: true, useRegex: true });
    expect(result.regex?.test("42")).toBe(true);
    expect(result.regex?.test("abc42def")).toBe(false);
  });
});
