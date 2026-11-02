// marshal-owned renderer test
import type { McpsAPI } from "@common/marshal-ipc-contract";
import { QueryClient, QueryClientProvider, useIsMutating } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs } from "@/test-utils";

import {
  mcpOAuthStore,
  useIsMutatingMcpServerSignOut,
  useSignOutMcpServerMutation,
} from "./mcp-oauth-store";

vi.mock("sonner", () => ({
  toast: { error: vi.fn<(message: string) => void>() },
}));

describe("useSignOutMcpServerMutation", () => {
  let queryClient: QueryClient;

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    installMockAPIs();
    mcpOAuthStore.resetForTests();
    queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    queryClient.clear();
  });

  it("clears the UI state and invalidates the cache on success", async () => {
    // Seed a "connected" state so we can confirm it's cleared on success.
    mcpOAuthStore.setUiState("test-server", {
      serverKey: "test-server",
      state: "connected",
      alias: "alice@example.com",
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const signOut = vi.fn<McpsAPI["signOut"]>().mockResolvedValue({ status: "success" });
    window.mcpsAPI.signOut = signOut;

    const { result } = renderHook(() => useSignOutMcpServerMutation("test-server"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(signOut).toHaveBeenCalledWith("test-server");
    // UI state row is dropped — otherwise isMcpServerSignedIn would still
    // return true on the stale state: "connected" flag.
    expect(mcpOAuthStore.getUiStateSnapshot()["test-server"]).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["mcp-servers"] });
  });

  it("leaves UI state alone and surfaces a toast on IPC failure (error result)", async () => {
    mcpOAuthStore.setUiState("test-server", {
      serverKey: "test-server",
      state: "connected",
      alias: "alice@example.com",
    });
    window.mcpsAPI.signOut = vi
      .fn<McpsAPI["signOut"]>()
      .mockResolvedValue({ status: "error", message: "Something went wrong" });

    const { result } = renderHook(() => useSignOutMcpServerMutation("test-server"), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow("Something went wrong");
    });

    expect(toast.error).toHaveBeenCalledWith("Something went wrong");
    // The store no longer rolls back on failure — the IPC handler is the
    // source of truth. Whatever the store held going in stays.
    expect(mcpOAuthStore.getUiStateSnapshot()["test-server"]).toEqual({
      serverKey: "test-server",
      state: "connected",
      alias: "alice@example.com",
    });
  });

  it("surfaces a toast on a thrown IPC error", async () => {
    window.mcpsAPI.signOut = vi
      .fn<McpsAPI["signOut"]>()
      .mockRejectedValue(new Error("IPC disconnect"));

    const { result } = renderHook(() => useSignOutMcpServerMutation("test-server"), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow("IPC disconnect");
    });

    expect(toast.error).toHaveBeenCalledWith("IPC disconnect");
  });

  it("normalizes the server name via toMcpServerKey for the mutation key", async () => {
    // toMcpServerKey lowercases and replaces non-[a-z0-9_-] with underscores.
    // The mutation key must use the normalized key so useIsMutating observers
    // (which always normalize) find the in-flight mutation.
    let resolveSignOut: () => void = () => {};
    window.mcpsAPI.signOut = vi.fn<McpsAPI["signOut"]>().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSignOut = () => resolve({ status: "success" });
        }),
    );

    const { result: observer } = renderHook(
      () => useIsMutating({ mutationKey: ["mcp-signout", "power_bi_mcp"] }),
      { wrapper },
    );
    const { result: mutation } = renderHook(() => useSignOutMcpServerMutation("Power BI MCP"), {
      wrapper,
    });

    act(() => {
      mutation.current.mutate();
    });
    await waitFor(() => expect(observer.current).toBe(1));

    await act(async () => {
      resolveSignOut();
    });
    await waitFor(() => expect(observer.current).toBe(0));
  });

  it("throws when the API is unavailable", async () => {
    const originalSignOut = window.mcpsAPI.signOut;
    // @ts-expect-error - intentionally widening to test fallback.
    window.mcpsAPI.signOut = undefined;
    try {
      const { result } = renderHook(() => useSignOutMcpServerMutation("test-server"), { wrapper });
      await act(async () => {
        await expect(result.current.mutateAsync()).rejects.toThrow("MCP API unavailable");
      });
      expect(toast.error).toHaveBeenCalledWith("MCP API unavailable");
    } finally {
      window.mcpsAPI.signOut = originalSignOut;
    }
  });
});

describe("useIsMutatingMcpServerSignOut", () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    installMockAPIs();
    mcpOAuthStore.resetForTests();
    queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
  });

  afterEach(() => {
    queryClient.clear();
  });

  it("returns true when a mutation for the same server is in flight, false otherwise", async () => {
    let resolveSignOut: () => void = () => {};
    window.mcpsAPI.signOut = vi.fn<McpsAPI["signOut"]>().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSignOut = () => resolve({ status: "success" });
        }),
    );

    const { result: observer } = renderHook(() => useIsMutatingMcpServerSignOut("test-server"), {
      wrapper,
    });
    const { result: mutation } = renderHook(() => useSignOutMcpServerMutation("test-server"), {
      wrapper,
    });

    expect(observer.current).toBe(false);
    act(() => {
      mutation.current.mutate();
    });
    await waitFor(() => expect(observer.current).toBe(true));

    await act(async () => {
      resolveSignOut();
    });
    await waitFor(() => expect(observer.current).toBe(false));
  });

  // Mirror of the McpOAuthDialog F5 isPending-continuity test, but for the
  // sign-out side. `useSignOutMcpServerMutation.onSettled` *returns* the
  // invalidate promise (instead of `void`-ing it) so TanStack keeps
  // `isPending` true — and therefore `useIsMutatingMcpServerSignOut` stays
  // true — until the `["mcp-servers"]` refetch lands. If `void` is
  // accidentally reintroduced for sign-out, the "Log out" button (and the
  // Re-authenticate primary that mirrors `isSigningOut`) re-enable while
  // the cache is still stale — the exact regression F5 prevents on the
  // sign-in side.
  it("stays true through onSettled invalidateQueries (pins isPending continuity on sign-out)", async () => {
    window.mcpsAPI.signOut = vi.fn<McpsAPI["signOut"]>().mockResolvedValue({ status: "success" });
    // Never-resolving invalidate: TanStack awaits the promise returned
    // from onSettled, so isPending must stay true the entire time this
    // promise is unresolved.
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation(
      () => new Promise<void>(() => {}),
    );

    const { result: observer } = renderHook(() => useIsMutatingMcpServerSignOut("test-server"), {
      wrapper,
    });
    const { result: mutation } = renderHook(() => useSignOutMcpServerMutation("test-server"), {
      wrapper,
    });

    expect(observer.current).toBe(false);
    act(() => {
      mutation.current.mutate();
    });
    // The IPC settles immediately, so onSuccess + onSettled fire. The
    // observer flips to true while the (hanging) invalidate keeps the
    // mutation in flight. waitFor confirms we observed the true state AND
    // continues to observe it (the invalidate never resolves so the
    // observer can't flip back).
    await waitFor(() => expect(observer.current).toBe(true));
    await waitFor(() => expect(window.mcpsAPI.signOut).toHaveBeenCalled());
    // Still pending — the invalidate promise hasn't resolved. If `void`
    // were put back on onSettled, the observer would have flipped to
    // false here.
    expect(observer.current).toBe(true);
  });
});
