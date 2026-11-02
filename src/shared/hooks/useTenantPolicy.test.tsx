import type { TenantAPI } from "@common/marshal-ipc-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs } from "@/test-utils";

import { useTenantPolicy } from "./useTenantPolicy";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useTenantPolicy", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  it("returns unmanaged defaults when tenantAPI is not available", async () => {
    window.tenantAPI = undefined;
    const { result } = renderHook(() => useTenantPolicy(), { wrapper: createWrapper() });
    // Should immediately have the default unmanaged state
    expect(result.current.managed).toBe(false);
    expect(result.current.disabledServers).toEqual([]);
    expect(result.current.disabledPermissionKinds).toEqual([]);
    expect(result.current.forcePrompt).toBe(false);
  });

  it("returns tenant status from the API", async () => {
    window.tenantAPI = {
      getStatus: vi.fn<TenantAPI["getStatus"]>().mockResolvedValue({
        success: true,
        managed: true,
        disabledServers: ["ExampleMcp"],
        disabledPermissionKinds: ["shell"],
        forcePrompt: true,
        disabledModels: [],
        disableHeartbeat: false,
        disableAutomations: false,
        disabledProviders: [],
        restrictToWorkspace: false,
        browserEgressBlockedOrigins: [],
      }),
    };
    const { result } = renderHook(() => useTenantPolicy(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.managed).toBe(true));
    expect(result.current.disabledServers).toEqual(["ExampleMcp"]);
    expect(result.current.disabledPermissionKinds).toEqual(["shell"]);
    expect(result.current.forcePrompt).toBe(true);
  });

  it("returns unmanaged defaults when API call fails", async () => {
    window.tenantAPI = {
      getStatus: vi.fn<TenantAPI["getStatus"]>().mockResolvedValue({
        success: false,
        managed: false,
        disabledServers: [],
        disabledPermissionKinds: [],
        forcePrompt: false,
        disabledModels: [],
        disableHeartbeat: false,
        disableAutomations: false,
        disabledProviders: [],
        restrictToWorkspace: false,
        browserEgressBlockedOrigins: [],
      }),
    };
    const { result } = renderHook(() => useTenantPolicy(), { wrapper: createWrapper() });
    // Still returns defaults — the hook should not throw
    await waitFor(() => expect(result.current.managed).toBe(false));
    expect(result.current.disabledServers).toEqual([]);
  });

  it("isServerDisabledByTenant checks against disabledServers (mapped to UI names)", async () => {
    window.tenantAPI = {
      getStatus: vi.fn<TenantAPI["getStatus"]>().mockResolvedValue({
        success: true,
        managed: true,
        disabledServers: ["ExampleMcp", "filesystem"],
        disabledPermissionKinds: [],
        forcePrompt: false,
        disabledModels: [],
        disableHeartbeat: false,
        disableAutomations: false,
        disabledProviders: [],
        restrictToWorkspace: false,
        browserEgressBlockedOrigins: [],
      }),
    };
    const { result } = renderHook(() => useTenantPolicy(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.managed).toBe(true));
    // "filesystem" config key maps to "File System Access" UI name
    expect(result.current.isServerDisabledByTenant("File System Access")).toBe(true);
    // "ExampleMcp" is the same in both
    expect(result.current.isServerDisabledByTenant("ExampleMcp")).toBe(true);
    // Non-disabled server
    expect(result.current.isServerDisabledByTenant("Browser Control and Web Browsing")).toBe(false);
  });

  it("exposes disabledModels from the API", async () => {
    window.tenantAPI = {
      getStatus: vi.fn<TenantAPI["getStatus"]>().mockResolvedValue({
        success: true,
        managed: true,
        disabledServers: [],
        disabledPermissionKinds: [],
        forcePrompt: false,
        disabledModels: ["o3-mini", "gpt-5"],
        disableHeartbeat: false,
        disableAutomations: false,
        disabledProviders: [],
        restrictToWorkspace: false,
        browserEgressBlockedOrigins: [],
      }),
    };
    const { result } = renderHook(() => useTenantPolicy(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.managed).toBe(true));
    expect(result.current.disabledModels).toEqual(["o3-mini", "gpt-5"]);
  });

  it("exposes disableHeartbeat and disableAutomations from the API", async () => {
    window.tenantAPI = {
      getStatus: vi.fn<TenantAPI["getStatus"]>().mockResolvedValue({
        success: true,
        managed: true,
        disabledServers: [],
        disabledPermissionKinds: [],
        forcePrompt: false,
        disabledModels: [],
        disableHeartbeat: true,
        disableAutomations: true,
        disabledProviders: [],
        restrictToWorkspace: false,
        browserEgressBlockedOrigins: [],
      }),
    };
    const { result } = renderHook(() => useTenantPolicy(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.managed).toBe(true));
    expect(result.current.disableHeartbeat).toBe(true);
    expect(result.current.disableAutomations).toBe(true);
  });

  it("defaults Phase 3 fields to safe values when not present", async () => {
    window.tenantAPI = {
      getStatus: vi.fn<TenantAPI["getStatus"]>().mockResolvedValue({
        success: true,
        managed: false,
        disabledServers: [],
        disabledPermissionKinds: [],
        forcePrompt: false,
        disabledModels: [],
        disableHeartbeat: false,
        disableAutomations: false,
        disabledProviders: [],
        restrictToWorkspace: false,
        browserEgressBlockedOrigins: [],
      }),
    };
    const { result } = renderHook(() => useTenantPolicy(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.disabledModels).toEqual([]));
    expect(result.current.disableHeartbeat).toBe(false);
    expect(result.current.disableAutomations).toBe(false);
  });

  it("isPending is false after data resolves", async () => {
    window.tenantAPI = {
      getStatus: vi.fn<TenantAPI["getStatus"]>().mockResolvedValue({
        success: true,
        managed: false,
        disabledServers: [],
        disabledPermissionKinds: [],
        forcePrompt: false,
        disabledModels: [],
        disableHeartbeat: false,
        disableAutomations: false,
        disabledProviders: [],
        restrictToWorkspace: false,
        browserEgressBlockedOrigins: [],
      }),
    };
    const { result } = renderHook(() => useTenantPolicy(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isPending).toBe(false));
  });

  it("isPending stays false while the query is in flight", () => {
    window.tenantAPI = {
      getStatus: vi.fn<TenantAPI["getStatus"]>().mockReturnValue(new Promise(() => {})), // never resolves
    };
    const { result } = renderHook(() => useTenantPolicy(), { wrapper: createWrapper() });
    expect(result.current.isPending).toBe(false);
  });
});
