/**
 * Shared helpers for managed MCP envFile paths (`${mcpEnvDir}/<key>.env`).
 *
 * The server-key allowlist (`/^[a-z0-9_-]+$/`) and the `${mcpEnvDir}/<key>.env`
 * token shape are load-bearing in three places that have to stay in sync:
 *
 *   - main process: `resolveMcpEnvFilePath` / `mcps:remove` sweep in
 *     `electron/ipc/mcp-ipc.ts` (re-validates the key from IPC before
 *     touching disk — defense in depth against a compromised renderer).
 *   - renderer (add dialog): `AddMcpDialog` builds the default envFile token
 *     and decides when to surface the Open/Reveal buttons.
 *   - renderer (list tab): `McpServersTab` re-derives the key for the
 *     row-level Open/Reveal menu.
 *
 * Drift between these three copies would cause the renderer to surface
 * affordances the main process rejects (benign) or worse, so the canonical
 * regex and token live here.
 */

/** The `envFile` substitution token that resolves to the app-data
 *  `marshal-mcp-env/` directory at spawn time. */
export const MCP_ENV_DIR_TOKEN = "${mcpEnvDir}";

/** Allowlist for managed envFile server keys. Mirrors `toMcpServerKey`'s
 *  output charset (lowercase + digits + `_` + `-`); anything else (path
 *  separators, `.`, whitespace) is rejected to keep the key from being a
 *  path-traversal vector when it's joined into `marshal-mcp-env/<key>.env`. */
export const MCP_ENV_SERVER_KEY_PATTERN = /^[a-z0-9_-]+$/;

/** Build the default managed envFile value for a server name. Empty string
 *  when the name has no valid key (e.g. blank input in the add dialog). */
export function defaultMcpEnvFileToken(serverKey: string): string {
  return serverKey ? `${MCP_ENV_DIR_TOKEN}/${serverKey}.env` : "";
}

/** Extract the server key when `envFile` uses the `${mcpEnvDir}/<key>.env`
 *  token shape. Returns null for absolute paths, `${workspaceFolder}/...`,
 *  or any key that doesn't match the allowlist. Renderer uses this to
 *  decide whether to show Open/Reveal affordances — only managed paths
 *  are openable via `mcps:openEnvFile`. */
export function managedMcpEnvServerKey(envFile: string | undefined): string | null {
  const trimmed = envFile?.trim();
  if (!trimmed) return null;
  const prefix = `${MCP_ENV_DIR_TOKEN}/`;
  if (!trimmed.startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length);
  const match = /^([a-z0-9_-]+)\.env$/.exec(rest);
  return match ? match[1] : null;
}
