// Owns the sensitive-path access gate policy rule.

import type { ApprovalRequest } from "../backend/types";
import { checkSensitivePath } from "../sensitive-path-permission-guard";
import type { PolicyContext, PolicyRule, RuleResult } from "./types";

export const SENSITIVE_PATH_GATE_RULE: PolicyRule = {
  id: "sensitive-path-gate",
  auditSource: "policy-security-gate",
  apply(request: ApprovalRequest, ctx: PolicyContext): RuleResult | null {
    // SDK-origin writes that are NOT paired with a concurrent kind:mcp request need to run
    // the sensitive-path gate. Pairing is detected by the absence of a toolCallId: MCP-paired
    // writes arrive without one (the CLI omits toolCallId for MCP permission requests), while
    // direct SDK writes (edit/create via the "ask" pre-hook gate) have a toolCallId
    // resolved from the execution_start queue. Skip only the MCP-paired case to avoid
    // double-gating; always run for synthesized-browser and direct SDK writes.
    if (request.kind === "write" && request.origin === "sdk" && !request.toolCallId) return null;

    if (checkSensitivePath(request, ctx.permissions.allowedSensitivePaths ?? []) !== null) {
      return { decision: "prompt", auditOutcome: "denied", sdkResult: "denied-by-rules" };
    }

    return null;
  },
};
