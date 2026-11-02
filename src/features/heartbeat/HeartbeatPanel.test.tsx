import type {
  AutomationCapabilities,
  HeartbeatControllableMap,
  TenantAPI,
} from "@common/marshal-ipc-contract";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Spy on sonner.toast.error so the error-path tests can
// assert the IPC `result.error` actually reaches the user.
// HeartbeatPanel was the original site of the dead-letter pattern; this
// hooks it at the panel layer so a future refactor that drops
// `useIpcMutation` for a hand-rolled `await + invalidate` is caught.
const toastErrorSpy = vi.fn<(message: string) => void>();
vi.mock("sonner", () => ({
  toast: {
    error: (message: string) => toastErrorSpy(message),
  },
}));

import {
  ALL_AUTOMATION_CAPABILITIES_MOCK,
  ALL_CONTROLLABLE_MOCK,
  installMockAPIs,
  render,
  screen,
  waitFor,
} from "@/test-utils";
import type { BackendAPI, HeartbeatAPI, PermissionsAPI } from "@/types/electron";

import { HeartbeatPanel } from "./HeartbeatPanel";

// Local aliases so existing references stay short — single source of truth in test-utils.
const ALL_CONTROLLABLE = ALL_CONTROLLABLE_MOCK;
const ALL_CAPABILITIES = ALL_AUTOMATION_CAPABILITIES_MOCK;

describe("HeartbeatPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs({
      heartbeatAPI: {
        status: vi.fn<HeartbeatAPI["status"]>().mockResolvedValue({
          success: true,
          status: {
            supported: true,
            enabled: true,
            lastRun: "2025-01-01 12:00:00",
            nextRun: null,
            running: false,
          },
        }),
        getSettings: vi.fn<HeartbeatAPI["getSettings"]>().mockResolvedValue({
          success: true,
          settings: {
            supported: true,
            intervalMinutes: 30,
            schedule: "work-hours",
            prompt: "Check chat for urgent messages",
            controllable: ALL_CONTROLLABLE,
          },
        }),
        getLogs: vi.fn<HeartbeatAPI["getLogs"]>().mockResolvedValue({
          success: true,
          logs: [
            { timestamp: "2025-01-01 12:00:00", type: "start", message: "Starting heartbeat" },
          ],
        }),
      },
    });
  });

  it("returns null when isOpen is false", () => {
    const { container } = render(<HeartbeatPanel isOpen={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows panel when isOpen is true", async () => {
    render(<HeartbeatPanel isOpen={true} />);
    await waitFor(() => {
      expect(screen.getByText("Heartbeat")).toBeInTheDocument();
    });
  });

  it("shows active status when enabled", async () => {
    render(<HeartbeatPanel isOpen={true} />);
    await waitFor(() => {
      expect(screen.getByText(/Active/)).toBeInTheDocument();
    });
  });

  it("shows disable button when heartbeat is active", async () => {
    render(<HeartbeatPanel isOpen={true} />);
    await waitFor(() => {
      expect(screen.getByText("Disable")).toBeInTheDocument();
    });
  });

  it("shows frequency and schedule dropdowns", async () => {
    render(<HeartbeatPanel isOpen={true} />);
    await waitFor(() => {
      expect(screen.getByText("Frequency")).toBeInTheDocument();
      expect(screen.getByText("Schedule")).toBeInTheDocument();
    });
  });

  it("shows prompt textarea with saved content", async () => {
    render(<HeartbeatPanel isOpen={true} />);
    await waitFor(() => {
      expect(screen.getByText("What to check")).toBeInTheDocument();
      expect(screen.getByDisplayValue("Check chat for urgent messages")).toBeInTheDocument();
    });
  });

  it("shows collapsible Recent Activity section", async () => {
    render(<HeartbeatPanel isOpen={true} />);
    await waitFor(() => {
      expect(screen.getByText(/Recent Activity/)).toBeInTheDocument();
    });
  });

  it("shows View all button when onOpenActivities is provided", async () => {
    const mockOnOpenActivities = vi.fn<() => void>();
    render(<HeartbeatPanel isOpen={true} onOpenActivities={mockOnOpenActivities} />);
    await waitFor(() => {
      expect(screen.getByText("View all")).toBeInTheDocument();
    });
  });

  it("calls onOpenActivities when View all clicked", async () => {
    const mockOnOpenActivities = vi.fn<() => void>();
    render(<HeartbeatPanel isOpen={true} onOpenActivities={mockOnOpenActivities} />);
    await waitFor(() => {
      expect(screen.getByText("View all")).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByText("View all"));
    expect(mockOnOpenActivities).toHaveBeenCalledOnce();
  });

  it("shows Run now button", async () => {
    render(<HeartbeatPanel isOpen={true} />);
    await waitFor(() => {
      expect(screen.getByText("Run now")).toBeInTheDocument();
    });
  });

  it("refetches status after toggling heartbeat", async () => {
    render(<HeartbeatPanel isOpen={true} />);
    await waitFor(() => {
      expect(screen.getByText("Disable")).toBeInTheDocument();
    });

    const statusMock = vi.mocked(window.heartbeatAPI.status);
    const callCountBefore = statusMock.mock.calls.length;

    const user = userEvent.setup();
    await user.click(screen.getByText("Disable"));

    await waitFor(() => {
      expect(window.heartbeatAPI.toggle).toHaveBeenCalledWith(false);
    });
    await waitFor(() => {
      expect(statusMock.mock.calls.length).toBeGreaterThan(callCountBefore);
    });
  });

  it("refetches settings after changing interval", async () => {
    render(<HeartbeatPanel isOpen={true} />);
    await waitFor(() => {
      expect(screen.getByText("Frequency")).toBeInTheDocument();
    });

    const getSettingsMock = vi.mocked(window.heartbeatAPI.getSettings);
    const callCountBefore = getSettingsMock.mock.calls.length;

    // Open the frequency dropdown and select "Every hour"
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Frequency" }));
    await user.click(await screen.findByText("Every hour"));

    await waitFor(() => {
      expect(window.heartbeatAPI.saveSettings).toHaveBeenCalledWith({ intervalMinutes: 60 });
    });
    await waitFor(() => {
      expect(getSettingsMock.mock.calls.length).toBeGreaterThan(callCountBefore);
    });
  });

  it("shows link to Settings power management when heartbeat is enabled", async () => {
    const mockOpenSettings = vi.fn<() => void>();
    render(<HeartbeatPanel isOpen={true} onOpenSettings={mockOpenSettings} />);

    await waitFor(() => {
      expect(screen.getByText(/Power Management/)).toBeInTheDocument();
    });
  });

  it("navigates to Settings when power management link is clicked", async () => {
    const user = userEvent.setup();
    const mockOpenSettings = vi.fn<() => void>();
    render(<HeartbeatPanel isOpen={true} onOpenSettings={mockOpenSettings} />);

    const link = await screen.findByText(/Settings → Power Management/);
    await user.click(link);

    expect(mockOpenSettings).toHaveBeenCalled();
  });

  it("shows work schedule config when schedule is work-hours", async () => {
    render(<HeartbeatPanel isOpen={true} />);
    await waitFor(() => {
      expect(screen.getByText("Work days")).toBeInTheDocument();
      expect(screen.getByLabelText("Work start hour")).toBeInTheDocument();
      expect(screen.getByLabelText("Work end hour")).toBeInTheDocument();
    });
    // Default work days: Mon–Fri should be pressed
    expect(screen.getByLabelText("Mon")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Sat")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("Sun")).toHaveAttribute("aria-pressed", "false");
  });

  it("toggles a work day and saves", async () => {
    render(<HeartbeatPanel isOpen={true} />);
    await waitFor(() => {
      expect(screen.getByText("Work days")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    // Toggle Saturday on
    await user.click(screen.getByLabelText("Sat"));

    await waitFor(() => {
      expect(window.heartbeatAPI.saveSettings).toHaveBeenCalledWith({
        workDays: [1, 2, 3, 4, 5, 6],
      });
    });
  });

  it("hides work schedule config when schedule is always", async () => {
    vi.mocked(window.heartbeatAPI.getSettings).mockResolvedValue({
      success: true,
      settings: {
        supported: true,
        intervalMinutes: 30,
        schedule: "always",
        prompt: "Check messages",
        controllable: ALL_CONTROLLABLE,
      },
    });
    render(<HeartbeatPanel isOpen={true} />);
    // Wait for "Always" schedule label to appear (confirms settings loaded)
    await waitFor(() => {
      expect(screen.getByText("Always (while app is open)")).toBeInTheDocument();
    });
    expect(screen.queryByText("Work days")).not.toBeInTheDocument();
  });
});

describe("HeartbeatPanel — empty prompt warning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs({
      heartbeatAPI: {
        status: vi.fn<HeartbeatAPI["status"]>().mockResolvedValue({
          success: true,
          status: {
            supported: true,
            enabled: true,
            lastRun: null,
            nextRun: null,
            running: false,
          },
        }),
        getSettings: vi.fn<HeartbeatAPI["getSettings"]>().mockResolvedValue({
          success: true,
          settings: {
            supported: true,
            intervalMinutes: 30,
            schedule: "work-hours",
            prompt: "",
            controllable: ALL_CONTROLLABLE,
          },
        }),
        getLogs: vi.fn<HeartbeatAPI["getLogs"]>().mockResolvedValue({ success: true, logs: [] }),
      },
    });
  });

  it("shows warning when user clears the prompt", async () => {
    const user = userEvent.setup();
    render(<HeartbeatPanel isOpen={true} />);
    const textarea = await screen.findByPlaceholderText(/Check my inbox/);

    // Warning visible immediately — enabled + empty saved prompt
    await waitFor(() => {
      expect(screen.getByText(/every run is skipped/)).toBeInTheDocument();
    });

    // Type something — warning disappears
    await user.type(textarea, "Check my inbox");
    expect(screen.queryByText(/every run is skipped/)).not.toBeInTheDocument();

    // Clear — warning returns
    await user.clear(textarea);
    await waitFor(() => {
      expect(screen.getByText(/every run is skipped/)).toBeInTheDocument();
    });
  });

  it("hides warning when user types a prompt", async () => {
    const user = userEvent.setup();
    render(<HeartbeatPanel isOpen={true} />);
    const textarea = await screen.findByPlaceholderText(/Check my inbox/);

    await waitFor(() => {
      expect(screen.getByText(/every run is skipped/)).toBeInTheDocument();
    });

    await user.type(textarea, "Check my inbox");
    expect(screen.queryByText(/every run is skipped/)).not.toBeInTheDocument();
  });

  it("disables Save button when prompt is empty", async () => {
    const user = userEvent.setup();
    render(<HeartbeatPanel isOpen={true} />);
    const textarea = await screen.findByPlaceholderText(/Check my inbox/);

    // Type and clear to trigger dirty state with empty prompt
    await user.type(textarea, "x");
    await user.clear(textarea);

    await waitFor(() => {
      const saveBtn = screen.getByRole("button", { name: /Save/ });
      expect(saveBtn).toBeDisabled();
    });
  });

  it("disables Enable button when prompt is empty", async () => {
    // Use disabled heartbeat so Enable button is shown
    installMockAPIs({
      heartbeatAPI: {
        status: vi.fn<HeartbeatAPI["status"]>().mockResolvedValue({
          success: true,
          status: {
            supported: true,
            enabled: false,
            lastRun: null,
            nextRun: null,
            running: false,
          },
        }),
        getSettings: vi.fn<HeartbeatAPI["getSettings"]>().mockResolvedValue({
          success: true,
          settings: {
            supported: true,
            intervalMinutes: 30,
            schedule: "work-hours",
            prompt: "",
            controllable: ALL_CONTROLLABLE,
          },
        }),
        getLogs: vi.fn<HeartbeatAPI["getLogs"]>().mockResolvedValue({ success: true, logs: [] }),
      },
    });
    render(<HeartbeatPanel isOpen={true} />);

    await waitFor(() => {
      const enableBtn = screen.getByRole("button", { name: /Enable/ });
      expect(enableBtn).toBeDisabled();
    });
  });

  it("preserves an unsaved prompt draft when frequency changes", async () => {
    // saveSettings must persist the patch and getSettings must return the
    // updated envelope — otherwise React Query's structural sharing returns
    // the same reference and the buggy sync effect never fires.
    let savedInterval: 15 | 30 | 60 | 120 = 30;
    vi.mocked(window.heartbeatAPI.getSettings).mockImplementation(() =>
      Promise.resolve({
        success: true,
        settings: {
          supported: true,
          intervalMinutes: savedInterval,
          schedule: "work-hours",
          prompt: "",
          controllable: ALL_CONTROLLABLE,
        },
      }),
    );
    vi.mocked(window.heartbeatAPI.saveSettings).mockImplementation((patch) => {
      if (patch.intervalMinutes !== undefined) savedInterval = patch.intervalMinutes;
      return Promise.resolve({ success: true });
    });

    const user = userEvent.setup();
    render(<HeartbeatPanel isOpen={true} />);
    const textarea = await screen.findByPlaceholderText(/Check my inbox/);

    await user.type(textarea, "draft prompt");
    expect(textarea).toHaveValue("draft prompt");

    await user.click(screen.getByRole("button", { name: "Frequency" }));
    await user.click(await screen.findByText("Every hour"));

    await waitFor(() => {
      expect(window.heartbeatAPI.saveSettings).toHaveBeenCalledWith({ intervalMinutes: 60 });
    });
    // Wait for the refetch to land — the new settings reference is what
    // would trigger the bug.
    await waitFor(() => {
      expect(screen.getByText("Every hour")).toBeInTheDocument();
    });

    expect(textarea).toHaveValue("draft prompt");
  });

  it("shows prompt-required message when disabled and prompt is empty", async () => {
    installMockAPIs({
      heartbeatAPI: {
        status: vi.fn<HeartbeatAPI["status"]>().mockResolvedValue({
          success: true,
          status: {
            supported: true,
            enabled: false,
            lastRun: null,
            nextRun: null,
            running: false,
          },
        }),
        getSettings: vi.fn<HeartbeatAPI["getSettings"]>().mockResolvedValue({
          success: true,
          settings: {
            supported: true,
            intervalMinutes: 30,
            schedule: "work-hours",
            prompt: "",
            controllable: ALL_CONTROLLABLE,
          },
        }),
        getLogs: vi.fn<HeartbeatAPI["getLogs"]>().mockResolvedValue({ success: true, logs: [] }),
      },
    });
    const user = userEvent.setup();
    render(<HeartbeatPanel isOpen={true} />);
    const textarea = await screen.findByPlaceholderText(/Check my inbox/);

    // Type and clear to trigger dirty state
    await user.type(textarea, "x");
    await user.clear(textarea);

    await waitFor(() => {
      expect(screen.getByText(/prompt is required/)).toBeInTheDocument();
    });
  });
});

describe("HeartbeatPanel — tenant disabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs({
      heartbeatAPI: {
        status: vi.fn<HeartbeatAPI["status"]>().mockResolvedValue({
          success: true,
          status: {
            supported: true,
            enabled: false,
            lastRun: null,
            nextRun: null,
            running: false,
          },
        }),
        getSettings: vi.fn<HeartbeatAPI["getSettings"]>().mockResolvedValue({
          success: true,
          settings: {
            supported: true,
            intervalMinutes: 30,
            schedule: "work-hours",
            prompt: "",
            controllable: ALL_CONTROLLABLE,
          },
        }),
        getLogs: vi.fn<HeartbeatAPI["getLogs"]>().mockResolvedValue({ success: true, logs: [] }),
      },
    });
  });

  it("shows disabled-by-org placeholder when disableHeartbeat is true", async () => {
    // Override tenantAPI to return disableHeartbeat: true (component reads from hook)
    window.tenantAPI = {
      getStatus: vi.fn<TenantAPI["getStatus"]>().mockResolvedValue({
        success: true,
        managed: true,
        disabledServers: [],
        disabledPermissionKinds: [],
        forcePrompt: false,
        disabledModels: [],
        disableHeartbeat: true,
        disableAutomations: false,
        disabledProviders: [],
        restrictToWorkspace: false,
        browserEgressBlockedOrigins: [],
      }),
    };
    render(<HeartbeatPanel isOpen={true} />);
    await waitFor(() => {
      expect(screen.getByText(/disabled by your organization/i)).toBeInTheDocument();
    });
  });

  it("does not show disabled-by-org placeholder when disableHeartbeat is false", async () => {
    render(<HeartbeatPanel isOpen={true} />);
    await waitFor(() => {
      expect(screen.getByText("Heartbeat")).toBeInTheDocument();
    });
    expect(screen.queryByText(/disabled by your organization/i)).not.toBeInTheDocument();
  });
});

describe("HeartbeatPanel capability-aware rendering", () => {
  /**
   * Render the panel with overridden capability flags.
   *  - `controllable`: per-field editability map merged into HeartbeatSettingsEnvelope
   *  - `capabilities`: AutomationCapabilities subset merged into BackendAPI.capabilities()
   *
   * Both default to fully enabled (copilot-flavored), so each test only
   * specifies the flags it cares about flipping off.
   */
  function renderPanelWithCaps(
    controllable: Partial<HeartbeatControllableMap> = {},
    capabilities: Partial<AutomationCapabilities> = {},
    permissionsAPI: Partial<PermissionsAPI> = {},
  ) {
    vi.clearAllMocks();
    installMockAPIs({
      heartbeatAPI: {
        status: vi.fn<HeartbeatAPI["status"]>().mockResolvedValue({
          success: true,
          status: {
            supported: true,
            enabled: true,
            lastRun: null,
            nextRun: null,
            running: false,
          },
        }),
        getSettings: vi.fn<HeartbeatAPI["getSettings"]>().mockResolvedValue({
          success: true,
          settings: {
            supported: true,
            intervalMinutes: 30,
            schedule: "work-hours",
            prompt: "Check chat",
            controllable: { ...ALL_CONTROLLABLE, ...controllable },
          },
        }),
        getLogs: vi.fn<HeartbeatAPI["getLogs"]>().mockResolvedValue({ success: true, logs: [] }),
      },
      backendAPI: {
        capabilities: vi.fn<BackendAPI["capabilities"]>().mockResolvedValue({
          taskList: false,
          cronExpressions: false,
          retryPolicy: false,
          policyEditor: false,
          heartbeatIsolated: false,
          modelFallback: false,
          connectionStatus: false,
          sessionCompaction: false,
          busyTurnSteer: false,
          automations: { ...ALL_CAPABILITIES, ...capabilities },
          desktopCapabilities: {
            localTools: false,
            notifications: false,
          },
        }),
      },
      permissionsAPI,
    });
    return render(<HeartbeatPanel isOpen={true} />);
  }

  it("disables intervalMinutes select when controllable.intervalMinutes is false", async () => {
    renderPanelWithCaps({ intervalMinutes: false }, {});
    // Wait for settings query to resolve (panel renders with ALL_CONTROLLABLE
    // default until then).
    await waitFor(() => {
      expect(screen.getByLabelText(/frequency/i)).toBeDisabled();
    });
  });

  it("hides WorkDaysPicker when controllable.workDays is false", async () => {
    renderPanelWithCaps(
      {
        workDays: false,
        workStartHour: false,
        workEndHour: false,
      },
      {},
    );
    await waitFor(() => {
      expect(screen.queryByTestId("work-days-picker")).not.toBeInTheDocument();
    });
  });

  it("hides PermissionsSection when permissions envelope has no controllable", async () => {
    // Simulate a backend where the permissions envelope has no controllable map
    // (e.g. supported:false). The section must not render in this case.
    renderPanelWithCaps(
      {},
      {},
      {
        getConfig: vi
          .fn<PermissionsAPI["getConfig"]>()
          .mockResolvedValue({ success: false, error: "unsupported" }),
      },
    );
    await waitFor(() => {
      expect(screen.queryByTestId("heartbeat-permissions-section")).not.toBeInTheDocument();
    });
  });

  it("hides RunNowButton when capabilities.heartbeatRunNow is false", async () => {
    renderPanelWithCaps({}, { heartbeatRunNow: false });
    // Wait for capabilities query to resolve (panel initially renders with the
    // copilot-flavored ALL_ENABLED default while the query loads).
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /run now/i })).not.toBeInTheDocument();
    });
  });

  it("shows everything as editable when controllable map is all true and heartbeatRunNow is true", async () => {
    renderPanelWithCaps({}, {});
    // waitFor the ready state — gated sections are now suppressed until both
    // the capabilities and settings queries settle (the "no flash" fix).
    await waitFor(() => {
      expect(screen.getByTestId("heartbeat-permissions-section")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /run now/i })).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/frequency/i)).not.toBeDisabled();
    expect(screen.getByTestId("work-days-picker")).toBeInTheDocument();
  });

  it("gateway profile (workDays:false, hours:true): container present, day toggles hidden, hours editable", async () => {
    // The earlier "hides WorkDaysPicker when workDays:false" test set all
    // three flags false — but the real GATEWAY_CONTROLLABLE has workDays:false
    // with hours:true. A regression that gated the container on the workDays
    // flag alone (instead of the OR-derived showWorkScheduleSection) wouldn't
    // be caught by the all-three-false test. This pins the actual gateway
    // shape.
    renderPanelWithCaps({ workDays: false, workStartHour: true, workEndHour: true }, {});
    // waitFor the steady-state: settings query resolves and the panel
    // re-renders with the gateway controllable map. Without this, the
    // initial-render-with-ALL_CONTROLLABLE snapshot would still show the
    // day buttons.
    await waitFor(() => {
      // Outer container renders because hours are editable.
      expect(screen.getByTestId("work-days-picker")).toBeInTheDocument();
      // Day toggles inside the container do NOT render (the inner
      // controllable.workDays gate is independent of the outer container).
      expect(screen.queryByLabelText("Mon")).not.toBeInTheDocument();
    });
    // Hours dropdowns remain accessible.
    expect(screen.getByLabelText(/work start hour/i)).not.toBeDisabled();
    expect(screen.getByLabelText(/work end hour/i)).not.toBeDisabled();
  });

  describe("save handler error path", () => {
    beforeEach(() => {
      toastErrorSpy.mockClear();
    });

    it("toggle: surfaces result.error as a toast when backend returns success: false", async () => {
      // Originally, HeartbeatPanel.handleToggle was `await api.toggle(...)`
      // followed by `void invalidateQueries(...)` — it dropped the IPC
      // envelope. surfaceIpcError then landed as a band-aid;
      // the useIpcMutation refactor moved the toast into useIpcMutation. Pin it
      // here so a regression that drops the helper is caught at the panel
      // layer.
      renderPanelWithCaps({}, {});
      const disableBtn = await screen.findByRole("button", { name: "Disable" });
      vi.mocked(window.heartbeatAPI.toggle).mockResolvedValue({
        success: false,
        error: "Heartbeat is disabled by your organization's policy",
      });

      const user = userEvent.setup();
      await user.click(disableBtn);

      await waitFor(() => {
        expect(toastErrorSpy).toHaveBeenCalledWith(
          "Heartbeat is disabled by your organization's policy",
        );
      });
    });

    it("saveSettings (interval change): falls back to the helper's fallbackErrorMessage when result.error is missing", async () => {
      // Defensive case mirroring the AutomationsPanel parallel: a future
      // gateway IPC bug returning `{ success: false }` without an `error`
      // field still surfaces the panel-configured fallback rather than
      // silently dropping.
      renderPanelWithCaps({}, {});
      const frequencyBtn = await screen.findByLabelText(/frequency/i);
      vi.mocked(window.heartbeatAPI.saveSettings).mockResolvedValue({ success: false });

      const user = userEvent.setup();
      await user.click(frequencyBtn);
      const item = await screen.findByRole("menuitem", { name: /Every 15 min/ });
      await user.click(item);

      await waitFor(() => {
        expect(toastErrorSpy).toHaveBeenCalledWith("Failed to save heartbeat settings");
      });
    });
  });

  it("renders the not-connected placeholder when settings envelope is { supported: false }", async () => {
    // Discriminated-union envelopes: backends that report supported:false
    // bypass the editable UI and surface a clear placeholder. This is the
    // payoff of the Phase 2a hazard #2 fix — the renderer can't accidentally
    // read fields off an unsupported envelope.
    installMockAPIs({
      heartbeatAPI: {
        status: vi.fn<HeartbeatAPI["status"]>().mockResolvedValue({
          success: true,
          status: { supported: false },
        }),
        getSettings: vi.fn<HeartbeatAPI["getSettings"]>().mockResolvedValue({
          success: true,
          settings: { supported: false },
        }),
        getLogs: vi.fn<HeartbeatAPI["getLogs"]>().mockResolvedValue({ success: true, logs: [] }),
      },
    });
    render(<HeartbeatPanel isOpen={true} />);
    await waitFor(() => {
      expect(screen.getByText(/not connected to a backend/i)).toBeInTheDocument();
    });
    // Editable form fields must not render — the discriminated union prevents
    // reading settings.intervalMinutes off an unsupported envelope, but a
    // future regression that drops the early-return would render the form
    // with default values; this assertion locks the placeholder branch.
    expect(screen.queryByLabelText(/frequency/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("work-days-picker")).not.toBeInTheDocument();
  });

  it("gateway permissions section: renders with perHeartbeatScope:false → Customize button disabled", async () => {
    // Pair with HeartbeatPanel finding 2: would have caught missing controllable forward.
    // Gateway-style controllable: perHeartbeatScope false, other keys vary.
    const gatewayControllable = {
      tools: { enabled: true },
      autopilotMode: { enabled: true },
      autoApproveReadOnly: { enabled: true },
      shellAllow: { enabled: true },
      shellDeny: {
        enabled: false,
        disabledReason: "Shell command deny patterns are not supported in gateway mode yet.",
      },
      serverEnabled: {
        enabled: false,
        disabledReason: "MCP server enable/disable is not supported in gateway mode yet.",
      },
      serverAutoApprove: {
        enabled: false,
        disabledReason: "Per-server auto-approve is not supported in gateway mode yet.",
      },
      perHeartbeatScope: {
        enabled: false,
        disabledReason: "Per-heartbeat overrides are not supported in gateway mode yet.",
      },
    };
    renderPanelWithCaps(
      {},
      {},
      {
        getConfig: vi.fn<PermissionsAPI["getConfig"]>().mockResolvedValue({
          success: true,
          envelope: {
            supported: true,
            permissions: { autoApproveReadOnly: true, allow: [], tools: {}, servers: {} },
            controllable: gatewayControllable,
          },
        }),
      },
    );

    // The permissions section must render when controllable is present.
    await waitFor(() => {
      expect(screen.getByTestId("heartbeat-permissions-section")).toBeInTheDocument();
    });

    // Customize button should be disabled because perHeartbeatScope is false.
    const customizeBtn = screen.getByRole("button", { name: /customize/i });
    expect(customizeBtn).toBeDisabled();
  });
});

describe("HeartbeatPanel dismiss button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs({
      heartbeatAPI: {
        status: vi.fn<HeartbeatAPI["status"]>().mockResolvedValue({
          success: true,
          status: {
            supported: true,
            enabled: true,
            lastRun: "2025-01-01 12:00:00",
            nextRun: null,
            running: false,
          },
        }),
        getSettings: vi.fn<HeartbeatAPI["getSettings"]>().mockResolvedValue({
          success: true,
          settings: {
            supported: true,
            intervalMinutes: 30,
            schedule: "work-hours",
            prompt: "Check chat",
            controllable: ALL_CONTROLLABLE,
          },
        }),
      },
    });
  });

  it("renders Close button when onClose is provided", async () => {
    render(<HeartbeatPanel isOpen={true} onClose={vi.fn<() => void>()} />);
    expect(await screen.findByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("calls onClose when Close button is clicked", async () => {
    const onClose = vi.fn<() => void>();
    const user = userEvent.setup();
    render(<HeartbeatPanel isOpen={true} onClose={onClose} />);
    await user.click(await screen.findByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
