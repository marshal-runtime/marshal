import type { ApprovalRequest } from "../backend/types";
import { isPathUnderAnyDir, isPathWithinDir } from "../permission-path-scope";
import type { PolicyContext, PolicyRule, RuleResult } from "./types";

/**
 * Gates SDK read/write tools whose resolved path is OUTSIDE the workspace.
 * In-workspace access is decided by earlier rules; this rule:
 *   - denies (no card) under tenant restrictToWorkspace,
 *   - approves under explicit allow-all mode (Autopilot / trusted orchestration),
 *   - approves when the path is under a folder granted for that scope,
 *   - otherwise forces the prompt card (so a blanket server/tool auto-approve
 *     cannot silently bypass the out-of-workspace boundary).
 * Read and write grants are independent scopes.
 */
export const FOLDER_GRANT_RULE: PolicyRule = {
  id: "folder-grant",
  auditSource: "policy-security-gate",
  apply(request: ApprovalRequest, ctx: PolicyContext): RuleResult | null {
    if (request.kind !== "read" && request.kind !== "write") return null;
    if (!ctx.workspaceDir || !request.path) return null;

    // includeSelf so a read of the workspace root itself counts as inside and is
    // never routed to a folder grant — matches isOutsideWorkspace in recordDecision.
    if (isPathWithinDir(request.path, ctx.workspaceDir, { includeSelf: true })) return null;

    if (ctx.tenantPolicy?.get()?.restrictToWorkspace) {
      return { decision: "deny", auditOutcome: "denied", sdkResult: "denied-by-rules" };
    }

    if (ctx.allowAllMode) {
      return { decision: "approve", auditOutcome: "approved", sdkResult: "approved" };
    }

    const grants =
      request.kind === "read"
        ? (ctx.permissions.allowedReadFolders ?? [])
        : (ctx.permissions.allowedWriteFolders ?? []);
    if (isPathUnderAnyDir(request.path, grants)) {
      return { decision: "approve", auditOutcome: "approved" };
    }

    return { decision: "prompt", auditOutcome: undefined };
  },
};
