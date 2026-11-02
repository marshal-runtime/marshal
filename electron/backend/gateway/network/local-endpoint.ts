const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Returns false on parse failure rather than throwing — callers treat that as
// "not local" (the safe default for production/AAD URLs).
export function isLoopbackGatewayEndpoint(endpoint: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}
