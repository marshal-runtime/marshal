// Ownership: configured pattern whitelist policy rule.
import type { ApprovalRequest } from "../backend/types";
import {
  allSegmentsMatchAllowPatterns,
  getPatternKey,
  matchesAllowPattern,
} from "../permission-patterns";
import { getCommandText } from "../permission-policy";
import type { PolicyContext, PolicyRule, RuleResult } from "./types";

export const PATTERN_WHITELIST_RULE: PolicyRule = {
  id: "pattern-whitelist",
  auditSource: "policy-auto-approve",
  apply(request: ApprovalRequest, ctx: PolicyContext): RuleResult | null {
    const allow = ctx.permissions.allow;
    if (!allow || allow.length === 0) return null;

    let matched = false;

    if (request.kind === "shell") {
      // Shell: split compound commands and check each segment against allow list.
      const command = getCommandText(request);
      if (command) {
        matched = allSegmentsMatchAllowPatterns(command, allow);
      }
    } else {
      // Non-shell: match pattern key against allow list
      const patternKey = getPatternKey(request);
      if (!patternKey) return null;
      matched = allow.some((pattern) => matchesAllowPattern(patternKey, pattern));
    }

    if (matched) {
      return { decision: "approve", auditOutcome: "approved" };
    }

    return null;
  },
};
