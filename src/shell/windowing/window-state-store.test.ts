import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, createMockWindowControlsAPI } from "@/test-utils";

import { createWindowStore } from "./window-state-store";

describe("createWindowStore", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  it("initializes with default state when no API is available", () => {
    window.windowControlsAPI = undefined;

    const store = createWindowStore();
    expect(store.getSnapshot()).toEqual({ isMaximized: false, isFullScreen: false });
  });

  it("seeds initial state from getState()", async () => {
    const windowControlsAPI = createMockWindowControlsAPI({
      getState: vi
        .fn<() => Promise<{ success: boolean; isMaximized: boolean; isFullScreen: boolean }>>()
        .mockResolvedValue({
          success: true,
          isMaximized: true,
          isFullScreen: true,
        }),
    });
    installMockAPIs({ windowControlsAPI });

    const store = createWindowStore();

    // Wait for the async getState() to resolve
    await vi.waitFor(() => {
      expect(store.getSnapshot()).toEqual({ isMaximized: true, isFullScreen: true });
    });
  });

  it("updates state when onMaximizeChanged fires", () => {
    let maximizeCallback: ((v: boolean) => void) | undefined;
    const windowControlsAPI = createMockWindowControlsAPI({
      onMaximizeChanged: vi
        .fn<(cb: (v: boolean) => void) => () => void>()
        .mockImplementation((cb) => {
          maximizeCallback = cb;
          return () => {};
        }),
    });
    installMockAPIs({ windowControlsAPI });

    const store = createWindowStore();
    expect(store.getSnapshot().isMaximized).toBe(false);

    maximizeCallback?.(true);
    expect(store.getSnapshot().isMaximized).toBe(true);

    maximizeCallback?.(false);
    expect(store.getSnapshot().isMaximized).toBe(false);
  });

  it("updates state when onFullScreenChanged fires", () => {
    let fullScreenCallback: ((v: boolean) => void) | undefined;
    const windowControlsAPI = createMockWindowControlsAPI({
      onFullScreenChanged: vi
        .fn<(cb: (v: boolean) => void) => () => void>()
        .mockImplementation((cb) => {
          fullScreenCallback = cb;
          return () => {};
        }),
    });
    installMockAPIs({ windowControlsAPI });

    const store = createWindowStore();
    expect(store.getSnapshot().isFullScreen).toBe(false);

    fullScreenCallback?.(true);
    expect(store.getSnapshot().isFullScreen).toBe(true);
  });

  it("notifies subscribers on state change", () => {
    let maximizeCallback: ((v: boolean) => void) | undefined;
    const windowControlsAPI = createMockWindowControlsAPI({
      onMaximizeChanged: vi
        .fn<(cb: (v: boolean) => void) => () => void>()
        .mockImplementation((cb) => {
          maximizeCallback = cb;
          return () => {};
        }),
    });
    installMockAPIs({ windowControlsAPI });

    const store = createWindowStore();
    const listener = vi.fn<() => void>();
    store.subscribe(listener);

    maximizeCallback?.(true);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("unsubscribes listeners correctly", () => {
    let maximizeCallback: ((v: boolean) => void) | undefined;
    const windowControlsAPI = createMockWindowControlsAPI({
      onMaximizeChanged: vi
        .fn<(cb: (v: boolean) => void) => () => void>()
        .mockImplementation((cb) => {
          maximizeCallback = cb;
          return () => {};
        }),
    });
    installMockAPIs({ windowControlsAPI });

    const store = createWindowStore();
    const listener = vi.fn<() => void>();
    const unsub = store.subscribe(listener);

    unsub();
    maximizeCallback?.(true);
    expect(listener).not.toHaveBeenCalled();
  });
});
