import { createLogger } from "../../../common/marshal-logger";
import type { CommandClassification } from "../../permission-classification-contracts";
import { applyGuardrails } from "../../permission-pattern-guardrails";
import { extractPattern } from "../../permission-patterns";
import { getCommandText, isReadOnlyCommand } from "../../permission-policy";
import type { PolicyEvaluation } from "../../permission-policy";
import type { IApprovalBroker, ICommandClassifier, IPermissionPolicy } from "../ports";
import type { ApprovalDecision, ApprovalRequest, ApprovalResult } from "../types";

const log = createLogger("permission-classifier:adapter");
const DECISION_APPROVE: ApprovalDecision = "approved";
const DECISION_DENY_RULES: ApprovalDecision = "denied-by-rules";
const DECISION_REJECT: ApprovalDecision = "denied-interactively-by-user";

/**
 * Local-runtime glue between the runtime permission callback
 * and the shared ApprovalBroker.
 *
 * Responsibilities:
 *  - canShowUI gate (Electron window availability)
 *  - policy.evaluate() dispatch
 *  - Pre-compute LLM explanation for unknown shell commands
 *  - policy.recordInteractiveOutcome() after user responds
 *  - policy.logInfraFailure() on timeout / no-window
 *
 * All presentation (formatting, tooltips, buttons, card creation) is
 * the PermissionCardManager's job — it subscribes to broker events.
 *
 * GatewayBackend does not use this adapter. It calls
 * broker.requestPrompt() directly from DesktopCapabilities.
 */
export function createApprovalCallbackAdapter(deps: {
  broker: IApprovalBroker;
  policy: IPermissionPolicy;
  classifier: ICommandClassifier;
  canShowUI: () => boolean;
}): (request: ApprovalRequest) => Promise<ApprovalResult> {
  const { broker, policy, classifier, canShowUI } = deps;

  return async (request: ApprovalRequest): Promise<ApprovalResult> => {
    // Gate: if no window is available, deny immediately
    if (!canShowUI()) {
      policy.logInfraFailure(request, "no-window");
      return DECISION_DENY_RULES;
    }

    // Policy evaluation. Prefer evaluateDetailed so a hard policy deny can carry
    // an actionable reason to the model; fall back to evaluate() when the policy
    // implementation does not provide it.
    const evaluation: PolicyEvaluation = policy.evaluateDetailed
      ? policy.evaluateDetailed(request)
      : { decision: policy.evaluate(request) };
    if (evaluation.decision === "approve") return DECISION_APPROVE;
    if (evaluation.decision === "deny") {
      // A policy/security hard-deny is NOT a "couldn't find an approver"
      // situation. Surface the real reason via reject+feedback so the model
      // adapts instead of looping on the generic user-not-available message.
      return evaluation.denyReason
        ? { kind: "denied-by-policy-with-feedback", feedback: evaluation.denyReason }
        : DECISION_DENY_RULES;
    }

    // PRIMARY (sync): heuristic pattern + guardrails run synchronously so the
    // permission card can render immediately. Primary action's stored pattern
    // is locked here — the async classifier never mutates it. The user can
    // always trust the button label they see matches the rule that will be
    // stored. Safety invariant: primary mutation hazards (user glances at a
    // label, clicks quickly, LLM resolves between glance and click with a
    // different pattern) are eliminated by never changing approvalPattern
    // after requestPrompt is called.
    if (request.kind === "shell") {
      const cmd = getCommandText(request);
      if (cmd) {
        const heuristic = extractPattern(cmd);
        const gated = applyGuardrails(
          cmd,
          {
            explanation: "",
            category: "unknown",
            suggestedPattern: heuristic,
            patternRationale: null,
            source: "fallback",
            guardrailRuleId: null,
          },
          { isReadOnlyCommand },
        );
        if (gated.suggestedPattern) {
          request.approvalPattern = gated.suggestedPattern;
        }
      }
    }

    // Prompt the user NOW without waiting for the classifier. Card renders
    // with the heuristic primary; the classifier fires in parallel below.
    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const promptPromise = broker.requestPrompt({
      permissionRequest: request,
      requestId,
      sessionId: request.sessionId,
    });

    // SECONDARY (async): classifier runs in parallel. If it finishes before
    // the card is resolved and produces something useful, report it through
    // the broker — card manager patches the card with a secondary suggestion.
    // Never touches request.approvalPattern (primary is locked).
    void (async () => {
      try {
        const classification = await tryClassifyForPermission(request, classifier);
        if (!classification) return;
        if (!broker.hasPending(requestId)) return;
        broker.reportClassification(requestId, classification);
      } catch (err) {
        log.warn("background classifier failed", { error: String(err) });
      }
    })();

    const result = await promptPromise;

    // Handle result
    if (result.outcome === "timed-out") {
      policy.logInfraFailure(request, "timeout");
      return DECISION_DENY_RULES;
    }

    const action = result.action;
    const isApproved =
      action === "allow" ||
      action === "allow-type" ||
      action === "allow-all" ||
      action === "allow-session" ||
      action === "always-allow";
    const sdkResult = buildSdkDecisionForAction(isApproved);
    // Silent resolves come from the burst defuser, which has already emitted
    // a dedicated `policy-burst-defuser` audit row. Calling
    // recordInteractiveOutcome here would write a second row attributing
    // the action to a `user-interactive` click that never happened.
    if (!result.silent) {
      const accepted = policy.recordInteractiveOutcome(request, action, sdkResult);
      if (isApproved && !accepted) return DECISION_DENY_RULES;
    } else if (isApproved && policy.evaluate(request) === "deny") {
      return DECISION_DENY_RULES;
    }
    return sdkResult;
  };
}

function buildSdkDecisionForAction(isApproved: boolean): ApprovalDecision {
  if (!isApproved) return DECISION_REJECT;
  return DECISION_APPROVE;
}

/** Classify a shell command so the permission card can broaden the
 *  "Always allow" pattern and tag the risk category. Runs for every shell
 *  command with a non-empty command string — the SDK's own purpose
 *  description (e.g. "Extract key PR details") does NOT preempt this, because
 *  classification is about generating a PATTERN, not a description. The card
 *  manager keeps preferring the SDK description for the card's message text. */
async function tryClassifyForPermission(
  request: ApprovalRequest,
  classifier: ICommandClassifier,
): Promise<CommandClassification | undefined> {
  if (request.kind !== "shell") {
    log.info("skip", { reason: "non-shell", kind: request.kind });
    return undefined;
  }
  const command = getCommandText(request);
  if (!command) {
    log.info("skip", { reason: "empty-command" });
    return undefined;
  }
  return classifier.classifyForPermission(command);
}
