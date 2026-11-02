// Ownership: read tool auto-approval policy rule.
import path from "node:path";

import type { ApprovalRequest } from "../backend/types";
import type { PolicyContext, PolicyRule, RuleResult } from "./types";

export const READ_AUTO_APPROVE_RULE: PolicyRule = {
  id: "read-auto-approve",
  auditSource: "policy-auto-approve",
  apply(request: ApprovalRequest, ctx: PolicyContext): RuleResult | null {
    if (request.kind !== "read") return null;

    const servers = ctx.permissions.servers;
    const fsConfig = "filesystem" in servers ? servers["filesystem"] : undefined;
    if (fsConfig?.enabled === false) {
      return { decision: "deny", auditOutcome: "denied", sdkResult: "denied-by-rules" };
    }

    // SDK read tools bypass the MCP's allowedDirectories; enforce the same boundary here.
    // path.resolve normalizes ".." but doesn't follow symlinks — same as the filesystem MCP.
    if (ctx.workspaceDir && request.path) {
      const resolved = path.resolve(request.path);
      const wsPrefix = path.resolve(ctx.workspaceDir) + path.sep;
      const insideWorkspace =
        process.platform === "win32"
          ? resolved.toLowerCase().startsWith(wsPrefix.toLowerCase())
          : resolved.startsWith(wsPrefix);
      if (!insideWorkspace) {
        // Fall through so persisted read approvals can short-circuit later.
        // Sensitive paths are already gated earlier.
        return null;
      }
    }

    return { decision: "approve", auditOutcome: "approved" };
  },
};
