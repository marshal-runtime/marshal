// Ownership: configured server auto-approval policy rule.
import { BUILTIN_SHELL_SERVERS } from "../../common/marshal-permission-servers";
import type { ApprovalRequest } from "../backend/types";
import { getCommandText, isSingleShellInvocation } from "../permission-policy";
import type { PolicyContext, PolicyRule, RuleResult } from "./types";

export const SERVER_AUTO_APPROVE_RULE: PolicyRule = {
  id: "server-auto-approve",
  auditSource: "policy-auto-approve",
  apply(request: ApprovalRequest, ctx: PolicyContext): RuleResult | null {
    if (ctx.serverConfig?.autoApprove !== true) return null;

    const isBuiltinShell =
      request.kind === "shell" && BUILTIN_SHELL_SERVERS.has(ctx.effectiveServerName);

    if (isBuiltinShell) {
      const command = getCommandText(request);
      if (!isSingleShellInvocation(command)) return null;
    }

    return { decision: "approve", auditOutcome: "approved" };
  },
};
