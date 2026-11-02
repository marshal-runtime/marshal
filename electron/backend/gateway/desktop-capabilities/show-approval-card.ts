/**
 * DesktopCapabilities RPC #3 — `showApprovalCard`.
 *
 * Wraps `ApprovalBroker.requestPrompt` and bridges the broker's `PromptResult`
 * (`{outcome:"resolved", action: PermissionAction}` | `{outcome:"timed-out"}`)
 * into the spec's `ApprovalCardDecision` (`{action, rememberFor?}`).
 *
 * The handler re-runs local policy before surfacing UI. This makes the direct
 * `showApprovalCard` route robust to settings changes or cloud-side misses:
 * local auto-approve/deny decisions short-circuit without a card, while
 * `prompt` flows through the broker. On a resolved prompt, calls
 * `policy.recordInteractiveOutcome(...)`. The copilot path goes through
 * `createApprovalCallbackAdapter` which records on its behalf; the gateway
 * has no such adapter, so the handler does it directly.
 *
 * Spec: docs/specs/gateway-automations-phase-2b-design.md §5.1 (RPC #3).
 */

import type { PermissionAction } from "../../../../common/marshal-constants";
import { canonicalizeFirstPartyToolName } from "../../../../common/tool-names";
import type { IApprovalBroker, IPermissionPolicy } from "../../ports";
import type { ApprovalRequest } from "../../types";
import type { ApprovalCardDecision, ApprovalCardRequest } from "../../types";

function buildApprovalApprovalRequest(request: ApprovalCardRequest): ApprovalRequest {
  const base = { id: request.requestId, sessionId: request.sessionId, toolCallId: undefined };
  // SF-4: toolArgs from trusted internal RPC, not user input — narrowing to Record<string, unknown> is safe
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- object check above guards the cast
  const toolArgs: Record<string, unknown> = (
    request.toolArgs && typeof request.toolArgs === "object" && !Array.isArray(request.toolArgs)
      ? request.toolArgs
      : {}
  ) as Record<string, unknown>;
  if (request.kind === "shell") {
    return {
      ...base,
      kind: "shell" as const,
      command: request.toolName,
      serverName: request.serverName ?? "",
      intention: undefined,
      warning: undefined,
      commandIdentifiers: [],
    };
  }
  if (request.kind === "mcp") {
    return {
      ...base,
      kind: "mcp" as const,
      toolName: request.toolName,
      serverName: request.serverName,
      toolTitle: undefined,
      toolDescription: undefined,
      toolArgs,
      readOnly: false,
    };
  }
  if (request.kind === "custom-tool") {
    return {
      ...base,
      kind: "custom-tool" as const,
      toolName: canonicalizeFirstPartyToolName(request.toolName),
      toolDescription: undefined,
      toolArgs,
      intention: undefined,
      warning: undefined,
      commandIdentifiers: [],
    };
  }
  // Unhandled kind: fail loudly so future gateway additions surface immediately
  // rather than silently misfiring the wrong policy rules.
  throw new Error(
    `buildApprovalApprovalRequest: unhandled kind "${request.kind}" — add an explicit case`,
  );
}

export interface ShowApprovalCardDeps {
  /** Narrow `IApprovalBroker` port — only `requestPrompt` is called. */
  broker: IApprovalBroker;
  /** Narrow `IPermissionPolicy` port — evaluates policy and records prompt outcomes. */
  policy: IPermissionPolicy;
}

export function makeShowApprovalCardHandler(deps: ShowApprovalCardDeps) {
  const { broker, policy } = deps;

  return async function showApprovalCard(
    request: ApprovalCardRequest,
  ): Promise<ApprovalCardDecision> {
    // Use the cloud-supplied requestId as the local ApprovalRequest.id so
    // audit-log entries from `recordInteractiveOutcome` are correlatable
    // back to the originating cloud RPC.
    const permissionRequest = buildApprovalApprovalRequest(request);
    const policyDecision = policy.evaluate(permissionRequest);
    if (policyDecision === "approve") return { action: "approve" };
    if (policyDecision === "deny") return { action: "deny" };

    const result = await broker.requestPrompt({
      requestId: request.requestId,
      sessionId: request.sessionId,
      permissionRequest,
    });

    // Timeout: treat as deny (user was given the card and didn't act). Don't
    // call recordInteractiveOutcome — the policy distinguishes timeout-deny
    // (logInfraFailure) from user-deny but the gateway's RPC contract
    // collapses both into `{action: "deny"}` for v0.
    if (result.outcome === "timed-out") {
      return { action: "deny" };
    }

    const action = result.action;
    const isApproved = isApproveAction(action);
    const sdkResult = isApproved ? "approved" : "denied-interactively-by-user";
    const accepted = policy.recordInteractiveOutcome(permissionRequest, action, sdkResult);

    if (!isApproved || !accepted) return { action: "deny" };

    const rememberFor = rememberForFromAction(action);
    return rememberFor ? { action: "approve", rememberFor } : { action: "approve" };
  };
}

/**
 * Approve actions in PermissionAction:
 *   - "allow"           → approve once (no remember)
 *   - "allow-session"   → remember for session
 *   - "always-allow"    → remember forever
 *   - "allow-type"      → legacy no-op (treated as approve once)
 *   - "allow-all"       → legacy no-op (treated as approve once)
 *
 * "deny" is the only deny variant.
 */
function isApproveAction(action: PermissionAction): boolean {
  return (
    action === "allow" ||
    action === "allow-type" ||
    action === "allow-all" ||
    action === "allow-session" ||
    action === "always-allow"
  );
}

function rememberForFromAction(action: PermissionAction): "session" | "always" | undefined {
  if (action === "allow-session") return "session";
  if (action === "always-allow") return "always";
  return undefined;
}
