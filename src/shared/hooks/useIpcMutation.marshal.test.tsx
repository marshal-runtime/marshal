// marshal-owned renderer test
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useIpcMutation } from "./useIpcMutation";

const toastErrorSpy = vi.fn<(message: string) => void>();
vi.mock("sonner", () => ({
  toast: {
    error: (message: string) => toastErrorSpy(message),
  },
}));

function makeWrapper() {
  // Fresh client per test — mutation/error caches don't leak.
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  toastErrorSpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useIpcMutation", () => {
  it("resolves with the IPC payload when result.success is true", async () => {
    const mutationFn = vi.fn<() => Promise<{ success: true; payload: number }>>(async () => ({
      success: true,
      payload: 42,
    }));
    const { result } = renderHook(
      () =>
        useIpcMutation({
          mutationFn,
          fallbackErrorMessage: "should not surface",
        }),
      { wrapper: makeWrapper() },
    );

    await act(async () => {
      const data = await result.current.mutateAsync();
      expect(data).toEqual({ success: true, payload: 42 });
    });

    expect(mutationFn).toHaveBeenCalledTimes(1);
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  it("throws and toasts result.error when result.success is false", async () => {
    const mutationFn = vi.fn<() => Promise<{ success: false; error: string }>>(async () => ({
      success: false,
      error: "Settings changed externally; please refresh and try again.",
    }));
    const { result } = renderHook(
      () =>
        useIpcMutation({
          mutationFn,
          fallbackErrorMessage: "Failed to save",
        }),
      { wrapper: makeWrapper() },
    );

    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow(/changed externally/i);
    });

    await waitFor(() => {
      expect(toastErrorSpy).toHaveBeenCalledWith(
        "Settings changed externally; please refresh and try again.",
      );
    });
  });

  it("falls back to fallbackErrorMessage when result.error is missing", async () => {
    const mutationFn = vi.fn<() => Promise<{ success: false }>>(async () => ({ success: false }));
    const { result } = renderHook(
      () =>
        useIpcMutation({
          mutationFn,
          fallbackErrorMessage: "Failed to save heartbeat",
        }),
      { wrapper: makeWrapper() },
    );

    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow("Failed to save heartbeat");
    });

    await waitFor(() => {
      expect(toastErrorSpy).toHaveBeenCalledWith("Failed to save heartbeat");
    });
  });

  it("does not toast when toastOnError: false (caller surfaces error themselves)", async () => {
    const mutationFn = vi.fn<() => Promise<{ success: false; error: string }>>(async () => ({
      success: false,
      error: "Cancelled",
    }));
    const customOnError = vi.fn<(err: Error) => void>();
    const { result } = renderHook(
      () =>
        useIpcMutation({
          mutationFn,
          fallbackErrorMessage: "Failed",
          toastOnError: false,
          onError: customOnError,
        }),
      { wrapper: makeWrapper() },
    );

    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow("Cancelled");
    });

    expect(toastErrorSpy).not.toHaveBeenCalled();
    expect(customOnError).toHaveBeenCalledTimes(1);
    // First arg is the Error.
    expect(customOnError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("toasts AND calls user onError when both are wired", async () => {
    const mutationFn = vi.fn<() => Promise<{ success: false; error: string }>>(async () => ({
      success: false,
      error: "boom",
    }));
    const customOnError = vi.fn<(err: Error) => void>();
    const { result } = renderHook(
      () =>
        useIpcMutation({
          mutationFn,
          fallbackErrorMessage: "Failed",
          onError: customOnError,
        }),
      { wrapper: makeWrapper() },
    );

    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow("boom");
    });

    await waitFor(() => {
      expect(toastErrorSpy).toHaveBeenCalledWith("boom");
      expect(customOnError).toHaveBeenCalledTimes(1);
    });
  });

  it("propagates a thrown error from mutationFn through onError as well", async () => {
    // Network-level failure (raw throw, not result-shape) — should still
    // toast and reject. Belt-and-braces: callers don't have to wrap their
    // mutationFn in their own try/catch.
    const mutationFn = vi.fn<() => Promise<{ success: true }>>(async () => {
      throw new Error("connection refused");
    });
    const { result } = renderHook(
      () =>
        useIpcMutation({
          mutationFn,
          fallbackErrorMessage: "Failed",
        }),
      { wrapper: makeWrapper() },
    );

    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow("connection refused");
    });

    await waitFor(() => {
      expect(toastErrorSpy).toHaveBeenCalledWith("connection refused");
    });
  });

  it("exposes isPending while the mutation is in flight", async () => {
    let resolve: (value: { success: true }) => void = () => {};
    const mutationFn = vi.fn<() => Promise<{ success: true }>>(
      () =>
        new Promise<{ success: true }>((r) => {
          resolve = r;
        }),
    );
    const { result } = renderHook(
      () =>
        useIpcMutation({
          mutationFn,
          fallbackErrorMessage: "Failed",
        }),
      { wrapper: makeWrapper() },
    );

    expect(result.current.isPending).toBe(false);

    let pending: Promise<unknown>;
    act(() => {
      pending = result.current.mutateAsync();
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });

    await act(async () => {
      resolve({ success: true });
      await pending;
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });
  });

  it("invokes onSettled regardless of outcome (so query invalidation always fires)", async () => {
    const onSettled = vi.fn<() => void>();
    const successFn = vi.fn<() => Promise<{ success: true }>>(async () => ({ success: true }));
    const { result: ok } = renderHook(
      () =>
        useIpcMutation({
          mutationFn: successFn,
          fallbackErrorMessage: "Failed",
          onSettled,
        }),
      { wrapper: makeWrapper() },
    );
    await act(async () => {
      await ok.current.mutateAsync();
    });
    expect(onSettled).toHaveBeenCalledTimes(1);

    onSettled.mockClear();
    const failFn = vi.fn<() => Promise<{ success: false; error: string }>>(async () => ({
      success: false,
      error: "boom",
    }));
    const { result: fail } = renderHook(
      () =>
        useIpcMutation({
          mutationFn: failFn,
          fallbackErrorMessage: "Failed",
          onSettled,
        }),
      { wrapper: makeWrapper() },
    );
    await act(async () => {
      await expect(fail.current.mutateAsync()).rejects.toThrow("boom");
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
