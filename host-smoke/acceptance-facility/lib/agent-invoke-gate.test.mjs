import assert from "node:assert/strict";
import { test } from "node:test";

import { AGENT_INVOKE_ENVELOPE_FIXTURES } from "./agent-invoke-classification.mjs";
import {
  EXPECTABLE_OUTCOMES,
  assertExpectedAgentInvokeOutcome,
  evaluateAgentInvokeGate,
  validateAgentInvokeProvenance,
} from "./agent-invoke-gate.mjs";

const CAPABILITY = "codereview.accounts.list";

const VALID_RECEIPT = Object.freeze({
  receiptId: "receipt-fdeploy-agentgate-1",
  executionId: "execution-fdeploy-agentgate-1",
  target: CAPABILITY,
  scope: Object.freeze({ workspaceId: "workspace-demo", sessionId: "session-demo" }),
  startedAt: "2026-09-10T04:40:00.000Z",
  completedAt: "2026-09-10T04:40:00.250Z",
});

function withReceipt(outcome, receipt = VALID_RECEIPT) {
  return { ...AGENT_INVOKE_ENVELOPE_FIXTURES[outcome], receipts: [receipt] };
}

// --- validateAgentInvokeProvenance ---

void test("validateAgentInvokeProvenance accepts a well-formed, capability-bound receipt", () => {
  const result = validateAgentInvokeProvenance(CAPABILITY, withReceipt("policy-allow"));
  assert.deepEqual(result, { ok: true });
});

void test("validateAgentInvokeProvenance rejects a missing/empty receipts array", () => {
  assert.equal(
    validateAgentInvokeProvenance(CAPABILITY, { ok: true, value: {}, receipts: [] }).ok,
    false,
  );
  assert.equal(validateAgentInvokeProvenance(CAPABILITY, { ok: true, value: {} }).ok, false);
});

void test("validateAgentInvokeProvenance rejects each missing required string field", () => {
  for (const field of ["receiptId", "executionId", "target", "startedAt", "completedAt"]) {
    const receipt = { ...VALID_RECEIPT };
    delete receipt[field];
    const result = validateAgentInvokeProvenance(CAPABILITY, withReceipt("policy-allow", receipt));
    assert.equal(result.ok, false, `expected rejection for missing ${field}`);
    assert.match(result.reason, new RegExp(field));
  }
});

void test("validateAgentInvokeProvenance rejects a missing/non-object scope", () => {
  const receipt = { ...VALID_RECEIPT, scope: undefined };
  assert.equal(
    validateAgentInvokeProvenance(CAPABILITY, withReceipt("policy-allow", receipt)).ok,
    false,
  );
});

void test("validateAgentInvokeProvenance rejects a receipt whose target does not name the declared capability", () => {
  const receipt = { ...VALID_RECEIPT, target: "some.other.capability" };
  const result = validateAgentInvokeProvenance(CAPABILITY, withReceipt("policy-allow", receipt));
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not name the declared capability/);
});

void test("validateAgentInvokeProvenance rejects an unparsable or reversed timestamp pair", () => {
  const reversed = { ...VALID_RECEIPT, startedAt: "2026-09-10T04:40:01.000Z" };
  assert.equal(
    validateAgentInvokeProvenance(CAPABILITY, withReceipt("policy-allow", reversed)).ok,
    false,
  );
  const unparsable = { ...VALID_RECEIPT, completedAt: "not-a-timestamp" };
  assert.equal(
    validateAgentInvokeProvenance(CAPABILITY, withReceipt("policy-allow", unparsable)).ok,
    false,
  );
});

// --- assertExpectedAgentInvokeOutcome ---

void test("assertExpectedAgentInvokeOutcome passes only when the declared expectation matches", () => {
  for (const outcome of EXPECTABLE_OUTCOMES) {
    assert.deepEqual(assertExpectedAgentInvokeOutcome(outcome, outcome), { ok: true });
    for (const other of EXPECTABLE_OUTCOMES.filter((candidate) => candidate !== outcome)) {
      assert.equal(assertExpectedAgentInvokeOutcome(outcome, other).ok, false);
    }
  }
});

void test("assertExpectedAgentInvokeOutcome fails when no expectation was declared", () => {
  for (const outcome of EXPECTABLE_OUTCOMES) {
    assert.equal(assertExpectedAgentInvokeOutcome(outcome, undefined).ok, false);
  }
});

void test("assertExpectedAgentInvokeOutcome ALWAYS fails unsupported-deny/provider-error, regardless of expectation", () => {
  for (const outcome of ["unsupported-deny", "provider-error"]) {
    assert.equal(assertExpectedAgentInvokeOutcome(outcome, undefined).ok, false);
    assert.equal(assertExpectedAgentInvokeOutcome(outcome, outcome).ok, false);
    for (const declared of EXPECTABLE_OUTCOMES) {
      assert.equal(assertExpectedAgentInvokeOutcome(outcome, declared).ok, false);
    }
  }
});

// --- evaluateAgentInvokeGate (the STEP's full acceptance gate) ---

void test("evaluateAgentInvokeGate: expected-allow envelope with valid provenance PASSes", () => {
  const gate = evaluateAgentInvokeGate({
    capability: CAPABILITY,
    envelope: withReceipt("policy-allow"),
    declaredExpectation: "policy-allow",
  });
  assert.equal(gate.status, "pass");
  assert.equal(gate.proof.outcome, "policy-allow");
});

void test("evaluateAgentInvokeGate: unsupported-deny (the F-DEPLOY-4 shape) never PASSes and never BLOCKs", () => {
  const gate = evaluateAgentInvokeGate({
    capability: CAPABILITY,
    envelope: withReceipt("unsupported-deny"),
    declaredExpectation: "unsupported-deny",
  });
  assert.equal(gate.status, "fail");
});

void test("evaluateAgentInvokeGate: provider-error never PASSes and never BLOCKs", () => {
  const gate = evaluateAgentInvokeGate({
    capability: CAPABILITY,
    envelope: withReceipt("provider-error"),
    declaredExpectation: undefined,
  });
  assert.equal(gate.status, "fail");
});

void test("evaluateAgentInvokeGate: policy-deny PASSes only when explicitly expected", () => {
  const expected = evaluateAgentInvokeGate({
    capability: CAPABILITY,
    envelope: withReceipt("policy-deny"),
    declaredExpectation: "policy-deny",
  });
  assert.equal(expected.status, "pass");
  const unexpected = evaluateAgentInvokeGate({
    capability: CAPABILITY,
    envelope: withReceipt("policy-deny"),
    declaredExpectation: undefined,
  });
  assert.equal(unexpected.status, "fail");
});

void test("evaluateAgentInvokeGate: a classifiable envelope with missing provenance is BLOCKED, never a pass", () => {
  const gate = evaluateAgentInvokeGate({
    capability: CAPABILITY,
    envelope: AGENT_INVOKE_ENVELOPE_FIXTURES["policy-allow"], // receipts: [] in the shared fixture
    declaredExpectation: "policy-allow",
  });
  assert.equal(gate.status, "blocked");
});

void test("evaluateAgentInvokeGate: a malformed envelope is refused (blocked), not guessed", () => {
  const gate = evaluateAgentInvokeGate({
    capability: CAPABILITY,
    envelope: { ok: "not-a-boolean" },
    declaredExpectation: "policy-allow",
  });
  assert.equal(gate.status, "blocked");
});
