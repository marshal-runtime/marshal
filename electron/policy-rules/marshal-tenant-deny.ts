import type { ApprovalRequest } from "../backend/types";
import type { PolicyContext, PolicyRule, RuleResult } from "./types";

function applyMarshalTenantDeny(
  request: ApprovalRequest,
  ctx: PolicyContext,
): RuleResult | null {
  const policy = ctx.tenantPolicy?.get();
  if (!policy) return null;

  if (policy.disabledPermissionKinds?.includes(request.kind)) {
    return { decision: "deny", auditOutcome: "denied", sdkResult: "denied-by-rules" };
  }

  if (request.kind === "mcp" && policy.disabledServers?.length) {
    const serverName = request.serverName ?? "";
    if (serverName && policy.disabledServers.includes(serverName)) {
      return { decision: "deny", auditOutcome: "denied", sdkResult: "denied-by-rules" };
    }
  }

  return null;
}

export const TENANT_DENY_RULE: PolicyRule = {
  id: "tenant-deny",
  auditSource: "policy-auto-deny",
  apply: applyMarshalTenantDeny,
};
