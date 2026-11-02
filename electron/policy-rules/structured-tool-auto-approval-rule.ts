// Owns the structured-tool auto-approval policy rule.

import { getToolGroupKey } from "../../common/marshal-tool-registry";
import type { ApprovalRequest } from "../backend/types";
import { getPatternKey } from "../permission-patterns";
import type { PolicyContext, PolicyRule, RuleResult } from "./types";

export const STRUCTURED_TOOL_AUTO_APPROVE_RULE: PolicyRule = {
  id: "structured-tool-auto-approve",
  auditSource: "policy-auto-approve",
  apply(request: ApprovalRequest, ctx: PolicyContext): RuleResult | null {
    if (request.kind === "shell") return null;

    const toolKey = getPatternKey(request);
    if (!toolKey) return null;

    const tools = ctx.permissions.tools;

    if (toolKey in tools) {
      if (tools[toolKey]) {
        return { decision: "approve", auditOutcome: "approved" };
      }
      // Explicitly false — skip group check, continue to later steps
      return null;
    }

    // No tool-specific entry — check group key
    const groupKey = getToolGroupKey(toolKey);
    // Group key false = "not auto-approved" (same as absent). Does NOT actively block.
    if (groupKey && tools[groupKey]) {
      return { decision: "approve", auditOutcome: "approved" };
    }

    return null;
  },
};
