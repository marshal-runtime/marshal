/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- test file: mock setup + DOM queries need casts */
import type { IdentityAPI, TenantAPI } from "@common/marshal-ipc-contract";
import { toast } from "sonner";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { render, screen, waitFor, userEvent, installMockAPIs } from "@/test-utils";

import { SettingsPanel } from "./SettingsPanel";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn<(title: string) => void>(),
    error: vi.fn<(title: string) => void>(),
  },
}));

beforeEach(() => {
  installMockAPIs();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(window.copilotAPI.checkAuth).mockResolvedValue({
    success: true,
    isAuthenticated: true,
    login: "testuser",
  });
});

const defaultProps = {
  isOpen: true,
};

describe("SettingsPanel runtime adapters", () => {
  it("shows the effective runtime without the experiments flight", async () => {
    vi.mocked(window.settingsAPI.getRuntimeSelection).mockResolvedValue({
      success: true,
      selection: { requestedRuntimeId: "copilot", runtimeId: "copilot" },
    });
    render(<SettingsPanel {...defaultProps} />);

    expect(await screen.findByText("Runtime adapters")).toBeInTheDocument();
    expect(screen.getByText("Active AI runtime")).toBeInTheDocument();
    // Status row, runtime selector, and the About card all name the active runtime.
    expect(await screen.findAllByText("Copilot")).toHaveLength(3);
    expect(screen.getByLabelText("AI runtime")).toBeInTheDocument();
  });

  it("lists all product runtimes with permitted branding", async () => {
    render(<SettingsPanel {...defaultProps} />);
    const user = userEvent.setup();

    await user.click(screen.getByLabelText("AI runtime"));

    expect(screen.getByRole("option", { name: "Copilot" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Gateway" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Claude Agent" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Codex" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Cursor" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Codex" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.queryByText("Claude Code")).not.toBeInTheDocument();
  });

  it("preserves an open-ended runtime ID in the selector", async () => {
    vi.mocked(window.settingsAPI.get).mockResolvedValue({
      success: true,
      settings: {
        autoApprove: { global: false, perServer: {} },
        runtimeId: "custom-runtime",
      },
    });
    render(<SettingsPanel {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByLabelText("AI runtime")).toHaveTextContent("custom-runtime");
    });
  });

  it("lets the active runtime account sign out so another account can authenticate", async () => {
    installMockAPIs({
      identityAPI: {
        get: vi.fn<IdentityAPI["get"]>().mockResolvedValue({
          success: true,
          identity: {
            isAuthenticated: true,
            displayName: "Cursor",
            subtitle: "Cursor · user@example.com",
            accountName: null,
            avatarUrl: null,
            statusColor: "success",
            statusText: "Connected",
            integrations: [],
            signOut: {
              title: "Sign out of Cursor?",
              description:
                "Signing out removes the Cursor API key stored by Marshal. You can sign in or paste a key again.",
              confirmLabel: "Sign out",
            },
          },
        }),
      },
    });
    const onSignOut = vi.fn<() => void>();
    const user = userEvent.setup();
    render(<SettingsPanel {...defaultProps} onSignOut={onSignOut} />);

    expect(await screen.findByText("Runtime account")).toBeInTheDocument();
    expect(await screen.findByText("Cursor · user@example.com")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Sign out to authenticate this runtime with a different account or credential.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign out of Cursor?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(onSignOut).toHaveBeenCalledOnce();
  });
});

describe("SettingsPanel Background Service section", () => {
  beforeEach(() => {
    // Pin platform to Win32 so "tray only" / "menu bar only" label is deterministic
    Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
  });

  it("renders Window Behavior and Quick Access sections", async () => {
    render(<SettingsPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Window behavior")).toBeInTheDocument();
    });
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByLabelText(/Run in background/)).toBeInTheDocument();
    expect(screen.getByText("Show mini mode indicator")).toBeInTheDocument();
    expect(screen.getByText("Quick Access")).toBeInTheDocument();
    expect(screen.getByText("Enable global show/hide shortcut")).toBeInTheDocument();
    expect(screen.getByText("Shortcut")).toBeInTheDocument();

    // Description copy for both Quick Access rows -- pinned so dropping
    // either `description=` prop on the SettingsRows fails the test, and
    // so a copy rewrite to the Shortcut row's surrounding prose (currently
    // splits across <strong>Record</strong>) doesn't go undetected.
    expect(
      screen.getByText(
        "Use a keyboard shortcut to pop Marshal open without leaving what you're doing.",
      ),
    ).toBeInTheDocument();
    const shortcutDescriptionSpan = screen.getByText("Record", {
      selector: "strong",
    }).parentElement;
    expect(shortcutDescriptionSpan).toHaveTextContent(
      "Click Record and then press the keys you want to use as your shortcut (for example, Ctrl+Alt+S).",
    );
  });

  it("defaults to quit mode with no sub-options visible", async () => {
    render(<SettingsPanel {...defaultProps} />);
    await screen.findByText("Window behavior");

    const defaultRadio = screen.getByLabelText("Default");
    expect(defaultRadio).toHaveAttribute("aria-checked", "true");
    // Launch at system startup is always visible (mode-independent)
    expect(screen.getByLabelText("Launch at system startup")).toBeInTheDocument();
    // Mini mode sub-options should not be visible in quit mode
    expect(screen.queryByLabelText("Launch directly into mini mode")).not.toBeInTheDocument();
  });

  it("shows background sub-options when background mode is selected", async () => {
    vi.mocked(window.backgroundAPI!.getSettings).mockResolvedValue({
      success: true,
      settings: { enabled: true, runOnStartup: true, hideOnLaunch: false },
    });
    render(<SettingsPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/Run in background/)).toHaveAttribute("aria-checked", "true");
    });
    expect(screen.getByLabelText("Launch at system startup")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Start hidden/)).toBeInTheDocument();
  });

  it("enables background mode and saves via backgroundAPI", async () => {
    render(<SettingsPanel {...defaultProps} />);
    await screen.findByText("Window behavior");

    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/Run in background/));
    expect(window.backgroundAPI!.saveSettings).toHaveBeenCalledWith({ enabled: true });
  });

  it("shows mini mode sub-options when mini mode is selected", async () => {
    vi.mocked(window.settingsAPI.get).mockResolvedValue({
      success: true,
      settings: {
        autoApprove: { global: false, perServer: {} },
        miniModeEnabled: true,
        startInMiniModeEnabled: true,
      },
    });
    render(<SettingsPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByLabelText("Show mini mode indicator")).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });
    expect(screen.getByLabelText("Launch directly into mini mode")).toBeInTheDocument();
  });

  it("enables mini mode with startInMiniModeEnabled defaulting to true", async () => {
    render(<SettingsPanel {...defaultProps} />);
    await screen.findByText("Window behavior");

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Show mini mode indicator"));

    expect(window.settingsAPI.save).toHaveBeenCalledWith(
      expect.objectContaining({ miniModeEnabled: true, startInMiniModeEnabled: true }),
    );
  });

  it("switching from mini mode to quit clears miniModeEnabled", async () => {
    vi.mocked(window.settingsAPI.get).mockResolvedValue({
      success: true,
      settings: {
        autoApprove: { global: false, perServer: {} },
        miniModeEnabled: true,
        startInMiniModeEnabled: true,
      },
    });
    render(<SettingsPanel {...defaultProps} />);
    await screen.findByText("Window behavior");

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Default"));

    expect(window.settingsAPI.save).toHaveBeenCalledWith(
      expect.objectContaining({ miniModeEnabled: false }),
    );
    const saved = vi.mocked(window.settingsAPI.save).mock.calls[0][0];
    expect(saved.startInMiniModeEnabled).toBeUndefined();
  });

  it("switching from background to mini mode disables background and enables mini", async () => {
    vi.mocked(window.backgroundAPI!.getSettings).mockResolvedValue({
      success: true,
      settings: { enabled: true, runOnStartup: false, hideOnLaunch: false },
    });
    render(<SettingsPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/Run in background/)).toHaveAttribute("aria-checked", "true");
    });

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Show mini mode indicator"));

    expect(window.backgroundAPI!.saveSettings).toHaveBeenCalledWith({
      enabled: false,
      hideOnLaunch: false,
    });
    expect(window.settingsAPI.save).toHaveBeenCalledWith(
      expect.objectContaining({ miniModeEnabled: true, startInMiniModeEnabled: true }),
    );
  });

  it("switching from mini mode to background disables mini and enables background", async () => {
    vi.mocked(window.settingsAPI.get).mockResolvedValue({
      success: true,
      settings: {
        autoApprove: { global: false, perServer: {} },
        miniModeEnabled: true,
        startInMiniModeEnabled: true,
      },
    });
    render(<SettingsPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByLabelText("Show mini mode indicator")).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });

    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/Run in background/));

    // Background should be enabled first (async), then mini mode cleared
    expect(window.backgroundAPI!.saveSettings).toHaveBeenCalledWith({ enabled: true });
    expect(window.settingsAPI.save).toHaveBeenCalledWith(
      expect.objectContaining({ miniModeEnabled: false }),
    );
    const saved = vi.mocked(window.settingsAPI.save).mock.calls[0][0];
    expect(saved.startInMiniModeEnabled).toBeUndefined();
  });
});

describe("SettingsPanel cleanup", () => {
  it("does not expose removed Memory or Tool Pinning settings", async () => {
    render(<SettingsPanel {...defaultProps} />);
    await screen.findByText("Settings");

    expect(screen.queryByText("Memory")).toBeNull();
    expect(screen.queryByText("Tool Pinning")).toBeNull();
  });
});

describe("SettingsPanel tenant policy UI", () => {
  const managedTenant = (overrides: Partial<Awaited<ReturnType<TenantAPI["getStatus"]>>> = {}) => {
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
        ...overrides,
      }),
    };
  };

  async function navigateToPermissions() {
    const user = userEvent.setup();
    await user.click(screen.getByText("Manage Permissions"));
    await waitFor(() => {
      expect(screen.getByText("Capabilities")).toBeInTheDocument();
    });
    return user;
  }

  it("shows managed-by-org banner in permissions panel", async () => {
    managedTenant();
    render(<SettingsPanel {...defaultProps} />);
    await screen.findByText("Settings");
    await navigateToPermissions();
    expect(screen.getByTestId("tenant-managed-banner")).toBeInTheDocument();
    expect(screen.getByText(/managed by your organization/i)).toBeInTheDocument();
  });

  it("hides managed-by-org banner when tenant is not managed", async () => {
    managedTenant({ managed: false });
    render(<SettingsPanel {...defaultProps} />);
    await screen.findByText("Settings");
    await navigateToPermissions();
    expect(screen.queryByTestId("tenant-managed-banner")).not.toBeInTheDocument();
  });

  it("locks server toggle when server is tenant-disabled", async () => {
    managedTenant({ disabledServers: ["filesystem"] });
    render(<SettingsPanel {...defaultProps} />);
    await screen.findByText("Settings");
    await navigateToPermissions();
    expect(screen.getByTestId("tenant-lock-File System Access")).toBeInTheDocument();
  });

  it("does not lock server toggle for non-tenant-disabled servers", async () => {
    managedTenant({ disabledServers: ["filesystem"] });
    render(<SettingsPanel {...defaultProps} />);
    await screen.findByText("Settings");
    await navigateToPermissions();
    expect(screen.queryByTestId("tenant-lock-Shell")).not.toBeInTheDocument();
  });

  it("locks global auto-approve toggle when forcePrompt is true", async () => {
    managedTenant({ forcePrompt: true });
    render(<SettingsPanel {...defaultProps} />);
    await screen.findByText("Settings");
    await navigateToPermissions();
    expect(screen.getByTestId("tenant-lock-auto-approve")).toBeInTheDocument();
  });

  it("locks autopilot toggle when forcePrompt is true", async () => {
    managedTenant({ forcePrompt: true });
    render(<SettingsPanel {...defaultProps} />);
    await screen.findByText("Settings");
    await navigateToPermissions();
    expect(screen.getByTestId("tenant-lock-autopilot-mode")).toBeInTheDocument();
  });

  it("does not lock auto-approve when forcePrompt is false", async () => {
    managedTenant({ managed: false });
    render(<SettingsPanel {...defaultProps} />);
    await screen.findByText("Settings");
    await navigateToPermissions();
    expect(screen.queryByTestId("tenant-lock-auto-approve")).not.toBeInTheDocument();
  });
});

describe("SettingsPanel Hidden Experiments", () => {
  it("does not show Hidden Experiments section by default", () => {
    render(<SettingsPanel {...defaultProps} />);
    expect(screen.queryByText("Hidden Experiments")).not.toBeInTheDocument();
    expect(screen.getByText("Runtime adapters")).toBeInTheDocument();
  });

  it("does not let the local reveal state bypass the signed build profile", () => {
    render(<SettingsPanel {...defaultProps} showHiddenExperiments />);
    expect(screen.queryByText("Hidden Experiments")).not.toBeInTheDocument();
    expect(screen.getByLabelText("AI runtime")).toBeInTheDocument();
  });

  it("keeps runtime selection visible without revealing Hidden Experiments", async () => {
    vi.mocked(window.settingsAPI.get).mockResolvedValue({
      success: true,
      settings: {
        autoApprove: { global: false, perServer: {} },
        runtimeId: "gateway",
      },
    });
    render(<SettingsPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByLabelText("AI runtime")).toHaveTextContent("Gateway");
    });
    expect(screen.queryByText("Hidden Experiments")).not.toBeInTheDocument();
  });

  it("switches between local runtimes without restarting", async () => {
    render(<SettingsPanel {...defaultProps} />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("AI runtime"));
    await user.click(screen.getByRole("option", { name: "Codex" }));

    // Dialog appears
    const confirmDialog = await screen.findByText(/Switch to Codex/i);
    expect(confirmDialog).toBeInTheDocument();
    expect(
      screen.getByText(/Existing chats transfer their context only when you continue them/i),
    ).toBeInTheDocument();

    // Setting not yet persisted
    expect(window.settingsAPI.switchRuntime).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /switch now/i }));

    await waitFor(() => {
      expect(window.settingsAPI.switchRuntime).toHaveBeenCalledWith("codex");
    });
  });

  it("Runtime selection Cancel leaves settings untouched", async () => {
    render(<SettingsPanel {...defaultProps} />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("AI runtime"));
    await user.click(screen.getByRole("option", { name: "Gateway" }));
    await screen.findByText(/Switch to Gateway/i);

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    // No save call
    expect(window.settingsAPI.switchRuntime).not.toHaveBeenCalled();
  });
});

describe("SettingsPanel Workspace section", () => {
  it("renders effective workspace directory and picker actions", async () => {
    vi.mocked(window.settingsAPI.get).mockResolvedValue({
      success: true,
      settings: {
        autoApprove: { global: false, perServer: {} },
        workspaceDir: "C:/Users/test/Dev/Workspace",
      },
    });

    render(<SettingsPanel {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Workspaces")).toBeInTheDocument();
    });
    expect(screen.getByText("Default file location")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTitle("C:/Users/test/Dev/Workspace")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Browse" })).toBeInTheDocument();
    expect(screen.getByText("Changes take effect after you restart Marshal.")).toBeInTheDocument();
  });

  it("Browse picks a folder and updates visible path", async () => {
    vi.mocked(window.settingsAPI.get)
      .mockResolvedValueOnce({
        success: true,
        settings: {
          autoApprove: { global: false, perServer: {} },
        },
      })
      .mockResolvedValue({
        success: true,
        settings: {
          autoApprove: { global: false, perServer: {} },
          workspaceDir: "C:/Users/test/Dev/Workspace",
        },
      });
    vi.mocked(window.settingsAPI.pickWorkspaceDir).mockResolvedValue({
      success: true,
      folderPath: "C:/Users/test/Dev/Workspace",
    });

    render(<SettingsPanel {...defaultProps} />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Browse" }));

    await waitFor(() => {
      expect(window.settingsAPI.pickWorkspaceDir).toHaveBeenCalledWith(
        "C:/Users/test/Documents/Marshal",
      );
      expect(window.settingsAPI.save).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceDir: "C:/Users/test/Dev/Workspace" }),
      );
      expect(screen.getByTitle("C:/Users/test/Dev/Workspace")).toBeInTheDocument();
    });
  });
});

describe("SettingsPanel worktree location", () => {
  it("picks a device-local root for future subagent worktrees", async () => {
    vi.mocked(window.settingsAPI.get)
      .mockResolvedValueOnce({
        success: true,
        settings: {
          autoApprove: { global: false, perServer: {} },
          worktreeDir: "Q:/Marshal/worktrees-old",
        },
      })
      .mockResolvedValue({
        success: true,
        settings: {
          autoApprove: { global: false, perServer: {} },
          worktreeDir: "Q:/Marshal/worktrees",
        },
      });
    vi.mocked(window.settingsAPI.pickWorktreeDir).mockResolvedValue({
      success: true,
      folderPath: "Q:/Marshal/worktrees",
    });

    render(<SettingsPanel {...defaultProps} />);
    const user = userEvent.setup();
    await screen.findByText("New worktree location");
    await screen.findByTitle("Q:/Marshal/worktrees-old");
    await user.click(screen.getByRole("button", { name: "Browse worktree location" }));

    await waitFor(() => {
      expect(window.settingsAPI.pickWorktreeDir).toHaveBeenCalledWith("Q:/Marshal/worktrees-old");
      expect(window.settingsAPI.save).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeDir: "Q:/Marshal/worktrees" }),
      );
      expect(screen.getByTitle("Q:/Marshal/worktrees")).toBeInTheDocument();
    });
  });

  it("resets future worktrees to the app-data default", async () => {
    vi.mocked(window.settingsAPI.get)
      .mockResolvedValueOnce({
        success: true,
        settings: {
          autoApprove: { global: false, perServer: {} },
          worktreeDir: "Q:/Marshal/worktrees",
        },
      })
      .mockResolvedValue({
        success: true,
        settings: {
          autoApprove: { global: false, perServer: {} },
        },
      });

    render(<SettingsPanel {...defaultProps} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Reset worktree location" }));

    await waitFor(() => {
      expect(window.settingsAPI.save).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeDir: undefined }),
      );
      expect(screen.getByTitle("Default (~/.marshal/marshal-worktrees)")).toBeInTheDocument();
    });
  });
});

describe("SettingsPanel dismiss button", () => {
  it("renders a Close button when onClose is provided", async () => {
    const onClose = vi.fn<() => void>();
    render(<SettingsPanel {...defaultProps} onClose={onClose} />);

    const closeBtn = await screen.findByRole("button", { name: "Close" });
    expect(closeBtn).toBeInTheDocument();
  });

  it("calls onClose when the Close button is clicked", async () => {
    const onClose = vi.fn<() => void>();
    render(<SettingsPanel {...defaultProps} onClose={onClose} />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not render a Close button when onClose is omitted", async () => {
    render(<SettingsPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });
});

describe("SettingsPanel extension settings", () => {
  it("does not show a Swarm settings section", async () => {
    render(<SettingsPanel {...defaultProps} />);
    await screen.findByText("Permissions");
    expect(screen.queryByText("Swarm")).not.toBeInTheDocument();
    expect(screen.queryByTestId("swarm-worker-model-select")).not.toBeInTheDocument();
  });
});
