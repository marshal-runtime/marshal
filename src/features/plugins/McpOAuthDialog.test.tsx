import type { McpsAPI, UserIdentity } from "@common/marshal-ipc-contract";
import { QueryClient } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  mcpOAuthStore,
  openMcpOAuthPrompt,
  wireMcpOAuth,
  type McpOAuthUiState,
} from "@/hooks/mcp-oauth-store";
import { installMockAPIs, render, screen, userEvent, waitFor, within } from "@/test-utils";

import { McpOAuthDialog } from "./McpOAuthDialog";

type ServerStatusCallback = Parameters<NonNullable<McpsAPI["onServerStatus"]>>[0];

function setupPrompt() {
  let serverStatus: ServerStatusCallback | undefined;
  installMockAPIs();
  window.identityAPI!.get = vi
    .fn<() => Promise<{ success: true; identity: UserIdentity }>>()
    .mockResolvedValue({
      success: true,
      identity: {
        isAuthenticated: true,
        displayName: "Jane Smith",
        subtitle: "janesmith",
        accountName: "janesmith@example.com",
        avatarUrl: null,
        statusColor: "success",
        statusText: "Connected",
        integrations: [],
        signOut: { title: "", description: "", confirmLabel: "" },
      },
    });
  window.mcpsAPI.onServerStatus = vi.fn<NonNullable<McpsAPI["onServerStatus"]>>((callback) => {
    serverStatus = callback;
    return vi.fn<() => void>();
  });
  window.mcpsAPI.initiateOAuth = vi
    .fn<McpsAPI["initiateOAuth"]>()
    .mockResolvedValue({ status: "success", oauthAlias: "janesmith@example.com" });

  return {
    emitServerStatus: (data: Parameters<ServerStatusCallback>[0]) => serverStatus?.(data),
  };
}

function collectUiStates(serverKey: string) {
  const states: McpOAuthUiState[] = [];
  const unsub = mcpOAuthStore.subscribe(() => {
    const s = mcpOAuthStore.getUiStateSnapshot()[serverKey];
    if (s) states.push({ ...s });
  });
  return { states, dispose: unsub };
}

describe("McpOAuthDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mcpOAuthStore.resetForTests();
  });

  afterEach(() => {
    mcpOAuthStore.resetForTests();
  });

  it("opens a foreground prompt for chat-time MCP auth and pre-fills the current alias", async () => {
    setupPrompt();
    const user = userEvent.setup();
    render(<McpOAuthDialog />);

    openMcpOAuthPrompt({ serverName: "powerbi", reason: "sign-in" });

    const dialog = await screen.findByRole("dialog", { name: "Sign in to powerbi" });
    expect(dialog).toHaveTextContent("Choose the account Marshal should use for this MCP server.");
    await waitFor(() => expect(window.identityAPI!.get).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByLabelText("Username or alias")).toHaveValue("janesmith@example.com");
    });

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      // 3rd arg is `options` — fields are undefined here because the
      // prompt was opened via `openMcpOAuthPrompt` (user-initiated, not a
      // chat-time event) and reason was not "switch".
      expect(window.mcpsAPI.initiateOAuth).toHaveBeenCalledWith(
        "powerbi",
        "janesmith@example.com",
        {
          contextSessionId: undefined,
          forceReauth: undefined,
        },
      );
    });
  });

  it("shows error message in dialog when initiateOAuth fails, dialog stays open", async () => {
    setupPrompt();
    const user = userEvent.setup();
    window.mcpsAPI.initiateOAuth = vi
      .fn<McpsAPI["initiateOAuth"]>()
      .mockResolvedValue({ status: "error", message: "Token exchange failed" });
    render(<McpOAuthDialog />);

    openMcpOAuthPrompt({ serverName: "powerbi", reason: "sign-in" });

    const dialog = await screen.findByRole("dialog", { name: "Sign in to powerbi" });
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Token exchange failed");
    });
    expect(dialog).toBeVisible();
  });

  // Pin: the renderer's "mcp-servers" query MUST be invalidated even
  // when the sign-in IPC throws after the SDK has already mutated token
  // state (the bug had `invalidateQueries` on `onSuccess`, so an error left
  // the renderer with a stale view of the server list). The fix uses
  // `onSettled`, which fires on both success and error.
  it("invalidates the mcp-servers query on error (pins onSettled vs onSuccess)", async () => {
    setupPrompt();
    window.mcpsAPI.initiateOAuth = vi
      .fn<McpsAPI["initiateOAuth"]>()
      .mockResolvedValue({ status: "error", message: "IPC failed after SDK mutated token state" });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const user = userEvent.setup();
    render(<McpOAuthDialog />, { queryClient });
    openMcpOAuthPrompt({ serverName: "powerbi", reason: "sign-in" });
    await screen.findByRole("dialog", { name: "Sign in to powerbi" });
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      // Error path: the mutation threw, the error banner is visible — yet
      // the renderer's mcp-servers cache must still be invalidated so a
      // partial sign-in (SDK side mutated, IPC rejected) doesn't leave the
      // UI showing the pre-mutation state.
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["mcp-servers"] });
    });
  });

  // Pin the second half of the fix: the mutation's `onSettled` now
  // *returns* the invalidate promise (instead of `void`-ing it), so TanStack
  // keeps `isPending` true until the cache refetch completes. That keeps
  // the submit button disabled across the post-IPC window where a stale
  // cache + a freshly enabled button would re-open the double-submit
  // window the void→return-promise change closed.
  //
  // We drive the assertion on the *error* path because the success path
  // closes the dialog (`mcpOAuthStore.close()` in `onSuccess`) before the
  // button can be observed — but `onSettled` fires on both branches with
  // the same returned-promise semantics, so the same invariant is at
  // stake. A future regression that puts `void` back on the
  // `invalidateQueries` call would re-enable the button immediately and
  // this test would fail.
  it("keeps the submit button disabled while invalidateQueries is pending (pins isPending continuity)", async () => {
    setupPrompt();
    window.mcpsAPI.initiateOAuth = vi
      .fn<McpsAPI["initiateOAuth"]>()
      .mockResolvedValue({ status: "error", message: "Token exchange failed" });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Never-resolving invalidate: TanStack will wait on the promise
    // returned from `onSettled`, so the mutation's `isPending` MUST stay
    // true the entire time this promise is unresolved.
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation(
      () => new Promise<void>(() => {}),
    );

    const user = userEvent.setup();
    render(<McpOAuthDialog />, { queryClient });
    openMcpOAuthPrompt({ serverName: "powerbi", reason: "sign-in" });
    const dialog = await screen.findByRole("dialog", { name: "Sign in to powerbi" });
    await user.click(within(dialog).getByRole("button", { name: "Sign in" }));

    // IPC has been called and rejected → onError + onSettled have fired.
    // isPending is still true (invalidate is pending), so the submit
    // button is labeled "Connecting..." and stays disabled. If `void`
    // were put back on `onSettled`, isPending would flip to false here
    // and the button would re-enable.
    await waitFor(() => {
      expect(window.mcpsAPI.initiateOAuth).toHaveBeenCalled();
    });
    const connectingButton = await within(dialog).findByRole("button", {
      name: "Connecting...",
    });
    expect(connectingButton).toBeDisabled();
  });

  it("updates store uiState to connected on successful sign-in", async () => {
    setupPrompt();
    const user = userEvent.setup();
    const { states, dispose } = collectUiStates("powerbi");
    render(<McpOAuthDialog />);

    openMcpOAuthPrompt({ serverName: "powerbi", reason: "sign-in" });
    await screen.findByRole("dialog", { name: "Sign in to powerbi" });
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(states.some((s) => s.state === "connected")).toBe(true);
    });
    dispose();
  });

  it("updates store uiState to failed on sign-in failure", async () => {
    setupPrompt();
    const user = userEvent.setup();
    window.mcpsAPI.initiateOAuth = vi
      .fn<McpsAPI["initiateOAuth"]>()
      .mockResolvedValue({ status: "error", message: "Token exchange failed" });
    const { states, dispose } = collectUiStates("powerbi");
    render(<McpOAuthDialog />);

    openMcpOAuthPrompt({ serverName: "powerbi", reason: "sign-in" });
    await screen.findByRole("dialog", { name: "Sign in to powerbi" });
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(states.some((s) => s.state === "failed")).toBe(true);
    });
    dispose();
  });

  it("onOAuthRequired IPC callback fires a blocking chat-required dialog", async () => {
    let oauthRequired: Parameters<NonNullable<McpsAPI["onOAuthRequired"]>>[0] | undefined;
    installMockAPIs();
    window.identityAPI!.get = vi
      .fn<() => Promise<{ success: true; identity: UserIdentity }>>()
      .mockResolvedValue({
        success: true,
        identity: {
          isAuthenticated: true,
          displayName: "Jane Smith",
          subtitle: "janesmith",
          accountName: "janesmith@example.com",
          avatarUrl: null,
          statusColor: "success",
          statusText: "Connected",
          integrations: [],
          signOut: { title: "", description: "", confirmLabel: "" },
        },
      });
    window.mcpsAPI.onOAuthRequired = vi.fn<NonNullable<McpsAPI["onOAuthRequired"]>>((callback) => {
      oauthRequired = callback;
      return vi.fn<() => void>();
    });

    // Wire the IPC subscriptions exactly as the renderer does at boot,
    // then dispatch a real IPC payload through the captured callback.
    const cleanup = wireMcpOAuth(new QueryClient());
    render(<McpOAuthDialog />);

    expect(oauthRequired).toBeDefined();
    oauthRequired!({
      requestId: "req-1",
      serverName: "powerbi",
      serverUrl: "https://powerbi.example.com",
    });

    const dialog = await screen.findByRole("dialog", { name: "Sign in to powerbi" });
    expect(dialog).toHaveTextContent(
      "Marshal needs you to sign in to powerbi before this MCP server can be used.",
    );
    cleanup();
  });

  it("chat-required path threads the originating sessionId into initiateOAuth", async () => {
    // Regression: the SDK emits mcp.oauth_required on a specific session.
    // Prior to the fix, the dialog dropped that sessionId and the IPC
    // handler asked sessionManager for getCurrentSessionId() — which could
    // be null (new-chat tab, init in flight) or could be a different
    // session from the originating one. With the fix, the sessionId rides
    // through event → store.contextSessionId → dialog submit → IPC.
    let oauthRequired: Parameters<NonNullable<McpsAPI["onOAuthRequired"]>>[0] | undefined;
    installMockAPIs();
    window.identityAPI!.get = vi
      .fn<() => Promise<{ success: true; identity: UserIdentity }>>()
      .mockResolvedValue({
        success: true,
        identity: {
          isAuthenticated: true,
          displayName: "Jane Smith",
          subtitle: "janesmith",
          accountName: "janesmith@example.com",
          avatarUrl: null,
          statusColor: "success",
          statusText: "Connected",
          integrations: [],
          signOut: { title: "", description: "", confirmLabel: "" },
        },
      });
    window.mcpsAPI.onOAuthRequired = vi.fn<NonNullable<McpsAPI["onOAuthRequired"]>>((callback) => {
      oauthRequired = callback;
      return vi.fn<() => void>();
    });
    window.mcpsAPI.initiateOAuth = vi
      .fn<McpsAPI["initiateOAuth"]>()
      .mockResolvedValue({ status: "success", oauthAlias: "janesmith@example.com" });

    const user = userEvent.setup();
    const cleanup = wireMcpOAuth(new QueryClient());
    render(<McpOAuthDialog />);

    expect(oauthRequired).toBeDefined();
    oauthRequired!({
      requestId: "req-1",
      serverName: "powerbi",
      serverUrl: "https://powerbi.example.com",
      sessionId: "sess-originating",
    });

    await screen.findByRole("dialog", { name: "Sign in to powerbi" });
    await waitFor(() => {
      expect(screen.getByLabelText("Username or alias")).toHaveValue("janesmith@example.com");
    });
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(window.mcpsAPI.initiateOAuth).toHaveBeenCalledWith(
        "powerbi",
        "janesmith@example.com",
        {
          contextSessionId: "sess-originating",
        },
      );
    });
    cleanup();
  });

  it("threads forceReauth through to initiateOAuth when the prompt requests it", async () => {
    // User-initiated re-sign-in on a signed-in-but-account-unknown server
    // (the "Sign in" button on a card already showing "Signed in (account
    // unknown)"). The IPC default heuristic uses `forceReauth = !!loginHint`,
    // which would silently let the SDK reuse the cached token when the user
    // submits an empty alias. The dialog must surface the explicit signal so
    // the cached token is dropped and the OAuth flow truly restarts.
    setupPrompt();
    const user = userEvent.setup();
    render(<McpOAuthDialog />);

    openMcpOAuthPrompt({
      serverName: "powerbi",
      reason: "sign-in",
      forceReauth: true,
    });

    await screen.findByRole("dialog", { name: "Sign in to powerbi" });
    await waitFor(() => {
      expect(screen.getByLabelText("Username or alias")).toHaveValue("janesmith@example.com");
    });
    // Clear the prefilled alias so we exercise the empty-alias submit path —
    // this is the exact condition where the default heuristic would otherwise
    // pick forceReauth=false. The explicit prompt-level flag must still win.
    await user.clear(screen.getByLabelText("Username or alias"));
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(window.mcpsAPI.initiateOAuth).toHaveBeenCalledWith("powerbi", undefined, {
        forceReauth: true,
      });
    });
  });

  it("onServerStatus(needs-auth) does NOT auto-open the dialog (passive notification)", async () => {
    // The app-status rail / Plugins panel surface the Sign in CTA based on
    // server status; clicking that CTA opens the dialog explicitly. The IPC
    // event itself must not pop a modal at session start, since the user may
    // not need that server in the current session.
    let serverStatus: Parameters<NonNullable<McpsAPI["onServerStatus"]>>[0] | undefined;
    installMockAPIs();
    window.mcpsAPI.onServerStatus = vi.fn<NonNullable<McpsAPI["onServerStatus"]>>((callback) => {
      serverStatus = callback;
      return vi.fn<() => void>();
    });

    const cleanup = wireMcpOAuth(new QueryClient());
    render(<McpOAuthDialog />);

    expect(serverStatus).toBeDefined();
    serverStatus!({ serverName: "powerbi", status: "needs-auth" });

    // Wait a tick to let any (incorrect) async dialog open paths flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mcpOAuthStore.getPromptSnapshot()).toBeNull();

    cleanup();
  });

  it("Cancel closes the dialog and sets uiState to idle", async () => {
    setupPrompt();
    const user = userEvent.setup();
    const { states, dispose } = collectUiStates("powerbi");
    render(<McpOAuthDialog />);

    openMcpOAuthPrompt({ serverName: "powerbi", reason: "sign-in" });
    await screen.findByRole("dialog", { name: "Sign in to powerbi" });

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(states.some((s) => s.state === "idle")).toBe(true);
    dispose();
  });

  it("disables buttons and blocks dismiss while sign-in is in progress", async () => {
    setupPrompt();
    const user = userEvent.setup();
    window.mcpsAPI.initiateOAuth = vi
      .fn<McpsAPI["initiateOAuth"]>()
      .mockReturnValue(new Promise(() => {}));

    render(<McpOAuthDialog />);

    openMcpOAuthPrompt({ serverName: "powerbi", reason: "sign-in" });
    await screen.findByRole("dialog", { name: "Sign in to powerbi" });

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Connecting..." })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    });
    expect(screen.getByRole("dialog")).toBeVisible();
  });
});

describe("mcpOAuthStore.open same-server coalesce", () => {
  beforeEach(() => {
    mcpOAuthStore.resetForTests();
  });
  afterEach(() => {
    mcpOAuthStore.resetForTests();
  });

  it("merges newer fields onto an in-flight prompt for the same server", () => {
    // Self-review F4: a non-blocking "sign-in" prompt followed by a blocking
    // "chat-required" prompt for the same server must escalate to blocking
    // rather than be silently dropped. Local dialog state (alias text the
    // user is typing) lives in component state, not in the store, so the
    // merge does not clobber user input.
    mcpOAuthStore.open({ serverName: "powerbi", reason: "sign-in" });
    mcpOAuthStore.open({ serverName: "powerbi", reason: "chat-required", blocking: true });

    const prompt = mcpOAuthStore.getPromptSnapshot();
    expect(prompt).toEqual({
      serverName: "powerbi",
      reason: "chat-required",
      blocking: true,
    });
  });

  it("notifies subscribers when a same-server open() merges new fields", () => {
    mcpOAuthStore.open({ serverName: "powerbi", reason: "sign-in" });
    let notifyCount = 0;
    const unsub = mcpOAuthStore.subscribe(() => {
      notifyCount++;
    });
    mcpOAuthStore.open({ serverName: "powerbi", reason: "switch" });
    unsub();
    expect(notifyCount).toBe(1);
    expect(mcpOAuthStore.getPromptSnapshot()?.reason).toBe("switch");
  });

  it("replaces the prompt when serverName differs", () => {
    mcpOAuthStore.open({ serverName: "powerbi", reason: "sign-in" });
    mcpOAuthStore.open({ serverName: "tracker", reason: "switch" });
    expect(mcpOAuthStore.getPromptSnapshot()).toEqual({
      serverName: "tracker",
      reason: "switch",
    });
  });
});
