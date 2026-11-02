import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { useTimeout } from "./use-timeout";

describe("useTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls callback after delay", () => {
    const cb = vi.fn<() => void>();
    renderHook(() => useTimeout(cb, 1000));

    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledOnce();
  });

  it("does not call callback when delay is null", () => {
    const cb = vi.fn<() => void>();
    renderHook(() => useTimeout(cb, null));

    vi.advanceTimersByTime(5000);
    expect(cb).not.toHaveBeenCalled();
  });

  it("clears timeout on unmount", () => {
    const cb = vi.fn<() => void>();
    const { unmount } = renderHook(() => useTimeout(cb, 1000));

    vi.advanceTimersByTime(500);
    unmount();
    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
  });

  it("resets timeout when delay changes", () => {
    const cb = vi.fn<() => void>();
    const { rerender } = renderHook(({ delay }) => useTimeout(cb, delay), {
      initialProps: { delay: 1000 as number | null },
    });

    vi.advanceTimersByTime(800);
    rerender({ delay: 2000 });
    vi.advanceTimersByTime(1500);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledOnce();
  });

  it("stops when delay changes to null", () => {
    const cb = vi.fn<() => void>();
    const { rerender } = renderHook(({ delay }) => useTimeout(cb, delay), {
      initialProps: { delay: 1000 as number | null },
    });

    vi.advanceTimersByTime(500);
    rerender({ delay: null });
    vi.advanceTimersByTime(2000);
    expect(cb).not.toHaveBeenCalled();
  });

  it("uses latest callback without resetting timer", () => {
    const cb1 = vi.fn<() => void>();
    const cb2 = vi.fn<() => void>();
    const { rerender } = renderHook(({ cb }) => useTimeout(cb, 1000), {
      initialProps: { cb: cb1 },
    });

    vi.advanceTimersByTime(500);
    rerender({ cb: cb2 });
    vi.advanceTimersByTime(500);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it("resets timer when key changes even if delay stays the same", () => {
    const cb = vi.fn<() => void>();
    const { rerender } = renderHook(({ key }) => useTimeout(cb, 3000, key), {
      initialProps: { key: "a" as unknown },
    });

    vi.advanceTimersByTime(2000);
    expect(cb).not.toHaveBeenCalled();

    // Change key at 2s — timer should reset to full 3s
    rerender({ key: "b" });
    vi.advanceTimersByTime(2000);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledOnce();
  });
});
