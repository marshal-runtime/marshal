import type { ApprovalRequest } from "../backend/types";
import type { PolicyContext, PolicyRule, RuleResult } from "./types";

function applyMarshalTenantForcePrompt(
  _request: ApprovalRequest,
  ctx: PolicyContext,
): RuleResult | null {
  if (ctx.tenantPolicy?.get().forcePrompt) {
    // No audit from this rule — user-interactive path logs later.
    return { decision: "prompt", auditOutcome: undefined };
  }
  return null;
}

export const TENANT_FORCE_PROMPT_RULE: PolicyRule = {
  id: "tenant-force-prompt",
  auditSource: "policy-auto-deny",
  apply: applyMarshalTenantForcePrompt,
};
