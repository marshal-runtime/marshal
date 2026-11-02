// Marshal-owned module.
import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { useInterval } from "./useInterval";

describe("useInterval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls callback on each interval", () => {
    const cb = vi.fn<() => void>();
    renderHook(() => useInterval(cb, 1000));

    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("does not call callback when delay is null", () => {
    const cb = vi.fn<() => void>();
    renderHook(() => useInterval(cb, null));

    vi.advanceTimersByTime(5000);
    expect(cb).not.toHaveBeenCalled();
  });

  it("clears interval on unmount", () => {
    const cb = vi.fn<() => void>();
    const { unmount } = renderHook(() => useInterval(cb, 1000));

    vi.advanceTimersByTime(2500);
    expect(cb).toHaveBeenCalledTimes(2);
    unmount();
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("restarts interval when delay changes", () => {
    const cb = vi.fn<() => void>();
    const { rerender } = renderHook(({ delay }) => useInterval(cb, delay), {
      initialProps: { delay: 1000 as number | null },
    });

    vi.advanceTimersByTime(2500);
    expect(cb).toHaveBeenCalledTimes(2);

    rerender({ delay: 500 });
    vi.advanceTimersByTime(1500);
    expect(cb).toHaveBeenCalledTimes(5); // 2 from before + 3 at 500ms
  });

  it("stops when delay changes to null", () => {
    const cb = vi.fn<() => void>();
    const { rerender } = renderHook(({ delay }) => useInterval(cb, delay), {
      initialProps: { delay: 1000 as number | null },
    });

    vi.advanceTimersByTime(2500);
    expect(cb).toHaveBeenCalledTimes(2);

    rerender({ delay: null });
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("uses latest callback without restarting interval", () => {
    const cb1 = vi.fn<() => void>();
    const cb2 = vi.fn<() => void>();
    const { rerender } = renderHook(({ cb }) => useInterval(cb, 1000), {
      initialProps: { cb: cb1 },
    });

    vi.advanceTimersByTime(1000);
    expect(cb1).toHaveBeenCalledTimes(1);

    rerender({ cb: cb2 });
    vi.advanceTimersByTime(1000);
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});
