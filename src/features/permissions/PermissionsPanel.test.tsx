import type { TenantAPI } from "@common/marshal-ipc-contract";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs, render, screen, waitFor, userEvent, within } from "@/test-utils";
import type { PermissionsConfig } from "@/types/electron";

import { PermissionsPanel } from "./PermissionsPanel";
import { TOOL_PLAIN_COPY } from "./tool-descriptions";

beforeEach(() => {
  installMockAPIs();
});

const basePermissions: PermissionsConfig = {
  autoApproveReadOnly: false,
  allow: [],
  tools: {},
  servers: {
    filesystem: { enabled: true, autoApprove: false },
    playwright: { enabled: true, autoApprove: false },
    shell: { enabled: true, autoApprove: false },
  },
};

function renderPanel(overrides: { permissions?: Partial<PermissionsConfig> } = {}) {
  const permissions = {
    ...basePermissions,
    ...overrides.permissions,
    servers: { ...basePermissions.servers, ...overrides.permissions?.servers },
  };
  const onBack = vi.fn<() => void>();
  const onUpdatePermissions = vi.fn<(p: PermissionsConfig) => void>();
  const onToggleInterceptFileChooser = vi.fn<() => void>();
  const onEditJson = vi.fn<() => void>();

  render(
    <PermissionsPanel
      onBack={onBack}
      permissions={permissions}
      onUpdatePermissions={onUpdatePermissions}
      interceptFileChooser={false}
      onToggleInterceptFileChooser={onToggleInterceptFileChooser}
      showEditJson
      onEditJson={onEditJson}
    />,
  );

  return { onBack, onUpdatePermissions, onEditJson };
}

describe("PermissionsPanel", () => {
  it("renders panel header with title", () => {
    renderPanel();
    expect(screen.getByText("Permissions")).toBeInTheDocument();
  });

  it("renders SDK servers (Shell, File System Access) in Capabilities section", () => {
    renderPanel();
    expect(screen.getByText("Shell (terminal commands)")).toBeInTheDocument();
    expect(screen.getByText("File System Access")).toBeInTheDocument();
  });

  it("renders File System Access as a capability but not MCP-only servers", () => {
    renderPanel();
    expect(screen.getByText("Shell (terminal commands)")).toBeInTheDocument();
    // File System Access graduated from an MCP server to a built-in capability,
    // so it renders in the Capabilities section.
    expect(screen.getByText("File System Access")).toBeInTheDocument();
    // Browser Control and Web Browsing is still MCP-only (from useToolRegistry).
    // With mock IPC returning empty categories it must not appear here.
    expect(screen.queryByText("Browser Control")).not.toBeInTheDocument();
  });

  it("renders Shell Commands section", () => {
    renderPanel();
    expect(screen.getByText("Shell Commands")).toBeInTheDocument();
  });

  it("renders Edit raw JSON button", () => {
    renderPanel();
    expect(screen.getByText("Edit raw JSON")).toBeInTheDocument();
  });

  it("calls onEditJson when Edit raw JSON is clicked", async () => {
    const { onEditJson } = renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByText("Edit raw JSON"));
    expect(onEditJson).toHaveBeenCalledTimes(1);
  });

  it("shows auto-approve toggle for Shell when enabled", () => {
    renderPanel();
    expect(screen.getAllByText("Auto-approve without asking").length).toBeGreaterThan(0);
  });

  it("shows read-only toggle at top level", () => {
    renderPanel();
    expect(screen.getByText("Auto-approve read-only operations")).toBeInTheDocument();
  });

  it("renders the autoApproveReadOnly description from the spec", () => {
    renderPanel();
    expect(screen.getByText(TOOL_PLAIN_COPY.autoApproveReadOnly.description)).toBeInTheDocument();
  });

  it("renders the shell SDK server description in the panel", () => {
    renderPanel();
    expect(screen.getByText(TOOL_PLAIN_COPY.shell.description)).toBeInTheDocument();
  });

  it("renders the serverAutoApprove + shellAutoApprove descriptions under their auto-approve sub-rows", () => {
    // Restored on review -- guards against the v2 spec
    // silently dropping the only descriptions rendered under every
    // "Auto-approve without asking" sub-row. PermissionsEditor.tsx picks
    // shellAutoApprove for the Shell row and serverAutoApprove for File System Access.
    // Scope the assertions per-row via within() so a flipped condition
    // (`!== "shell"`) fails the test instead of passing silently because
    // both strings appear somewhere in the panel.
    renderPanel();
    const shellAutoRow = screen.getByTestId("shell-server-auto-approve").closest("label");
    const filesystemAutoRow = screen
      .getByTestId("filesystem-server-auto-approve")
      .closest("label");
    if (!shellAutoRow || !filesystemAutoRow) {
      throw new Error("expected auto-approve sub-row labels for shell + filesystem");
    }
    expect(
      within(shellAutoRow).getByText(TOOL_PLAIN_COPY.shellAutoApprove.description),
    ).toBeInTheDocument();
    expect(
      within(filesystemAutoRow).getByText(TOOL_PLAIN_COPY.serverAutoApprove.description),
    ).toBeInTheDocument();
    // Shell row must NOT carry the generic copy; File System Access row must NOT carry
    // the Shell-specific copy. Catches a swapped conditional.
    expect(
      within(shellAutoRow).queryByText(TOOL_PLAIN_COPY.serverAutoApprove.description),
    ).not.toBeInTheDocument();
    expect(
      within(filesystemAutoRow).queryByText(TOOL_PLAIN_COPY.shellAutoApprove.description),
    ).not.toBeInTheDocument();
  });
});

describe("PermissionsPanel tool categories", () => {
  it("renders tool groups from categories", async () => {
    vi.mocked(window.permissionsAPI!.listTools).mockResolvedValue({
      success: true,
      categories: [
        {
          key: "app",
          name: "App Tools",
          groups: [
            {
              key: "tool:email",
              name: "Email",
              tools: [
                { key: "tool:listEmails", name: "List Emails" },
                { key: "tool:sendEmail", name: "Send Email" },
              ],
              status: "connected",
            },
          ],
        },
      ],
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText("Email")).toBeInTheDocument();
    });
    // Group is collapsed — tools not in DOM until expanded
    expect(screen.queryByText("List Emails")).not.toBeInTheDocument();
  });

  it("renders Browser Control as one MCP group", async () => {
    vi.mocked(window.permissionsAPI!.listTools).mockResolvedValue({
      success: true,
      categories: [
        {
          key: "mcp",
          name: "MCP Servers",
          groups: [
            {
              key: "mcp:playwright",
              name: "Browser Control and Web Browsing",
              tools: [{ key: "mcp:playwright:browser_navigate", name: "Browser Navigate" }],
              status: "static",
            },
          ],
        },
      ],
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText("Browser Control")).toBeInTheDocument();
    });
    expect(screen.queryByText("Web Fetch")).not.toBeInTheDocument();
  });

  it("keeps Web Fetch individually clickable when Browser Control and Web Browsing auto-approves MCP tools", async () => {
    vi.mocked(window.permissionsAPI!.listTools).mockResolvedValue({
      success: true,
      categories: [
        {
          key: "mcp",
          name: "MCP Servers",
          groups: [
            {
              key: "mcp:playwright",
              name: "Browser Control and Web Browsing",
              tools: [
                { key: "mcp:playwright:browser_navigate", name: "Browser Navigate" },
                {
                  key: "tool:web_fetch",
                  name: "Web Fetch",
                  description: "Fetch HTTP(S) URLs without browser automation",
                },
              ],
              status: "static",
            },
          ],
        },
      ],
    });
    const { onUpdatePermissions } = renderPanel({
      permissions: {
        tools: {},
        servers: { playwright: { enabled: true, autoApprove: true } },
      },
    });
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("Browser Control")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Browser Control"));

    expect(screen.getByText("Web Fetch")).toBeInTheDocument();

    const webFetchCheckbox = screen.getByRole("checkbox", { name: /Web Fetch/i });
    expect(webFetchCheckbox).not.toBeChecked();
    expect(webFetchCheckbox).toBeEnabled();

    await user.click(webFetchCheckbox);

    expect(onUpdatePermissions).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({ "tool:web_fetch": true }),
      }),
    );
  });

  it("disables Web Fetch when Browser Control and Web Browsing is disabled", async () => {
    vi.mocked(window.permissionsAPI!.listTools).mockResolvedValue({
      success: true,
      categories: [
        {
          key: "mcp",
          name: "MCP Servers",
          groups: [
            {
              key: "mcp:playwright",
              name: "Browser Control and Web Browsing",
              tools: [
                { key: "mcp:playwright:browser_navigate", name: "Browser Navigate" },
                {
                  key: "tool:web_fetch",
                  name: "Web Fetch",
                  description: "Fetch HTTP(S) URLs without browser automation",
                },
              ],
              status: "static",
            },
          ],
        },
      ],
    });
    const user = userEvent.setup();
    renderPanel({
      permissions: {
        servers: { playwright: { enabled: false, autoApprove: false } },
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Browser Control")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Browser Control"));

    expect(screen.getByRole("checkbox", { name: /Web Fetch/i })).toBeDisabled();
  });
});

describe("PermissionsPanel MCP refresh button", () => {
  it("renders refresh button for MCP category", async () => {
    vi.mocked(window.permissionsAPI!.listTools).mockResolvedValue({
      success: true,
      categories: [
        {
          key: "mcp",
          name: "MCP Servers",
          groups: [
            {
              key: "mcp:filesystem",
              name: "File System Access",
              tools: [{ key: "mcp:filesystem:read_file", name: "Read File" }],
              status: "static",
            },
          ],
        },
      ],
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Refresh MCP tools")).toBeInTheDocument();
    });
  });

  it("calls rediscover on click", async () => {
    vi.mocked(window.permissionsAPI!.listTools).mockResolvedValue({
      success: true,
      categories: [
        {
          key: "mcp",
          name: "MCP Servers",
          groups: [
            {
              key: "mcp:filesystem",
              name: "File System Access",
              tools: [{ key: "mcp:filesystem:read_file", name: "Read File" }],
              status: "static",
            },
          ],
        },
      ],
    });
    renderPanel();
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByLabelText("Refresh MCP tools")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Refresh MCP tools"));
    expect(window.mcpsAPI?.rediscover).toHaveBeenCalledTimes(1);
  });

  it("shows spinner when groups have loading status", async () => {
    vi.mocked(window.permissionsAPI!.listTools).mockResolvedValue({
      success: true,
      categories: [
        {
          key: "mcp",
          name: "MCP Servers",
          groups: [
            {
              key: "mcp:filesystem",
              name: "File System Access",
              tools: [],
              status: "loading",
            },
          ],
        },
      ],
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByLabelText("Refresh MCP tools")).toBeDisabled();
    });
  });
});

describe("PermissionsPanel tenant policy", () => {
  function installTenantPolicy(overrides: {
    managed?: boolean;
    forcePrompt?: boolean;
    disabledServers?: string[];
  }) {
    window.tenantAPI = {
      getStatus: vi.fn<TenantAPI["getStatus"]>().mockResolvedValue({
        success: true,
        managed: overrides.managed ?? true,
        disabledServers: overrides.disabledServers ?? [],
        disabledPermissionKinds: [],
        forcePrompt: overrides.forcePrompt ?? false,
        disabledModels: [],
        disableHeartbeat: false,
        disableAutomations: false,
        disabledProviders: [],
        restrictToWorkspace: false,
        browserEgressBlockedOrigins: [],
      }),
    } satisfies TenantAPI;
  }

  it("shows managed banner when tenant is managed", async () => {
    installTenantPolicy({ managed: true });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("tenant-managed-banner")).toBeInTheDocument();
    });
  });

  it("shows auto-approve lock when forcePrompt is true", async () => {
    installTenantPolicy({ forcePrompt: true });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("tenant-lock-auto-approve")).toBeInTheDocument();
    });
  });

  it("locks File System Access server toggle when tenant-disabled", async () => {
    installTenantPolicy({ disabledServers: ["File System Access"] });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("tenant-lock-File System Access")).toBeInTheDocument();
    });
  });

  it("does not show lock for non-disabled servers", async () => {
    installTenantPolicy({ disabledServers: ["File System Access"] });
    renderPanel();
    // Wait for tenant policy to load (File System Access lock appears)
    await waitFor(() => {
      expect(screen.getByTestId("tenant-lock-File System Access")).toBeInTheDocument();
    });
    // Shell should NOT have a lock icon
    expect(screen.queryByTestId("tenant-lock-Shell")).not.toBeInTheDocument();
  });
});

describe("PermissionsPanel server toggles", () => {
  it("toggling Shell server calls onUpdatePermissions", async () => {
    const { onUpdatePermissions } = renderPanel();
    const user = userEvent.setup();

    const shellSwitch = screen.getByTestId("shell-server-enabled");

    await user.click(shellSwitch);

    expect(onUpdatePermissions).toHaveBeenCalledTimes(1);
    const update = onUpdatePermissions.mock.calls[0][0];
    expect(update.servers.shell.enabled).toBe(false);
  });

  it("toggling Shell auto-approve calls onUpdatePermissions", async () => {
    const { onUpdatePermissions } = renderPanel();
    const user = userEvent.setup();

    const shellAutoApproveSwitch = screen.getByTestId("shell-server-auto-approve");

    await user.click(shellAutoApproveSwitch);

    expect(onUpdatePermissions).toHaveBeenCalledTimes(1);
    const update = onUpdatePermissions.mock.calls[0][0];
    expect(update.servers.shell.autoApprove).toBe(true);
  });
});

describe("PermissionsPanel dismiss button", () => {
  it("renders both Back and Close buttons when onBack and onClose are provided", () => {
    const onBack = vi.fn<() => void>();
    const onClose = vi.fn<() => void>();
    render(
      <PermissionsPanel
        onBack={onBack}
        onClose={onClose}
        permissions={basePermissions}
        onUpdatePermissions={vi.fn<(p: PermissionsConfig) => void>()}
      />,
    );
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("Back calls onBack (returns to parent panel)", async () => {
    const onBack = vi.fn<() => void>();
    const onClose = vi.fn<() => void>();
    render(
      <PermissionsPanel
        onBack={onBack}
        onClose={onClose}
        permissions={basePermissions}
        onUpdatePermissions={vi.fn<(p: PermissionsConfig) => void>()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Close calls onClose (returns to original page)", async () => {
    const onBack = vi.fn<() => void>();
    const onClose = vi.fn<() => void>();
    render(
      <PermissionsPanel
        onBack={onBack}
        onClose={onClose}
        permissions={basePermissions}
        onUpdatePermissions={vi.fn<(p: PermissionsConfig) => void>()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
  });
});
