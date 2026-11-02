import type { McpServerInfo } from "@common/marshal-ipc-contract";

import type { McpOAuthUiState } from "@/hooks/mcp-oauth-store";

export type OAuthActionReason = "sign-in" | "retry" | "switch";
export type OAuthSecondaryActionReason = "sign-out";

export interface OAuthAction {
  label: string;
  disabled?: boolean;
  reason: OAuthActionReason;
  /**
   * If true, the user-initiated re-sign-in must clear the SDK's cached
   * OAuth token before opening the authorization URL — otherwise the SDK
   * silently reuses the cached token and reconnects as the same account,
   * which defeats the point of clicking "Sign in" on a server that's
   * already shown as signed in. Set whenever the user can plausibly want
   * to pick a different account: "Switch account" (alias known) and
   * "Sign in" on a signed-in-but-account-unknown server.
   */
  forceReauth?: boolean;
}

/** Secondary card action — currently just "Log out" on signed-in servers.
 * Kept distinct from `OAuthAction` so callers passing `reason` into the
 * OAuth dialog prompt can't accidentally route a sign-out through the
 * sign-in flow. */
export interface OAuthSecondaryAction {
  label: string;
  reason: OAuthSecondaryActionReason;
  /** True while a sign-out IPC is in flight — disable the button so the
   *  user can't fire overlapping sign-out requests for the same server. */
  disabled?: boolean;
}

/** Whether the server can ever require OAuth (remote, no static bearer token). */
export function isMcpOAuthCapable(server: McpServerInfo): boolean {
  const config = server.config;
  // Stdio servers (config exists with command, no url) never need OAuth.
  if (config && !("url" in config)) return false;
  // Manual bearer token: not OAuth.
  if (config && "accessToken" in config && config.accessToken) return false;
  return server.requiresOAuth === true || server.status === "needs-auth";
}

/** Whether the server is currently signed in (per server status + optional UI state). */
export function isMcpServerSignedIn(server: McpServerInfo, uiState?: McpOAuthUiState): boolean {
  if (uiState?.state === "connected") return true;
  if (server.status === "connected") return true;
  const alias = uiState?.alias ?? server.oauthAlias;
  return (
    !!alias &&
    !!server.requiresOAuth &&
    server.status !== "needs-auth" &&
    server.status !== "failed" &&
    server.status !== "pending"
  );
}

/**
 * Human-readable status label for an MCP server. Mirrors uiState transitions
 * before falling back to the steady-state server.status.
 *
 * `includeError`: when true (default), failure labels include the error string
 * (e.g. "Failed · Connection refused"). When false, returns just "Failed".
 */
export function getMcpServerStatusLabel(
  server: McpServerInfo,
  uiState?: McpOAuthUiState,
  options: { includeError?: boolean } = {},
): string | undefined {
  const includeError = options.includeError ?? true;
  if (uiState?.state === "connecting") return "Connecting";
  if (uiState?.state === "failed") {
    return includeError && uiState.error ? `Failed · ${uiState.error}` : "Failed";
  }
  if (isMcpServerSignedIn(server, uiState)) {
    const alias = uiState?.alias ?? server.oauthAlias;
    if (alias) return `Signed in as ${alias}`;
    // OAuth servers can land in "connected" without us knowing the account
    // (e.g. user deleted and recreated a remote server with the same URL —
    // the SDK's cached tokens auto-connect, but our config has no alias).
    // Be explicit so the user isn't left wondering why the alias field is
    // empty under a "Signed in" status.
    return server.requiresOAuth ? "Signed in (account unknown)" : "Connected";
  }
  switch (server.status) {
    case "failed":
      return includeError && server.error ? `Failed · ${server.error}` : "Failed";
    case "needs-auth":
      return "Sign-in required";
    case "pending":
      return "Connecting";
    case "disabled":
      return "Disabled";
    case "not_configured":
      return "Not configured";
    default:
      return server.config && "url" in server.config
        ? server.requiresOAuth
          ? "Not signed in"
          : "Not connected"
        : undefined;
  }
}

/**
 * Computes the primary OAuth action a user can take for a server — or null
 * when the server is not OAuth-capable. Used by both the carousel cards and
 * the server detail dialog so labels stay in sync.
 *
 * `isSigningOut`: pass the result of `useIsMutatingMcpServerSignOut(name)` so
 * the primary action disables in lockstep with the secondary "Log out" while
 * a `mcps:signOut` IPC is in flight — otherwise the user could fire a
 * Re-authenticate during sign-out and race the token-deletion + alias-clear.
 */
export function getMcpOAuthAction(
  server: McpServerInfo,
  uiState?: McpOAuthUiState,
  isSigningOut = false,
): OAuthAction | null {
  if (!isMcpOAuthCapable(server)) return null;
  if (uiState?.state === "connecting" || server.status === "pending") {
    return { label: "Connecting...", disabled: true, reason: "sign-in" };
  }
  if (isMcpServerSignedIn(server, uiState)) {
    // forceReauth is always on so the SDK doesn't silently reuse the cached
    // token — re-authenticating as a different account would otherwise grant
    // the original account's session.
    return {
      label: "Re-authenticate",
      reason: "switch",
      forceReauth: true,
      disabled: isSigningOut,
    };
  }
  if (uiState?.state === "failed" || server.status === "failed") {
    return { label: "Retry sign in", reason: "retry" };
  }
  if (server.status === "needs-auth") return { label: "Sign in", reason: "sign-in" };
  // Default for OAuth-capable servers without an SDK status yet — e.g. plugin-
  // contributed MCPs before the chat session connects, or cold start.
  // The MCP attention notice treats this same shape as `needs-auth`, so the
  // action label must match.
  return { label: "Sign in", reason: "sign-in" };
}

/**
 * Secondary OAuth action shown alongside the primary one — currently the
 * "Log out" CTA we offer when a server is signed in. Returned separately
 * (rather than as a `secondary?` field on `OAuthAction`) so callers that
 * already destructure {label, reason, forceReauth} from `getMcpOAuthAction`
 * stay untouched.
 *
 * The primary action ("Re-authenticate") opens the OAuth dialog and runs a
 * full new sign-in. The secondary action ("Log out") goes through a
 * separate `mcps:signOut` IPC that drops the SDK's cached OAuth token
 * *without* opening a new browser flow, so the user can return to the
 * "Not signed in" state.
 *
 * `isSigningOut`: see getMcpOAuthAction.
 */
export function getMcpOAuthSecondaryAction(
  server: McpServerInfo,
  uiState?: McpOAuthUiState,
  isSigningOut = false,
): OAuthSecondaryAction | null {
  if (!isMcpOAuthCapable(server)) return null;
  // Don't surface log-out while a connection attempt is in flight — the
  // primary action is disabled in that state and the secondary should be
  // too, but rendering it would imply there's something useful to do.
  if (uiState?.state === "connecting" || server.status === "pending") return null;
  if (!isMcpServerSignedIn(server, uiState)) return null;
  return { label: "Log out", reason: "sign-out", disabled: isSigningOut };
}

/**
 * Top-line description rendered in the detail dialog header — the
 * remote-MCP URL for URL servers, undefined for stdio servers (whose
 * command line is shown in the details list instead so it can wrap).
 */
export function getMcpServerDescription(server: McpServerInfo): string | undefined {
  const config = server.config;
  return config && "url" in config ? config.url : undefined;
}

/**
 * Detail rows rendered under the description in the MCP detail dialog:
 * endpoint (URL or command), human-readable status, error message (if any),
 * and the tool list (or a placeholder for remote MCPs whose tools are
 * discovered inside chat sessions rather than enumerated up front).
 *
 * `uiState` (optional): when provided, the Status row mirrors the live
 * OAuth UI state (e.g. shows "Connecting" mid-flow) so the row stays in
 * sync with the action button label. Omit for snapshot contexts that don't
 * have access to the OAuth store (e.g. the catalog-card fallback).
 */
export function getMcpServerDetails(
  server: McpServerInfo,
  uiState?: McpOAuthUiState,
): { label: string; value: string; linkify?: boolean }[] | undefined {
  const details: { label: string; value: string; linkify?: boolean }[] = [];
  const config = server.config;
  const isHttp = !!config && "url" in config;
  const endpoint = isHttp ? config.url : config && "command" in config ? config.command : undefined;
  if (endpoint)
    details.push({
      label: isHttp ? "URL" : "Command",
      value: endpoint,
      linkify: isHttp,
    });
  const statusLabel = getMcpServerStatusLabel(server, uiState, {
    includeError: false,
  });
  if (statusLabel) details.push({ label: "Status", value: statusLabel });
  if (server.error) details.push({ label: "Error", value: server.error });
  if (server.tools && server.tools.length > 0) {
    details.push({
      label: isHttp ? "Tools seen in chat" : "Tools",
      value: server.tools.map((tool) => tool.name).join(", "),
    });
  } else if (isHttp && server.status === "connected") {
    details.push({
      label: "Tools",
      value:
        "Remote MCP tools are discovered by the Copilot SDK inside chat sessions and are not listed individually here.",
    });
  }
  return details.length > 0 ? details : undefined;
}
