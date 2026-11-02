const ACCEPTED_SOURCE_STATUSES = new Set(["EVIDENCE_CAPTURED", "PASS"]);

export function readSourceCapabilityNames(evidence) {
  const sourceCapabilityNames = Array.isArray(evidence?.proof?.sourceCapabilityNames)
    ? evidence.proof.sourceCapabilityNames.filter((name) => typeof name === "string")
    : [];
  if (
    evidence?.stableId !== "MRT-HAR-001" ||
    !ACCEPTED_SOURCE_STATUSES.has(evidence?.status) ||
    evidence?.assertions?.sourceCapabilityDiscoverable !== true ||
    !sourceCapabilityNames.includes("code.index.status")
  ) {
    throw new Error("Source capability evidence did not prove code.index.status discovery.");
  }
  return sourceCapabilityNames;
}
