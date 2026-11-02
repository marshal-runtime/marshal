import type { TenantPolicyStatus } from "@common/marshal-ipc-contract";
import { CONFIG_KEY_TO_DISPLAY_NAME } from "@common/marshal-permission-servers";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

function toUiName(configKey: string): string {
  return CONFIG_KEY_TO_DISPLAY_NAME[configKey] ?? configKey;
}

/** Renderer-side tenant policy status — extends the IPC response with UI helpers. */
interface TenantPolicyHookResult extends Omit<TenantPolicyStatus, "success"> {
  /** Check if a server (by UI name) is disabled by tenant policy. */
  isServerDisabledByTenant: (uiName: string) => boolean;
  isPending: boolean;
}

const UNMANAGED: TenantPolicyHookResult = {
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
  isPending: false,
  isServerDisabledByTenant: () => false,
};

export function useTenantPolicy(): TenantPolicyHookResult {
  const queryClient = useQueryClient();

  // Invalidate cache when main process signals a policy change (periodic refresh)
  useEffect(() => {
    const cleanup = window.tenantAPI?.onPolicyChanged?.(() => {
      void queryClient.invalidateQueries({ queryKey: ["tenant-policy"] });
    });
    return cleanup;
  }, [queryClient]);

  const { data } = useQuery({
    queryKey: ["tenant-policy"],
    queryFn: async () => {
      if (!window.tenantAPI) return null;
      const result = await window.tenantAPI.getStatus();
      if (!result.success) return null;
      return result;
    },
    staleTime: Infinity, // Refetched only when policyChanged event fires
    retry: 0, // handler is synchronous — IPC errors are not transient
  });

  // Never surface the loading state: tenant policy must not block the UI while it loads.
  if (!data) return { ...UNMANAGED, isPending: false };

  // Convert config keys to UI names for the renderer
  const uiDisabledServers = data.disabledServers.map(toUiName);

  return {
    managed: data.managed,
    disabledServers: uiDisabledServers,
    disabledPermissionKinds: data.disabledPermissionKinds,
    forcePrompt: data.forcePrompt,
    disabledModels: data.disabledModels ?? [],
    disableHeartbeat: data.disableHeartbeat ?? false,
    disableAutomations: data.disableAutomations ?? false,
    disabledProviders: data.disabledProviders ?? [],
    restrictToWorkspace: data.restrictToWorkspace ?? false,
    browserEgressBlockedOrigins: data.browserEgressBlockedOrigins ?? [],
    isPending: false,
    isServerDisabledByTenant: (uiName: string) => uiDisabledServers.includes(uiName),
  };
}
