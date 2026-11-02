#!/usr/bin/env node
// Class-killer facility step (facfix, root/facility-agent-step) — added after three
// live-only integration defects a generic pass/fail hid from every prior offline suite:
// F-DEPLOY-1 (an installed extension manifest live-install defect), F-DEPLOY-3 (an
// agent-originated enable/update mutation never reached the open renderer without a
// reload), and F-DEPLOY-4 (the agent-path `runtimeInvoke` self-tool denied a permission
// the live catalog itself declared, because the declared-permission resolver's search
// context silently threw and was swallowed by a fail-closed catch). All three only ever
// surfaced live, and each one hid behind an outcome that looked like an ordinary deny or
// a generic failure. This step exercises ONE real agent-path capability invoke under
// NORMAL policy and classifies the result distinctly (see
// lib/agent-invoke-classification.mjs) so that class of defect can never again hide
// inside an undifferentiated failure.
//
// ACCEPTANCE-GATE repair (facfix, root/agent-step-2 — Codex-found 04:43): a classification alone is
// NOT proof of a permanent agent-path regression — the installed-api branch previously passed on
// ANY recognized classification, including unsupported-deny (the exact F-DEPLOY-4 failure shape)
// and provider-error. lib/agent-invoke-gate.mjs's evaluateAgentInvokeGate() is the actual gate: a
// pass now requires a provenance-bound runtime-receipt (proof a real invocation happened) AND an
// operator-declared expected outcome that matches; unsupported-deny/provider-error always fail.
//
// Route (non-CDP — see README's "Class-killer: agent-path invoke" section): the
// `runtimeInvoke` self-tool (electron/marshal-runtime/runtime-self-tools.ts) is a
// main-process-only tool the Marshal Runtime host exposes to an agent's own tool-call
// loop — it has no `window.*` renderer bridge the other live-gated steps in this
// facility connect to over CDP. This facility carries no agent/MCP broker client of its
// own (SCOPE forbids new electron/** or SDK wiring here), so — exactly like
// `provider-acceptance-receipts.mjs`'s live branch — it never invokes the agent path
// itself: an operator (or an authorized live agent lane) independently invokes a real
// capability via the real agent path and supplies the resulting envelope as evidence.
// This script's job is to classify that envelope honestly, never to fabricate one.
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_INVOKE_ENVELOPE_FIXTURES,
  AGENT_INVOKE_OUTCOMES,
  classifyAgentInvokeOutcome,
} from "../lib/agent-invoke-classification.mjs";
import { EXPECTABLE_OUTCOMES, evaluateAgentInvokeGate } from "../lib/agent-invoke-gate.mjs";
import { liveModeRequested } from "../lib/live-connection.mjs";
import { writeReceipt } from "../lib/receipt.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECEIPTS_DIR = path.resolve(__dirname, "..", "example-receipts");

function kernelMockClassification() {
  const receiptPath = path.join(RECEIPTS_DIR, "agent-path-invoke.kernel-mock.json");
  const subject = "Classify all five agent-path invoke outcome shapes from fixture envelopes";
  const classifications = {};
  const mismatches = [];
  for (const outcome of AGENT_INVOKE_OUTCOMES) {
    const fixture = AGENT_INVOKE_ENVELOPE_FIXTURES[outcome];
    const classification = classifyAgentInvokeOutcome(fixture);
    classifications[outcome] = classification;
    if (classification.outcome !== outcome)
      mismatches.push({ expected: outcome, actual: classification });
  }
  return writeReceipt(receiptPath, {
    evidenceClass: "kernel-mock",
    status: mismatches.length === 0 ? "pass" : "fail",
    facility: "agent-path-invoke",
    subject,
    reason:
      mismatches.length === 0
        ? undefined
        : "One or more fixture envelopes misclassified — see proof.mismatches.",
    proof: { classifications, mismatches },
    limits: [
      "This proves the classification function's own decision logic against fixture-shaped envelopes " +
        "built from electron/marshal-runtime/api.ts's and production-adapter.ts's real code/message " +
        "shapes — it does NOT invoke the real runtimeInvoke self-tool, the real PermissionPolicy, or any " +
        "installed extension. See the installed-api receipt for what only a real agent-path invoke proves.",
    ],
  });
}

/**
 * @returns {{capability: string, envelope: object} | null}
 */
function parseLiveAgentInvokeEvidence() {
  const raw = process.env.ACCEPTANCE_FACILITY_LIVE_AGENT_INVOKE?.trim();
  if (!raw) return null;
  try {
    // SF-4: operator-independently-obtained local evidence, not externally supplied data.
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed.capability !== "string" ||
      !parsed.capability.trim() ||
      typeof parsed.envelope !== "object" ||
      parsed.envelope === null
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function installedApiAgentInvoke() {
  const receiptPath = path.join(RECEIPTS_DIR, "agent-path-invoke.installed-api.json");
  const subject =
    "One real agent-path capability invoke under NORMAL policy, outcome classified distinctly";
  const unlockLimits = [
    'Unlock: ACCEPTANCE_FACILITY_ALLOW_LIVE=1 ACCEPTANCE_FACILITY_LIVE_AGENT_INVOKE=\'{"capability":' +
      '"<the capability name that was invoked>","envelope":<the exact MarshalRuntimeApiResult JSON the ' +
      "real runtimeInvoke self-tool returned — envelope.receipts[0] must carry receiptId/executionId/" +
      "target/scope/startedAt/completedAt, and target must equal the declared capability>}' " +
      `ACCEPTANCE_FACILITY_LIVE_AGENT_INVOKE_EXPECT=<one of ${EXPECTABLE_OUTCOMES.join("|")}> node ` +
      "scripts/agent-path-invoke.mjs — the operator (or an authorized live agent lane) independently " +
      "invokes a real capability via the real agent path under NORMAL policy, supplies the resulting " +
      "envelope, and declares which outcome they expected.",
    "PASS requires the classified outcome to exactly match the declared expectation; unsupported-deny/" +
      "provider-error ALWAYS fail regardless of any declared expectation (they are executed-and-" +
      "defective, not legitimate policy outcomes to expect) — pass-by-classification is abolished.",
    "No ACCEPTANCE_FACILITY_CDP_PORT is used by this step — the agent path has no window.*-bridged " +
      "CDP route, unlike identify-installed-artifact.mjs/execute-application-route.mjs.",
  ];
  if (!liveModeRequested()) {
    return writeReceipt(receiptPath, {
      evidenceClass: "installed-api",
      status: "blocked",
      facility: "agent-path-invoke",
      subject,
      reason:
        "Requires parent authorization: set ACCEPTANCE_FACILITY_ALLOW_LIVE=1 and supply " +
        "ACCEPTANCE_FACILITY_LIVE_AGENT_INVOKE (+ ACCEPTANCE_FACILITY_LIVE_AGENT_INVOKE_EXPECT). This " +
        "facility never invokes the agent path itself — see the file-level comment for why (no " +
        "CDP/renderer bridge exists for runtimeInvoke).",
      limits: unlockLimits,
    });
  }
  const evidence = parseLiveAgentInvokeEvidence();
  if (!evidence) {
    return writeReceipt(receiptPath, {
      evidenceClass: "installed-api",
      status: "blocked",
      facility: "agent-path-invoke",
      subject,
      reason:
        "ACCEPTANCE_FACILITY_ALLOW_LIVE=1 was set but ACCEPTANCE_FACILITY_LIVE_AGENT_INVOKE was not " +
        "provided (or was not valid JSON with a non-empty `capability` and an `envelope` object) — no " +
        "real agent-path invoke result to classify. This lane never fabricates one.",
      limits: unlockLimits,
    });
  }
  const declaredExpectation =
    process.env.ACCEPTANCE_FACILITY_LIVE_AGENT_INVOKE_EXPECT?.trim() || undefined;
  const gate = evaluateAgentInvokeGate({
    capability: evidence.capability,
    envelope: evidence.envelope,
    declaredExpectation,
  });
  return writeReceipt(receiptPath, {
    evidenceClass: "installed-api",
    status: gate.status,
    facility: "agent-path-invoke",
    subject,
    reason: gate.reason,
    proof: gate.proof,
    limits: [
      "This facility never invokes the agent path itself; the operator/agent independently invoked a " +
        "real capability via the real runtimeInvoke self-tool under NORMAL policy and supplied the " +
        "resulting envelope. A `pass` here proves BOTH that the envelope carried a provenance-bound " +
        "runtime-receipt AND that the classified outcome matched the operator's declared expectation — " +
        "never a classification alone.",
      "The raw envelope value/input is never written to this receipt — only its error code and the " +
        "classified outcome — to avoid embedding live capability output in a checked-in receipt.",
    ],
  });
}

function main() {
  const kernelMock = kernelMockClassification();
  const installedApi = installedApiAgentInvoke();
  process.stdout.write(`${JSON.stringify({ kernelMock, installedApi }, null, 2)}\n`);
  process.exitCode = [kernelMock, installedApi].some((receipt) => receipt.status === "fail")
    ? 1
    : 0;
}

main();
