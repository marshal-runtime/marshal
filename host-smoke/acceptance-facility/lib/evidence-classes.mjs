// D4 evidence-class contract (Field Guide decision 5 / audit "Testing capability
// gaps" point 6): exactly these seven ids. A blocked/unavailable class must be
// recorded with status "blocked" and never silently reported under a weaker or
// stronger class.
export const EVIDENCE_CLASSES = Object.freeze([
  "unit",
  "kernel-mock",
  "native-frame",
  "installed-api",
  "installed-ui",
  "provider-read",
  "external-write",
]);

export const RECEIPT_STATUSES = Object.freeze(["pass", "fail", "blocked"]);

export function assertEvidenceClass(value) {
  if (!EVIDENCE_CLASSES.includes(value)) {
    throw new Error(
      `Unknown acceptance evidence class: ${JSON.stringify(value)}. Expected one of ${EVIDENCE_CLASSES.join(", ")}.`,
    );
  }
  return value;
}

export function assertReceiptStatus(value) {
  if (!RECEIPT_STATUSES.includes(value)) {
    throw new Error(
      `Unknown acceptance receipt status: ${JSON.stringify(value)}. Expected one of ${RECEIPT_STATUSES.join(", ")}.`,
    );
  }
  return value;
}
