// Ownership: read-only tool auto-approval policy rule.
import type { ApprovalRequest } from "../backend/types";
import {
  getCommandText,
  getToolName,
  isReadOnlyCommand,
  isReadOnlyCustomTool,
  isUnattendedSafeCustomTool,
} from "../permission-policy";
import type { PolicyContext, PolicyRule, RuleResult } from "./types";

export const READ_ONLY_AUTO_APPROVE_RULE: PolicyRule = {
  id: "read-only-auto-approve",
  auditSource: "policy-auto-approve",
  apply(request: ApprovalRequest, ctx: PolicyContext): RuleResult | null {
    if (!ctx.permissions.autoApproveReadOnly) return null;

    let toolIsApproved = false;

    if (request.kind === "shell") {
      toolIsApproved = isReadOnlyCommand(getCommandText(request));
    } else if (request.kind === "custom-tool") {
      const toolName = getToolName(request);
      toolIsApproved = ctx.unattendedSessions.has(request.sessionId)
        ? isUnattendedSafeCustomTool(toolName)
        : isReadOnlyCustomTool(toolName);
    }

    if (toolIsApproved) {
      return { decision: "approve", auditOutcome: "approved" };
    }

    return null;
  },
};
