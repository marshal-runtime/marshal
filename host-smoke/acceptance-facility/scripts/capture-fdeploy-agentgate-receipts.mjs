#!/usr/bin/env node
// AGENT-STEP ACCEPTANCE-GATE HONEST-RED/GREEN capture (facfix, root/agent-step-2, Codex-found
// 04:43, binding).
//
// Reproduces the pre-repair defect landed at 7cb059c12: scripts/agent-path-invoke.mjs's
// installed-api branch wrote status="pass" for ANY successfully classified envelope, including
// unsupported-deny (the exact F-DEPLOY-4 failure shape) and provider-error — a classification-only
// pass, not proof of a real, expected agent-path invocation. Then proves the repaired gate
// (lib/agent-invoke-gate.mjs's evaluateAgentInvokeGate(), the SAME function the real step calls —
// this script never re-implements it, only the frozen pre-repair defect below does):
//   - an expected-allow envelope with valid provenance PASSes;
//   - unsupported-deny and provider-error always FAIL, never pass, never blocked;
//   - policy-deny PASSes only when explicitly declared expected, and FAILs otherwise;
//   - a classifiable envelope with no bound runtime-receipt is BLOCKED, never a pass;
//   - a malformed envelope is BLOCKED (refused), not guessed.
//
// Produces:
//   test-receipts/fdeploy-agentgate-red.txt   — the PRE-repair gate (frozen copy of 7cb059c12's
//     installedApiAgentInvoke() pass branch) writing status="pass" for an unsupported-deny envelope.
//   test-receipts/fdeploy-agentgate-green.txt — the CURRENT gate's full decision matrix above.
//
// Re-runnable on demand; no network, no live app, no CDP — purely a demonstration of this facility's
// own decision logic, same pattern as scripts/capture-facfix-receipts.mjs and
// scripts/capture-facfix2-receipts.mjs. Not part of run-all.mjs's offline pipeline (permanent fast
// regression coverage of this same gate lives in lib/agent-invoke-gate.test.mjs); this script's job
// is to produce the committed honest-red/green evidence the task's acceptance criteria require.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_INVOKE_ENVELOPE_FIXTURES,
  classifyAgentInvokeOutcome,
} from "../lib/agent-invoke-classification.mjs";
import { evaluateAgentInvokeGate } from "../lib/agent-invoke-gate.mjs";
import { buildReceipt } from "../lib/receipt.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECEIPTS_DIR = path.resolve(__dirname, "..", "test-receipts");

const CAPABILITY = "codereview.accounts.list";

// Real RuntimeExecutionReceipt shape (@marshal/runtime/core's contracts.ts, imported at
// electron/marshal-runtime/contracts.ts:16 / api.ts:9 — receiptId/executionId/target/scope/
// startedAt/completedAt, `target` naming the invoked capability), the same field set already
// modeled in this facility's own example-receipts/execute-application-route.kernel-mock.json
// fixture — used here only as a demonstration receipt, never a fabricated live result.
const VALID_RECEIPT = Object.freeze({
  receiptId: "receipt-fdeploy-agentgate-demo-1",
  executionId: "execution-fdeploy-agentgate-demo-1",
  target: CAPABILITY,
  scope: Object.freeze({ workspaceId: "workspace-demo", sessionId: "session-demo" }),
  startedAt: "2026-09-10T04:40:00.000Z",
  completedAt: "2026-09-10T04:40:00.250Z",
});

function envelopeWithReceipt(outcome, receipt = VALID_RECEIPT) {
  return { ...AGENT_INVOKE_ENVELOPE_FIXTURES[outcome], receipts: [receipt] };
}

// --- Frozen, historical copy of the PRE-repair installedApiAgentInvoke() PASS branch, byte-for-
// --- byte the decision 7cb059c12's scripts/agent-path-invoke.mjs made: any envelope that
// --- classifyAgentInvokeOutcome() could classify at all was written status:"pass", with no
// --- provenance check and no expected-outcome assertion. Never imported by, or reachable from, any
// --- production code path in this facility — kept only for this red reproduction.
function preRepairInstalledApiGate(capability, envelope) {
  const classification = classifyAgentInvokeOutcome(envelope);
  return buildReceipt({
    evidenceClass: "installed-api",
    status: "pass",
    facility: "agent-path-invoke",
    subject:
      "One real agent-path capability invoke under NORMAL policy, outcome classified distinctly",
    proof: {
      capability,
      outcome: classification.outcome,
      detail: classification.detail,
      envelopeOk: envelope.ok === true,
      envelopeErrorCode: envelope.error?.code ?? null,
    },
  });
}

function captureRed() {
  const lines = [
    "=== AGENT-STEP ACCEPTANCE-GATE RED: pre-repair gate (7cb059c12) PASSes an unsupported-deny envelope ===",
    "",
  ];
  const envelope = AGENT_INVOKE_ENVELOPE_FIXTURES["unsupported-deny"];
  lines.push(
    `Capability: ${CAPABILITY}. Envelope: ${JSON.stringify(envelope)} — the exact F-DEPLOY-4 ` +
      "failure shape (a permission-denied deny whose message names the resolver-chain's own " +
      '"...is not supported..." fall-through, never a real policy decision).',
  );
  const receipt = preRepairInstalledApiGate(CAPABILITY, envelope);
  lines.push(
    `Pre-repair receipt: status=${receipt.status}, proof.outcome=${receipt.proof.outcome}`,
  );
  const ok = receipt.status === "pass";
  lines.push(
    ok
      ? "REPRODUCED: the pre-repair step wrote status=PASS for a classification alone — no runtime-" +
          "receipt provenance was checked, and no expected outcome was asserted, so this executed-and-" +
          "defective shape passed exactly like a legitimate allow would have."
      : "FAIL: did not reproduce the defect.",
  );
  return { lines, ok };
}

function scenario(title, { capability = CAPABILITY, envelope, declaredExpectation, expectStatus }) {
  const lines = [`=== AGENT-STEP ACCEPTANCE-GATE GREEN: ${title} ===`, ""];
  lines.push(
    `capability=${capability} declaredExpectation=${declaredExpectation ?? "(none)"} envelope=${JSON.stringify(envelope)}`,
  );
  const gate = evaluateAgentInvokeGate({ capability, envelope, declaredExpectation });
  lines.push(`Gate result: status=${gate.status}${gate.reason ? ` reason=${gate.reason}` : ""}`);
  const ok = gate.status === expectStatus;
  lines.push(
    ok
      ? `PASS: gate returned the expected "${expectStatus}" status.`
      : `FAIL: expected "${expectStatus}", got "${gate.status}".`,
  );
  return { lines, ok };
}

function captureGreen() {
  return [
    scenario("expected-allow envelope with valid provenance", {
      envelope: envelopeWithReceipt("policy-allow"),
      declaredExpectation: "policy-allow",
      expectStatus: "pass",
    }),
    scenario("unsupported-deny ALWAYS fails, even if declared as the expectation", {
      envelope: envelopeWithReceipt("unsupported-deny"),
      declaredExpectation: "unsupported-deny",
      expectStatus: "fail",
    }),
    scenario("provider-error ALWAYS fails", {
      envelope: envelopeWithReceipt("provider-error"),
      declaredExpectation: undefined,
      expectStatus: "fail",
    }),
    scenario("policy-deny PASSes when explicitly expected", {
      envelope: envelopeWithReceipt("policy-deny"),
      declaredExpectation: "policy-deny",
      expectStatus: "pass",
    }),
    scenario("policy-deny FAILs without a declared expectation", {
      envelope: envelopeWithReceipt("policy-deny"),
      declaredExpectation: undefined,
      expectStatus: "fail",
    }),
    scenario("a classifiable envelope with no bound runtime-receipt is BLOCKED, never a pass", {
      envelope: AGENT_INVOKE_ENVELOPE_FIXTURES["policy-allow"], // shared fixture's receipts: []
      declaredExpectation: "policy-allow",
      expectStatus: "blocked",
    }),
    scenario("a malformed envelope is BLOCKED (refused), not guessed", {
      envelope: { ok: "not-a-boolean" },
      declaredExpectation: "policy-allow",
      expectStatus: "blocked",
    }),
  ];
}

function writeLines(fileName, sections) {
  const filePath = path.join(RECEIPTS_DIR, fileName);
  const body = sections.map(({ lines }) => lines.join("\n")).join("\n\n");
  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
  fs.writeFileSync(filePath, `${body}\n`);
  return filePath;
}

function main() {
  const red = captureRed();
  const redPath = writeLines("fdeploy-agentgate-red.txt", [red]);

  const greenSections = captureGreen();
  const greenPath = writeLines("fdeploy-agentgate-green.txt", greenSections);

  const summary = {
    redPath,
    greenPath,
    redOk: red.ok,
    greenOk: greenSections.every((section) => section.ok),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = summary.redOk && summary.greenOk ? 0 : 1;
}

main();
