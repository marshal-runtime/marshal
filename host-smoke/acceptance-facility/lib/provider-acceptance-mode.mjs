// F-005 (c) repair: provider-acceptance-receipts.mjs previously imported the
// example fixtures and wrote status:"blocked" unconditionally — there was NO
// live branch even with ACCEPTANCE_FACILITY_ALLOW_LIVE=1, contradicting the
// README. This module decides which evidence source a provider-acceptance
// step should consume:
//   - non-live (default): the checked-in example fixture, always "blocked".
//   - live, evidence supplied: an operator-supplied, independently-obtained
//     JSON blob (env var), compared for real and written pass/fail.
//   - live, evidence NOT supplied: still "blocked" — ACCEPTANCE_FACILITY_ALLOW_LIVE=1
//     alone is not a license to fabricate live evidence from the fixture.
//
// Pure/testable: the env values are passed in explicitly rather than read
// inside this module.
export function resolveProviderEvidenceSource({ liveRequested, rawLiveEnvValue }) {
  if (!liveRequested) return { mode: "non-live" };
  if (typeof rawLiveEnvValue !== "string" || !rawLiveEnvValue.trim()) {
    return { mode: "blocked-missing-evidence" };
  }
  return { mode: "live", raw: rawLiveEnvValue };
}
