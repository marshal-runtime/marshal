import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareKnownPr,
  verifyAccountScope,
  verifyAuthorizedWrite,
} from "./provider-comparisons.mjs";

const PR_ID = { owner: "OmerMachluf", repo: "acme", number: 42 };
const HEAD_SHA = "a".repeat(40);

function realPr(overrides = {}) {
  return {
    ...PR_ID,
    headSha: HEAD_SHA,
    files: [{ path: "src/a.ts", patch: "@@ -1 +1 @@\n-old\n+new" }],
    threads: [{ id: "thread-1", anchor: "src/a.ts:10", body: "Nit: rename this." }],
    checks: [{ name: "build", conclusion: "success" }],
    iterations: [{ id: "iteration-1" }],
    ...overrides,
  };
}

void test("verifyAccountScope matches a login within the expected organization", () => {
  const result = verifyAccountScope(
    { accounts: [{ login: "OmerMachluf", organization: "acme-edge" }] },
    { login: "OmerMachluf", organization: "acme-edge" },
  );
  assert.equal(result.verified, true);
  assert.deepEqual(result.matchedAccount, { login: "OmerMachluf", organization: "acme-edge" });
});

void test("verifyAccountScope does not verify a same-name login in the wrong organization", () => {
  const result = verifyAccountScope(
    { accounts: [{ login: "OmerMachluf", organization: "personal" }] },
    { login: "OmerMachluf", organization: "acme-edge" },
  );
  assert.equal(result.verified, false);
  assert.equal(result.matchedAccount, null);
  assert.deepEqual(result.candidateLogins, ["OmerMachluf"]);
});

void test("compareKnownPr flags a mismatch when the local view is missing threads/checks the provider has", () => {
  const local = { ...PR_ID, headSha: HEAD_SHA, files: [], threads: [], checks: [], iterations: [] };
  const provider = realPr();
  const result = compareKnownPr(local, provider, PR_ID);
  assert.equal(result.identityMatches, true);
  assert.equal(result.fieldComparisons.threads.matches, false);
  assert.equal(result.fieldComparisons.files.matches, false);
  assert.equal(result.allFieldsMatch, false);
});

void test("compareKnownPr passes when a document is compared against an exact copy of itself", () => {
  const doc = realPr();
  const result = compareKnownPr(doc, structuredClone(doc), PR_ID);
  assert.equal(result.allFieldsMatch, true);
  assert.equal(result.headShaMatches, true);
  assert.equal(result.fieldComparisons.files.matches, true);
});

// F-005b Defect 2 — ported/adapted from Codex's independent negative probe
// (verification/d4-independent-negative.mjs, read-only): equal counts with different real content must
// never pass — the pre-repair helper compared only array.length per field.
void test("compareKnownPr fails when every field's count agrees but the real content differs (Codex negative probe)", () => {
  const id = { owner: "work", repo: "test", number: 1 };
  const local = {
    ...id,
    files: [{ path: "wrong.ts", patch: "wrong" }],
    threads: [{ id: "wrong", body: "wrong" }],
    checks: [{ name: "ci", conclusion: "success" }],
    iterations: [],
  };
  const remote = {
    ...id,
    files: [{ path: "real.ts", patch: "real" }],
    threads: [{ id: "actual", body: "actual" }],
    checks: [{ name: "ci", conclusion: "failure" }],
    iterations: [],
  };
  assert.equal(compareKnownPr(local, remote, id).allFieldsMatch, false);
});

void test("compareKnownPr fails on wrong file paths even when file count and patch text agree", () => {
  const local = realPr({ files: [{ path: "src/wrong-path.ts", patch: realPr().files[0].patch }] });
  const provider = realPr();
  const result = compareKnownPr(local, provider, PR_ID);
  assert.equal(result.fieldComparisons.files.matches, false);
  assert.equal(result.allFieldsMatch, false);
});

void test("compareKnownPr fails on an unrelated thread id/body even when thread count agrees", () => {
  const local = realPr({
    threads: [{ id: "unrelated-thread", anchor: "x", body: "unrelated body" }],
  });
  const provider = realPr();
  const result = compareKnownPr(local, provider, PR_ID);
  assert.equal(result.fieldComparisons.threads.matches, false);
  assert.deepEqual(result.fieldComparisons.threads.keysMismatch, true);
  assert.equal(result.allFieldsMatch, false);
});

void test("compareKnownPr fails on an opposite check conclusion for the same check name", () => {
  const local = realPr({ checks: [{ name: "build", conclusion: "failure" }] });
  const provider = realPr({ checks: [{ name: "build", conclusion: "success" }] });
  const result = compareKnownPr(local, provider, PR_ID);
  assert.equal(result.fieldComparisons.checks.matches, false);
  assert.deepEqual(result.fieldComparisons.checks.mismatchedKeys, ["build"]);
  assert.equal(result.allFieldsMatch, false);
});

void test("compareKnownPr fails when the head SHA differs even though every other field matches", () => {
  const local = realPr({ headSha: "b".repeat(40) });
  const provider = realPr();
  const result = compareKnownPr(local, provider, PR_ID);
  assert.equal(result.headShaMatches, false);
  assert.equal(result.allFieldsMatch, false);
});

void test("compareKnownPr fails when the local head SHA is missing", () => {
  const { headSha: _drop, ...localWithoutHeadSha } = realPr();
  const result = compareKnownPr(localWithoutHeadSha, realPr(), PR_ID);
  assert.equal(result.headShaMatches, false);
  assert.equal(result.allFieldsMatch, false);
});

void test("compareKnownPr normalizes whitespace in thread bodies and file patches before comparing", () => {
  const provider = realPr();
  const local = realPr({
    files: [{ path: "src/a.ts", patch: "  @@ -1 +1 @@\n-old\n+new  " }],
    threads: [{ id: "thread-1", anchor: "src/a.ts:10", body: "Nit:  rename   this." }],
  });
  // Whitespace-only differences collapse under normalization, but this thread body differs by more than
  // whitespace (extra spaces AND is otherwise the same words) — demonstrate the collapse explicitly.
  const result = compareKnownPr(local, provider, PR_ID);
  assert.equal(result.fieldComparisons.files.matches, true);
  assert.equal(result.fieldComparisons.threads.matches, true);
});

// F-005b Defect 2 (required-field rejection): count agreement with missing required fields must never pass.
void test("compareKnownPr rejects a files entry missing patch even when paths and counts agree", () => {
  const local = realPr({ files: [{ path: "src/a.ts" }] });
  const provider = realPr();
  const result = compareKnownPr(local, provider, PR_ID);
  assert.equal(result.fieldComparisons.files.missingRequiredFields, true);
  assert.equal(result.fieldComparisons.files.matches, false);
  assert.equal(result.allFieldsMatch, false);
});

void test("compareKnownPr rejects a threads entry missing body even when ids and counts agree", () => {
  const local = realPr({ threads: [{ id: "thread-1", anchor: "src/a.ts:10" }] });
  const provider = realPr();
  const result = compareKnownPr(local, provider, PR_ID);
  assert.equal(result.fieldComparisons.threads.missingRequiredFields, true);
  assert.equal(result.allFieldsMatch, false);
});

void test("compareKnownPr rejects a checks entry missing conclusion even when names and counts agree", () => {
  const local = realPr({ checks: [{ name: "build" }] });
  const provider = realPr();
  const result = compareKnownPr(local, provider, PR_ID);
  assert.equal(result.fieldComparisons.checks.missingRequiredFields, true);
  assert.equal(result.allFieldsMatch, false);
});

void test("compareKnownPr rejects duplicate keys within one side as ambiguous rather than passing", () => {
  const local = realPr({
    files: [
      { path: "src/a.ts", patch: "one" },
      { path: "src/a.ts", patch: "two" },
    ],
  });
  const provider = realPr({ files: [{ path: "src/a.ts", patch: "one" }] });
  const result = compareKnownPr(local, provider, PR_ID);
  assert.equal(result.fieldComparisons.files.matches, false);
});

void test("verifyAuthorizedWrite rejects a mock that changes the commit SHA but not the file bytes", () => {
  const before = { commitSha: "sha-1", "file.ts": "old" };
  const after = { commitSha: "sha-2", "file.ts": "old" };
  const result = verifyAuthorizedWrite(before, after, {
    expectedChangedFiles: { "file.ts": "new" },
  });
  assert.equal(result.commitShaChanged, true);
  assert.equal(result.changedFiles[0].changed, false);
  assert.equal(result.verified, false);
});

void test("verifyAuthorizedWrite verifies a real byte-level change matching expected content", () => {
  const before = { commitSha: "sha-1", "file.ts": "old" };
  const after = { commitSha: "sha-2", "file.ts": "new" };
  const result = verifyAuthorizedWrite(before, after, {
    expectedChangedFiles: { "file.ts": "new" },
  });
  assert.equal(result.verified, true);
});
