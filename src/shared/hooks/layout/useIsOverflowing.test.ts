// Marshal-owned module.
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { useIsOverflowing } from "./useIsOverflowing";

describe("useIsOverflowing", () => {
  let mockObserve: ReturnType<typeof vi.fn>;
  let mockDisconnect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockObserve = vi.fn<(target: Element) => void>();
    mockDisconnect = vi.fn<() => void>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = mockObserve;
        disconnect = mockDisconnect;
        unobserve = vi.fn<(target: Element) => void>();
      },
    );
  });

  it("returns a callback ref and initial overflowing=false", () => {
    const { result } = renderHook(() => useIsOverflowing());
    const [ref, overflowing] = result.current;
    expect(typeof ref).toBe("function");
    expect(overflowing).toBe(false);
  });

  it("sets up ResizeObserver when ref is attached to an element", async () => {
    const { result } = renderHook(() => useIsOverflowing());

    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { value: 100 });
    Object.defineProperty(el, "clientHeight", { value: 40 });

    act(() => result.current[0](el));

    expect(mockObserve).toHaveBeenCalledWith(el);
  });

  it("disconnects ResizeObserver on unmount", async () => {
    const { result, unmount } = renderHook(() => useIsOverflowing());

    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { value: 50 });
    Object.defineProperty(el, "clientHeight", { value: 50 });

    act(() => result.current[0](el));

    unmount();
    expect(mockDisconnect).toHaveBeenCalled();
  });
});
