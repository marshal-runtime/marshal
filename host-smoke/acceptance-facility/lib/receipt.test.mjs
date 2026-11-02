import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildReceipt, readReceipt, summarizeReceipts, writeReceipt } from "./receipt.mjs";

void test("buildReceipt rejects an unknown evidence class", () => {
  assert.throws(() =>
    buildReceipt({ evidenceClass: "e2e", status: "pass", facility: "x", subject: "y" }),
  );
});

void test("buildReceipt requires a reason for non-pass statuses", () => {
  assert.throws(() =>
    buildReceipt({ evidenceClass: "unit", status: "blocked", facility: "x", subject: "y" }),
  );
  assert.doesNotThrow(() =>
    buildReceipt({
      evidenceClass: "unit",
      status: "blocked",
      facility: "x",
      subject: "y",
      reason: "no live app",
    }),
  );
});

void test("buildReceipt redacts proof before storing it", () => {
  const receipt = buildReceipt({
    evidenceClass: "provider-read",
    status: "blocked",
    facility: "provider-acceptance-receipts",
    subject: "known PR comparison",
    reason: "no live authorization in this lane",
    proof: { account: { token: "shh", login: "omer" } },
  });
  assert.equal(receipt.proof.account.token, "[REDACTED]");
  assert.equal(receipt.proof.account.login, "omer");
  assert.equal(receipt.secretsRedacted, true);
});

void test("writeReceipt persists a receipt readable by readReceipt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-facility-receipt-"));
  const target = path.join(dir, "nested", "example.json");
  const written = writeReceipt(target, {
    evidenceClass: "kernel-mock",
    status: "pass",
    facility: "identify-installed-artifact",
    subject: "sample-app fixture",
  });
  const reread = readReceipt(target);
  assert.deepEqual(reread, written);
  fs.rmSync(dir, { recursive: true, force: true });
});

void test("readReceipt returns null for a missing file", () => {
  assert.equal(readReceipt("/nonexistent/path/does-not-exist.json"), null);
});

void test("summarizeReceipts groups by evidence class", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-facility-summary-"));
  const a = path.join(dir, "a.json");
  const b = path.join(dir, "b.json");
  writeReceipt(a, { evidenceClass: "unit", status: "pass", facility: "f", subject: "one" });
  writeReceipt(b, {
    evidenceClass: "provider-read",
    status: "blocked",
    facility: "f",
    subject: "two",
    reason: "no live authorization",
  });
  const summary = summarizeReceipts([a, b]);
  assert.equal(summary.unit.length, 1);
  assert.equal(summary["provider-read"][0].status, "blocked");
  fs.rmSync(dir, { recursive: true, force: true });
});
