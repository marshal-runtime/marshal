/**
 * McpStatusManager — MCP server status tracking, OAuth flow, and the
 * `waitForMcpServerConnection` coalescing/abort plumbing. Extracted from
 * {@link SessionManager}. The consumer surface for
 * `sessions.ts` + IPC handlers is the {@link McpStatusLike} subset declared
 * in `sessions.ts`; composition-root wiring goes through
 * {@link SessionManager.connectMcpPipeline}.
 */

import type { BackendEvent } from "./backend/types";
import type { CustomMcpServer } from "./ipc/types";
import { toMcpServerKey } from "./platform/extensions/mcp-server-key";

/** Hard upper bound on a single `waitForMcpServerConnection` call. */
export const MCP_OAUTH_CONNECT_TIMEOUT_MS = 180_000;

export type McpServerStatus =
  | "connected"
  | "failed"
  | "needs-auth"
  | "pending"
  | "disabled"
  | "not_configured";

export interface McpServerStatusEntry {
  serverName: string;
  status: McpServerStatus;
  error?: string;
}

/**
 * Narrow view of {@link McpStore} that {@link McpStatusManager.signOutMcpOAuth}
 * needs. Kept as a structural type so this module doesn't take a direct
 * dependency on the full McpStore implementation.
 */
export interface McpStoreLike {
  getCustomServers(): CustomMcpServer[];
  updateServerConfig(name: string, update: Partial<CustomMcpServer>): void;
}

/**
 * Logger-like surface used by {@link McpStatusManager.handleBackendEvent} so
 * the caller can pass a session-scoped logger (preserving the `sessionId`
 * field on every emitted log line).
 */
export interface ScopedLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface McpStatusManagerDeps {
  /**
   * Pushes the latest custom-server list to the backend layer. Called
   * synchronously by {@link McpStatusManager.setCustomMcpServers} **after**
   * the in-memory field is updated.
   */
  applyCustomServersToBackend: (servers: CustomMcpServer[]) => void;
  /**
   * Refreshes the currently active session so the new MCP config takes
   * effect. Called synchronously by {@link McpStatusManager.setCustomMcpServers}
   * **after** {@link applyCustomServersToBackend}.
   */
  refreshActiveSessionForCustomServersChange: () => void;
  /**
   * Resolve an SDK executor session id for an OAuth RPC. Implemented by
   * SessionManager — selection touches session lifecycle state (handles,
   * pending creations, the persisted index) that does not belong here.
   */
  resolveOAuthExecutor: (contextSessionId?: string) => Promise<string>;
  /**
   * Forward an `oauth.login` RPC to the backend's session layer.
   * Implemented by SessionManager as
   * `(id, name, opts) => this.backend.sessions.initiateMcpOAuth(id, name, opts)`.
   */
  callBackendInitiateOAuth: (
    executorId: string,
    serverName: string,
    opts: { forceReauth?: boolean },
  ) => Promise<{ authorizationUrl?: string }>;
  /**
   * Returns the McpStore for alias / config updates from
   * {@link McpStatusManager.signOutMcpOAuth}. Undefined before
   * `setMcpStore` is wired (early in main.ts startup).
   */
  getMcpStore: () => McpStoreLike | undefined;
}

export class McpStatusManager {
  /**
   * Forwards MCP server status changes (incl. plugin-declared remote MCPs
   * that trigger OAuth) to main.ts → renderer. The bundled CLI handles the
   * OAuth flow itself; we only surface progress so the user gets feedback
   * (otherwise a needs-auth server appears silently broken).
   */
  private mcpStatusCallback: ((event: BackendEvent) => void) | null = null;
  private mcpStatusListeners = new Set<(event: BackendEvent) => void>();
  private mcpServerStatuses = new Map<string, McpServerStatusEntry>();
  /**
   * Coalesces concurrent waiters for the same server — if two calls to
   * {@link waitForMcpServerConnection} arrive before the server connects,
   * the second call joins the first instead of racing on the same status
   * event.
   */
  private pendingConnectionWaits = new Map<string, Promise<void>>();
  /**
   * Aborters for in-flight `waitForMcpServerConnection` promises. Keyed by
   * the same normalized server key as {@link pendingConnectionWaits}.
   * Calling an aborter rejects the wait with a teardown error and runs its
   * cleanup (clears the timeout + removes the listener); the promise's
   * existing `.finally()` handler then evicts the entry from
   * `pendingConnectionWaits`. Used by
   * {@link drainPendingMcpConnectionWaits} so that signing out or deleting
   * sessions while OAuth is in flight doesn't wedge the IPC handler for
   * the full {@link MCP_OAUTH_CONNECT_TIMEOUT_MS} timeout (which would also
   * block any future caller from starting a fresh wait for that server).
   */
  private mcpConnectionWaitAborters = new Map<string, () => void>();
  private customMcpServers: CustomMcpServer[] = [];
  /**
   * Disabled-MCP display names (e.g. "Browser Control and Web Browsing") for a
   * given session, derived from permissions.servers[key].enabled === false.
   * Wired by main.ts to consult per-session entity permissions first (so an
   * automation that disables Browser Control and Web Browsing on its own scope gets a prompt
   * omitting that section), falling back to global settings.
   */
  private disabledMcpProvider: (sessionId: string) => Set<string> = () => new Set();

  constructor(private deps: McpStatusManagerDeps) {}

  // ── Custom-server config + disabled provider ────────────────────────────

  /**
   * Test wiring for the disabled-MCP provider (consumed via
   * {@link getDisabledMcps}). Production callers go through
   * {@link connectPipeline}.
   */
  setDisabledMcpProvider(provider: (sessionId: string) => Set<string>): void {
    this.disabledMcpProvider = provider;
  }

  /** Read-only accessor for SessionManager's system-prompt path. */
  getDisabledMcps(sessionId: string): Set<string> {
    return this.disabledMcpProvider(sessionId);
  }

  setCustomMcpServers(servers: CustomMcpServer[]): void {
    this.customMcpServers = servers;
    this.deps.applyCustomServersToBackend(servers);
    this.deps.refreshActiveSessionForCustomServersChange();
  }

  /**
   * Read-only accessor for SessionManager (token refresh, accumulator
   * display name resolution). Returns the live internal array — callers
   * MUST NOT mutate it; use {@link setCustomMcpServersInMemory} or
   * {@link setCustomMcpServers} to update.
   */
  getCustomMcpServers(): CustomMcpServer[] {
    return this.customMcpServers;
  }

  /**
   * Update the in-memory custom-server list **without** firing the
   * backend-propagation + active-session-refresh side effects of
   * {@link setCustomMcpServers}. Used by `refreshExpiredTokens` to swap in
   * refreshed access tokens — the SDK config is unchanged so a full
   * propagation+refresh would be wasted work.
   */
  setCustomMcpServersInMemory(servers: CustomMcpServer[]): void {
    this.customMcpServers = servers;
  }

  // ── Status map ──────────────────────────────────────────────────────────

  getMcpServerStatuses(): Record<string, McpServerStatusEntry> {
    return Object.fromEntries(this.mcpServerStatuses);
  }

  clearMcpServerStatus(serverName: string): void {
    this.mcpServerStatuses.delete(toMcpServerKey(serverName));
  }

  /**
   * Removes MCP status entries for servers that are not in the configured
   * custom-server list (i.e. runtime-discovered plugin servers). Called
   * when all backend sessions have been torn down so stale SDK-reported
   * statuses cannot pre-resolve a waitForMcpServerConnection call in a new
   * session.
   */
  clearRuntimeMcpStatuses(): void {
    const configuredKeys = new Set(this.customMcpServers.map((s) => toMcpServerKey(s.name)));
    for (const key of this.mcpServerStatuses.keys()) {
      if (!configuredKeys.has(key)) this.mcpServerStatuses.delete(key);
    }
  }

  /**
   * Reject every in-flight `waitForMcpServerConnection` promise with a
   * teardown error and drop the supporting bookkeeping.
   *
   * Called from session-teardown paths (`pauseSession` / `deleteSession` /
   * `deleteAllSessions`) so that an OAuth flow that started under one
   * session does not wedge the calling IPC handler for the full
   * {@link MCP_OAUTH_CONNECT_TIMEOUT_MS} window when the originating
   * session disappears, and so that a stale `pendingConnectionWaits` entry
   * can't cause a future caller to silently join a wait that nobody will
   * ever resolve.
   *
   * Callers are responsible for invoking this only when no active session
   * remains (see the `sessionHandles.size === 0` guard at each call site).
   * Each aborter rejects the promise + runs the wait's own `cleanup()`,
   * which removes the listener and the aborter entry. Belt-and-suspenders:
   * we still defensively clear both maps and the listener set in case a
   * listener was registered without a matching aborter (impossible today
   * but cheap insurance against future drift).
   */
  drainPendingMcpConnectionWaits(): void {
    // Snapshot before iterating: each abort() mutates the map via cleanup().
    const aborters = [...this.mcpConnectionWaitAborters.values()];
    for (const abort of aborters) abort();
    this.mcpConnectionWaitAborters.clear();
    this.pendingConnectionWaits.clear();
    this.mcpStatusListeners.clear();
  }

  // ── OAuth flow ──────────────────────────────────────────────────────────

  async initiateMcpOAuth(
    serverName: string,
    options?: { forceReauth?: boolean; contextSessionId?: string },
  ): Promise<{ authorizationUrl?: string }> {
    // Pick the SDK executor session.
    //
    // OAuth state itself is *server-scoped* (the SDK runtime owns the token
    // cache keyed by server name), but the `oauth.login` RPC is per-session
    // because the SDK looks up `serverName` in that session's `mcpServers`
    // config. We therefore need a live session, but we do NOT need it to be
    // any particular one — except for chat-time prompts, where preferring
    // the *originating* session matches the connection that's actually
    // waiting for OAuth completion.
    const executorId = await this.deps.resolveOAuthExecutor(options?.contextSessionId);

    // Always clear the cached status entry before starting a fresh OAuth flow.
    // The SDK will emit fresh status events as it works through the new attempt;
    // any prior "failed" or "connected" reading is stale relative to this call
    // and would cause `waitForMcpServerConnection` to settle synchronously from
    // the cache before the new flow has had a chance to update it. The
    // forceReauth flag itself is still passed through to the SDK so it knows
    // to discard its own cached token, which is independent of this UI cache.
    this.mcpServerStatuses.delete(toMcpServerKey(serverName));
    return this.deps.callBackendInitiateOAuth(executorId, serverName, {
      forceReauth: options?.forceReauth,
    });
  }

  /**
   * User-initiated sign-out for an MCP OAuth server. Atomic primitive that
   * (1) clears the persisted `oauthAlias`, (2) pushes the new config to the
   * backend (triggering a session refresh), and (3) drops the SDK's cached
   * OAuth token via `session.rpc.mcp.oauth.login({ forceReauth: true })`.
   *
   * Alias-clear runs *before* the SDK call: forceReauth deletes the cached
   * token as its first step, so a partway-through failure must not leave
   * the UI claiming "Signed in as foo" with no credentials behind it. With
   * the alias cleared first, the card falls back to "Not signed in" /
   * "Signed in (account unknown)" — a recoverable state from which the
   * user can re-click Log out or Re-authenticate.
   *
   * The returned `authorizationUrl` is intentionally discarded — the SDK's
   * loopback callback server waits ~5 minutes for a redirect that never
   * arrives, logs a timeout, and tears down quietly. The SDK runtime still
   * considers the server connected after this call (the HTTP connection
   * isn't dropped), but the token cache is gone — any reconnect (config
   * change, restart, the refresh we trigger) lands the server in
   * `needs-auth`. Errors during the SDK call propagate so the IPC handler
   * can audit-log a failure.
   */
  async signOutMcpOAuth(serverName: string): Promise<void> {
    // Look up the canonical custom-server name (case-insensitive match) so
    // we clear the right alias even when callers pass a different casing.
    const serverKey = toMcpServerKey(serverName);
    const mcpStore = this.deps.getMcpStore();
    const customServer = mcpStore
      ?.getCustomServers()
      .find((s) => s.name === serverName || toMcpServerKey(s.name) === serverKey);

    if (customServer && mcpStore) {
      mcpStore.updateServerConfig(customServer.name, { oauthAlias: undefined });
      // setCustomMcpServers triggers an async refresh of the active session;
      // resolveOAuthExecutor (called below) awaits any in-flight creation
      // before picking the executor, so the SDK call lands on a session that
      // has observed the new config.
      this.setCustomMcpServers(mcpStore.getCustomServers());
    }

    const effectiveName = customServer?.name ?? serverName;
    const executorId = await this.deps.resolveOAuthExecutor();

    this.mcpServerStatuses.delete(toMcpServerKey(effectiveName));
    await this.deps.callBackendInitiateOAuth(executorId, effectiveName, {
      forceReauth: true,
    });
  }

  // ── Wait-for-connect ────────────────────────────────────────────────────

  waitForMcpServerConnection(
    serverName: string,
    timeoutMs = MCP_OAUTH_CONNECT_TIMEOUT_MS,
  ): Promise<void> {
    const normalizedServerName = toMcpServerKey(serverName);

    // Coalesce concurrent callers for the same server: the second caller shares
    // the first promise rather than racing on the same status event. Semantics
    // (timeout, resolution) are shared — which is correct since only one OAuth
    // flow for a given server should be in flight at a time.
    const existing = this.pendingConnectionWaits.get(normalizedServerName);
    if (existing) return existing;

    const promise = new Promise<void>((resolve, reject) => {
      const connectionError = (error?: string) =>
        new Error(
          `MCP server "${serverName}" failed to connect after OAuth: ${error ?? "unknown error"}`,
        );

      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for MCP server "${serverName}" to finish OAuth and connect.`,
          ),
        );
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.mcpStatusListeners.delete(listener);
        // Best-effort removal: only delete our own aborter entry, never a
        // newer one that a subsequent call may have just registered for the
        // same key (the .finally() on the outer promise handles map eviction
        // for `pendingConnectionWaits`; we mirror that conservativeness here).
        if (this.mcpConnectionWaitAborters.get(normalizedServerName) === abort) {
          this.mcpConnectionWaitAborters.delete(normalizedServerName);
        }
      };

      const abort = () => {
        cleanup();
        reject(
          new Error(
            `MCP server "${serverName}" wait aborted: session torn down before connection completed.`,
          ),
        );
      };

      const settleFromStatus = (status: McpServerStatus | undefined, error?: string) => {
        if (status === "connected") {
          cleanup();
          resolve();
        } else if (status === "failed") {
          cleanup();
          reject(connectionError(error));
        }
      };

      const listener = (event: BackendEvent) => {
        if (event.type !== "mcp-server-status") return;
        const eventServerName = toMcpServerKey(event.serverName);
        if (eventServerName !== normalizedServerName) return;
        settleFromStatus(event.status, event.error);
      };

      this.mcpStatusListeners.add(listener);
      this.mcpConnectionWaitAborters.set(normalizedServerName, abort);
      const current = this.mcpServerStatuses.get(normalizedServerName);
      settleFromStatus(current?.status, current?.error);
    }).finally(() => {
      this.pendingConnectionWaits.delete(normalizedServerName);
    });

    this.pendingConnectionWaits.set(normalizedServerName, promise);
    return promise;
  }

  // ── Status callback + backend-event sink ────────────────────────────────

  /**
   * Test wiring for the renderer-forwarding status callback (main.ts
   * forwards to webContents). Production callers go through
   * {@link connectPipeline}.
   */
  setMcpStatusCallback(callback: (event: BackendEvent) => void): void {
    this.mcpStatusCallback = callback;
  }

  /**
   * One-shot wiring helper: installs both the disabled-MCP provider and the
   * renderer-forwarding status callback. Production callers go through
   * {@link SessionManager.connectMcpPipeline}; the individual setters stay
   * public for unit tests that only want to wire one side.
   */
  connectPipeline(opts: {
    disabledProvider: (sessionId: string) => Set<string>;
    statusCallback: (event: BackendEvent) => void;
  }): void {
    this.setDisabledMcpProvider(opts.disabledProvider);
    this.setMcpStatusCallback(opts.statusCallback);
  }

  /**
   * Routes an MCP-namespaced backend event (`mcp-server-status`,
   * `mcp-oauth-required`, `mcp-oauth-completed`) into the status cache,
   * the registered callback, and the fan-out listener set. Returns
   * **true** if the event was MCP-namespaced (and thus handled here); the
   * caller MUST short-circuit further routing on a true return so that
   * non-MCP handlers don't double-process the same event.
   *
   * The `sessionId` carried in {@link ScopedLogger} is the originating
   * subscription's session — used both to scope log entries and to stamp
   * `mcp-oauth-required` events (the SDK does not carry it, and downstream
   * IPC needs it to pick the same session as the OAuth executor).
   */
  handleBackendEvent(event: BackendEvent, ctx: { sessionId: string; log: ScopedLogger }): boolean {
    if (
      event.type !== "mcp-server-status" &&
      event.type !== "mcp-oauth-required" &&
      event.type !== "mcp-oauth-completed"
    ) {
      return false;
    }

    if (event.type === "mcp-server-status") {
      this.mcpServerStatuses.set(toMcpServerKey(event.serverName), {
        serverName: event.serverName,
        status: event.status,
        error: event.error,
      });
    }
    if (event.type === "mcp-oauth-required") {
      // Stamp the originating sessionId from the caller's subscription
      // closure. The SDK event payload does not carry it (and the
      // normalizer is intentionally session-agnostic), but the IPC
      // handler needs it to pick the same session as the OAuth executor —
      // otherwise the login RPC may land on a different session whose
      // `mcpServers` config does not contain `serverName`, and the SDK
      // rejects with "MCP server not found".
      event = { ...event, sessionId: ctx.sessionId };
      ctx.log.info(
        `MCP OAuth required for "${event.serverName}" (${event.serverUrl}); CLI will open browser`,
      );
    } else if (event.type === "mcp-server-status" && event.status === "failed") {
      ctx.log.warn(`MCP server "${event.serverName}" failed: ${event.error ?? "unknown error"}`);
    }
    this.mcpStatusCallback?.(event);
    for (const listener of this.mcpStatusListeners) {
      listener(event);
    }
    return true;
  }
}
