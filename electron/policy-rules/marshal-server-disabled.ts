import type { ApprovalRequest } from "../backend/types";
import type { PolicyContext, PolicyRule, RuleResult } from "./types";

function applyMarshalServerDisabled(
  _request: ApprovalRequest,
  ctx: PolicyContext,
): RuleResult | null {
  if (ctx.serverConfig?.enabled === false) {
    return { decision: "deny", auditOutcome: "denied", sdkResult: "denied-by-rules" };
  }
  return null;
}

export const SERVER_DISABLED_RULE: PolicyRule = {
  id: "server-disabled",
  auditSource: "policy-auto-deny",
  apply: applyMarshalServerDisabled,
};
