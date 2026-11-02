/**
 * Shared URL validation for custom remote MCP server connections.
 * Used by both the renderer (UI form) and main process (config builder).
 */
// Marshal ownership: relocated module identity.

export type McpUrlValidation = { ok: true; isLocalhost: boolean } | { ok: false; reason: string };

// new URL("http://[::1]").hostname === "[::1]" (URL parser keeps brackets for IPv6)
const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validate a URL for use as a custom remote MCP server endpoint.
 *
 * Rules:
 * - Must be parseable by `new URL()`
 * - Scheme must be `http:` or `https:` — rejects `file://`, `ftp://`, etc.
 * - `http:` is only allowed for localhost addresses
 * - `http://localhost` is always allowed (local MCP servers are a real use case)
 */
export function validateMcpUrl(url: string): McpUrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "Invalid URL format." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    const scheme = parsed.protocol.slice(0, -1);
    return {
      ok: false,
      reason: `"${scheme}://" URLs are not allowed. Use https:// (or http://localhost for local servers).`,
    };
  }

  const isLocalhost = LOCALHOST_HOSTNAMES.has(parsed.hostname);

  if (parsed.protocol === "http:" && !isLocalhost) {
    return {
      ok: false,
      reason: "http:// is only allowed for localhost. Use https:// for remote servers.",
    };
  }

  return { ok: true, isLocalhost };
}
