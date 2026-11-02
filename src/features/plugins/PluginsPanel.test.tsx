import type { McpsAPI, RuntimeExtensionsAPI } from "@common/marshal-ipc-contract";
import type { RuntimeExtensionCatalogEntry } from "@marshal/runtime/extensions";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { mcpOAuthStore, type McpOAuthPromptRequest } from "@/hooks/mcp-oauth-store";
import { installMockAPIs, render, screen, userEvent, waitFor, within, act } from "@/test-utils";

import { PluginsPanel } from "./PluginsPanel";

function collectPromptEvents() {
  const details: McpOAuthPromptRequest[] = [];
  const spy = vi.spyOn(mcpOAuthStore, "open").mockImplementation((req) => {
    details.push(req);
  });
  return {
    details,
    dispose: () => spy.mockRestore(),
  };
}

describe("PluginsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
  });

  it("returns null when isOpen is false", () => {
    const { container } = render(<PluginsPanel isOpen={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders panel header 'Plugins'", () => {
    render(<PluginsPanel isOpen={true} />);
    expect(screen.getByText("Plugins")).toBeInTheDocument();
  });

  it("shows Skills and MCP Servers tabs", () => {
    render(<PluginsPanel isOpen={true} />);
    expect(screen.getByRole("tab", { name: "Skills" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "MCP Servers" })).toBeInTheDocument();
  });

  it("hides UI Plugins tab when showUiPluginsTab is false", () => {
    render(<PluginsPanel isOpen={true} showUiPluginsTab={false} />);
    expect(screen.queryByRole("tab", { name: "UI Plugins" })).not.toBeInTheDocument();
  });

  it("shows and renders UI Plugins tab when showUiPluginsTab is true", async () => {
    const user = userEvent.setup();
    render(<PluginsPanel isOpen={true} showUiPluginsTab={true} />);

    const uiPluginsTab = screen.getByRole("tab", { name: "UI Plugins" });
    expect(uiPluginsTab).toBeInTheDocument();

    await user.click(uiPluginsTab);
    expect(await screen.findByText("No UI plugins registered")).toBeInTheDocument();
  });

  it("renders Runtime catalog entries alongside the legacy catalog and routes lifecycle actions", async () => {
    const runtimeEntry: RuntimeExtensionCatalogEntry = {
      id: "catalog://native/fixture",
      identity: "@fixture/runtime-extension",
      version: "1.0.0",
      origin: "native",
      originLabel: "Native",
      title: "Runtime Fixture",
      description: "Fixture Runtime extension",
      sourceId: "native",
      sourceLabel: "Native",
      sourceOrder: 0,
      order: 0,
      request: {
        packageRoot: "C:\\runtime-extensions\\fixture",
        integrity: {
          algorithm: "sha256",
          domain: "marshal-runtime-extension-package-v1",
          value: "a".repeat(64),
        },
      },
      installation: {
        identity: "@fixture/runtime-extension",
        version: "1.0.0",
        integrity: {
          algorithm: "sha256",
          domain: "marshal-runtime-extension-package-v1",
          value: "a".repeat(64),
        },
        entrypoint: "dist/index.cjs",
        status: "enabled",
        activationOrder: 1,
        configuration: {},
      },
      isCurrentVersion: true,
    };
    const disable = vi.fn<RuntimeExtensionsAPI["disable"]>().mockResolvedValue({
      success: true,
      value: { ...runtimeEntry.installation!, status: "disabled" },
    });
    installMockAPIs({
      runtimeExtensionsAPI: {
        search: vi.fn<RuntimeExtensionsAPI["search"]>().mockResolvedValue({
          success: true,
          value: {
            query: "",
            matches: [
              {
                entry: runtimeEntry,
                score: 1,
                matchedTerms: [],
                matchedFields: [],
              },
            ],
          },
        }),
        disable,
      },
    });
    const user = userEvent.setup();
    render(
      <PluginsPanel
        isOpen={true}
        runtimeScope={{ sessionId: "session-1", workspaceName: "workspace-1" }}
      />,
    );

    expect(await screen.findByText("Runtime Fixture")).toBeInTheDocument();
    expect(screen.getByText(/Native · v1\.0\.0/)).toBeInTheDocument();
    expect(screen.getByText("Bundled Skills")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() =>
      expect(disable).toHaveBeenCalledWith({
        sessionId: "session-1",
        workspaceName: "workspace-1",
        identity: runtimeEntry.identity,
      }),
    );
  });

  it("installs and builds a detected unbuilt Runtime extension from its package root", async () => {
    const packageRoot = "C:\\runtime-extensions\\unbuilt-fixture";
    const installLocal = vi.fn<RuntimeExtensionsAPI["installLocal"]>().mockResolvedValue({
      success: true,
      value: {
        identity: "@fixture/unbuilt",
        version: "1.0.0",
        integrity: {
          algorithm: "sha256",
          domain: "marshal-runtime-extension-package-v1",
          value: "b".repeat(64),
        },
        entrypoint: "dist/index.cjs",
        status: "enabled",
        activationOrder: 1,
        configuration: {},
      },
    });
    installMockAPIs({
      runtimeExtensionsAPI: {
        status: vi.fn<RuntimeExtensionsAPI["status"]>().mockImplementation(async (request) => ({
          success: true,
          value: {
            ...request,
            revision: 4,
            scannedAt: "2026-08-29T00:00:00.000Z",
            discoveryStatus: "ready",
            items: [
              {
                candidateId: packageRoot,
                identity: "@fixture/unbuilt",
                version: "1.0.0",
                packageRoot,
                status: "unbuilt",
                installation: { script: "install:marshal", packageManager: "pnpm" },
                diagnostics: [
                  {
                    code: "entrypoint_missing",
                    path: `${packageRoot}\\dist\\index.cjs`,
                    message: "Runtime extension entrypoint has not been built.",
                  },
                ],
              },
            ],
            diagnostics: [],
          },
        })),
        installLocal,
      },
    });
    const user = userEvent.setup();
    render(
      <PluginsPanel
        isOpen={true}
        runtimeScope={{ sessionId: "session-1", workspaceName: "workspace-1" }}
      />,
    );

    expect(await screen.findByText("@fixture/unbuilt")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Install and build" }));

    await waitFor(() =>
      expect(installLocal).toHaveBeenCalledWith({
        sessionId: "session-1",
        workspaceName: "workspace-1",
        packageRoot,
      }),
    );
  });

  it("shows search input after clicking search icon", async () => {
    const user = userEvent.setup();
    render(<PluginsPanel isOpen={true} />);
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByPlaceholderText("Search skills...")).toBeInTheDocument();
  });

  it("shows a sign-in action for URL MCP servers that need auth", async () => {
    installMockAPIs();
    const initiateOAuth = vi
      .fn<McpsAPI["initiateOAuth"]>()
      .mockResolvedValue({ status: "success" });
    window.mcpsAPI.initiateOAuth = initiateOAuth;
    window.mcpsAPI.list = vi.fn<McpsAPI["list"]>().mockResolvedValue({
      success: true,
      servers: [
        {
          key: "powerbi",
          name: "powerbi",
          builtin: false,
          status: "needs-auth",
          requiresOAuth: true,
          config: { name: "powerbi", url: "https://mcp.powerbi.com/mcp", type: "http" },
        },
      ],
    });

    const user = userEvent.setup();
    render(<PluginsPanel isOpen={true} initialTab="mcp-servers" />);

    await user.click(await screen.findByText("powerbi"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText("https://mcp.powerbi.com/mcp").length).toBeGreaterThan(0);

    const prompts = collectPromptEvents();
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(initiateOAuth).not.toHaveBeenCalled();
    expect(prompts.details[0]).toMatchObject({
      serverName: "powerbi",
      reason: "sign-in",
    });
    prompts.dispose();
  });

  it("starts config sign-in with the stored display name when status is keyed by SDK name", async () => {
    installMockAPIs();
    const initiateOAuth = vi
      .fn<McpsAPI["initiateOAuth"]>()
      .mockResolvedValue({ status: "success" });
    window.mcpsAPI.initiateOAuth = initiateOAuth;
    window.mcpsAPI.list = vi.fn<McpsAPI["list"]>().mockResolvedValue({
      success: true,
      servers: [
        {
          key: "power_bi_mcp",
          name: "Power BI MCP",
          builtin: false,
          status: "needs-auth",
          requiresOAuth: true,
          config: { name: "Power BI MCP", url: "https://mcp.powerbi.com/mcp", type: "http" },
        },
      ],
    });

    const user = userEvent.setup();
    render(<PluginsPanel isOpen={true} initialTab="mcp-servers" />);

    await user.click(await screen.findByText("Power BI MCP"));
    const prompts = collectPromptEvents();
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(initiateOAuth).not.toHaveBeenCalled();
    expect(prompts.details[0]).toMatchObject({
      serverName: "Power BI MCP",
      reason: "sign-in",
    });
    prompts.dispose();
  });

  it("shows a status for URL MCP servers even before the SDK reports one", async () => {
    installMockAPIs();
    window.mcpsAPI.list = vi.fn<McpsAPI["list"]>().mockResolvedValue({
      success: true,
      servers: [
        {
          key: "power_bi_mcp",
          name: "Power BI MCP",
          builtin: false,
          requiresOAuth: true,
          config: {
            name: "Power BI MCP",
            url: "https://mcp.example.com/v1/mcp/powerbi",
            type: "http",
          },
        },
      ],
    });

    const user = userEvent.setup();
    render(<PluginsPanel isOpen={true} initialTab="mcp-servers" />);

    expect(await screen.findByText(/Not signed in/)).toBeInTheDocument();
    expect(
      await screen.findByText(/https:\/\/mcp\.example\.com\/v1\/mcp\/powerbi/),
    ).toBeInTheDocument();

    await user.click(screen.getByText("Power BI MCP"));
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText("Status")).toBeInTheDocument();
    expect(within(dialog).getByText("Not signed in")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("opens the shared sign-in prompt from the detail-dialog Re-authenticate action", async () => {
    installMockAPIs();
    window.mcpsAPI.list = vi.fn<McpsAPI["list"]>().mockResolvedValue({
      success: true,
      servers: [
        {
          key: "power_bi_mcp",
          name: "Power BI MCP",
          builtin: false,
          requiresOAuth: true,
          oauthAlias: "alice@example.com",
          config: {
            name: "Power BI MCP",
            url: "https://mcp.example.com/v1/mcp/powerbi",
            type: "http",
            oauthAlias: "alice@example.com",
          },
        },
      ],
    });

    const user = userEvent.setup();
    render(<PluginsPanel isOpen={true} initialTab="mcp-servers" />);

    expect(await screen.findByText(/Signed in as alice@example.com/)).toBeInTheDocument();
    await user.click(screen.getByText("Power BI MCP"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Signed in as alice@example.com")).toBeInTheDocument();

    const prompts = collectPromptEvents();
    // Signed-in maintenance actions live in the detail dialog only; the
    // carousel card is status-only when signed in.
    await user.click(within(dialog).getByRole("button", { name: "Re-authenticate" }));

    expect(prompts.details[0]).toMatchObject({
      serverName: "Power BI MCP",
      defaultLoginHint: "alice@example.com",
      reason: "switch",
      // Re-authenticate on an already signed-in server must force a fresh
      // OAuth flow so the SDK drops cached tokens — otherwise it silently
      // reconnects as the same account.
      forceReauth: true,
    });
    prompts.dispose();
  });

  it("adds remote MCP servers without automatically starting OAuth", async () => {
    installMockAPIs();
    const addMcp = vi
      .fn<McpsAPI["add"]>()
      .mockResolvedValue({ success: true, name: "Power BI MCP", needsOAuth: true });
    const initiateOAuth = vi
      .fn<McpsAPI["initiateOAuth"]>()
      .mockResolvedValue({ status: "success" });
    window.mcpsAPI.add = addMcp;
    window.mcpsAPI.initiateOAuth = initiateOAuth;
    window.mcpsAPI.list = vi.fn<McpsAPI["list"]>().mockResolvedValue({
      success: true,
      servers: [],
    });

    const user = userEvent.setup();
    render(<PluginsPanel isOpen={true} initialTab="mcp-servers" />);

    await user.click(await screen.findByRole("button", { name: "Add Server" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("Server name"), "Power BI MCP");
    await user.type(
      within(dialog).getByPlaceholderText("https://... or http://localhost:..."),
      "https://mcp.example.com/v1/mcp/powerbi",
    );
    expect(within(dialog).queryByRole("button", { name: "Add & Connect" })).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(addMcp).toHaveBeenCalled());
    expect(initiateOAuth).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        'Added MCP server "Power BI MCP". Use Sign in on the card to authenticate.',
      ),
    ).toBeInTheDocument();
  });

  it("shows runtime MCP servers from SDK status and starts sign-in", async () => {
    installMockAPIs();
    const initiateOAuth = vi
      .fn<McpsAPI["initiateOAuth"]>()
      .mockResolvedValue({ status: "success" });
    window.mcpsAPI.initiateOAuth = initiateOAuth;
    window.mcpsAPI.list = vi.fn<McpsAPI["list"]>().mockResolvedValue({
      success: true,
      servers: [
        {
          key: "powerbi_remote",
          name: "powerbi-remote",
          builtin: false,
          status: "needs-auth",
          requiresOAuth: true,
        },
      ],
    });

    const user = userEvent.setup();
    render(<PluginsPanel isOpen={true} initialTab="mcp-servers" />);

    expect(await screen.findByText("Sign-in required")).toBeInTheDocument();
    await user.click(screen.getByText("powerbi-remote"));
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText("Status")).toBeInTheDocument();
    expect(within(dialog).getByText("Sign-in required")).toBeInTheDocument();

    const prompts = collectPromptEvents();
    await user.click(within(dialog).getByRole("button", { name: "Sign in" }));

    expect(initiateOAuth).not.toHaveBeenCalled();
    expect(prompts.details[0]).toMatchObject({
      serverName: "powerbi-remote",
      reason: "sign-in",
    });
    prompts.dispose();
  });

  it("shows retry sign-in for failed runtime MCP servers", async () => {
    installMockAPIs();
    const initiateOAuth = vi
      .fn<McpsAPI["initiateOAuth"]>()
      .mockResolvedValue({ status: "success" });
    window.mcpsAPI.initiateOAuth = initiateOAuth;
    window.mcpsAPI.list = vi.fn<McpsAPI["list"]>().mockResolvedValue({
      success: true,
      servers: [
        {
          key: "powerbi_remote",
          name: "powerbi-remote",
          builtin: false,
          status: "failed",
          requiresOAuth: true,
          error: "OAuth token expired",
        },
      ],
    });

    const user = userEvent.setup();
    render(<PluginsPanel isOpen={true} initialTab="mcp-servers" />);

    expect(await screen.findByText("Failed · OAuth token expired")).toBeInTheDocument();
    await user.click(screen.getByText("powerbi-remote"));
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText("Failed")).toBeInTheDocument();
    expect(within(dialog).getByText("OAuth token expired")).toBeInTheDocument();

    const prompts = collectPromptEvents();
    await user.click(within(dialog).getByRole("button", { name: "Retry sign in" }));

    expect(initiateOAuth).not.toHaveBeenCalled();
    expect(prompts.details[0]).toMatchObject({
      serverName: "powerbi-remote",
      reason: "retry",
    });
    prompts.dispose();
  });

  it.each([
    { status: "pending" as const, label: "Connecting", withAlias: false },
    {
      status: "connected" as const,
      label: "Signed in as user@example.com",
      withAlias: true,
    },
  ])(
    "does not show sign-in actions for $status runtime MCP servers",
    async ({ status, label, withAlias }) => {
      installMockAPIs();
      window.mcpsAPI.list = vi.fn<McpsAPI["list"]>().mockResolvedValue({
        success: true,
        servers: [
          {
            key: "powerbi_remote",
            name: "powerbi-remote",
            builtin: false,
            status,
            requiresOAuth: true,
            ...(withAlias
              ? {
                  oauthAlias: "user@example.com",
                  config: {
                    name: "powerbi-remote",
                    url: "https://mcp.example.com/v1/mcp/powerbi",
                    type: "http" as const,
                    oauthAlias: "user@example.com",
                  },
                }
              : {}),
          },
        ],
      });

      const user = userEvent.setup();
      render(<PluginsPanel isOpen={true} initialTab="mcp-servers" />);

      // The "with alias" case appends ` · <url>` to the description, so use
      // a substring matcher; the no-alias / no-config case has just the label.
      const matcher = withAlias ? new RegExp(label.replace(/\./g, "\\.")) : label;
      expect(await screen.findByText(matcher)).toBeInTheDocument();
      await user.click(screen.getByText("powerbi-remote"));
      const dialog = screen.getByRole("dialog");

      expect(within(dialog).queryByRole("button", { name: "Sign in" })).toBeNull();
      expect(within(dialog).queryByRole("button", { name: "Retry sign in" })).toBeNull();
    },
  );

  // Regression for: deleted + recreated remote MCP server scenario where the
  // SDK auto-connects on cached OAuth tokens but our store has no
  // oauthAlias. We must NOT pretend to know the account — surface that
  // explicitly. After the "Re-authenticate" rollup, the primary action label
  // is the same for alias-known and alias-unknown signed-in servers
  // ("Re-authenticate"); the disambiguation lives in the status row.
  it("shows 'Signed in (account unknown)' and a Re-authenticate button when an OAuth server is connected without an alias", async () => {
    installMockAPIs();
    window.mcpsAPI.list = vi.fn<McpsAPI["list"]>().mockResolvedValue({
      success: true,
      servers: [
        {
          key: "powerbi_remote",
          name: "powerbi-remote",
          builtin: false,
          status: "connected",
          requiresOAuth: true,
          // Note: no oauthAlias — emulates SDK auto-connecting on cached
          // tokens after the user deleted and recreated the server.
          config: {
            name: "powerbi-remote",
            url: "https://mcp.example.com/v1/mcp/powerbi",
            type: "http" as const,
          },
        },
      ],
    });

    const user = userEvent.setup();
    render(<PluginsPanel isOpen={true} initialTab="mcp-servers" />);

    // Card description includes URL after status label, so use regex.
    expect(await screen.findByText(/Signed in \(account unknown\)/)).toBeInTheDocument();

    await user.click(screen.getByText("powerbi-remote"));
    const dialog = screen.getByRole("dialog");

    // Status detail row in dialog renders the label alone (no URL suffix).
    expect(within(dialog).getByText("Signed in (account unknown)")).toBeInTheDocument();
    // Action button is "Re-authenticate" (forceReauth=true) regardless of
    // whether the alias is known — see getMcpOAuthAction.
    expect(within(dialog).getByRole("button", { name: "Re-authenticate" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Switch account" })).toBeNull();
  });

  // Regression for the same scenario above: the detail-dialog Re-authenticate
  // action must force a fresh OAuth flow. Without `forceReauth: true` the IPC
  // handler's default heuristic (`forceReauth = !!loginHint`) would let the
  // SDK silently reuse the cached token whenever the user submits an empty
  // alias — leaving the user stuck signed in as the same unknown account.
  it("threads forceReauth=true when Re-authenticate is clicked in the detail dialog on a signed-in alias-unknown server", async () => {
    installMockAPIs();
    window.mcpsAPI.list = vi.fn<McpsAPI["list"]>().mockResolvedValue({
      success: true,
      servers: [
        {
          key: "powerbi_remote",
          name: "powerbi-remote",
          builtin: false,
          status: "connected",
          requiresOAuth: true,
          config: {
            name: "powerbi-remote",
            url: "https://mcp.example.com/v1/mcp/powerbi",
            type: "http" as const,
          },
        },
      ],
    });

    const user = userEvent.setup();
    render(<PluginsPanel isOpen={true} initialTab="mcp-servers" />);

    expect(await screen.findByText(/Signed in \(account unknown\)/)).toBeInTheDocument();

    await user.click(screen.getByText("powerbi-remote"));
    const dialog = screen.getByRole("dialog");

    const prompts = collectPromptEvents();
    await user.click(within(dialog).getByRole("button", { name: "Re-authenticate" }));

    expect(prompts.details[0]).toMatchObject({
      serverName: "powerbi-remote",
      reason: "switch",
      forceReauth: true,
    });
    prompts.dispose();
  });

  // Pins the full detail-dialog button cycle that the Round-6 architectural
  // rollup specifically fixed. A future revert that re-introduces the snapshot
  // read (i.e. caches `selectedCustom.primaryActionLabel` instead of deriving
  // from `oauthUiStates`) would freeze the label at "Sign in" through the
  // entire flow — this test asserts we re-render through "Connecting..." and
  // then auto-close the dialog when the server reaches "connected".
  it("cycles detail dialog button: Sign in → Connecting... → auto-close on connected", async () => {
    mcpOAuthStore.resetForTests();
    installMockAPIs();
    // Pin: the rising-edge auto-close must run from a `useEffect`,
    // not from a render-phase `setState` on the parent. The react-compiler
    // lint rule catches render-phase setState statically (it rejected a
    // useRef-during-render attempt), so the regression is pinned at the lint level —
    // this test just exercises the dialog-cycling behavior end to end.
    window.mcpsAPI.list = vi.fn<McpsAPI["list"]>().mockResolvedValue({
      success: true,
      servers: [
        {
          key: "powerbi_remote",
          name: "powerbi-remote",
          builtin: false,
          status: "needs-auth",
          requiresOAuth: true,
          config: {
            name: "powerbi-remote",
            url: "https://mcp.example.com/v1/mcp/powerbi",
            type: "http",
          },
        },
      ],
    });

    const user = userEvent.setup();
    render(<PluginsPanel isOpen={true} initialTab="mcp-servers" />);

    // Open detail dialog → button shows "Sign in".
    await user.click(await screen.findByText("powerbi-remote"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Sign in" })).toBeInTheDocument();

    // Drive a connecting transition via the OAuth store → label re-renders to
    // "Connecting...". This is the state that breaks if a future regression
    // caches the snapshot label on dialog open instead of deriving live.
    act(() => {
      mcpOAuthStore.setUiState("powerbi-remote", {
        serverKey: "powerbi-remote",
        state: "connecting",
      });
    });
    await within(dialog).findByRole("button", { name: "Connecting..." });
    expect(within(dialog).queryByRole("button", { name: "Sign in" })).toBeNull();

    // Drive connected → PluginsPanel auto-closes the detail dialog
    // (rising-edge `connecting → connected` transition is the trigger;
    // see the "does not auto-close ... already-connected" test below for
    // the regression-protection counterpart).
    act(() => {
      mcpOAuthStore.setUiState("powerbi-remote", {
        serverKey: "powerbi-remote",
        state: "connected",
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    mcpOAuthStore.resetForTests();
  });

  // Regression for a UX bug introduced by deriving the auto-close from the
  // store snapshot rather than the connecting → connected transition. With a
  // bare snapshot check, opening the detail dialog on a server whose stored
  // `mcpOAuthStore` state already reads "connected" (because the user signed
  // in earlier and the store entry was never cleared) closes the dialog
  // immediately, so the click looks like a no-op. The fix waits for the
  // explicit transition before closing, so initial-render "connected" stays
  // open.
  it("does not auto-close the detail dialog when opened on an already-connected server", async () => {
    mcpOAuthStore.resetForTests();
    installMockAPIs();
    window.mcpsAPI.list = vi.fn<McpsAPI["list"]>().mockResolvedValue({
      success: true,
      servers: [
        {
          key: "powerbi_remote",
          name: "powerbi-remote",
          builtin: false,
          status: "connected",
          requiresOAuth: true,
          oauthAlias: "user@example.com",
          config: {
            name: "powerbi-remote",
            url: "https://mcp.example.com/v1/mcp/powerbi",
            type: "http",
          },
        },
      ],
    });

    // Seed the store with a stale "connected" entry — simulates a successful
    // sign-in earlier in the session that left the uiState populated.
    mcpOAuthStore.setUiState("powerbi-remote", {
      serverKey: "powerbi-remote",
      state: "connected",
      alias: "user@example.com",
    });

    const user = userEvent.setup();
    render(<PluginsPanel isOpen={true} initialTab="mcp-servers" />);

    await user.click(await screen.findByText("powerbi-remote"));
    // Dialog stays open even though the snapshot already reads "connected".
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    mcpOAuthStore.resetForTests();
  });

  // Round-7: explicit "Log out" CTA on signed-in OAuth servers. The detail
  // dialog must (a) render the secondary "Log out" button when signed in,
  // (b) call `mcps:signOut` with the right server name on click, and
  // (c) close itself only after the IPC resolves (so an error toast lands
  // in the same surface the user clicked from).
  it("renders the Log out button on signed-in OAuth servers and routes clicks through mcps:signOut", async () => {
    mcpOAuthStore.resetForTests();
    installMockAPIs();
    window.mcpsAPI.list = vi.fn<McpsAPI["list"]>().mockResolvedValue({
      success: true,
      servers: [
        {
          key: "powerbi_remote",
          name: "powerbi-remote",
          builtin: false,
          status: "connected",
          requiresOAuth: true,
          oauthAlias: "alice@example.com",
          config: {
            name: "powerbi-remote",
            url: "https://mcp.example.com/v1/mcp/powerbi",
            type: "http",
            oauthAlias: "alice@example.com",
          },
        },
      ],
    });
    const signOut = vi.fn<McpsAPI["signOut"]>().mockResolvedValue({ status: "success" });
    window.mcpsAPI.signOut = signOut;

    const user = userEvent.setup();
    render(<PluginsPanel isOpen={true} initialTab="mcp-servers" />);

    // Open detail dialog and confirm both actions render.
    await user.click(await screen.findByText("powerbi-remote"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Re-authenticate" })).toBeInTheDocument();
    const logOutButton = within(dialog).getByRole("button", { name: "Log out" });

    await user.click(logOutButton);
    await waitFor(() => expect(signOut).toHaveBeenCalledWith("powerbi-remote"));
    // Dialog closes after the IPC resolves successfully.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    mcpOAuthStore.resetForTests();
  });

  // Invariant pin (not a fix regression — the same assertion held against
  // the pre-extraction inline code, which guarded `onRemove` with
  // `scope === "local"` and MCP snapshots never carry a scope). The
  // McpServerDetailDialog must NEVER render a Remove (or Uninstall)
  // button: removal for MCPs lives on the McpServersTab card menu, and
  // plugin-declared MCPs (which lack a `scope`) must NOT be removable from
  // the extensions panel — that route would bypass the plugin lifecycle.
  // This test pins the invariant forward so a future refactor that wires
  // `onRemove` through the MCP path fails loudly.
  it("invariant: McpServerDetailDialog never renders a Remove or Uninstall button", async () => {
    mcpOAuthStore.resetForTests();
    installMockAPIs();
    window.mcpsAPI.list = vi.fn<McpsAPI["list"]>().mockResolvedValue({
      success: true,
      servers: [
        {
          key: "powerbi_remote",
          name: "powerbi-remote",
          builtin: false,
          status: "connected",
          requiresOAuth: true,
          oauthAlias: "alice@example.com",
          config: {
            name: "powerbi-remote",
            url: "https://mcp.example.com/v1/mcp/powerbi",
            type: "http",
          },
        },
      ],
    });

    const user = userEvent.setup();
    render(<PluginsPanel isOpen={true} initialTab="mcp-servers" />);

    await user.click(await screen.findByText("powerbi-remote"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: /^remove$/i })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /^uninstall$/i })).toBeNull();

    mcpOAuthStore.resetForTests();
  });
});

describe("PluginsPanel dismiss button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
  });

  it("renders Close button when onClose is provided", async () => {
    render(<PluginsPanel isOpen={true} onClose={vi.fn<() => void>()} />);
    expect(await screen.findByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("calls onClose when Close button is clicked", async () => {
    const onClose = vi.fn<() => void>();
    const user = userEvent.setup();
    render(<PluginsPanel isOpen={true} onClose={onClose} />);
    await user.click(await screen.findByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
