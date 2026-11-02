#!/usr/bin/env node
// D4, point (e): provider acceptance receipt helpers
// (AUDIT-VERDICT-AND-ACCEPTANCE.md "Testing capability gaps", point 5).
// Non-live default (ACCEPTANCE_FACILITY_ALLOW_LIVE unset or "0"): makes NO
// real provider call and touches no network — the comparison logic
// (lib/provider-comparisons.mjs) is unit-tested separately (see
// lib/provider-comparisons.test.mjs, evidence class "unit"). This script runs
// those same helpers against local example fixtures
// (sample-app/provider-fixtures.mjs) to produce example "blocked"
// "provider-read"/"external-write" receipts.
//
// F-005 repair (c): with ACCEPTANCE_FACILITY_ALLOW_LIVE=1 AND the matching
// evidence env var set, this now runs a REAL live branch: it consumes
// actual, independently-obtained provider/product evidence supplied by the
// operator (this script never fetches it itself — no network in this
// facility) and reports pass/fail from the same comparison helpers. Setting
// ACCEPTANCE_FACILITY_ALLOW_LIVE=1 alone (no evidence) still reports
// "blocked", never a fabricated pass — see lib/provider-acceptance-mode.mjs.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { liveModeRequested } from "../lib/live-connection.mjs";
import { resolveProviderEvidenceSource } from "../lib/provider-acceptance-mode.mjs";
import {
  compareKnownPr,
  verifyAccountScope,
  verifyAuthorizedWrite,
} from "../lib/provider-comparisons.mjs";
import { writeReceipt } from "../lib/receipt.mjs";
import {
  EXAMPLE_ACCOUNTS_LIST,
  EXAMPLE_EXPECTED_ACCOUNT,
  EXAMPLE_EXPECTED_PR,
  EXAMPLE_LOCAL_PR_DETAIL,
  EXAMPLE_PROVIDER_PR_DETAIL,
  EXAMPLE_WRITE_AFTER,
  EXAMPLE_WRITE_BEFORE,
  EXAMPLE_WRITE_EXPECTATION,
} from "../sample-app/provider-fixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECEIPTS_DIR = path.resolve(__dirname, "..", "example-receipts");

function blockedMissingEvidenceReceipt(receiptPath, { evidenceClass, subject, envVarName }) {
  return writeReceipt(receiptPath, {
    evidenceClass,
    status: "blocked",
    facility: "provider-acceptance-receipts",
    subject,
    reason:
      `ACCEPTANCE_FACILITY_ALLOW_LIVE=1 was set but ${envVarName} was not provided — no independently-` +
      "obtained live evidence to verify. This lane never fabricates a live receipt from the example fixture.",
  });
}

function accountScopeReceipt() {
  const receiptPath = path.join(RECEIPTS_DIR, "provider-account-scope.provider-read.json");
  const subject = "Verify the connected account matches the expected work login/organization";
  const source = resolveProviderEvidenceSource({
    liveRequested: liveModeRequested(),
    rawLiveEnvValue: process.env.ACCEPTANCE_FACILITY_LIVE_ACCOUNT_SCOPE,
  });
  if (source.mode === "blocked-missing-evidence") {
    return blockedMissingEvidenceReceipt(receiptPath, {
      evidenceClass: "provider-read",
      subject,
      envVarName: "ACCEPTANCE_FACILITY_LIVE_ACCOUNT_SCOPE",
    });
  }
  if (source.mode === "live") {
    // SF-4: operator-supplied local evidence file content (independently obtained by the operator, not
    // fetched over the network by this facility), not externally supplied data.
    const evidence = JSON.parse(source.raw);
    const comparison = verifyAccountScope(evidence.accountsList, evidence.expected);
    return writeReceipt(receiptPath, {
      evidenceClass: "provider-read",
      status: comparison.verified ? "pass" : "fail",
      facility: "provider-acceptance-receipts",
      subject,
      reason: comparison.verified
        ? undefined
        : "The connected account did not match the expected work login/organization.",
      proof: { comparison, evidenceSource: "live (ACCEPTANCE_FACILITY_LIVE_ACCOUNT_SCOPE)" },
      limits: [
        "This receipt only proves the comparison helper's verdict on operator-supplied evidence; the " +
          "operator must independently obtain the real accounts list (e.g. via the product's own " +
          "connected-accounts API/UI) — this facility never fetches it itself.",
      ],
    });
  }
  const comparison = verifyAccountScope(EXAMPLE_ACCOUNTS_LIST, EXAMPLE_EXPECTED_ACCOUNT);
  return writeReceipt(receiptPath, {
    evidenceClass: "provider-read",
    status: "blocked",
    facility: "provider-acceptance-receipts",
    subject,
    reason:
      "No real provider call is executed in this lane. This receipt runs verifyAccountScope() " +
      "(lib/provider-comparisons.mjs, unit-tested in lib/provider-comparisons.test.mjs) against a local " +
      "example fixture, not a live GitHub accounts list. Real verification requires " +
      "ACCEPTANCE_FACILITY_ALLOW_LIVE=1 plus ACCEPTANCE_FACILITY_LIVE_ACCOUNT_SCOPE.",
    proof: { comparison, usedFixture: "sample-app/provider-fixtures.mjs" },
    limits: [
      "This example fixture is deliberately a MATCH; it demonstrates the helper's positive path only.",
    ],
  });
}

function knownPrReceipt() {
  const receiptPath = path.join(RECEIPTS_DIR, "provider-known-pr.provider-read.json");
  const subject =
    "Compare the product's loaded PR view against an independently-fetched provider PR detail";
  const source = resolveProviderEvidenceSource({
    liveRequested: liveModeRequested(),
    rawLiveEnvValue: process.env.ACCEPTANCE_FACILITY_LIVE_KNOWN_PR,
  });
  if (source.mode === "blocked-missing-evidence") {
    return blockedMissingEvidenceReceipt(receiptPath, {
      evidenceClass: "provider-read",
      subject,
      envVarName: "ACCEPTANCE_FACILITY_LIVE_KNOWN_PR",
    });
  }
  if (source.mode === "live") {
    // SF-4: operator-supplied local evidence file content, not externally supplied data.
    const evidence = JSON.parse(source.raw);
    const comparison = compareKnownPr(
      evidence.localPrDetail,
      evidence.providerPrDetail,
      evidence.expected,
    );
    return writeReceipt(receiptPath, {
      evidenceClass: "provider-read",
      status: comparison.allFieldsMatch ? "pass" : "fail",
      facility: "provider-acceptance-receipts",
      subject,
      reason: comparison.allFieldsMatch
        ? undefined
        : "The product's loaded PR view does not match an independently-fetched provider PR detail.",
      proof: { comparison, evidenceSource: "live (ACCEPTANCE_FACILITY_LIVE_KNOWN_PR)" },
      limits: [
        "This receipt only proves the comparison helper's verdict on operator-supplied evidence; the " +
          "operator must independently fetch the provider PR detail themselves — this facility never " +
          "fetches it itself.",
      ],
    });
  }
  const comparison = compareKnownPr(
    EXAMPLE_LOCAL_PR_DETAIL,
    EXAMPLE_PROVIDER_PR_DETAIL,
    EXAMPLE_EXPECTED_PR,
  );
  return writeReceipt(receiptPath, {
    evidenceClass: "provider-read",
    status: "blocked",
    facility: "provider-acceptance-receipts",
    subject,
    reason:
      "No real provider call is executed in this lane. This receipt runs compareKnownPr() against local " +
      "example fixtures representing an EMPTY local view against a provider response that has real files/" +
      "threads/checks/iterations — the exact gap AUDIT-TEST-EVIDENCE.md found in the live product. Real " +
      "verification requires ACCEPTANCE_FACILITY_ALLOW_LIVE=1 plus ACCEPTANCE_FACILITY_LIVE_KNOWN_PR.",
    proof: { comparison, usedFixture: "sample-app/provider-fixtures.mjs" },
    limits: [
      "This example fixture is deliberately a MISMATCH (empty local threads/checks/iterations vs. a non-empty " +
        "provider response) so the receipt demonstrates the helper catching the real defect class, not just its happy path.",
    ],
  });
}

function authorizedWriteReceipt() {
  const receiptPath = path.join(RECEIPTS_DIR, "provider-authorized-write.external-write.json");
  const subject =
    "Verify an authorized write actually changed remote file bytes, not just a returned commit SHA";
  const source = resolveProviderEvidenceSource({
    liveRequested: liveModeRequested(),
    rawLiveEnvValue: process.env.ACCEPTANCE_FACILITY_LIVE_WRITE,
  });
  if (source.mode === "blocked-missing-evidence") {
    return blockedMissingEvidenceReceipt(receiptPath, {
      evidenceClass: "external-write",
      subject,
      envVarName: "ACCEPTANCE_FACILITY_LIVE_WRITE",
    });
  }
  if (source.mode === "live") {
    // SF-4: operator-supplied local evidence file content, not externally supplied data.
    const evidence = JSON.parse(source.raw);
    const comparison = verifyAuthorizedWrite(evidence.before, evidence.after, evidence.expectation);
    return writeReceipt(receiptPath, {
      evidenceClass: "external-write",
      status: comparison.verified ? "pass" : "fail",
      facility: "provider-acceptance-receipts",
      subject,
      reason: comparison.verified
        ? undefined
        : "The authorized write did not verifiably change the expected remote file bytes.",
      proof: { comparison, evidenceSource: "live (ACCEPTANCE_FACILITY_LIVE_WRITE)" },
      limits: [
        "This receipt only proves the comparison helper's verdict on operator-supplied before/after " +
          "content; the operator must independently perform the authorized write and read the changed " +
          "remote artifact themselves — this facility never performs writes or network reads itself.",
      ],
    });
  }
  const comparison = verifyAuthorizedWrite(
    EXAMPLE_WRITE_BEFORE,
    EXAMPLE_WRITE_AFTER,
    EXAMPLE_WRITE_EXPECTATION,
  );
  return writeReceipt(receiptPath, {
    evidenceClass: "external-write",
    status: "blocked",
    facility: "provider-acceptance-receipts",
    subject,
    reason:
      "No real write is executed in this lane. This receipt runs verifyAuthorizedWrite() against a local " +
      "example fixture reproducing AUDIT-VERDICT-AND-ACCEPTANCE.md's exact finding ('A mock returns a commit " +
      "SHA, so the test passes without proving changed file bytes') — the commit SHA changes but the file " +
      "content does not. Real verification requires ACCEPTANCE_FACILITY_ALLOW_LIVE=1 plus " +
      "ACCEPTANCE_FACILITY_LIVE_WRITE.",
    proof: { comparison, usedFixture: "sample-app/provider-fixtures.mjs" },
    limits: [
      "This example fixture is deliberately the FAILING case (verified: false) to prove the helper does not " +
        "rubber-stamp a changed commit SHA as a real write.",
    ],
  });
}

function main() {
  const receipts = {
    accountScope: accountScopeReceipt(),
    knownPr: knownPrReceipt(),
    authorizedWrite: authorizedWriteReceipt(),
  };
  process.stdout.write(`${JSON.stringify(receipts, null, 2)}\n`);
  process.exitCode = Object.values(receipts).some((receipt) => receipt.status === "fail") ? 1 : 0;
}

main();
