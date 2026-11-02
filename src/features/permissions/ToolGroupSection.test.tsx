import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs, render, screen, userEvent } from "@/test-utils";
import type { PermissionsConfig, ToolGroup } from "@/types/electron";

import { TOOL_PLAIN_COPY } from "./tool-descriptions";
import { ToolGroupSection } from "./ToolGroupSection";

beforeEach(() => {
  installMockAPIs();
});

const basePermissions: PermissionsConfig = {
  autoApproveReadOnly: false,
  allow: [],
  tools: {},
  servers: {},
};

// NOTE on fixture .name fields: getToolCopy() at render time overrides these
// with the spec label (e.g. "Remember" → "Save something to memory"). Leave the legacy
// names in place — the component reads from tool-descriptions.ts via the key.
const memoryGroup: ToolGroup = {
  key: "tool:memory",
  name: "Memory",
  tools: [
    { key: "tool:remember", name: "Remember" },
    { key: "tool:recall", name: "Recall" },
  ],
  status: "connected",
};

const emptyGroup: ToolGroup = {
  key: "mcp:disconnected",
  name: "Disconnected Server",
  tools: [],
  status: "disconnected",
};

const mcpNativeGroup: ToolGroup = {
  key: "mcp:playwright",
  name: "Browser Control and Web Browsing",
  tools: [
    { key: "mcp:playwright:browser_navigate", name: "Browser Navigate" },
    { key: "mcp:playwright:browser_click", name: "Browser Click" },
  ],
  status: "static",
};

const browserGroupWithWebFetch: ToolGroup = {
  key: "mcp:playwright",
  name: "Browser Control and Web Browsing",
  tools: [
    { key: "mcp:playwright:browser_navigate", name: "Browser Navigate" },
    { key: "tool:web_fetch", name: "Web Fetch" },
  ],
  status: "static",
};

function renderGroup(
  overrides: {
    group?: ToolGroup;
    permissions?: Partial<PermissionsConfig>;
    disabled?: boolean;
    serverAutoApprove?: boolean;
    forcePrompt?: boolean;
    serverConfig?: {
      configKey: string;
      enabled: boolean;
      autoApprove: boolean;
      onToggleEnabled: () => void;
      onToggleAutoApprove: () => void;
      lockedByTenant?: boolean;
    };
  } = {},
) {
  const onUpdate = vi.fn<(p: PermissionsConfig) => void>();
  const permissions = { ...basePermissions, ...overrides.permissions };

  const utils = render(
    <ToolGroupSection
      group={overrides.group ?? memoryGroup}
      permissions={permissions}
      onUpdate={onUpdate}
      disabled={overrides.disabled}
      serverAutoApprove={overrides.serverAutoApprove}
      forcePrompt={overrides.forcePrompt}
      serverConfig={overrides.serverConfig}
    />,
  );

  return { onUpdate, ...utils };
}

describe("ToolGroupSection", () => {
  it("renders group name", () => {
    renderGroup();
    expect(screen.getByText("Memory")).toBeInTheDocument();
  });

  it("renders the group description under the header", () => {
    renderGroup({ group: mcpNativeGroup });
    // Pin against the spec value, not a hand-typed substring — the PR body
    // invites factual-accuracy corrections to descriptions.
    expect(screen.getByText(TOOL_PLAIN_COPY.playwright.description)).toBeInTheDocument();
  });

  it("renders the per-tool description below each tool checkbox", async () => {
    const user = userEvent.setup();
    renderGroup({ group: mcpNativeGroup });
    await user.click(screen.getByText("Browser Control"));
    expect(screen.getByText(TOOL_PLAIN_COPY.browser_navigate.description)).toBeInTheDocument();
  });

  it("exposes a stable test-id on the enabled-count badge (used by e2e)", () => {
    renderGroup();
    expect(screen.getByTestId("tool-group-count")).toBeInTheDocument();
  });

  it("renders the serverAutoApprove description under the auto-approve sub-row (MCP server)", () => {
    // Regression guard for a review finding -- v2 had dropped the
    // serverAutoApprove entry but ToolGroupSection.tsx still reads it for
    // every MCP server's "Auto-approve without asking" sub-row. The
    // PermissionsPanel.test fixture mocks listTools to return empty
    // categories, so no MCP group renders there; this is the only spot
    // exercising the ToolGroupSection MCP path.
    const onToggleEnabled = vi.fn<() => void>();
    const onToggleAutoApprove = vi.fn<() => void>();
    renderGroup({
      group: mcpNativeGroup,
      serverConfig: {
        configKey: "playwright",
        enabled: true,
        autoApprove: false,
        onToggleEnabled,
        onToggleAutoApprove,
      },
    });
    expect(screen.getByText(TOOL_PLAIN_COPY.serverAutoApprove.description)).toBeInTheDocument();
  });

  it("shows auto-approves badge when serverAutoApprove is true", () => {
    renderGroup({ serverAutoApprove: true });
    expect(screen.getByText("auto-approves MCP tools")).toBeInTheDocument();
  });

  it("serverAutoApprove covers all tools in a non-MCP group (tool:* key)", () => {
    // Regression guard: isToolCoveredByServerAutoApprove must
    // return true for non-MCP groups (e.g. tool:memory) when serverAutoApprove
    // is on — not just for groups with an "mcp:" key prefix.
    renderGroup({ serverAutoApprove: true });
    const switches = screen.getAllByRole("switch");
    // Group switch + one switch per tool; all should appear checked when auto-approved.
    for (const sw of switches) {
      expect(sw).toBeChecked();
    }
  });

  it("group switch is unchecked when no tools are approved", () => {
    renderGroup();
    const switches = screen.getAllByRole("switch");
    expect(switches[0]).not.toBeChecked();
  });

  it("group switch is checked when group key is true", () => {
    renderGroup({
      permissions: { tools: { "tool:memory": true } },
    });
    const switches = screen.getAllByRole("switch");
    expect(switches[0]).toBeChecked();
  });

  it("empty group renders switch as unchecked (no vacuous truth)", () => {
    renderGroup({ group: emptyGroup });
    const switches = screen.getAllByRole("switch");
    expect(switches[0]).not.toBeChecked();
  });

  it("hides tools when collapsed, shows on expand", async () => {
    const user = userEvent.setup();
    renderGroup();
    // Collapsed — tools not in DOM (Radix Collapsible unmounts content)
    expect(screen.queryByText("Save something to memory")).not.toBeInTheDocument();
    // Expand
    await user.click(screen.getByText("Memory"));
    expect(screen.getByText("Save something to memory")).toBeInTheDocument();
    expect(screen.getByText("Look up saved memory")).toBeInTheDocument();
  });

  it("toggling group ON sets group key true and removes overrides", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderGroup({
      permissions: {
        tools: { "tool:remember": true, "tool:recall": false },
      },
    });

    const groupSwitch = screen.getAllByRole("switch")[0];
    await user.click(groupSwitch);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const updated = onUpdate.mock.calls[0][0];
    expect(updated.tools["tool:memory"]).toBe(true);
    // Individual overrides should be removed
    expect(updated.tools["tool:remember"]).toBeUndefined();
    expect(updated.tools["tool:recall"]).toBeUndefined();
  });

  it("does not show synthetic non-MCP tools as checked from an MCP group approval", async () => {
    const user = userEvent.setup();
    renderGroup({
      group: browserGroupWithWebFetch,
      permissions: { tools: { "mcp:playwright": true } },
    });

    await user.click(screen.getByText("Browser Control"));

    expect(screen.getByRole("checkbox", { name: /Open a website/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Web Fetch/i })).not.toBeChecked();
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("toggling group OFF removes group key and individual entries", async () => {
    const user = userEvent.setup();
    // All tools approved (group on, both inherit) so switch is checked
    const { onUpdate } = renderGroup({
      permissions: {
        tools: { "tool:memory": true },
      },
    });

    const groupSwitch = screen.getAllByRole("switch")[0];
    // Switch is checked (allOn=true via group), clicking toggles OFF
    await user.click(groupSwitch);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const updated = onUpdate.mock.calls[0][0];
    expect(updated.tools["tool:memory"]).toBeUndefined();
    expect(updated.tools["tool:remember"]).toBeUndefined();
    expect(updated.tools["tool:recall"]).toBeUndefined();
  });

  it("toggling group ON snapshots previous tool states into previousTools", async () => {
    const user = userEvent.setup();
    // Start with partial permissions: only Remember is approved (1/2)
    const { onUpdate } = renderGroup({
      permissions: {
        tools: { "tool:remember": true, "tool:recall": false },
      },
    });

    const groupSwitch = screen.getAllByRole("switch")[0];
    await user.click(groupSwitch);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const afterOn = onUpdate.mock.calls[0][0];
    expect(afterOn.tools["tool:memory"]).toBe(true);
    // Snapshot includes group key state and explicit overrides only
    expect(afterOn.previousTools?.["tool:memory"]).toEqual({
      "tool:memory": false,
      "tool:remember": true,
      "tool:recall": false,
    });
  });

  it("toggling group OFF restores previous partial state from previousTools", async () => {
    const user = userEvent.setup();
    // Group is ON (all approved), with a snapshot from a previous toggle
    const { onUpdate } = renderGroup({
      permissions: {
        tools: { "tool:memory": true },
        previousTools: {
          "tool:memory": {
            "tool:memory": false,
            "tool:remember": true,
            "tool:recall": false,
          },
        },
      },
    });

    const groupSwitch = screen.getAllByRole("switch")[0];
    await user.click(groupSwitch);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const afterOff = onUpdate.mock.calls[0][0];
    // Group key should not be set (was false in snapshot)
    expect(afterOff.tools["tool:memory"]).toBeUndefined();
    expect(afterOff.tools["tool:remember"]).toBe(true);
    expect(afterOff.tools["tool:recall"]).toBe(false);
    // Snapshot should be cleared after restore
    expect(afterOff.previousTools?.["tool:memory"]).toBeUndefined();
  });

  it("toggling group ON with no overrides snapshots only the group key", async () => {
    const user = userEvent.setup();
    // Start with no explicit tool states (all unset/inherited)
    const { onUpdate } = renderGroup({
      permissions: { tools: {} },
    });

    const groupSwitch = screen.getAllByRole("switch")[0];
    await user.click(groupSwitch);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const afterOn = onUpdate.mock.calls[0][0];
    // Snapshot should only contain the group key (no tool overrides existed)
    expect(afterOn.previousTools?.["tool:memory"]).toEqual({
      "tool:memory": false,
    });
  });

  it("toggling group OFF with group-only snapshot restores clean state", async () => {
    const user = userEvent.setup();
    // Group is ON, snapshot has only the group key (no tool overrides before)
    const { onUpdate } = renderGroup({
      permissions: {
        tools: { "tool:memory": true },
        previousTools: {
          "tool:memory": { "tool:memory": false },
        },
      },
    });

    const groupSwitch = screen.getAllByRole("switch")[0];
    await user.click(groupSwitch);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const afterOff = onUpdate.mock.calls[0][0];
    // No explicit tool entries should be set (clean state restored)
    expect(afterOff.tools["tool:memory"]).toBeUndefined();
    expect(afterOff.tools["tool:remember"]).toBeUndefined();
    expect(afterOff.tools["tool:recall"]).toBeUndefined();
  });

  it("restores explicit Web Fetch allow after toggling the Browser group on and off", async () => {
    const user = userEvent.setup();
    const { onUpdate, unmount } = renderGroup({
      group: browserGroupWithWebFetch,
      permissions: { tools: { "tool:web_fetch": true } },
    });

    await user.click(screen.getAllByRole("switch")[0]);

    const afterOn = onUpdate.mock.calls[0][0];
    expect(afterOn.tools["tool:web_fetch"]).toBeUndefined();
    unmount();

    const { onUpdate: onSecondUpdate } = renderGroup({
      group: browserGroupWithWebFetch,
      permissions: {
        tools: afterOn.tools,
        previousTools: afterOn.previousTools,
      },
    });

    await user.click(screen.getAllByRole("switch")[0]);

    const afterOff = onSecondUpdate.mock.calls[0][0];
    expect(afterOff.tools["tool:web_fetch"]).toBe(true);
  });

  it("group switch stays checked after manual tool edit when group key is on", () => {
    renderGroup({
      permissions: {
        tools: { "tool:memory": true, "tool:recall": false },
        previousTools: {
          "tool:memory": {
            "tool:memory": false,
            "tool:remember": true,
            "tool:recall": false,
          },
        },
      },
    });

    // Group key is true, so the switch should be checked even though not all tools are on
    const groupSwitch = screen.getAllByRole("switch")[0];
    expect(groupSwitch).toBeChecked();
  });

  it("toggling individual tool sets explicit true/false", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderGroup({
      permissions: { tools: { "tool:memory": true } },
    });

    // Expand
    await user.click(screen.getByText("Memory"));

    // Both tools should be shown as checked (inheriting from group)
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);

    // Uncheck "Recall"
    await user.click(checkboxes[1]);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const updated = onUpdate.mock.calls[0][0];
    expect(updated.tools["tool:recall"]).toBe(false);
  });

  it("tools inherit checked state from group when no override", async () => {
    const user = userEvent.setup();
    renderGroup({
      permissions: { tools: { "tool:memory": true } },
    });

    await user.click(screen.getByText("Memory"));

    const checkboxes = screen.getAllByRole("checkbox");
    // Both should be checked (inheriting from group ON)
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).toBeChecked();
  });

  it("disables all controls when disabled prop is true", () => {
    renderGroup({ disabled: true });
    const groupSwitch = screen.getAllByRole("switch")[0];
    expect(groupSwitch).toBeDisabled();
  });

  it("disables all controls when serverAutoApprove is true", () => {
    renderGroup({ group: mcpNativeGroup, serverAutoApprove: true });
    const groupSwitch = screen.getAllByRole("switch")[0];
    expect(groupSwitch).toBeDisabled();
  });
});

describe("ToolGroupSection enabled counts", () => {
  it("shows 0/N when no tools are approved", () => {
    renderGroup();
    expect(screen.getByText("0/2")).toBeInTheDocument();
  });

  it("shows N/N when group is approved", () => {
    renderGroup({ permissions: { tools: { "tool:memory": true } } });
    expect(screen.getByText("2/2")).toBeInTheDocument();
  });

  it("shows partial count when individual tools are set", () => {
    renderGroup({ permissions: { tools: { "tool:remember": true } } });
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("shows N/N when serverAutoApprove is true", () => {
    renderGroup({ group: mcpNativeGroup, serverAutoApprove: true });
    expect(screen.getByText("2/2")).toBeInTheDocument();
  });

  it("hides count when group has no tools", () => {
    renderGroup({ group: emptyGroup });
    expect(screen.queryByText(/\d+\/\d+/)).not.toBeInTheDocument();
  });
});

describe("ToolGroupSection status labels", () => {
  it("shows (cached) label when status is static", () => {
    renderGroup({ group: { ...memoryGroup, status: "static" } });
    expect(screen.getByText("(cached)")).toBeInTheDocument();
  });

  it("shows (no tools) label when status is disconnected (empty group)", () => {
    renderGroup({ group: emptyGroup });
    expect(screen.getByText("(no tools)")).toBeInTheDocument();
  });

  it("shows (no tools) label when status is disconnected even with tools", () => {
    renderGroup({ group: { ...memoryGroup, status: "disconnected" } });
    expect(screen.getByText("(no tools)")).toBeInTheDocument();
  });

  it("shows (error) label when status is error", () => {
    renderGroup({ group: { ...memoryGroup, status: "error" } });
    expect(screen.getByText("(error)")).toBeInTheDocument();
  });

  it("shows no status label when status is connected", () => {
    renderGroup({ group: memoryGroup });
    expect(screen.queryByText("(cached)")).not.toBeInTheDocument();
    expect(screen.queryByText("(no tools)")).not.toBeInTheDocument();
    expect(screen.queryByText("(error)")).not.toBeInTheDocument();
  });
});

describe("ToolGroupSection tenant policy", () => {
  it("disables group switch when forcePrompt is true", () => {
    renderGroup({ forcePrompt: true });
    const groupSwitch = screen.getAllByRole("switch")[0];
    expect(groupSwitch).toBeDisabled();
  });

  it("disables individual checkboxes when forcePrompt is true", async () => {
    const user = userEvent.setup();
    renderGroup({
      forcePrompt: true,
      permissions: { tools: { "tool:memory": true } },
    });

    await user.click(screen.getByText("Memory"));

    const checkboxes = screen.getAllByRole("checkbox");
    for (const checkbox of checkboxes) {
      expect(checkbox).toBeDisabled();
    }
  });

  it("shows lock icon when forcePrompt is true", () => {
    renderGroup({ forcePrompt: true });
    expect(screen.getByTestId("tenant-lock-forcePrompt")).toBeInTheDocument();
  });

  it("disables server config switch when lockedByTenant is true", () => {
    renderGroup({
      serverConfig: {
        configKey: "filesystem",
        enabled: true,
        autoApprove: false,
        onToggleEnabled: vi.fn<() => void>(),
        onToggleAutoApprove: vi.fn<() => void>(),
        lockedByTenant: true,
      },
    });
    const switches = screen.getAllByRole("switch");
    // First switch is the server config switch (replaces the group switch)
    expect(switches[0]).toBeDisabled();
  });

  it("shows tenant lock icon when server is lockedByTenant", () => {
    renderGroup({
      serverConfig: {
        configKey: "filesystem",
        enabled: true,
        autoApprove: false,
        onToggleEnabled: vi.fn<() => void>(),
        onToggleAutoApprove: vi.fn<() => void>(),
        lockedByTenant: true,
      },
    });
    expect(screen.getByTestId(`tenant-lock-${memoryGroup.name}`)).toBeInTheDocument();
  });

  it("disables MCP auto-approve sub-toggle when forcePrompt is true", () => {
    renderGroup({
      forcePrompt: true,
      serverConfig: {
        configKey: "filesystem",
        enabled: true,
        autoApprove: false,
        onToggleEnabled: vi.fn<() => void>(),
        onToggleAutoApprove: vi.fn<() => void>(),
        lockedByTenant: false,
      },
    });
    const switches = screen.getAllByRole("switch");
    // switches[0] = server enabled toggle, switches[1] = auto-approve sub-toggle
    expect(switches[1]).toBeDisabled();
  });

  it("labels server auto-approve as MCP-specific", () => {
    renderGroup({
      serverConfig: {
        configKey: "filesystem",
        enabled: true,
        autoApprove: false,
        onToggleEnabled: vi.fn<() => void>(),
        onToggleAutoApprove: vi.fn<() => void>(),
        lockedByTenant: false,
      },
    });

    expect(screen.getByText("Auto-approve without asking")).toBeInTheDocument();
  });
});
