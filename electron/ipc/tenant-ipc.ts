import type { TenantPolicyProvider } from "../tenant-policy";
import type { IpcDeps } from "./types";

export function registerTenantHandlers({
  ipcHandle,
  tenantPolicyProvider,
}: Pick<IpcDeps, "ipcHandle"> & {
  tenantPolicyProvider: Pick<TenantPolicyProvider, "get" | "isTenantManaged">;
}) {
  ipcHandle("tenant:getStatus", () => {
    const policy = tenantPolicyProvider.get();
    return {
      success: true,
      managed: tenantPolicyProvider.isTenantManaged(),
      disabledServers: policy.disabledServers ?? [],
      disabledPermissionKinds: policy.disabledPermissionKinds ?? [],
      forcePrompt: policy.forcePrompt ?? false,
      disabledModels: policy.disabledModels ?? [],
      disableHeartbeat: policy.disableHeartbeat ?? false,
      disableAutomations: policy.disableAutomations ?? false,
      disabledProviders: policy.disabledProviders ?? [],
      restrictToWorkspace: policy.restrictToWorkspace ?? false,
      browserEgressBlockedOrigins: policy.browserEgressBlockedOrigins ?? [],
    };
  });
}
