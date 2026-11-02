import type { GatewayAuthState } from "@common/marshal-ipc-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs } from "@/test-utils";

import { useGatewayAuth } from "./useGatewayDeviceAuth";

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe("useGatewayAuth", () => {
  beforeEach(() => {
    installMockAPIs();
    vi.clearAllMocks();
  });

  it("fetches initial state via getState", async () => {
    vi.mocked(window.gatewayAuthAPI!.getState).mockResolvedValue({
      success: true,
      state: { status: "picking" },
    });
    const { result } = renderHook(() => useGatewayAuth(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.status).toBe("picking"));
  });

  it("updates on stateChange IPC event", async () => {
    vi.mocked(window.gatewayAuthAPI!.getState).mockResolvedValue({
      success: true,
      state: { status: "picking" },
    });
    let fire: ((state: GatewayAuthState) => void) | null = null;
    vi.mocked(window.gatewayAuthAPI!.onStateChange).mockImplementation((cb) => {
      fire = cb;
      return () => {};
    });
    const { result } = renderHook(() => useGatewayAuth(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.status).toBe("picking"));

    act(() => {
      fire?.({
        status: "signed-in",
        identity: { mode: "hosted", oid: "alice-oid-001" },
      });
    });

    await waitFor(() => expect(result.current.status).toBe("signed-in"));
    expect(result.current.identity?.oid).toBe("alice-oid-001");
  });
});
