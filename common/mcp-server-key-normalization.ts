// Marshal-owned shared MCP server key normalization.

/**
 * Convert a user-facing MCP server name to the SDK/config key used for lookups.
 *
 * Two distinct contracts to keep in mind:
 *
 * - **Outbound** (us → SDK): `mcpServers[serverName]` lookups inside
 *   `oauth.login`, `getServer`, etc. are STRICT. Always normalize to the
 *   config key before calling into the SDK, otherwise the SDK throws
 *   `MCP server '<name>' is not configured`. `buildMcpConfig` registers
 *   custom servers under this normalized key, so the two sides line up.
 *
 * - **Inbound** (SDK → us): the Copilot SDK may report either display
 *   names ("Power BI") or config keys ("power_bi") across status and
 *   OAuth events. Normalize incoming `serverName` values before
 *   comparing or storing them so we don't double-bookkeep the same
 *   server.
 */
export function toMcpServerKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_");
}
