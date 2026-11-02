// Local, static example fixtures for the D4 provider-acceptance-receipts
// dry run. These are NOT live provider data — no network call produced
// them. They exist only so ../scripts/provider-acceptance-receipts.mjs has
// something concrete to run its comparison helpers (lib/provider-comparisons.mjs)
// against and produce an example "blocked" receipt shape. A live run
// replaces every one of these with real, redacted provider responses.
export const EXAMPLE_EXPECTED_ACCOUNT = {
  login: "example-work-login",
  organization: "example-work-org",
};

export const EXAMPLE_ACCOUNTS_LIST = {
  accounts: [
    { login: "example-work-login", organization: "example-work-org" },
    { login: "example-work-login", organization: "personal" },
  ],
};

export const EXAMPLE_EXPECTED_PR = { owner: "example-work-org", repo: "example-repo", number: 1 };

// Deliberately an EMPTY/stale local view (no headSha, no files/threads/checks/iterations) against a
// provider response with real content — the exact gap AUDIT-TEST-EVIDENCE.md found in the live product.
// The provider side's items carry the real, required fields (path+patch, id+body, name+conclusion) so
// F-005b's required-field rejection and normalized content comparison have realistic shapes to compare,
// not just this MISMATCH's counts.
export const EXAMPLE_LOCAL_PR_DETAIL = {
  owner: "example-work-org",
  repo: "example-repo",
  number: 1,
  files: [],
  threads: [],
  checks: [],
  iterations: [],
};

export const EXAMPLE_PROVIDER_PR_DETAIL = {
  owner: "example-work-org",
  repo: "example-repo",
  number: 1,
  headSha: "b7f3c9a1d2e4f6081a2b3c4d5e6f70819a2b3c4d",
  files: [{ path: "example.ts", patch: "@@ -1 +1 @@\n-old\n+new" }],
  threads: [{ id: "thread-1", anchor: "example.ts:1", body: "Example review comment." }],
  checks: [{ name: "build", conclusion: "success" }],
  iterations: [{ id: "iteration-1" }],
};

export const EXAMPLE_WRITE_BEFORE = {
  commitSha: "example-sha-before",
  "example.ts": "before content",
};
export const EXAMPLE_WRITE_AFTER = {
  commitSha: "example-sha-after",
  "example.ts": "before content",
};
export const EXAMPLE_WRITE_EXPECTATION = {
  expectedChangedFiles: { "example.ts": "after content" },
};
