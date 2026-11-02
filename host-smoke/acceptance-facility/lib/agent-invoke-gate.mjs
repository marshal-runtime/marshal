// AGENT-STEP ACCEPTANCE-GATE repair (facfix, root/agent-step-2 — Codex-found 04:43, binding).
// 7cb059c12's scripts/agent-path-invoke.mjs wrote status="pass" for ANY successfully classified
// envelope, including unsupported-deny (the exact F-DEPLOY-4 failure shape) and provider-error — a
// classification-only pass is not proof of a real, expected agent-path invocation; it is
// indistinguishable from the class of defect this step exists to catch. This module is the STEP's
// gate: lib/agent-invoke-classification.mjs's classifier itself stays unchanged (it correctly told
// unsupported-deny apart from policy-deny all along — the defect was entirely in what the step did
// with that classification).
//
// A pass now requires BOTH:
//   (a) a provenance-bound runtime-receipt on the envelope — `receipts[0]` naming `receiptId`,
//       `executionId`, `target` (which must equal the declared capability), `scope`, and an ordered
//       `startedAt`/`completedAt` pair — proof a real invocation happened, not just a well-shaped
//       envelope an operator typed by hand;
//   (b) an operator-declared expected outcome (one of `EXPECTABLE_OUTCOMES`) that exactly matches
//       the classified outcome. `unsupported-deny` and `provider-error` are never expectable — they
//       are executed-and-defective shapes, not legitimate policy outcomes to declare and pass on —
//       so they always fail the gate regardless of what was declared.
// Missing/malformed provenance is a typed refusal (never a pass, never a fail): this lane cannot
// tell whether a real invocation happened at all, so it declines rather than guesses — the same
// no-guess discipline lib/live-connection.mjs's endpoint/page guards use.
import { classifyAgentInvokeOutcome } from "./agent-invoke-classification.mjs";

export const EXPECTABLE_OUTCOMES = Object.freeze(["policy-allow", "policy-ask", "policy-deny"]);

// The two shapes that are always executed-and-defective, never a legitimate declared expectation.
const DEFECT_OUTCOMES = Object.freeze(["unsupported-deny", "provider-error"]);

const REQUIRED_RECEIPT_STRING_FIELDS = Object.freeze([
  "receiptId",
  "executionId",
  "target",
  "startedAt",
  "completedAt",
]);

/**
 * Validates the runtime-receipt provenance an envelope must carry before a PASS is even possible.
 * Independent of `classifyAgentInvokeOutcome` — a well-formed, classifiable envelope with no bound
 * receipt is still not proof a real invocation happened.
 *
 * @param {string} capability the declared target capability (evidence.capability)
 * @param {unknown} envelope untrusted, same envelope `classifyAgentInvokeOutcome` reads
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateAgentInvokeProvenance(capability, envelope) {
  const receipts = envelope && typeof envelope === "object" ? envelope.receipts : undefined;
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return {
      ok: false,
      reason: "envelope.receipts is missing or empty — no runtime-receipt provenance to bind to.",
    };
  }
  const receipt = receipts[0];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { ok: false, reason: "envelope.receipts[0] is not an object." };
  }
  for (const field of REQUIRED_RECEIPT_STRING_FIELDS) {
    if (typeof receipt[field] !== "string" || !receipt[field].trim()) {
      return {
        ok: false,
        reason: `envelope.receipts[0].${field} is missing or not a non-empty string.`,
      };
    }
  }
  if (!receipt.scope || typeof receipt.scope !== "object" || Array.isArray(receipt.scope)) {
    return { ok: false, reason: "envelope.receipts[0].scope is missing or not an object." };
  }
  if (receipt.target !== capability) {
    return {
      ok: false,
      reason:
        `envelope.receipts[0].target (${JSON.stringify(receipt.target)}) does not name the ` +
        `declared capability (${JSON.stringify(capability)}) — the receipt is not bound to this invoke.`,
    };
  }
  const started = Date.parse(receipt.startedAt);
  const completed = Date.parse(receipt.completedAt);
  if (Number.isNaN(started) || Number.isNaN(completed) || completed < started) {
    return {
      ok: false,
      reason: "envelope.receipts[0].startedAt/completedAt are not a valid, ordered timestamp pair.",
    };
  }
  return { ok: true };
}

/**
 * Applies the expected-outcome assertion. `unsupported-deny`/`provider-error` always fail — they
 * are executed-and-defective, never a legitimate outcome to declare and pass on, regardless of any
 * declared expectation. Any other outcome only passes when it exactly matches the operator-declared
 * expectation; a missing or unrecognized declared expectation fails (it does not block — the
 * classification itself is fine, the operator simply didn't assert what they expected).
 *
 * @param {string} classifiedOutcome one of AGENT_INVOKE_OUTCOMES
 * @param {string | undefined} declaredExpectation raw ACCEPTANCE_FACILITY_LIVE_AGENT_INVOKE_EXPECT value
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function assertExpectedAgentInvokeOutcome(classifiedOutcome, declaredExpectation) {
  if (DEFECT_OUTCOMES.includes(classifiedOutcome)) {
    return {
      ok: false,
      reason:
        `Classified outcome "${classifiedOutcome}" is executed-and-defective — it always fails ` +
        "the gate regardless of any declared expectation (pass-by-classification is abolished).",
    };
  }
  if (!EXPECTABLE_OUTCOMES.includes(classifiedOutcome)) {
    // Unreachable for the five outcomes AGENT_INVOKE_OUTCOMES currently declares; defends against a
    // future outcome being added there without this gate's expectable set being updated to match.
    return {
      ok: false,
      reason:
        `Classified outcome "${classifiedOutcome}" is not one of the outcomes this gate can ` +
        `assert an expectation against (${EXPECTABLE_OUTCOMES.join(", ")}).`,
    };
  }
  if (!declaredExpectation || !EXPECTABLE_OUTCOMES.includes(declaredExpectation)) {
    return {
      ok: false,
      reason:
        "ACCEPTANCE_FACILITY_LIVE_AGENT_INVOKE_EXPECT must declare one of " +
        `${EXPECTABLE_OUTCOMES.join(", ")} for the gate to pass; got ` +
        `${JSON.stringify(declaredExpectation ?? null)}.`,
    };
  }
  if (declaredExpectation !== classifiedOutcome) {
    return {
      ok: false,
      reason:
        `Classified outcome "${classifiedOutcome}" does not match the declared expectation ` +
        `"${declaredExpectation}".`,
    };
  }
  return { ok: true };
}

/**
 * The STEP's full acceptance gate. A pure function of `(capability, envelope,
 * declaredExpectation)` so `scripts/agent-path-invoke.mjs` and the honest-red/green capture script
 * both exercise the exact same decision — neither re-implements it.
 *
 * @param {object} input
 * @param {string} input.capability
 * @param {unknown} input.envelope
 * @param {string | undefined} input.declaredExpectation
 * @returns {{status: "pass"|"fail"|"blocked", reason?: string, proof: object}}
 */
export function evaluateAgentInvokeGate({ capability, envelope, declaredExpectation }) {
  let classification;
  try {
    classification = classifyAgentInvokeOutcome(envelope);
  } catch (error) {
    return {
      status: "blocked",
      reason:
        "Supplied envelope could not be classified — refusing rather than guessing an outcome: " +
        (error instanceof Error ? error.message : String(error)),
      proof: { capability },
    };
  }
  const provenance = validateAgentInvokeProvenance(capability, envelope);
  if (!provenance.ok) {
    return {
      status: "blocked",
      reason:
        "Missing/malformed runtime-receipt provenance — refusing to pass without proof of a real " +
        `invocation: ${provenance.reason}`,
      proof: { capability, outcome: classification.outcome, detail: classification.detail },
    };
  }
  const expectation = assertExpectedAgentInvokeOutcome(classification.outcome, declaredExpectation);
  const proof = {
    capability,
    outcome: classification.outcome,
    detail: classification.detail,
    declaredExpectation: declaredExpectation ?? null,
    // Envelope error code only — never the raw envelope, which can carry live capability
    // output/input beyond what lib/redact.mjs's secret-shape patterns catch.
    envelopeOk: envelope.ok === true,
    envelopeErrorCode: envelope.error?.code ?? null,
  };
  if (!expectation.ok) {
    return { status: "fail", reason: expectation.reason, proof };
  }
  return { status: "pass", proof };
}
