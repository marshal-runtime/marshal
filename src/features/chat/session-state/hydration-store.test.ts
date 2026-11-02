import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs } from "@/test-utils";
import type { SessionHydrationEvent } from "@/types/electron";

import { hydrationStore } from "./hydration-store";

function setupMockAPI() {
  let activeCallback: ((evt: SessionHydrationEvent) => void) | null = null;
  const unsubscribe = vi.fn<() => void>();
  const onHydrationChanged = vi
    .fn<(cb: (evt: SessionHydrationEvent) => void) => () => void>()
    .mockImplementation((cb) => {
      activeCallback = cb;
      return unsubscribe;
    });
  installMockAPIs({ sessionsAPI: { onHydrationChanged } });
  return {
    fire: (evt: SessionHydrationEvent) => activeCallback?.(evt),
    onHydrationChanged,
    unsubscribe,
  };
}

describe("hydrationStore", () => {
  beforeEach(() => hydrationStore.reset());
  afterEach(() => {
    hydrationStore.reset();
    (window as { sessionsAPI?: unknown }).sessionsAPI = undefined;
  });

  it("getSnapshot returns idle for unknown sessionId", () => {
    expect(hydrationStore.snapshot("nope")).toEqual({ isHydrating: false });
  });

  it("getSnapshot returns idle for null sessionId", () => {
    expect(hydrationStore.snapshot(null)).toEqual({ isHydrating: false });
  });

  it("init subscribes once even if called repeatedly", () => {
    const api = setupMockAPI();
    hydrationStore.initialize();
    hydrationStore.initialize();
    hydrationStore.initialize();
    expect(api.onHydrationChanged).toHaveBeenCalledTimes(1);
  });

  it("started → loaded transitions update getSnapshot and notify subscribers", () => {
    const api = setupMockAPI();
    hydrationStore.initialize();
    const notify = vi.fn<() => void>();
    hydrationStore.subscribe(notify);
    api.fire({ sessionId: "s1", state: "started" });
    expect(hydrationStore.snapshot("s1")).toEqual({ isHydrating: true });
    expect(notify).toHaveBeenCalledTimes(1);
    api.fire({ sessionId: "s1", state: "loaded" });
    expect(hydrationStore.snapshot("s1")).toEqual({ isHydrating: false });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("failed events return state to idle", () => {
    const api = setupMockAPI();
    hydrationStore.initialize();
    api.fire({ sessionId: "s1", state: "started" });
    api.fire({ sessionId: "s1", state: "failed" });
    expect(hydrationStore.snapshot("s1")).toEqual({ isHydrating: false });
  });

  it("scopes state per sessionId", () => {
    const api = setupMockAPI();
    hydrationStore.initialize();
    api.fire({ sessionId: "s1", state: "started" });
    expect(hydrationStore.snapshot("s1").isHydrating).toBe(true);
    expect(hydrationStore.snapshot("s2").isHydrating).toBe(false);
  });

  it("subscribe returns unsubscribe that removes the listener", () => {
    const api = setupMockAPI();
    hydrationStore.initialize();
    const notify = vi.fn<() => void>();
    const unsub = hydrationStore.subscribe(notify);
    api.fire({ sessionId: "s1", state: "started" });
    expect(notify).toHaveBeenCalledTimes(1);
    unsub();
    api.fire({ sessionId: "s1", state: "loaded" });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("init teardown clears state and listeners", () => {
    const api = setupMockAPI();
    const cleanup = hydrationStore.initialize();
    api.fire({ sessionId: "s1", state: "started" });
    const notify = vi.fn<() => void>();
    hydrationStore.subscribe(notify);
    expect(hydrationStore.snapshot("s1").isHydrating).toBe(true);
    cleanup();
    expect(hydrationStore.snapshot("s1")).toBe(hydrationStore.snapshot("never-seen"));
    api.fire({ sessionId: "s1", state: "started" });
    expect(notify).not.toHaveBeenCalled();
  });
});
