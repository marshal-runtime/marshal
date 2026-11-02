/**
 * Shared helpers for interpreting GitHub API error responses.
 * Used by both the in-app updater and the GitHub bundle importer.
 */
// Marshal ownership: relocated module identity.

/** Extract SSO authorization URL from the X-GitHub-SSO response header, if present. */
export function extractSsoUrl(header: string | null): string | undefined {
  return header?.match(/url=(https?:\/\/[^\s;]+)/)?.[1];
}

/** Check if a 403 response is caused by GitHub rate limiting. */
export function isRateLimited(resp: Response): boolean {
  return resp.headers.get("X-RateLimit-Remaining") === "0";
}
