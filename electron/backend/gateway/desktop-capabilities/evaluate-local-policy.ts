/**
 * DesktopCapabilities RPC #2 — `evaluateLocalPolicy`.
 *
 * Wraps `PermissionPolicy.evaluate`. The class returns the string literals
 * `"approve" | "deny" | "prompt"`; the RPC wire shape is the union object
 * `PolicyDecision`. This module bridges the two.
 *
 * The cloud's `LocalPolicyRequest` carries `kind` (PermissionKind), toolName,
 * serverName, and toolArgs. We construct a normalized `ApprovalRequest` here,
 * discriminated by `kind` so the policy's typed accessors work correctly.
 * `id` is a per-call random UUID so policy-internal lookups are unique.
 *
 * Spec: docs/specs/gateway-automations-phase-2b-design.md §5.1 (RPC #2).
 */

import { randomUUID } from "node:crypto";

import { canonicalizeFirstPartyToolName } from "../../../../common/tool-names";
import type { IPermissionPolicy } from "../../ports";
import type { ApprovalRequest } from "../../types";
import type { LocalPolicyRequest, PolicyDecision } from "../../types";

export interface EvaluateLocalPolicyDeps {
  /** Narrow `IPermissionPolicy` port — only `evaluate` is called here. */
  policy: IPermissionPolicy;
}

function buildApprovalRequest(request: LocalPolicyRequest): ApprovalRequest {
  const toolName =
    request.kind === "custom-tool"
      ? canonicalizeFirstPartyToolName(request.toolName)
      : request.toolName;
  const base = { id: randomUUID(), sessionId: request.sessionId, toolCallId: undefined };
  // SF-4: toolArgs from trusted internal RPC, not user input — narrowing to Record<string, unknown> is safe
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- object check above guards the cast
  const toolArgs: Record<string, unknown> = (
    request.toolArgs && typeof request.toolArgs === "object" && !Array.isArray(request.toolArgs)
      ? request.toolArgs
      : {}
  ) as Record<string, unknown>;

  switch (request.kind) {
    case "shell":
      return {
        ...base,
        kind: "shell",
        command: toolName,
        serverName: request.serverName ?? "",
        intention: undefined,
        warning: undefined,
        commandIdentifiers: [],
      };
    case "read":
      return { ...base, kind: "read", path: toolName };
    case "write":
      return {
        ...base,
        kind: "write",
        path: toolName,
        diff: null,
        intention: undefined,
        origin: "sdk" as const,
        browserToolName: undefined,
      };
    case "url":
      return { ...base, kind: "url", url: toolName, toolName };
    case "custom-tool":
      return {
        ...base,
        kind: "custom-tool",
        toolName,
        toolDescription: undefined,
        toolArgs,
        intention: undefined,
        warning: undefined,
        commandIdentifiers: [],
      };
    case "mcp":
    default:
      return {
        ...base,
        kind: "mcp",
        toolName,
        serverName: request.serverName,
        toolTitle: undefined,
        toolDescription: undefined,
        toolArgs,
        readOnly: false,
      };
  }
}

export function makeEvaluateLocalPolicyHandler(deps: EvaluateLocalPolicyDeps) {
  const { policy } = deps;

  return async function evaluateLocalPolicy(request: LocalPolicyRequest): Promise<PolicyDecision> {
    const permissionRequest = buildApprovalRequest(request);
    const decision = policy.evaluate(permissionRequest);

    if (decision === "approve") return { action: "approve" };
    if (decision === "prompt") return { action: "prompt" };
    // PermissionPolicy.evaluate returns just the literal "deny" — no specific
    // reason. The audit-log machinery records the reason internally
    // (tenant-deny / blocked-pattern / disabled-server) but doesn't surface
    // it here. v0 ships a generic message; can be enriched later by routing
    // the audit-log entry through.
    return { action: "deny", reason: "blocked by policy" };
  };
}
