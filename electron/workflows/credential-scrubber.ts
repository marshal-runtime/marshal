// electron/workflows/credential-scrubber.ts
//
// First-pass credential scrubbing on artifact writes (r1-fixes A24). The
// scrubber operates on UTF-8 text content; binary artifacts pass through
// unchanged. The intent is "stop the obviously dangerous string from
// landing on disk" — not "implement a perfect secret detector".

const PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["bearer", /bearer\s+[a-z0-9.\-_]{20,}/gi],
  ["jwt", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["aws_access_key", /AKIA[A-Z0-9]{16}/g],
  ["github_pat", /ghp_[A-Za-z0-9]{36}/g],
  ["azure_storage_key", /[A-Za-z0-9+/]{86}==/g],
];

export interface ScrubResult {
  readonly text: string;
  readonly hits: Readonly<Record<string, number>>;
}

/**
 * Replace recognised credential patterns with `[REDACTED:<name>]` markers.
 * Returns the redacted text and a map of pattern-name → hit-count so the
 * engine can emit an `artifact.credential-redacted` event.
 */
export function scrubCredentials(text: string): ScrubResult {
  const hits: Record<string, number> = {};
  let out = text;
  for (const [name, pattern] of PATTERNS) {
    out = out.replace(pattern, () => {
      hits[name] = (hits[name] ?? 0) + 1;
      return `[REDACTED:${name}]`;
    });
  }
  return { text: out, hits };
}
