// Owns the shell deny-pattern policy rule.

import type { ApprovalRequest } from "../backend/types";
import {
  isUnsafeShellSyntax,
  matchesDenyPattern,
  splitShellSegments,
} from "../permission-patterns";
import { getCommandText } from "../permission-policy";
import type { PolicyContext, PolicyRule, RuleResult } from "./types";

export const SHELL_DENY_PATTERN_RULE: PolicyRule = {
  id: "shell-deny-pattern",
  auditSource: "policy-auto-deny",
  apply(request: ApprovalRequest, ctx: PolicyContext): RuleResult | null {
    if (request.kind !== "shell") return null;

    const denyPatterns = ctx.permissions.denyPatterns;
    if (!denyPatterns || denyPatterns.length === 0) return null;

    const command = getCommandText(request);
    if (!command) return null;

    if (isUnsafeShellSyntax(command)) {
      return { decision: "deny", auditOutcome: "denied", sdkResult: "denied-by-rules" };
    }

    const split = splitShellSegments(command);
    const anyDenied = split.segments.some((seg) =>
      denyPatterns.some((p) => matchesDenyPattern(seg, p)),
    );

    if (anyDenied) {
      return { decision: "deny", auditOutcome: "denied", sdkResult: "denied-by-rules" };
    }

    return null;
  },
};
