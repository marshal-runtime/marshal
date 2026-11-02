// marshal-owned renderer test
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { _resetWindowFocusState } from "./useWindowFocused";
import { useWindowInactiveAttribute } from "./useWindowInactiveAttribute";

describe("useWindowInactiveAttribute", () => {
  beforeEach(() => {
    _resetWindowFocusState();
    document.documentElement.removeAttribute("data-window-inactive");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.removeAttribute("data-window-inactive");
  });

  it("sets data-window-inactive on <html> after focus+blur cycle", async () => {
    const { result } = renderHook(() => useWindowInactiveAttribute());

    // Initial: focused, not ready
    expect(result.current).toEqual({ focused: true, ready: false });
    expect(document.documentElement.hasAttribute("data-window-inactive")).toBe(false);

    // Focus (sawFocus) then blur
    await act(() => window.dispatchEvent(new Event("focus")));
    await act(() => window.dispatchEvent(new Event("blur")));

    expect(result.current.focused).toBe(false);
    expect(document.documentElement.hasAttribute("data-window-inactive")).toBe(true);
  });

  it("removes data-window-inactive when window regains focus", async () => {
    renderHook(() => useWindowInactiveAttribute());

    await act(() => window.dispatchEvent(new Event("focus")));
    await act(() => window.dispatchEvent(new Event("blur")));
    expect(document.documentElement.hasAttribute("data-window-inactive")).toBe(true);

    await act(() => window.dispatchEvent(new Event("focus")));
    expect(document.documentElement.hasAttribute("data-window-inactive")).toBe(false);
  });

  it("does not set data-window-inactive on initial mount when document lacks focus", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);

    renderHook(() => useWindowInactiveAttribute());

    // Hook stays inert until a real focus+blur cycle
    expect(document.documentElement.hasAttribute("data-window-inactive")).toBe(false);
  });

  it("returns ready=true after the first blur", async () => {
    const { result } = renderHook(() => useWindowInactiveAttribute());

    expect(result.current.ready).toBe(false);

    await act(() => window.dispatchEvent(new Event("focus")));
    await act(() => window.dispatchEvent(new Event("blur")));

    expect(result.current.ready).toBe(true);
  });
});
