import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs } from "@/test-utils";
import type { SessionHydrationEvent } from "@/types/electron";

import { hydrationStore } from "./hydration-store";
import { useSessionHydration } from "./use-session-hydration";

function setupMockAPI() {
  let activeCallback: ((evt: SessionHydrationEvent) => void) | null = null;
  const onHydrationChanged = (cb: (evt: SessionHydrationEvent) => void) => {
    activeCallback = cb;
    return () => {};
  };
  installMockAPIs({ sessionsAPI: { onHydrationChanged } });
  return { fire: (evt: SessionHydrationEvent) => activeCallback?.(evt) };
}

describe("useSessionHydration", () => {
  beforeEach(() => hydrationStore.reset());
  afterEach(() => {
    vi.restoreAllMocks();
    hydrationStore.reset();
    (window as { sessionsAPI?: unknown }).sessionsAPI = undefined;
  });

  it("starts with isHydrating=false", () => {
    setupMockAPI();
    hydrationStore.initialize();
    const { result } = renderHook(() => useSessionHydration("s1"));
    expect(result.current).toEqual({ isHydrating: false });
  });

  it("transitions started → loaded for the matching sessionId", () => {
    const api = setupMockAPI();
    hydrationStore.initialize();
    const { result } = renderHook(() => useSessionHydration("s1"));
    act(() => api.fire({ sessionId: "s1", state: "started" }));
    expect(result.current.isHydrating).toBe(true);
    act(() => api.fire({ sessionId: "s1", state: "loaded" }));
    expect(result.current.isHydrating).toBe(false);
  });

  it("transitions started → failed back to idle for the matching sessionId", () => {
    const api = setupMockAPI();
    hydrationStore.initialize();
    const { result } = renderHook(() => useSessionHydration("s1"));
    act(() => {
      api.fire({ sessionId: "s1", state: "started" });
      api.fire({ sessionId: "s1", state: "failed" });
    });
    expect(result.current.isHydrating).toBe(false);
  });

  it("ignores events for other sessionIds", () => {
    const api = setupMockAPI();
    hydrationStore.initialize();
    const { result } = renderHook(() => useSessionHydration("s1"));
    act(() => api.fire({ sessionId: "s2", state: "started" }));
    expect(result.current.isHydrating).toBe(false);
  });

  it("does nothing when sessionId is null", () => {
    setupMockAPI();
    hydrationStore.initialize();
    const { result } = renderHook(() => useSessionHydration(null));
    expect(result.current).toEqual({ isHydrating: false });
  });

  it("resets to idle immediately when sessionId changes", () => {
    const api = setupMockAPI();
    hydrationStore.initialize();
    const { result, rerender } = renderHook(({ id }: { id: string }) => useSessionHydration(id), {
      initialProps: { id: "sess-A" },
    });
    act(() => api.fire({ sessionId: "sess-A", state: "started" }));
    expect(result.current.isHydrating).toBe(true);
    rerender({ id: "sess-B" });
    expect(result.current).toEqual({ isHydrating: false });
  });

  it("keeps the external-store subscription stable across rerenders", () => {
    setupMockAPI();
    hydrationStore.initialize();
    const subscribe = vi.spyOn(hydrationStore, "subscribe");
    const { rerender } = renderHook(({ id }: { id: string }) => useSessionHydration(id), {
      initialProps: { id: "sess-A" },
    });

    expect(subscribe).toHaveBeenCalledTimes(1);
    rerender({ id: "sess-B" });
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
