import { shell } from "electron";

import { validateMcpUrl } from "../../common/extensions/mcp/mcp-url-validation";
import { createLogger } from "../../common/marshal-logger";
import { makeMcpError, mcpErrors } from "../../common/telemetry/errors/marshal-mcp";
import type { OAuthAuditLogInput } from "../audit-log";
import { toMcpServerKey } from "../platform/extensions/mcp-server-key";
import { sendErrorTelemetry } from "../telemetry-errors";
import type { IpcDeps } from "./types";

const log = createLogger("McpOAuthIpc");

// Discriminated union returned by mcps:initiateOAuth — no string matching required in the UI.
export type OAuthIpcResult =
  | { status: "success"; oauthAlias?: string }
  | { status: "error"; message: string };

export function normalizeMcpOAuthLoginHint(loginHint: string | undefined): string | undefined {
  const trimmed = loginHint?.trim();
  return trimmed || undefined;
}

/**
 * Validate that an OAuth authorization URL is safe to hand to `shell.openExternal`.
 * Returns null on success, or an error result (with audit log already written)
 * on failure. Both `runtime-only` and `configured` branches use this helper so
 * the validation rules and audit logging stay in lockstep.
 */
type LogOAuthFn = (input: Omit<OAuthAuditLogInput, "forceReauth" | "sessionId" | "alias">) => void;

function validateAuthorizationUrl(
  urlToOpen: string,
  serverName: string,
  logOAuth: LogOAuthFn,
): { status: "error"; message: string } | null {
  try {
    const parsed = new URL(urlToOpen);
    if (parsed.protocol !== "https:") {
      const message = "OAuth authorization URL must use HTTPS.";
      logOAuth({ event: "mcp-oauth-failure", serverName, error: message });
      return { status: "error", message };
    }
  } catch {
    const message = "Invalid OAuth authorization URL.";
    logOAuth({ event: "mcp-oauth-failure", serverName, error: message });
    return { status: "error", message };
  }
  return null;
}

export function registerMcpOAuthHandlers({
  mcpStore,
  sessionManager,
  auditLogger,
  ipcHandle,
}: Pick<IpcDeps, "mcpStore" | "sessionManager" | "auditLogger" | "ipcHandle">) {
  ipcHandle(
    "mcps:signOut",
    async (
      _event,
      serverName: string,
    ): Promise<{ status: "success" } | { status: "error"; message: string }> => {
      const sessionId = sessionManager.getCurrentSessionId() ?? undefined;
      const logSignOut = (input: Omit<OAuthAuditLogInput, "forceReauth" | "sessionId" | "alias">) =>
        auditLogger.logOAuth({ ...input, forceReauth: true, sessionId });

      try {
        const serverKey = toMcpServerKey(serverName);
        const server = mcpStore
          .getCustomServers()
          .find((s) => s.name === serverName || toMcpServerKey(s.name) === serverKey);
        const effectiveName =
          server?.name ??
          sessionManager.mcpStatus.getMcpServerStatuses()[serverKey]?.serverName ??
          serverName;

        if (server && server.type === "command") {
          const message = "Command-based servers do not use OAuth";
          logSignOut({ event: "mcp-oauth-failure", serverName: effectiveName, error: message });
          return { status: "error", message };
        }

        // signOutMcpOAuth is the atomic primitive: clears the persisted alias,
        // pushes the config refresh, then drops the SDK token. See
        // `McpStatusManager.signOutMcpOAuth` for the alias-first ordering
        // rationale.
        await sessionManager.mcpStatus.signOutMcpOAuth(effectiveName);

        // Terminal success event — `mcp-oauth-signout` is the single emit on
        // a successful sign-out. Failure path emits `mcp-oauth-failure` only.
        logSignOut({ event: "mcp-oauth-signout", serverName: effectiveName });
        return { status: "success" };
      } catch (error) {
        log.error("signOut failed:", error);
        sendErrorTelemetry(makeMcpError(mcpErrors.OAUTH_FAILED), error);
        const message = error instanceof Error ? error.message : String(error);
        logSignOut({ event: "mcp-oauth-failure", serverName, error: message });
        return { status: "error", message };
      }
    },
  );

  ipcHandle(
    "mcps:initiateOAuth",
    async (
      _event,
      serverName: string,
      loginHint?: string,
      options?: { contextSessionId?: string; forceReauth?: boolean },
    ): Promise<OAuthIpcResult> => {
      const normalizedLoginHint = normalizeMcpOAuthLoginHint(loginHint);
      // Explicit forceReauth wins; otherwise infer from loginHint (a typed
      // alias implies "I want a specific account") so the SDK doesn't
      // silently reuse the cached token. The explicit flag is what
      // separates user-initiated re-sign-in (forceReauth: true with no
      // alias) from chat-required prompts (forceReauth: false, no alias).
      const forceReauth = options?.forceReauth ?? !!normalizedLoginHint;
      // Prefer the originating session from a chat-time event so the audit
      // entry ties back to the session whose tool call triggered the prompt.
      const sessionId =
        options?.contextSessionId ?? sessionManager.getCurrentSessionId() ?? undefined;

      const logOAuth = (input: Omit<OAuthAuditLogInput, "forceReauth" | "sessionId" | "alias">) =>
        auditLogger.logOAuth({ ...input, forceReauth, sessionId, alias: normalizedLoginHint });

      const initiateOptions: { forceReauth: boolean; contextSessionId?: string } = {
        forceReauth,
      };
      if (options?.contextSessionId) {
        initiateOptions.contextSessionId = options.contextSessionId;
      }

      try {
        const serverKey = toMcpServerKey(serverName);
        const server = mcpStore
          .getCustomServers()
          .find((s) => s.name === serverName || toMcpServerKey(s.name) === serverKey);

        if (!server) {
          // Runtime-status path: server known to SDK but not saved as a custom server entry.
          const status = sessionManager.mcpStatus.getMcpServerStatuses()[serverKey];
          if (!status) {
            logOAuth({ event: "mcp-oauth-failure", serverName, error: "Server not found" });
            return { status: "error", message: "Server not found" };
          }

          logOAuth({ event: "mcp-oauth-initiate", serverName: status.serverName });
          const result = await sessionManager.mcpStatus.initiateMcpOAuth(
            status.serverName,
            initiateOptions,
          );
          if (result.authorizationUrl) {
            const urlToOpen = result.authorizationUrl;
            const validationError = validateAuthorizationUrl(
              urlToOpen,
              status.serverName,
              logOAuth,
            );
            if (validationError) return validationError;
            await shell.openExternal(urlToOpen);
          }
          await sessionManager.mcpStatus.waitForMcpServerConnection(status.serverName);
          await sessionManager.refreshCurrentSession();

          logOAuth({ event: "mcp-oauth-success", serverName: status.serverName });
          return normalizedLoginHint
            ? { status: "success", oauthAlias: normalizedLoginHint }
            : { status: "success" };
        }

        if (server.type === "command") {
          logOAuth({
            event: "mcp-oauth-failure",
            serverName: server.name,
            error: "Command-based servers do not use OAuth",
          });
          return { status: "error", message: "Command-based servers do not use OAuth" };
        }

        const urlValidation = validateMcpUrl(server.url);
        if (!urlValidation.ok) {
          logOAuth({
            event: "mcp-oauth-failure",
            serverName: server.name,
            error: `Invalid server URL: ${urlValidation.reason}`,
          });
          return { status: "error", message: `Invalid server URL: ${urlValidation.reason}` };
        }

        logOAuth({ event: "mcp-oauth-initiate", serverName: server.name });
        const result = await sessionManager.mcpStatus.initiateMcpOAuth(
          server.name,
          initiateOptions,
        );
        if (result.authorizationUrl) {
          const urlToOpen = result.authorizationUrl;
          const validationError = validateAuthorizationUrl(urlToOpen, server.name, logOAuth);
          if (validationError) return validationError;
          await shell.openExternal(urlToOpen);
        }
        await sessionManager.mcpStatus.waitForMcpServerConnection(server.name);
        if (normalizedLoginHint) {
          mcpStore.updateServerConfig(server.name, { oauthAlias: normalizedLoginHint });
          sessionManager.mcpStatus.setCustomMcpServers(mcpStore.getCustomServers());
        }
        await sessionManager.refreshCurrentSession();

        logOAuth({ event: "mcp-oauth-success", serverName: server.name });
        return normalizedLoginHint
          ? { status: "success", oauthAlias: normalizedLoginHint }
          : { status: "success" };
      } catch (error) {
        log.error("initiateOAuth failed:", error);
        sendErrorTelemetry(makeMcpError(mcpErrors.OAUTH_FAILED), error);
        const message = error instanceof Error ? error.message : String(error);
        logOAuth({ event: "mcp-oauth-failure", serverName, error: message });
        return { status: "error", message };
      }
    },
  );
}
