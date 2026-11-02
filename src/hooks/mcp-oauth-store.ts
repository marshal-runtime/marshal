import { toMcpServerKey } from "@common/mcp-server-key-normalization";
import {
  useIsMutating,
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

export interface McpOAuthPromptRequest {
  serverName: string;
  defaultLoginHint?: string;
  reason?: "sign-in" | "retry" | "switch" | "chat-required";
  blocking?: boolean;
  /**
   * Originating session id for chat-time prompts. Threaded back to the OAuth
   * IPC handler on sign-in submit so the SDK's `oauth.login` runs on the
   * same session whose tool call triggered the prompt — that session's
   * `mcpServers` config is what defines `serverName`'s URL/scheme. Absent
   * for user-initiated sign-in (Settings / app-status rail / Extensions panel
   * Sign-in buttons); the handler then picks any live session.
   */
  contextSessionId?: string;
  /**
   * Explicit force-reauth signal from the caller. When set, the IPC handler
   * passes `forceReauth: true` to the SDK regardless of whether the user
   * supplied an alias, so a cached token is dropped and a fresh OAuth flow
   * runs. Used for user-initiated re-sign-in on already-signed-in servers
   * (Switch account, Sign in on alias-unknown). When omitted the IPC falls
   * back to inferring force-reauth from the presence of a loginHint, which
   * matches the chat-required path where the SDK may already have a valid
   * cached token to reuse.
   */
  forceReauth?: boolean;
}

export interface McpOAuthUiState {
  serverKey: string;
  state: "idle" | "connecting" | "connected" | "failed";
  alias?: string;
  error?: string;
}

// Module-level state — single source of truth for OAuth prompt and per-server UI state.
// Subscribers are React useSyncExternalStore callbacks; all mutations call emit() to
// notify them synchronously so React's scheduler sees a consistent snapshot.

const listeners = new Set<() => void>();
let prompt: McpOAuthPromptRequest | null = null;
let uiStates: Readonly<Record<string, McpOAuthUiState>> = {};

function emit(): void {
  for (const l of listeners) l();
}

export const mcpOAuthStore = {
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  getPromptSnapshot(): McpOAuthPromptRequest | null {
    return prompt;
  },
  getUiStateSnapshot(): Readonly<Record<string, McpOAuthUiState>> {
    return uiStates;
  },
  open(request: McpOAuthPromptRequest): void {
    // Same-server coalesce: a second event for an already-open prompt
    // (e.g. user-initiated `connect` followed by an SDK-driven `chat-required`
    // for the same server) must not blow away local dialog state — but we DO
    // want any new context (different reason / blocking flag /
    // defaultLoginHint) to take effect, since a non-blocking "connect" prompt
    // followed by a blocking "chat-required" prompt should escalate, not be
    // silently dropped. Merge newer fields onto the existing prompt; alias
    // text the user has typed lives in dialog component state, not in the
    // store, so it is preserved.
    if (prompt && prompt.serverName === request.serverName) {
      prompt = { ...prompt, ...request };
      emit();
      return;
    }
    prompt = request;
    emit();
  },
  close(): void {
    prompt = null;
    emit();
  },
  setUiState(serverKey: string, state: McpOAuthUiState): void {
    uiStates = { ...uiStates, [serverKey]: state };
    emit();
  },
  /**
   * Drop the UI state row for a server entirely. Called after a successful
   * sign-out so the card no longer reports `state: "connected"` (which
   * `isMcpServerSignedIn` honours preferentially over backend status —
   * leaving stale "connected" would render the card as still signed in
   * even after the tokens were dropped).
   */
  clearUiState(serverKey: string): void {
    if (!(serverKey in uiStates)) return;
    const next = { ...uiStates };
    delete next[serverKey];
    uiStates = next;
    emit();
  },
  /**
   * Reset all module-level state. Tests only — call from `beforeEach` so that
   * `uiStates` from a prior test does not leak into the next one (`close()`
   * alone only clears `prompt`).
   */
  resetForTests(): void {
    prompt = null;
    uiStates = {};
    listeners.clear();
  },
};

export function openMcpOAuthPrompt(request: McpOAuthPromptRequest): void {
  mcpOAuthStore.open(request);
}

/**
 * Wire MCP OAuth IPC subscriptions. Call once at app boot (inside a useEffect
 * with `[queryClient]` deps). Returns a cleanup function for useEffect.
 *
 * Owns both the prompt-opening AND the cache invalidation lifecycle, so cache
 * invalidation no longer depends on the Extensions panel being mounted.
 *
 * Only `onOAuthRequired` opens the OAuth prompt — that event signals the SDK
 * is blocked on auth for an in-flight tool call, so the modal interrupt is
 * warranted. `onServerStatus("needs-auth")` is a passive status notification
 * (e.g. an MCP server reports it needs auth at session start); it invalidates
 * the cache so the app-status rail / Extensions panel surface the
 * "Sign in" CTA, but does NOT auto-open a modal — the user opts in by
 * clicking the CTA. This avoids a modal-on-startup interruption when the
 * user may not need that server in the current session.
 */
export function wireMcpOAuth(queryClient: QueryClient): () => void {
  if (!window.mcpsAPI) return () => {};
  const api = window.mcpsAPI;
  const cleanup: Array<() => void> = [];
  // Event-listener context — TanStack cannot await callbacks passed to
  // listeners (unlike mutation `onSettled`), so the `void` is intentional.
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });

  if (api.onOAuthRequired) {
    cleanup.push(
      api.onOAuthRequired(({ serverName, sessionId }) => {
        mcpOAuthStore.open({
          serverName,
          reason: "chat-required",
          blocking: true,
          contextSessionId: sessionId,
        });
      }),
    );
  }
  if (api.onServerStatus) {
    cleanup.push(
      api.onServerStatus(() => {
        // Refresh cached server status so passive surfaces (app-status rail,
        // Extensions panel) re-render with the latest state. We deliberately
        // do NOT open the OAuth prompt here — see the function comment.
        invalidate();
      }),
    );
  }
  if (api.onOAuthCompleted) {
    cleanup.push(api.onOAuthCompleted(() => invalidate()));
  }

  return () => {
    for (const fn of cleanup) fn();
  };
}

/**
 * `useMutation` wrapper for the per-server `mcps:signOut` IPC. Keyed on the
 * normalized server key so `useIsMutatingMcpServerSignOut(name)` can observe
 * pending state from any surface (carousel card, detail dialog) and disable
 * the corresponding buttons.
 *
 * On success: drops the UI state row for the server (otherwise a stale
 * `state: "connected"` would keep `isMcpServerSignedIn` returning true).
 * On error: surfaces a toast — the IPC handler has already audit-logged
 * the failure and the alias may or may not have been cleared by
 * `SessionManager.signOutMcpOAuth` (forceReauth deletes the token first;
 * if anything after that throws the alias is still cleared, so the card
 * lands in a recoverable state).
 * On settled: invalidates `["mcp-servers"]` so cards re-render with the
 * freshest backend status.
 */
export function useSignOutMcpServerMutation(serverName: string) {
  const queryClient = useQueryClient();
  const serverKey = toMcpServerKey(serverName);
  return useMutation({
    mutationKey: ["mcp-signout", serverKey],
    mutationFn: async (): Promise<void> => {
      const api = window.mcpsAPI;
      if (!api?.signOut) {
        throw new Error("MCP API unavailable");
      }
      const result = await api.signOut(serverName);
      if (result?.status === "error") {
        throw new Error(result.message);
      }
    },
    onSuccess: () => {
      mcpOAuthStore.clearUiState(serverKey);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : String(err));
    },
    // Return the invalidate promise so TanStack awaits the refetch — keeps
    // `isPending` true until the cache has caught up, so callers driving the
    // disable state via `useIsMutating` stay disabled through the refetch.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
  });
}

/**
 * Cross-component disable signal for sign-out buttons. Returns true while a
 * `mcps:signOut` IPC for this server is in flight, regardless of which
 * surface kicked it off. The dialog and the carousel card share the same
 * mutation key, so both disable in lockstep without manually mirroring
 * state through the OAuth store.
 */
export function useIsMutatingMcpServerSignOut(serverName: string): boolean {
  return useIsMutating({ mutationKey: ["mcp-signout", toMcpServerKey(serverName)] }) > 0;
}
