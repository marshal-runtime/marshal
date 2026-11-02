import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockChatWindowsAPI, installMockAPIs } from "@/test-utils";

import { useChatWindows } from "./use-chat-windows";

describe("useChatWindows", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  afterEach(() => {
    delete window.chatWindowsAPI;
  });

  it("reports isAvailable=true when the IPC bridge is present", () => {
    const { result } = renderHook(() => useChatWindows());
    expect(result.current.isAvailable).toBe(true);
  });

  it("reports isAvailable=false and no-ops openInNewWindow when the IPC bridge is absent", async () => {
    delete window.chatWindowsAPI;
    const { result } = renderHook(() => useChatWindows());

    expect(result.current.isAvailable).toBe(false);
    await act(async () => {
      await result.current.openInNewWindow("session-1");
    });
    // Nothing to assert other than that the call didn't throw.
  });

  it("delegates to chatWindowsAPI.open with the given sessionId", async () => {
    const open = vi
      .fn<
        (
          sessionId: string,
          bounds?: { x: number; y: number },
        ) => Promise<{ success: true; alreadyOpen: boolean }>
      >()
      .mockResolvedValue({ success: true, alreadyOpen: false });
    window.chatWindowsAPI = createMockChatWindowsAPI({ open });
    const { result } = renderHook(() => useChatWindows());

    await act(async () => {
      await result.current.openInNewWindow("session-42");
    });

    expect(open).toHaveBeenCalledWith("session-42", undefined);
  });

  it("forwards drop-location bounds to chatWindowsAPI.open (drag-to-popout)", async () => {
    const open = vi
      .fn<
        (
          sessionId: string,
          bounds?: { x: number; y: number },
        ) => Promise<{ success: true; alreadyOpen: boolean }>
      >()
      .mockResolvedValue({ success: true, alreadyOpen: false });
    window.chatWindowsAPI = createMockChatWindowsAPI({ open });
    const { result } = renderHook(() => useChatWindows());

    await act(async () => {
      await result.current.openInNewWindow("session-42", { x: 800, y: 300 });
    });

    expect(open).toHaveBeenCalledWith("session-42", { x: 800, y: 300 });
  });

  it("swallows IPC failures so the UI does not crash on a failed popout", async () => {
    const open = vi
      .fn<(sessionId: string) => Promise<{ success: false; error: string }>>()
      .mockResolvedValue({ success: false, error: "boom" });
    window.chatWindowsAPI = createMockChatWindowsAPI({ open });
    const { result } = renderHook(() => useChatWindows());

    await expect(
      act(async () => {
        await result.current.openInNewWindow("session-1");
      }),
    ).resolves.toBeUndefined();
  });

  it("returns a stable openInNewWindow callback across re-renders when the API is unchanged", () => {
    const { result, rerender } = renderHook(() => useChatWindows());
    const first = result.current.openInNewWindow;
    rerender();
    expect(result.current.openInNewWindow).toBe(first);
  });
});
