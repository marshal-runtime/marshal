/**
 * Neutral, local resolution of the bug-report destination.
 *
 * Order of precedence: `MARSHAL_ISSUE_REPORTER_TARGET` env override, then the
 * `issueReporter` block in local settings. The value is never hardcoded in
 * client code, so it stays out of shipped binaries when unconfigured — and
 * when absent the whole feature reports itself unavailable.
 */

import type { IssueReporterSettings } from "../../common/marshal-ipc-contract";

/** The only shape a target is allowed to take: a single `owner/name` pair with
 *  no path separators, no query characters, no whitespace. Enforced here
 *  because the value flows into a child-process argv, a permission allowlist
 *  pattern, and a URL handed to `openExternalSafe` — which validates the
 *  scheme but not the host, so anything that could smuggle a different host or
 *  a path-traversal segment must be rejected at this trust boundary. */
const TARGET_PATTERN = /^[^/?#\s]+\/[^/?#\s]+$/;

export const ISSUE_REPORTER_TARGET_ENV = "MARSHAL_ISSUE_REPORTER_TARGET";

export function isValidIssueReporterTarget(value: string | undefined | null): value is string {
  return typeof value === "string" && TARGET_PATTERN.test(value);
}

export function resolveIssueReporterTarget(
  settings: IssueReporterSettings | undefined,
): string | null {
  const candidates = [process.env[ISSUE_REPORTER_TARGET_ENV], settings?.target];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (isValidIssueReporterTarget(trimmed)) return trimmed;
  }
  return null;
}
