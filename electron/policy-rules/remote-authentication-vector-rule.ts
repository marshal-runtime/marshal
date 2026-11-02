// Ownership: remote authentication vector policy rule.
import type { ApprovalRequest } from "../backend/types";
import { getCommandText } from "../permission-policy";
import { hasRemoteAuthVector } from "../remote-auth-permission-guard";
import type { PolicyContext, PolicyRule, RuleResult } from "./types";

export const REMOTE_AUTH_VECTOR_RULE: PolicyRule = {
  id: "remote-auth-vector",
  auditSource: "policy-security-gate",
  apply(request: ApprovalRequest, ctx: PolicyContext): RuleResult | null {
    if (request.kind !== "shell") return null;

    const command = getCommandText(request);
    if (!hasRemoteAuthVector(command)) return null;

    const isBackground = ctx.sessionDenyPrompt.has(request.sessionId);
    if (isBackground) {
      ctx.onDenyPromptCallback?.(request.sessionId, request.kind, command);
      return { decision: "deny", auditOutcome: "denied", sdkResult: "denied-by-rules" };
    }

    return { decision: "prompt", auditOutcome: "denied", sdkResult: "denied-by-rules" };
  },
};
