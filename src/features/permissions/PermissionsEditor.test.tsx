import type { TenantAPI } from "@common/marshal-ipc-contract";
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installMockAPIs,
  render,
  screen,
  waitFor,
  userEvent,
  ALL_PERMISSIONS_CONTROLLABLE_MOCK,
} from "@/test-utils";
import type { PermissionsAPI, PermissionsConfig, ToolCategory } from "@/types/electron";

import { PermissionsEditor, type PermissionsEditorProps } from "./PermissionsEditor";

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
    "example-mcp": { enabled: true, autoApprove: false },
  },
};

function renderEditor(
  overrides: {
    permissions?: Partial<PermissionsConfig>;
    props?: Partial<PermissionsEditorProps>;
  } = {},
) {
  const permissions = {
    ...basePermissions,
    ...overrides.permissions,
    servers: { ...basePermissions.servers, ...overrides.permissions?.servers },
  };
  const onUpdatePermissions = vi.fn<(p: PermissionsConfig) => void>();
  const onEditJson = vi.fn<() => void>();
  const onToggleInterceptFileChooser = vi.fn<() => void>();

  render(
    <PermissionsEditor
      permissions={permissions}
      onUpdatePermissions={onUpdatePermissions}
      {...overrides.props}
      onEditJson={overrides.props?.onEditJson ?? onEditJson}
    />,
  );

  return { onUpdatePermissions, onEditJson, onToggleInterceptFileChooser };
}

const appToolCategories: ToolCategory[] = [
  {
    key: "app",
    name: "App Tools",
    groups: [
      {
        key: "tool:notifications",
        name: "Notifications",
        tools: [{ key: "tool:notificationStatus", name: "Relay Status" }],
        status: "connected",
      },
      {
        key: "tool:suggestedActions",
        name: "Suggested Actions",
        tools: [{ key: "tool:getSuggestedActions", name: "Get Suggested Actions" }],
        status: "connected",
      },
      {
        key: "tool:memory",
        name: "Memory",
        tools: [{ key: "tool:recall", name: "Recall" }],
        status: "connected",
      },
    ],
  },
];

describe("PermissionsEditor", () => {
  it("renders all sections — auto-approve toggles, servers, shell patterns", () => {
    renderEditor();
    expect(screen.getByText("Autopilot mode")).toBeInTheDocument();
    // Auto-approve read-only toggle
    expect(screen.getByText("Auto-approve read-only operations")).toBeInTheDocument();
    expect(screen.getAllByText("Auto-approve without asking").length).toBeGreaterThan(0);
    // Capabilities section
    expect(screen.getByText("Capabilities")).toBeInTheDocument();
    expect(screen.getByText("Shell (terminal commands)")).toBeInTheDocument();
    // Shell Commands section
    expect(screen.getByText("Shell Commands")).toBeInTheDocument();
  });

  it("shows tenant banner when tenant policy is managed", async () => {
    window.tenantAPI = {
      getStatus: vi.fn<TenantAPI["getStatus"]>().mockResolvedValue({
        success: true,
        managed: true,
        disabledServers: [],
        disabledPermissionKinds: [],
        forcePrompt: false,
        disabledModels: [],
        disableHeartbeat: false,
        disableAutomations: false,
        disabledProviders: [],
        restrictToWorkspace: false,
        browserEgressBlockedOrigins: [],
      }),
    } satisfies TenantAPI;

    renderEditor();

    await waitFor(() => {
      expect(screen.getByTestId("tenant-managed-banner")).toBeInTheDocument();
    });
  });

  it("shows Edit raw JSON button when showEditJson is true", () => {
    const onEditJson = vi.fn<() => void>();
    renderEditor({ props: { showEditJson: true, onEditJson } });
    expect(screen.getByText("Edit raw JSON")).toBeInTheDocument();
  });

  it("does not show Edit raw JSON button by default", () => {
    renderEditor();
    expect(screen.queryByText("Edit raw JSON")).not.toBeInTheDocument();
  });

  it("calls onEditJson when Edit raw JSON is clicked", async () => {
    const onEditJson = vi.fn<() => void>();
    renderEditor({ props: { showEditJson: true, onEditJson } });
    const user = userEvent.setup();
    await user.click(screen.getByText("Edit raw JSON"));
    expect(onEditJson).toHaveBeenCalledTimes(1);
  });

  it("renders disabled MCP server switch with tooltip when controllable.serverEnabled is false", async () => {
    const user = userEvent.setup();
    render(
      <PermissionsEditor
        permissions={basePermissions}
        onUpdatePermissions={() => {}}
        controllable={{
          ...ALL_PERMISSIONS_CONTROLLABLE_MOCK,
          serverEnabled: {
            enabled: false,
            disabledReason: "MCP server enable/disable is not supported in gateway mode yet.",
          },
        }}
      />,
    );
    // Find the Shell server row — it's an SDK (non-MCP) server and uses serverEnabled
    // The Switch for Shell server should be inside a Tooltip when controllable.serverEnabled=false
    const shellSwitches = screen.getAllByRole("switch");
    // At least one switch should be disabled (the server enabled switches)
    const disabledSwitches = shellSwitches.filter((sw) => sw.hasAttribute("disabled"));
    expect(disabledSwitches.length).toBeGreaterThan(0);

    // Hover the parent span to surface the tooltip — find a disabled switch's wrapping span
    const disabledSwitch = disabledSwitches[0];
    const wrapperSpan = disabledSwitch.closest("span");
    expect(wrapperSpan).not.toBeNull();
    await user.hover(wrapperSpan!); // eslint-disable-line @typescript-eslint/no-non-null-assertion
    const tooltipTexts = await screen.findAllByText(
      /MCP server enable\/disable is not supported in gateway mode/i,
    );
    expect(tooltipTexts.length).toBeGreaterThan(0);
  });

  it("renders the unrepresentable-patterns banner when hasUnrepresentablePatterns is true", () => {
    render(
      <PermissionsEditor
        permissions={basePermissions}
        onUpdatePermissions={() => {}}
        hasUnrepresentablePatterns
      />,
    );
    expect(screen.getByTestId("unrepresentable-patterns-banner")).toBeInTheDocument();
  });

  it("toggle fires onUpdatePermissions with allowModelPermissionsChange flipped", async () => {
    const user = userEvent.setup();
    const { onUpdatePermissions } = renderEditor({
      permissions: { allowModelPermissionsChange: false },
    });

    const toggle = screen.getByRole("switch", { name: /allow ai to request permission changes/i });
    await user.click(toggle);

    expect(onUpdatePermissions).toHaveBeenCalledOnce();
    const updated = onUpdatePermissions.mock.calls[0][0];
    expect(updated.allowModelPermissionsChange).toBe(true);
  });

  it("toggle fires onUpdatePermissions with autopilotMode flipped", async () => {
    const user = userEvent.setup();
    const { onUpdatePermissions } = renderEditor({
      permissions: { autopilotMode: false },
    });

    const toggle = screen.getByRole("switch", { name: /autopilot mode/i });
    await user.click(toggle);

    expect(onUpdatePermissions).toHaveBeenCalledOnce();
    expect(onUpdatePermissions.mock.calls[0][0].autopilotMode).toBe(true);
  });

  it("renders SensitivePathsSection", () => {
    renderEditor({ permissions: { allowedSensitivePaths: ["/home/user/.ssh/config"] } });
    expect(screen.getByText("Sensitive path overrides")).toBeInTheDocument();
    expect(screen.getByText("/home/user/.ssh/config")).toBeInTheDocument();
  });

  it("renders File System Access capability with a file-reads toggle and Folder access", () => {
    renderEditor();
    expect(screen.getByText("File System Access")).toBeInTheDocument();
    expect(screen.getByTestId("tool-read-enabled")).toBeInTheDocument();
    expect(screen.getByText("Folder access")).toBeInTheDocument();
  });

  it("toggling file reads flips permissions.tools['tool:read']", async () => {
    const user = userEvent.setup();
    const { onUpdatePermissions } = renderEditor();

    await user.click(screen.getByTestId("tool-read-enabled"));

    expect(onUpdatePermissions).toHaveBeenCalledOnce();
    expect(onUpdatePermissions.mock.calls[0][0].tools["tool:read"]).toBe(true);
  });

  it("hides the file-reads toggle when File System Access is disabled", () => {
    renderEditor({
      permissions: { servers: { filesystem: { enabled: false, autoApprove: false } } },
    });
    expect(screen.queryByTestId("tool-read-enabled")).not.toBeInTheDocument();
  });

  it("hides notification tools when the notification provider is absent", async () => {
    window.permissionsAPI!.listTools = vi.fn<PermissionsAPI["listTools"]>().mockResolvedValue({
      success: true,
      categories: appToolCategories,
    });

    renderEditor();

    expect(await screen.findByText("Memory")).toBeInTheDocument();
    expect(screen.queryByText("Notifications")).not.toBeInTheDocument();
    expect(screen.getByText("Suggested Actions")).toBeInTheDocument();
  });
});
