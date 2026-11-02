// Marshal-owned module.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDebouncedValue } from "./useDebouncedValue";

describe("useDebouncedValue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("updates after the debounce delay", async () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 300), {
      initialProps: { value: "a" },
    });

    rerender({ value: "ab" });
    expect(result.current).toBe("a");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current).toBe("ab");
  });

  it("discards intermediate values during rapid updates", async () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 300), {
      initialProps: { value: "a" },
    });

    rerender({ value: "ab" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    rerender({ value: "abc" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(result.current).toBe("a");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current).toBe("abc");
  });

  it("uses disabledValue immediately when disabled", async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useDebouncedValue("query", 300, { enabled, disabledValue: "" }),
      { initialProps: { enabled: true } },
    );

    rerender({ enabled: false });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current).toBe("");
  });

  it("uses disabledValue on the initial render when mounted disabled", () => {
    const { result } = renderHook(() =>
      useDebouncedValue("query", 300, { enabled: false, disabledValue: "" }),
    );

    expect(result.current).toBe("");
  });

  it("updates disabledValue while disabled", async () => {
    const { result, rerender } = renderHook(
      ({ disabledValue }) => useDebouncedValue("query", 300, { enabled: false, disabledValue }),
      { initialProps: { disabledValue: "" } },
    );

    rerender({ disabledValue: "disabled" });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current).toBe("disabled");
  });
});
