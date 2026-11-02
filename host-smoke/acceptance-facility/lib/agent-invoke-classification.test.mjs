import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_INVOKE_ENVELOPE_FIXTURES,
  AGENT_INVOKE_OUTCOMES,
  classifyAgentInvokeOutcome,
} from "./agent-invoke-classification.mjs";

void test("all five outcome fixtures classify to their own outcome id", () => {
  for (const outcome of AGENT_INVOKE_OUTCOMES) {
    const fixture = AGENT_INVOKE_ENVELOPE_FIXTURES[outcome];
    assert.ok(fixture, `missing fixture for ${outcome}`);
    const classification = classifyAgentInvokeOutcome(fixture);
    assert.equal(classification.outcome, outcome);
    assert.equal(typeof classification.detail, "string");
    assert.ok(classification.detail.length > 0);
  }
});

void test("AGENT_INVOKE_ENVELOPE_FIXTURES has exactly one fixture per declared outcome", () => {
  assert.deepEqual(
    Object.keys(AGENT_INVOKE_ENVELOPE_FIXTURES).sort(),
    [...AGENT_INVOKE_OUTCOMES].sort(),
  );
});

void test("a permission-denied without the unsupported phrase is policy-deny, not unsupported-deny", () => {
  const classification = classifyAgentInvokeOutcome({
    ok: false,
    error: {
      code: "permission-denied",
      message: "Marshal Runtime approval was rejected (denied).",
    },
  });
  assert.equal(classification.outcome, "policy-deny");
});

void test("the unsupported-deny phrase match is case-insensitive and substring-based", () => {
  const classification = classifyAgentInvokeOutcome({
    ok: false,
    error: {
      code: "permission-denied",
      message: "Marshal Runtime permission IS NOT SUPPORTED: some.permission.",
    },
  });
  assert.equal(classification.outcome, "unsupported-deny");
});

void test("any non-permission-denied, non-approval-required error code is provider-error", () => {
  for (const code of [
    "operation-failed",
    "not-found",
    "invalid-request",
    "runtime-unavailable",
    "aborted",
  ]) {
    const classification = classifyAgentInvokeOutcome({
      ok: false,
      error: { code, message: `fixture for ${code}` },
    });
    assert.equal(classification.outcome, "provider-error");
  }
});

void test("throws on a missing envelope rather than guessing an outcome", () => {
  assert.throws(() => classifyAgentInvokeOutcome(undefined), TypeError);
  assert.throws(() => classifyAgentInvokeOutcome(null), TypeError);
  assert.throws(() => classifyAgentInvokeOutcome([]), TypeError);
});

void test("throws when ok is false but error.code is missing rather than guessing an outcome", () => {
  assert.throws(() => classifyAgentInvokeOutcome({ ok: false }), TypeError);
  assert.throws(() => classifyAgentInvokeOutcome({ ok: false, error: {} }), TypeError);
});

void test("throws when ok is present but not a boolean rather than guessing an outcome", () => {
  assert.throws(() => classifyAgentInvokeOutcome({ ok: "yes" }), TypeError);
});
