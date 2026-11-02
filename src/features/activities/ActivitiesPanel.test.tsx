import { act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs, render, screen, waitFor } from "@/test-utils";
import type {
  ActivitiesAPI,
  HeartbeatLogEntry,
  SessionsAPI,
  AutomationData,
  AutomationRunData,
} from "@/types/electron";

import { ActivitiesPanel } from "./ActivitiesPanel";

const AUTOMATION: AutomationData = {
  id: "wf-1",
  name: "Daily Report",
  description: "A daily report automation",
  steps: [],
  schedule: { naturalLanguage: "every weekday at 9am", days: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
  enabled: true,
  triggerType: "schedule",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

function setupAPIs({
  heartbeatEnabled = false,
  lastRun = null as string | null,
  logs = [] as HeartbeatLogEntry[],
  automations = [] as (typeof AUTOMATION)[],
  allAutomationRuns = [] as AutomationRunData[],
} = {}) {
  installMockAPIs({
    activitiesAPI: {
      getAll: vi.fn<ActivitiesAPI["getAll"]>().mockResolvedValue({
        success: true,
        heartbeatStatus: {
          enabled: heartbeatEnabled,
          lastRun,
          nextRun: null,
          running: false,
        },
        heartbeatSettings: {
          enabled: heartbeatEnabled,
          intervalMinutes: 30 as const,
          schedule: "work-hours",
          prompt: "Check chat",
        },
        heartbeatLogs: logs,
        automations,
        allAutomationRuns,
        conditionStatuses: {},
      }),
    },
  });
}

function getActivityItem(name: string) {
  const items = screen.getAllByTestId("activity-item");
  const item = items.find((el) => el.textContent?.includes(name));
  if (!item) throw new Error(`No activity-item containing "${name}"`);
  return item;
}

describe("ActivitiesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupAPIs();
  });

  it("returns null when isOpen is false", () => {
    const { container } = render(<ActivitiesPanel isOpen={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows panel header when isOpen is true", async () => {
    render(<ActivitiesPanel isOpen={true} />);
    expect(await screen.findByText("Activity")).toBeInTheDocument();
  });

  it("shows Upcoming, History, and Command Center tabs", async () => {
    render(<ActivitiesPanel isOpen={true} />);
    await waitFor(() => {
      expect(screen.getByText("Upcoming")).toBeInTheDocument();
      expect(screen.getByText("History")).toBeInTheDocument();
      expect(screen.getByText("Command Center")).toBeInTheDocument();
    });
  });

  it("defaults to Upcoming tab", async () => {
    render(<ActivitiesPanel isOpen={true} />);
    const upcomingTab = await screen.findByRole("tab", { name: "Upcoming" });
    expect(upcomingTab).toHaveAttribute("data-state", "active");
  });

  it("switches to History tab when clicked", async () => {
    const user = userEvent.setup();
    render(<ActivitiesPanel isOpen={true} />);
    await screen.findByText("History");
    await user.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("data-state", "active");
  });

  it("opens legacy Command Center deep links on the Activity tab", async () => {
    render(<ActivitiesPanel isOpen={true} initialTab="command-center" />);

    expect(await screen.findByRole("tab", { name: "Command Center" })).toHaveAttribute(
      "data-state",
      "active",
    );
    expect(await screen.findByTestId("command-center-section-active")).toBeInTheDocument();
    expect(screen.getByTestId("command-center-detail")).toBeInTheDocument();
  });

  it("updates the selected tab when history changes the route-provided tab", async () => {
    const { rerender } = render(<ActivitiesPanel isOpen={true} initialTab="upcoming" />);

    expect(await screen.findByRole("tab", { name: "Upcoming" })).toHaveAttribute(
      "data-state",
      "active",
    );

    rerender(<ActivitiesPanel isOpen={true} initialTab="command-center" />);

    expect(await screen.findByRole("tab", { name: "Command Center" })).toHaveAttribute(
      "data-state",
      "active",
    );
  });

  describe("Upcoming tab", () => {
    it("shows empty state when no automations configured", async () => {
      setupAPIs({ heartbeatEnabled: false });
      // Override getAll to return undefined status/settings so no entries are built
      vi.mocked(window.activitiesAPI!.getAll).mockResolvedValue({
        success: true,
        heartbeatStatus: undefined,
        heartbeatSettings: undefined,
        heartbeatLogs: [],
        automations: [],
        allAutomationRuns: [],
        conditionStatuses: {},
      });
      render(<ActivitiesPanel isOpen={true} />);
      expect(await screen.findByText("No automations configured yet")).toBeInTheDocument();
    });

    it("shows heartbeat entry when enabled", async () => {
      setupAPIs({ heartbeatEnabled: true, lastRun: "2025-01-01 12:00:00" });
      render(<ActivitiesPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByText("Heartbeat")).toBeInTheDocument();
        expect(screen.getByText(/Every 30m/)).toBeInTheDocument();
      });
    });

    it("shows disabled heartbeat as off", async () => {
      setupAPIs({ heartbeatEnabled: false });
      render(<ActivitiesPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByText("Heartbeat")).toBeInTheDocument();
        expect(screen.getByText("off")).toBeInTheDocument();
      });
    });

    it("shows automation with schedule label", async () => {
      setupAPIs({ automations: [AUTOMATION] });
      render(<ActivitiesPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByText("Daily Report")).toBeInTheDocument();
        expect(screen.getByText("every weekday at 9am")).toBeInTheDocument();
      });
    });

    it("shows disabled automation with reduced opacity", async () => {
      setupAPIs({ automations: [{ ...AUTOMATION, enabled: false }] });
      render(<ActivitiesPanel isOpen={true} />);
      await screen.findByText("Daily Report");
      const item = getActivityItem("Daily Report");
      expect(item.className).toContain("opacity-50");
    });

    it("navigates to automations panel when clicking an upcoming automation", async () => {
      const user = userEvent.setup();
      const onOpenAutomations = vi.fn<() => void>();
      setupAPIs({ automations: [AUTOMATION] });
      render(<ActivitiesPanel isOpen={true} onOpenAutomations={onOpenAutomations} />);
      await screen.findByText("Daily Report");
      const item = getActivityItem("Daily Report");
      await user.click(item);
      expect(onOpenAutomations).toHaveBeenCalledOnce();
    });

    it("navigates to heartbeat panel when clicking the upcoming heartbeat entry", async () => {
      const user = userEvent.setup();
      const onOpenHeartbeat = vi.fn<() => void>();
      setupAPIs({ heartbeatEnabled: true, lastRun: "2025-01-01 12:00:00" });
      render(<ActivitiesPanel isOpen={true} onOpenHeartbeat={onOpenHeartbeat} />);
      await screen.findByText("Heartbeat");
      const item = getActivityItem("Heartbeat");
      await user.click(item);
      expect(onOpenHeartbeat).toHaveBeenCalledOnce();
    });

    it("does not add cursor-pointer class to upcoming automation when onOpenAutomations is not provided", async () => {
      setupAPIs({ automations: [AUTOMATION] });
      render(<ActivitiesPanel isOpen={true} />);
      await screen.findByText("Daily Report");
      const item = getActivityItem("Daily Report");
      expect(item.className).not.toContain("cursor-pointer");
    });
  });

  describe("History tab", () => {
    it("shows empty state when no history", async () => {
      const user = userEvent.setup();
      render(<ActivitiesPanel isOpen={true} />);
      await screen.findByText("History");
      await user.click(screen.getByText("History"));
      expect(await screen.findByText("No activity yet")).toBeInTheDocument();
    });

    it("shows heartbeat ok log entry", async () => {
      const user = userEvent.setup();
      setupAPIs({
        logs: [
          {
            timestamp: "2025-01-01 12:00:00",
            type: "ok",
            message: "All clear \u2014 nothing urgent",
          },
        ],
      });
      render(<ActivitiesPanel isOpen={true} />);
      await screen.findByText("History");
      await user.click(screen.getByText("History"));
      await waitFor(() => {
        expect(screen.getByText("Heartbeat")).toBeInTheDocument();
        expect(screen.getByText("All clear \u2014 nothing urgent")).toBeInTheDocument();
      });
    });

    it("shows heartbeat urgent log entry with warning badge", async () => {
      const user = userEvent.setup();
      setupAPIs({
        logs: [
          {
            timestamp: "2025-01-01 12:00:00",
            type: "urgent",
            message: "Chat: Urgent message from manager",
          },
        ],
      });
      render(<ActivitiesPanel isOpen={true} />);
      await user.click(screen.getByText("History"));
      await waitFor(() => {
        expect(screen.getByText("Chat: Urgent message from manager")).toBeInTheDocument();
        const badge = screen.getByText(/urgent/);
        expect(badge.className).toContain("warning");
      });
    });

    it("shows heartbeat error log entry with danger badge", async () => {
      const user = userEvent.setup();
      setupAPIs({
        logs: [
          { timestamp: "2025-01-01 12:00:00", type: "error", message: "Heartbeat failed: timeout" },
        ],
      });
      render(<ActivitiesPanel isOpen={true} />);
      await user.click(screen.getByText("History"));
      await waitFor(() => {
        const badge = screen.getByText(/error/);
        expect(badge).toHaveAttribute("data-status", "danger");
      });
    });

    it("does not show start or skip log entries", async () => {
      const user = userEvent.setup();
      setupAPIs({
        logs: [
          {
            timestamp: "2025-01-01 12:00:00",
            type: "start",
            message: "Starting heartbeat check...",
          },
          {
            timestamp: "2025-01-01 11:00:00",
            type: "skip",
            message: "Skipping \u2014 outside work hours",
          },
        ],
      });
      render(<ActivitiesPanel isOpen={true} />);
      await user.click(screen.getByText("History"));
      expect(await screen.findByText("No activity yet")).toBeInTheDocument();
    });

    it("shows automation completed run with success badge", async () => {
      const user = userEvent.setup();
      setupAPIs({
        automations: [AUTOMATION],
        allAutomationRuns: [
          {
            id: "run-1",
            automationId: "wf-1",
            automationName: "Daily Report",
            startedAt: "2025-01-01T09:00:00Z",
            completedAt: "2025-01-01T09:05:00Z",
            status: "completed",
            stepResults: [],
            finalOutput: "Report generated successfully",
          },
        ],
      });
      render(<ActivitiesPanel isOpen={true} />);
      await user.click(screen.getByText("History"));
      await waitFor(() => {
        expect(screen.getByText("Daily Report")).toBeInTheDocument();
        const badge = screen.getByText(/completed/);
        expect(badge.className).toContain("success");
        expect(screen.getByText("Report generated successfully")).toBeInTheDocument();
      });
    });

    it("shows automation failed run with danger badge", async () => {
      const user = userEvent.setup();
      setupAPIs({
        allAutomationRuns: [
          {
            id: "run-2",
            automationId: "wf-1",
            automationName: "Daily Report",
            startedAt: "2025-01-02T09:00:00Z",
            status: "failed",
            stepResults: [],
          },
        ],
      });
      render(<ActivitiesPanel isOpen={true} />);
      await user.click(screen.getByText("History"));
      await waitFor(() => {
        const badge = screen.getByText(/failed/);
        expect(badge).toHaveAttribute("data-status", "danger");
      });
    });

    it("shows history for deleted automations using stored automationName", async () => {
      const user = userEvent.setup();
      // No automations in list (all deleted), but history still has runs with stored names
      setupAPIs({
        automations: [],
        allAutomationRuns: [
          {
            id: "run-3",
            automationId: "deleted-wf-id",
            automationName: "Old Automation",
            startedAt: "2025-01-03T09:00:00Z",
            status: "completed",
            stepResults: [],
          },
        ],
      });
      render(<ActivitiesPanel isOpen={true} />);
      await user.click(screen.getByText("History"));
      expect(await screen.findByText("Old Automation")).toBeInTheDocument();
    });

    it("sorts history entries newest first", async () => {
      const user = userEvent.setup();
      setupAPIs({
        logs: [
          { timestamp: "2025-01-01 10:00:00", type: "ok", message: "Earlier check" },
          { timestamp: "2025-01-01 12:00:00", type: "ok", message: "Later check" },
        ],
      });
      render(<ActivitiesPanel isOpen={true} />);
      await user.click(screen.getByText("History"));
      await waitFor(() => {
        const items = screen.getAllByText(/check/);
        expect(items[0].textContent).toBe("Later check");
        expect(items[1].textContent).toBe("Earlier check");
      });
    });

    it("fetches all activity data on open via activitiesAPI", async () => {
      setupAPIs({ automations: [AUTOMATION] });
      render(<ActivitiesPanel isOpen={true} />);
      await waitFor(() => {
        expect(window.activitiesAPI!.getAll).toHaveBeenCalled();
      });
    });

    it("navigates to session when clicking an automation run with a valid sessionId", async () => {
      const user = userEvent.setup();
      const onSessionSelect = vi.fn<(id: string) => void>();
      installMockAPIs({
        sessionsAPI: {
          get: vi.fn<SessionsAPI["get"]>().mockResolvedValue({
            success: true,
            session: {
              id: "sess-1",
              name: "Test",
              messages: [],
              createdAt: "",
              updatedAt: "",
              hasUnread: false,
              isActive: true,
            },
          }),
        },
        activitiesAPI: {
          getAll: vi.fn<ActivitiesAPI["getAll"]>().mockResolvedValue({
            success: true,
            heartbeatStatus: { enabled: false, lastRun: null, nextRun: null, running: false },
            heartbeatSettings: {
              enabled: false,
              intervalMinutes: 30,
              schedule: "work-hours",
              prompt: "",
            },
            heartbeatLogs: [],
            automations: [],
            allAutomationRuns: [
              {
                id: "run-1",
                automationId: "wf-1",
                automationName: "Daily Report",
                sessionId: "sess-1",
                startedAt: "2025-01-01T09:00:00Z",
                status: "completed",
                stepResults: [],
              },
            ],
            conditionStatuses: {},
          }),
        },
      });
      render(<ActivitiesPanel isOpen={true} onSessionSelect={onSessionSelect} />);
      await user.click(screen.getByText("History"));
      await screen.findByText("Daily Report");
      const item = getActivityItem("Daily Report");
      await user.click(item);
      await waitFor(() => {
        expect(onSessionSelect).toHaveBeenCalledWith("sess-1");
      });
    });

    it("does not navigate when session no longer exists", async () => {
      const user = userEvent.setup();
      const onSessionSelect = vi.fn<(id: string) => void>();
      installMockAPIs({
        sessionsAPI: {
          get: vi.fn<SessionsAPI["get"]>().mockResolvedValue({ success: true, session: undefined }),
        },
        activitiesAPI: {
          getAll: vi.fn<ActivitiesAPI["getAll"]>().mockResolvedValue({
            success: true,
            heartbeatStatus: { enabled: false, lastRun: null, nextRun: null, running: false },
            heartbeatSettings: {
              enabled: false,
              intervalMinutes: 30,
              schedule: "work-hours",
              prompt: "",
            },
            heartbeatLogs: [],
            automations: [],
            allAutomationRuns: [
              {
                id: "run-2",
                automationId: "wf-1",
                automationName: "Daily Report",
                sessionId: "deleted-sess",
                startedAt: "2025-01-01T09:00:00Z",
                status: "completed",
                stepResults: [],
              },
            ],
            conditionStatuses: {},
          }),
        },
      });
      render(<ActivitiesPanel isOpen={true} onSessionSelect={onSessionSelect} />);
      await user.click(screen.getByText("History"));
      await screen.findByText("Daily Report");
      const item = getActivityItem("Daily Report");
      await user.click(item);
      await waitFor(() => {
        expect(vi.mocked(window.sessionsAPI.get)).toHaveBeenCalledWith("deleted-sess", {
          messageLimit: 0,
        });
        expect(screen.getByText("Session no longer exists")).toBeInTheDocument();
      });
      expect(onSessionSelect).not.toHaveBeenCalled();
    });
  });

  describe("polling and timers", () => {
    it("auto-refreshes data every 30 seconds while the panel is open", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        setupAPIs();
        render(<ActivitiesPanel isOpen={true} />);

        // Flush initial async data load
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });

        const getAllMock = vi.mocked(window.activitiesAPI!.getAll);
        expect(getAllMock).toHaveBeenCalledTimes(1);

        // Trigger the 30s polling interval
        act(() => {
          vi.advanceTimersByTime(30_000);
        });

        // Flush the async data load triggered by the interval
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(getAllMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("auto-dismisses the session-not-found toast after 3 seconds", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const run: AutomationRunData = {
          id: "run-1",
          automationId: "wf-1",
          automationName: "Daily Report",
          sessionId: "gone",
          startedAt: "2025-01-01T09:00:00Z",
          status: "completed",
          stepResults: [],
        };
        installMockAPIs({
          sessionsAPI: {
            get: vi
              .fn<SessionsAPI["get"]>()
              .mockResolvedValue({ success: true, session: undefined }),
          },
          activitiesAPI: {
            getAll: vi.fn<ActivitiesAPI["getAll"]>().mockResolvedValue({
              success: true,
              heartbeatStatus: { enabled: false, lastRun: null, nextRun: null, running: false },
              heartbeatSettings: {
                enabled: false,
                intervalMinutes: 30,
                schedule: "work-hours",
                prompt: "",
              },
              heartbeatLogs: [],
              automations: [],
              allAutomationRuns: [run],
              conditionStatuses: {},
            }),
          },
        });

        render(<ActivitiesPanel isOpen={true} onSessionSelect={vi.fn<(id: string) => void>()} />);

        // Flush initial data load so history entries are in state
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });

        await user.click(screen.getByText("History"));

        await user.click(getActivityItem("Daily Report"));

        // Flush the sessionsAPI.get promise and resulting state update
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(screen.getByText("Session no longer exists")).toBeInTheDocument();

        // Advance past the 3s useTimeout to auto-dismiss the toast
        act(() => {
          vi.advanceTimersByTime(3000);
        });

        expect(screen.queryByText("Session no longer exists")).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("dismiss button", () => {
    it("renders Close button when onClose is provided", async () => {
      render(<ActivitiesPanel isOpen={true} onClose={vi.fn<() => void>()} />);
      expect(await screen.findByRole("button", { name: "Close" })).toBeInTheDocument();
    });

    it("calls onClose when Close button is clicked", async () => {
      const onClose = vi.fn<() => void>();
      const user = userEvent.setup();
      render(<ActivitiesPanel isOpen={true} onClose={onClose} />);
      await user.click(await screen.findByRole("button", { name: "Close" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
