import type { PermissionsConfig } from "../../common/marshal-ipc-contract";
import type { ApprovalRequest } from "../backend/types";
import type { TenantPolicyProvider } from "../tenant-policy";
import { testDouble } from "../testing/harness";
import type { PolicyContext } from "./types";

export { testDouble };
export type { TenantPolicyProvider };

const BASE_PERMISSIONS: PermissionsConfig = {
  autoApproveReadOnly: false,
  allow: [],
  tools: {},
  servers: {
    filesystem: { enabled: true, autoApprove: true },
    playwright: { enabled: true, autoApprove: false },
    shell: { enabled: true, autoApprove: false },
  },
};

export function makeCtx(
  overrides: Omit<Partial<PolicyContext>, "permissions"> & {
    permissions?: Partial<PermissionsConfig>;
  } = {},
): PolicyContext {
  const { permissions: permOverride, ...rest } = overrides;
  return {
    permissions: {
      ...BASE_PERMISSIONS,
      ...permOverride,
      servers: { ...BASE_PERMISSIONS.servers, ...permOverride?.servers },
    },
    effectiveServerName: "shell",
    serverConfig: undefined,
    tenantPolicy: undefined,
    allowAllMode: false,
    unattendedSessions: new Set(),
    sessionDenyPrompt: new Set(),
    onDenyPromptCallback: undefined,
    workspaceDir: undefined,
    ...rest,
  };
}

export function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return testDouble<ApprovalRequest>({
    id: "r1",
    sessionId: "s1",
    kind: "shell",
    toolCallId: undefined,
    command: "ls",
    serverName: "",
    intention: undefined,
    warning: undefined,
    commandIdentifiers: [],
    ...overrides,
  });
}
