// marshal-owned renderer test
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { useWindowFocused, _resetWindowFocusState } from "./useWindowFocused";

describe("useWindowFocused", () => {
  let listeners: Record<string, Set<EventListener>>;
  let hasFocusValue: boolean;

  beforeEach(() => {
    _resetWindowFocusState();
    listeners = { focus: new Set(), blur: new Set() };
    hasFocusValue = true;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock narrows overloaded addEventListener signature
    vi.spyOn(window, "addEventListener").mockImplementation(((type: string, fn: EventListener) => {
      listeners[type]?.add(fn);
    }) as typeof window.addEventListener);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock narrows overloaded removeEventListener signature
    vi.spyOn(window, "removeEventListener").mockImplementation(((
      type: string,
      fn: EventListener,
    ) => {
      listeners[type]?.delete(fn);
    }) as typeof window.removeEventListener);
    vi.spyOn(document, "hasFocus").mockImplementation(() => hasFocusValue);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function simulateWindowEvent(type: "focus" | "blur") {
    for (const fn of listeners[type]) {
      fn(new Event(type));
    }
  }

  it("defaults to focused=true, ready=false", () => {
    const { result } = renderHook(() => useWindowFocused());
    expect(result.current).toEqual({ focused: true, ready: false });
  });

  it("ignores blur before window has ever been focused", () => {
    hasFocusValue = false;
    const { result } = renderHook(() => useWindowFocused());

    act(() => simulateWindowEvent("blur"));
    expect(result.current).toEqual({ focused: true, ready: false });
  });

  it("reacts to blur after focus has been seen", () => {
    const { result } = renderHook(() => useWindowFocused());

    // Window already had focus at mount (hasFocusValue=true → sawFocus=true)
    act(() => simulateWindowEvent("blur"));
    expect(result.current).toEqual({ focused: false, ready: true });
  });

  it("tracks focus after first blur", () => {
    const { result } = renderHook(() => useWindowFocused());

    act(() => simulateWindowEvent("blur"));
    expect(result.current.focused).toBe(false);

    act(() => simulateWindowEvent("focus"));
    expect(result.current).toEqual({ focused: true, ready: true });
  });

  it("becomes ready after focus event followed by blur when initially unfocused", () => {
    hasFocusValue = false;
    const { result } = renderHook(() => useWindowFocused());

    // Blur ignored — sawFocus is still false
    act(() => simulateWindowEvent("blur"));
    expect(result.current).toEqual({ focused: true, ready: false });

    // Focus marks sawFocus
    act(() => simulateWindowEvent("focus"));
    expect(result.current).toEqual({ focused: true, ready: false });

    // Now blur is honoured
    act(() => simulateWindowEvent("blur"));
    expect(result.current).toEqual({ focused: false, ready: true });
  });

  it("cleans up listeners on unmount", () => {
    const { unmount } = renderHook(() => useWindowFocused());

    expect(listeners.focus.size).toBe(1);
    expect(listeners.blur.size).toBe(1);

    unmount();

    expect(listeners.focus.size).toBe(0);
    expect(listeners.blur.size).toBe(0);
  });
});
