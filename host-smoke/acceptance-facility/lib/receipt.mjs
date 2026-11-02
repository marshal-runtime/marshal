import fs from "node:fs";
import path from "node:path";

import { assertEvidenceClass, assertReceiptStatus } from "./evidence-classes.mjs";
import { redactSecrets } from "./redact.mjs";

/**
 * Builds one evidence-class receipt object. Every field the six D4 points
 * require is present: `subject` identifies what was exercised, `revision`
 * ties it to the installed revision when known, `details`/`proof` carry the
 * redacted evidence, and `limits` states honestly what this receipt does
 * NOT prove (e.g. "kernel-mock does not exercise the real PermissionPolicy").
 *
 * @param {object} spec
 * @param {string} spec.evidenceClass one of EVIDENCE_CLASSES
 * @param {"pass"|"fail"|"blocked"} spec.status
 * @param {string} spec.facility which script produced this (e.g. "identify-installed-artifact")
 * @param {string} spec.subject human-readable description of what was tested
 * @param {object} [spec.revision] identity/version/integrity tying evidence to an installed revision, or null
 * @param {object} [spec.proof] raw (pre-redaction) evidence payload
 * @param {string[]} [spec.limits] honest statements of what this receipt does not establish
 * @param {string} [spec.reason] required when status is "blocked" or "fail"
 */
export function buildReceipt(spec) {
  assertEvidenceClass(spec.evidenceClass);
  assertReceiptStatus(spec.status);
  if (spec.status !== "pass" && !spec.reason) {
    throw new Error(
      `A "${spec.status}" receipt requires a reason: ${spec.facility}/${spec.subject}`,
    );
  }
  return {
    schemaVersion: 1,
    evidenceClass: spec.evidenceClass,
    status: spec.status,
    facility: spec.facility,
    subject: spec.subject,
    generatedAt: new Date().toISOString(),
    revision: spec.revision ?? null,
    reason: spec.reason ?? null,
    limits: spec.limits ?? [],
    secretsRedacted: true,
    proof: redactSecrets(spec.proof ?? null),
  };
}

export function writeReceipt(filePath, spec) {
  const receipt = buildReceipt(spec);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

/** Convenience for the common "this evidence class requires the live app" case. */
export function blockedReceipt(filePath, { evidenceClass, facility, subject, reason, limits }) {
  return writeReceipt(filePath, {
    evidenceClass,
    status: "blocked",
    facility,
    subject,
    reason,
    limits,
  });
}

export function readReceipt(filePath) {
  if (!fs.existsSync(filePath)) return null;
  // SF-4: local receipt files this same facility wrote; not externally supplied.
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function summarizeReceipts(receiptPaths) {
  const receipts = receiptPaths.map((filePath) => ({ filePath, receipt: readReceipt(filePath) }));
  const byClass = {};
  for (const { filePath, receipt } of receipts) {
    if (!receipt) continue;
    byClass[receipt.evidenceClass] ??= [];
    byClass[receipt.evidenceClass].push({
      filePath: path.basename(filePath),
      status: receipt.status,
      subject: receipt.subject,
      reason: receipt.reason,
    });
  }
  return byClass;
}
