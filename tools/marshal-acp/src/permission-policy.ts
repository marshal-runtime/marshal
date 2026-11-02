export type PermissionRequest = {
  tool: string;
  input: Record<string, unknown>;
};

/** `review` runs the deny list below (used by marshal-review-queue). `default` has
 *  no policy denies and trusts the runtime's own permission prompts. */
export type PermissionProfile = {
  profile: "review" | "default";
};

// `\b` word boundary (not `^\s*`) so chained commands are caught:
//   "cd /tmp && gh pr comment 1 -b foo" and "ls && gh pr review 1 --approve"
// both deny. Verified empirically against the shipping check.
const GH_PR_WRITE_VERBS = /\bgh\s+pr\s+(comment|review|edit|merge|close|ready)\b/;

// `gh api` covers any REST endpoint. We deny by combining two independent
// checks — `gh api` is being invoked AND the command carries an HTTP write
// shape. Earlier versions of this regex tried to express both conditions
// in a single pattern with nested lazy `[^|;&]*?` quantifiers, which CodeQL
// flagged as a ReDoS shape. Splitting into two `.test()` calls is both
// linear-time and easier to reason about.
const GH_API_VERB = /\bgh\s+api\b/;
// No leading `\b` because there's no word boundary between a space and `-`.
const HTTP_WRITE_METHOD = /(?:--method\s+|-X\s+)(?:POST|PATCH|PUT|DELETE)\b/;
// `gh api` implicitly switches the method to POST when -f/--field or
// -F/--field is present, even without --method. Treating these as write
// signals closes the bypass `gh api repos/x/y/issues/1/comments -f body=foo`.
const GH_API_IMPLICIT_FIELD = /\s-(?:f|F|-field|-raw-field)\b/;

const MCP_GITHUB_WRITE = /^mcp__github__(create|update|delete|merge)_/;

// `gh auth token` would let an agent extract stored creds and POST via curl,
// bypassing GH_TOKEN="". Block it outright — review agents have no legitimate
// reason to read user credentials.
const GH_AUTH_TOKEN = /\bgh\s+auth\s+token\b/;

// Direct curl/wget against GitHub API write endpoints — pulls/issues comments
// and reviews. Same split-regex shape as gh api: anchor the binary, then
// confirm the target host appears on the same command line. (Bounded by the
// trailing `\bapi.github.com\b` match, no nested lazy quantifiers.)
const HTTP_CLIENT_VERB = /\b(?:curl|wget|http)\b/;
const GITHUB_API_HOST = /\bapi\.github\.com\b/;

export function isToolUseAllowed(req: PermissionRequest, profile: PermissionProfile): boolean {
  if (profile.profile === "default") return true;
  if (req.tool === "Bash") {
    const cmd = typeof req.input.command === "string" ? req.input.command : "";
    if (GH_PR_WRITE_VERBS.test(cmd)) return false;
    // `gh api` + any write-shaped HTTP signal = deny. Covers explicit
    // --method/-X POST/PATCH/PUT/DELETE AND the implicit-POST shape that
    // gh applies when -f/--field is present (the documented field-passing
    // mechanism).
    if (GH_API_VERB.test(cmd) && (HTTP_WRITE_METHOD.test(cmd) || GH_API_IMPLICIT_FIELD.test(cmd))) {
      return false;
    }
    if (GH_AUTH_TOKEN.test(cmd)) return false;
    // curl/wget against the GitHub API — best-effort backstop. Adversarial
    // bypass (aliased binaries, node-fetch, etc.) is out of scope; trust
    // boundary is "agent we spawned ourselves".
    if (HTTP_CLIENT_VERB.test(cmd) && GITHUB_API_HOST.test(cmd)) return false;
    return true;
  }

  if (MCP_GITHUB_WRITE.test(req.tool)) return false;

  return true;
}
