import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveProviderEvidenceSource } from "./provider-acceptance-mode.mjs";

// F-005 (d): live-flag-off must resolve to the non-live (fixture, "blocked") path — never a pass.
void test("resolveProviderEvidenceSource is non-live when the live flag is off, regardless of env content", () => {
  const result = resolveProviderEvidenceSource({
    liveRequested: false,
    rawLiveEnvValue: JSON.stringify({ some: "evidence" }),
  });
  assert.deepEqual(result, { mode: "non-live" });
});

// F-005 (c): ALLOW_LIVE=1 alone must not fabricate live evidence from the fixture.
void test("resolveProviderEvidenceSource is blocked-missing-evidence when live is requested but no evidence is supplied", () => {
  assert.deepEqual(
    resolveProviderEvidenceSource({ liveRequested: true, rawLiveEnvValue: undefined }),
    {
      mode: "blocked-missing-evidence",
    },
  );
  assert.deepEqual(resolveProviderEvidenceSource({ liveRequested: true, rawLiveEnvValue: "   " }), {
    mode: "blocked-missing-evidence",
  });
});

void test("resolveProviderEvidenceSource is live when requested and evidence is supplied", () => {
  const raw = JSON.stringify({ accountsList: {}, expected: {} });
  assert.deepEqual(resolveProviderEvidenceSource({ liveRequested: true, rawLiveEnvValue: raw }), {
    mode: "live",
    raw,
  });
});
