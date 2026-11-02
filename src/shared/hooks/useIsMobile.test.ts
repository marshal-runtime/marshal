import { describe, expect, it } from "vitest";

import { act, renderHook } from "@/test-utils";

import { useIsMobile } from "./useIsMobile";

// The hook's change listener takes no arguments — it just re-reads
// window.matchMedia(...).matches — so the mock doesn't need to fabricate a
// MediaQueryListEvent.
type Listener = () => void;

function installMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<Listener>();
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      get matches() {
        return matches;
      },
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      dispatchEvent: () => true,
    }),
  });
  return {
    setMatches(next: boolean) {
      matches = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("useIsMobile", () => {
  it("reflects the initial matchMedia state", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it("updates when the media query change event fires", () => {
    const mql = installMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    act(() => mql.setMatches(true));
    expect(result.current).toBe(true);

    act(() => mql.setMatches(false));
    expect(result.current).toBe(false);
  });
});
