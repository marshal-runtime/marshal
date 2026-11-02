import type { ApprovalRequest } from "../backend/types";
import { getCommandText, getServerName } from "../permission-policy";
import type { PolicyContext, PolicyRule, RuleResult } from "./types";

function applyMarshalBackgroundDeny(
  request: ApprovalRequest,
  ctx: PolicyContext,
): RuleResult | null {
  if (!ctx.sessionDenyPrompt.has(request.sessionId)) return null;

  const detail = getCommandText(request) || getServerName(request) || request.kind;
  ctx.onDenyPromptCallback?.(request.sessionId, request.kind, detail);
  return { decision: "deny", auditOutcome: "denied", sdkResult: "denied-by-rules" };
}

export const BACKGROUND_DENY_RULE: PolicyRule = {
  id: "background-deny",
  auditSource: "policy-auto-deny",
  apply: applyMarshalBackgroundDeny,
};
