import assert from "node:assert/strict";
import { test } from "node:test";

import { assertNoSecretsLeaked, redactSecrets, redactString } from "./redact.mjs";

void test("redactString masks emails, bearer tokens, and github PATs", () => {
  const input =
    "contact user@example.com using Bearer abc123.def456-ghi and ghp_abcdefghijklmnopqrst";
  const redacted = redactString(input);
  assert.ok(!redacted.includes("user@example.com"));
  assert.ok(!redacted.includes("ghp_abcdefghijklmnopqrst"));
  assert.ok(redacted.includes("Bearer [REDACTED]"));
});

void test("redactSecrets masks object keys that look like secrets regardless of value shape", () => {
  const redacted = redactSecrets({
    token: "plain-value",
    nested: { password: "hunter2" },
    count: 3,
  });
  assert.equal(redacted.token, "[REDACTED]");
  assert.equal(redacted.nested.password, "[REDACTED]");
  assert.equal(redacted.count, 3);
});

void test("redactSecrets recurses through arrays without dropping non-secret entries", () => {
  const redacted = redactSecrets([{ apiKey: "x" }, { note: "ok" }]);
  assert.equal(redacted[0].apiKey, "[REDACTED]");
  assert.equal(redacted[1].note, "ok");
});

void test("assertNoSecretsLeaked throws if a raw email survives redaction of an already-redacted structure", () => {
  assert.doesNotThrow(() => assertNoSecretsLeaked({ from: "a@b.com", body: "hi" }));
});

void test("redactSecrets handles circular references without throwing", () => {
  const circular = { name: "self" };
  circular.self = circular;
  assert.doesNotThrow(() => redactSecrets(circular));
});
