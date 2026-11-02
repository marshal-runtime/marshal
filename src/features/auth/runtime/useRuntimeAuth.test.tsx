import { getRuntimeMetadata } from "@common/runtime-config";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs } from "@/test-utils";

import { deriveRuntimeAuthStage, useRuntimeAuth } from "./useRuntimeAuth";

beforeEach(() => {
  installMockAPIs();
});

describe("deriveRuntimeAuthStage", () => {
  it("allows an authenticated Claude runtime without applying the Copilot plan gate", () => {
    expect(
      deriveRuntimeAuthStage({
        metadata: getRuntimeMetadata("claude"),
        status: { isAuthenticated: true, login: "api-key" },
        statusPending: false,
        statusError: null,
        loginState: null,
        loginError: null,
      }),
    ).toEqual({ kind: "ready" });
  });

  it("exposes Claude browser sign-in and API-key choices when credentials are absent", () => {
    const stage = deriveRuntimeAuthStage({
      metadata: getRuntimeMetadata("claude"),
      status: { isAuthenticated: false },
      statusPending: false,
      statusError: null,
      loginState: null,
      loginError: null,
    });

    expect(stage.kind).toBe("sign-in");
    if (stage.kind !== "sign-in") throw new Error("Expected sign-in stage");
    expect(stage.methods.map((method) => method.type)).toEqual(["browser", "api-key"]);
  });

  it("exposes Codex browser, device-code, and API-key choices generically", () => {
    const stage = deriveRuntimeAuthStage({
      metadata: getRuntimeMetadata("codex"),
      status: { isAuthenticated: false },
      statusPending: false,
      statusError: null,
      loginState: null,
      loginError: null,
    });

    expect(stage.kind).toBe("sign-in");
    if (stage.kind !== "sign-in") throw new Error("Expected sign-in stage");
    expect(stage.methods.map((method) => method.type)).toEqual([
      "browser",
      "device-code",
      "api-key",
    ]);
  });

  it("represents pending device-code login without runtime-specific downcasts", () => {
    expect(
      deriveRuntimeAuthStage({
        metadata: getRuntimeMetadata("codex"),
        status: { isAuthenticated: false },
        statusPending: false,
        statusError: null,
        loginState: {
          status: "pending",
          method: "device-code",
          verificationUri: "https://example.test/device",
          userCode: "ABCD-EFGH",
        },
        loginError: null,
      }),
    ).toEqual({
      kind: "pending",
      method: "device-code",
      verificationUri: "https://example.test/device",
      userCode: "ABCD-EFGH",
    });
  });

  it("clears secret-bearing mutation variables after login settles", async () => {
    vi.mocked(window.runtimeAuthAPI!.getStatus).mockResolvedValue({
      success: true,
      status: { isAuthenticated: false },
    });
    vi.mocked(window.runtimeAuthAPI!.login).mockResolvedValue({
      success: true,
      state: { status: "authenticated" },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useRuntimeAuth("codex"), { wrapper });
    await waitFor(() => expect(result.current.stage.kind).toBe("sign-in"));

    await act(async () => {
      await result.current.login({ type: "api-key", apiKey: "sk-secret-value" });
    });

    expect(window.runtimeAuthAPI!.login).toHaveBeenCalledWith({
      type: "api-key",
      apiKey: "sk-secret-value",
    });
    const mutationStates = queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state);
    expect(mutationStates.every((state) => state.variables === undefined)).toBe(true);
    expect(JSON.stringify(mutationStates)).not.toContain("sk-secret-value");
  });
});
