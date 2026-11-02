import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs } from "@/test-utils";

import { useRuntimeStartupSelection, useSettings } from "./useSettings";

describe("runtime startup selection", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  it("keeps the effective startup runtime separate from the next-launch setting", async () => {
    vi.mocked(window.settingsAPI.get).mockResolvedValue({
      success: true,
      settings: {
        autoApprove: { global: false, perServer: {} },
        runtimeId: "gateway",
      },
    });
    vi.mocked(window.settingsAPI.getRuntimeSelection).mockResolvedValue({
      success: true,
      selection: {
        requestedRuntimeId: "gateway",
        runtimeId: "copilot",
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () => ({
        settings: useSettings(),
        startup: useRuntimeStartupSelection(),
      }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.settings.isPending).toBe(false);
      expect(result.current.startup.isPending).toBe(false);
    });
    expect(result.current.settings.settings.runtimeId).toBe("gateway");
    expect(result.current.startup.runtimeSelection?.runtimeId).toBe("copilot");
  });

  it("updates the shared runtime selection after a live switch", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useRuntimeStartupSelection(), { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    await act(async () => {
      await result.current.switchRuntime("codex");
    });

    expect(window.settingsAPI.switchRuntime).toHaveBeenCalledWith("codex");
    await waitFor(() => expect(result.current.runtimeSelection?.runtimeId).toBe("codex"));
  });
});
