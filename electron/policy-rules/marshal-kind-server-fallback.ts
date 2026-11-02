import type { ApprovalRequest } from "../backend/types";
import { KIND_TO_MCP_TOOLS, KIND_TO_SERVER_FALLBACK } from "./permission-kind-mappings";
import type { PolicyContext, PolicyRule, RuleResult } from "./types";

function applyMarshalKindServerFallback(
  request: ApprovalRequest,
  ctx: PolicyContext,
): RuleResult | null {
  const fallbackServer = KIND_TO_SERVER_FALLBACK[request.kind];
  if (!fallbackServer) return null;
  if (ctx.effectiveServerName !== fallbackServer) return null;

  const tools = ctx.permissions.tools;
  const groupApproved = tools[`mcp:${fallbackServer}`];
  const toolApproved = KIND_TO_MCP_TOOLS[request.kind]?.some((key) => tools[key]);

  if (groupApproved || toolApproved) {
    return { decision: "approve", auditOutcome: "approved" };
  }

  return null;
}

export const KIND_SERVER_FALLBACK_RULE: PolicyRule = {
  id: "kind-server-fallback",
  auditSource: "policy-auto-approve",
  apply: applyMarshalKindServerFallback,
};
