import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs, render, screen, waitFor } from "@/test-utils";
import type { AutomationData, AutomationsAPI } from "@/types/electron";

import { AutomationsPanel } from "./AutomationsPanel";

// Spy on sonner.toast.error so the error-path test can
// assert the IPC `result.error` actually reaches the user. Pre-refactor,
// `delete` / `toggle` / `runNow` were silent on `success: false` — this
// test would have caught that regression.
const toastErrorSpy = vi.fn<(message: string) => void>();
vi.mock("sonner", () => ({
  toast: {
    error: (message: string) => toastErrorSpy(message),
  },
}));

const CONDITION_AUTOMATION: AutomationData = {
  id: "wf-cond",
  name: "PR Watcher",
  description: "Watch for PR approval",
  steps: [{ id: "1", label: "Notify", prompt: "Send chat message" }],
  schedule: { naturalLanguage: "", days: [], hour: 0, minute: 0 },
  enabled: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  triggerType: "condition",
  condition: "PR #123 is approved",
};

const SCHEDULE_AUTOMATION: AutomationData = {
  id: "wf-sched",
  name: "Morning Briefing",
  description: "",
  steps: [{ id: "1", label: "Main", prompt: "Summarize calendar" }],
  schedule: { naturalLanguage: "every weekday at 9am", days: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
  enabled: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  triggerType: "schedule",
};

function setupAPIs(automations: AutomationData[] = []) {
  installMockAPIs({
    automationsAPI: {
      list: vi.fn<AutomationsAPI["list"]>().mockResolvedValue({ success: true, automations }),
      create: vi
        .fn<AutomationsAPI["create"]>()
        .mockResolvedValue({ success: true, automation: automations[0] }),
      update: vi
        .fn<AutomationsAPI["update"]>()
        .mockResolvedValue({ success: true, automation: automations[0] }),
      delete: vi.fn<AutomationsAPI["delete"]>().mockResolvedValue({ success: true }),
      toggle: vi.fn<AutomationsAPI["toggle"]>().mockResolvedValue({ success: true }),
    },
  });
}

describe("AutomationsPanel", () => {
  beforeEach(() => {
    // `vi.clearAllMocks()` already clears `toastErrorSpy` (it's a `vi.fn`).
    vi.clearAllMocks();
  });

  describe("trigger type toggle", () => {
    it("shows trigger type toggle in create form", async () => {
      const user = userEvent.setup();
      setupAPIs();
      render(<AutomationsPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /new automation/i })).toBeDefined();
      });
      await user.click(screen.getByRole("button", { name: /new automation/i }));
      expect(screen.getAllByText("Schedule").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("Condition")).toBeDefined();
    });

    it("defaults to Schedule trigger type", async () => {
      const user = userEvent.setup();
      setupAPIs();
      render(<AutomationsPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /new automation/i })).toBeDefined();
      });
      await user.click(screen.getByRole("button", { name: /new automation/i }));
      // Schedule input should be visible
      expect(screen.getByPlaceholderText("e.g. every weekday at 9am")).toBeDefined();
    });

    it("switching to Condition hides schedule and shows condition input", async () => {
      const user = userEvent.setup();
      setupAPIs();
      render(<AutomationsPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /new automation/i })).toBeDefined();
      });
      await user.click(screen.getByRole("button", { name: /new automation/i }));
      await user.click(screen.getByText("Condition"));
      // Schedule input gone, condition input visible
      expect(screen.queryByPlaceholderText("e.g. every weekday at 9am")).toBeNull();
      expect(screen.getByPlaceholderText(/PR #123/)).toBeDefined();
    });

    it("switching back to Schedule restores schedule input", async () => {
      const user = userEvent.setup();
      setupAPIs();
      render(<AutomationsPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /new automation/i })).toBeDefined();
      });
      await user.click(screen.getByRole("button", { name: /new automation/i }));
      await user.click(screen.getByText("Condition"));
      await user.click(screen.getByText("Schedule"));
      expect(screen.getByPlaceholderText("e.g. every weekday at 9am")).toBeDefined();
      expect(screen.queryByPlaceholderText(/PR #123/)).toBeNull();
    });
  });

  describe("condition automation creation", () => {
    it("creates condition automation with correct payload", async () => {
      const user = userEvent.setup();
      setupAPIs();
      render(<AutomationsPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /new automation/i })).toBeDefined();
      });
      await user.click(screen.getByRole("button", { name: /new automation/i }));

      // Fill name
      await user.clear(screen.getByPlaceholderText("e.g. Morning Briefing"));
      await user.type(screen.getByPlaceholderText("e.g. Morning Briefing"), "PR Watcher");

      // Switch to condition
      await user.click(screen.getByText("Condition"));

      // Fill condition
      await user.clear(screen.getByPlaceholderText(/PR #123/));
      await user.type(screen.getByPlaceholderText(/PR #123/), "PR #456 is approved");

      // Fill step prompt
      const promptTextarea = screen.getByPlaceholderText(/What should/);
      await user.clear(promptTextarea);
      await user.type(promptTextarea, "Send notification");

      // Save
      await user.click(screen.getByRole("button", { name: "Create Automation" }));

      await waitFor(() => {
        expect(window.automationsAPI.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "PR Watcher",
            triggerType: "condition",
            condition: "PR #456 is approved",
          }),
        );
      });
    });

    it("validates condition text is required", async () => {
      const user = userEvent.setup();
      setupAPIs();
      render(<AutomationsPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /new automation/i })).toBeDefined();
      });
      await user.click(screen.getByRole("button", { name: /new automation/i }));

      // Fill name
      await user.clear(screen.getByPlaceholderText("e.g. Morning Briefing"));
      await user.type(screen.getByPlaceholderText("e.g. Morning Briefing"), "Test");

      // Switch to condition but don't fill it
      await user.click(screen.getByText("Condition"));

      // Fill step
      await user.clear(screen.getByPlaceholderText(/What should/));
      await user.type(screen.getByPlaceholderText(/What should/), "Do something");

      // Save
      await user.click(screen.getByRole("button", { name: "Create Automation" }));

      expect(screen.getByText("Condition is required")).toBeDefined();
    });

    it("does not require schedule when trigger is Condition", async () => {
      const user = userEvent.setup();
      setupAPIs();
      render(<AutomationsPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /new automation/i })).toBeDefined();
      });
      await user.click(screen.getByRole("button", { name: /new automation/i }));

      await user.clear(screen.getByPlaceholderText("e.g. Morning Briefing"));
      await user.type(screen.getByPlaceholderText("e.g. Morning Briefing"), "Test");
      await user.click(screen.getByText("Condition"));
      await user.clear(screen.getByPlaceholderText(/PR #123/));
      await user.type(screen.getByPlaceholderText(/PR #123/), "Something happens");
      await user.clear(screen.getByPlaceholderText(/What should/));
      await user.type(screen.getByPlaceholderText(/What should/), "Do it");

      await user.click(screen.getByRole("button", { name: "Create Automation" }));

      await waitFor(() => {
        expect(window.automationsAPI.create).toHaveBeenCalled();
      });
      // No error shown
      expect(screen.queryByText("Schedule is required")).toBeNull();
    });
  });

  describe("condition automation editing", () => {
    it("populates trigger type and condition when editing", async () => {
      setupAPIs([CONDITION_AUTOMATION, SCHEDULE_AUTOMATION]);
      render(<AutomationsPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByText("PR Watcher")).toBeDefined();
      });

      // Click edit on condition automation
      const user = userEvent.setup();
      const editButtons = screen.getAllByRole("button", { name: "Edit" });
      await user.click(editButtons[0]);

      // Condition input should be visible with the condition text
      await waitFor(() => {
        const conditionInput = screen.getByPlaceholderText<HTMLTextAreaElement>(/PR #123/);
        expect(conditionInput.value).toBe("PR #123 is approved");
      });
      // Schedule input should NOT be visible
      expect(screen.queryByPlaceholderText("e.g. every weekday at 9am")).toBeNull();
    });
  });

  describe("automation card display", () => {
    it("shows condition text for condition automations", async () => {
      setupAPIs([CONDITION_AUTOMATION, SCHEDULE_AUTOMATION]);
      render(<AutomationsPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByText(/PR #123 is approved/)).toBeDefined();
      });
    });

    it("renders workflows beneath automations with workspace discovery guidance", async () => {
      setupAPIs([SCHEDULE_AUTOMATION]);
      render(<AutomationsPanel isOpen={true} />);

      expect(await screen.findByText("Morning Briefing")).toBeDefined();
      expect(screen.getByRole("heading", { name: "Workflows" })).toBeDefined();
      expect(screen.getByText(/automatically collected from workspaces inside/i)).toBeDefined();
      expect(screen.getByText(".marshal/marshal-worktrees")).toBeDefined();
    });

    it("shows schedule for schedule automations", async () => {
      setupAPIs([SCHEDULE_AUTOMATION]);
      render(<AutomationsPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByText(/every weekday at 9am/)).toBeDefined();
      });
    });
  });

  describe("mutation-refetch cycle", () => {
    it("refreshes automation list after deleting an automation", async () => {
      setupAPIs([SCHEDULE_AUTOMATION]);
      render(<AutomationsPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByText("Morning Briefing")).toBeDefined();
      });

      const listMock = vi.mocked(window.automationsAPI.list);
      const callCountBefore = listMock.mock.calls.length;

      const user = userEvent.setup();
      const moreBtn = screen.getByRole("button", { name: "More actions" });
      await user.click(moreBtn);
      const deleteBtn = await screen.findByRole("menuitem", { name: /Delete/ });
      await user.click(deleteBtn);

      await waitFor(() => {
        expect(window.automationsAPI.delete).toHaveBeenCalledWith("wf-sched", undefined);
      });
      await waitFor(() => {
        expect(listMock.mock.calls.length).toBeGreaterThan(callCountBefore);
      });
    });

    it("refreshes automation list after toggling enabled", async () => {
      setupAPIs([SCHEDULE_AUTOMATION]);
      render(<AutomationsPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByText("Morning Briefing")).toBeDefined();
      });

      const listMock = vi.mocked(window.automationsAPI.list);
      const callCountBefore = listMock.mock.calls.length;

      const user = userEvent.setup();
      const toggleBtn = screen.getByRole("button", { name: "Disable" });
      await user.click(toggleBtn);

      await waitFor(() => {
        expect(window.automationsAPI.toggle).toHaveBeenCalledWith("wf-sched", false);
      });
      await waitFor(() => {
        expect(listMock.mock.calls.length).toBeGreaterThan(callCountBefore);
      });
    });
  });

  describe("save handler error path", () => {
    it("toggle: surfaces result.error as a toast when backend returns success: false", async () => {
      // Pre-refactor: handleToggle was `await api.toggle(...)`
      // followed by `await invalidateQueries(...)` — it dropped the IPC
      // envelope entirely. A backend-reported failure (e.g. tenant policy
      // change, race) would silently snap the toggle back with no
      // explanation. The useIpcMutation refactor routes the
      // failure through the helper's default toast.
      setupAPIs([SCHEDULE_AUTOMATION]);
      vi.mocked(window.automationsAPI.toggle).mockResolvedValue({
        success: false,
        error: "Heartbeat is disabled by your organization's policy",
      });

      render(<AutomationsPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByText("Morning Briefing")).toBeDefined();
      });

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Disable" }));

      await waitFor(() => {
        expect(toastErrorSpy).toHaveBeenCalledWith(
          "Heartbeat is disabled by your organization's policy",
        );
      });
    });

    it("toggle: falls back to a generic toast message when result.error is missing", async () => {
      // Defensive case: a future IPC handler bug (or stub mismatch) could
      // return `success: false` without an `error` field. The fallback
      // string lives in the panel's useIpcMutation config.
      setupAPIs([SCHEDULE_AUTOMATION]);
      vi.mocked(window.automationsAPI.toggle).mockResolvedValue({ success: false });

      render(<AutomationsPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByText("Morning Briefing")).toBeDefined();
      });

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Disable" }));

      await waitFor(() => {
        expect(toastErrorSpy).toHaveBeenCalledWith("Failed to toggle automation");
      });
    });

    it("delete: surfaces result.error as a toast and keeps the confirm dialog closed when no skills involved", async () => {
      // Pre-refactor parallel of the toggle case — delete was equally silent
      // on `success: false`. SCHEDULE_AUTOMATION has no skillNames so the
      // confirmation dialog is bypassed and handleDelete fires directly
      // from the overflow menu.
      setupAPIs([SCHEDULE_AUTOMATION]);
      vi.mocked(window.automationsAPI.delete).mockResolvedValue({
        success: false,
        error: "Automation is locked by another writer",
      });

      render(<AutomationsPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByText("Morning Briefing")).toBeDefined();
      });

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "More actions" }));
      const deleteItem = await screen.findByRole("menuitem", { name: /Delete/ });
      await user.click(deleteItem);

      await waitFor(() => {
        expect(window.automationsAPI.delete).toHaveBeenCalledWith("wf-sched", undefined);
        expect(toastErrorSpy).toHaveBeenCalledWith("Automation is locked by another writer");
      });
    });

    it("runNow: surfaces result.error as a toast when backend returns success: false", async () => {
      setupAPIs([SCHEDULE_AUTOMATION]);
      vi.mocked(window.automationsAPI.runNow).mockResolvedValue({
        success: false,
        error: "Run-now isn't exposed by marshal yet",
      });

      render(<AutomationsPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByText("Morning Briefing")).toBeDefined();
      });

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "More actions" }));
      const runNowItem = await screen.findByRole("menuitem", { name: /Run now/ });
      await user.click(runNowItem);

      await waitFor(() => {
        expect(toastErrorSpy).toHaveBeenCalledWith("Run-now isn't exposed by marshal yet");
      });
    });
  });

  describe("export", () => {
    it("calls fileExportAPI.saveJson with automation JSON when Export is clicked", async () => {
      setupAPIs([SCHEDULE_AUTOMATION]);
      vi.mocked(window.automationsAPI.exportAutomation).mockResolvedValue({
        success: true,
        json: '{"id":"wf-sched","name":"Morning Briefing"}',
      });
      render(<AutomationsPanel isOpen={true} />);
      await waitFor(() => {
        expect(screen.getByText("Morning Briefing")).toBeDefined();
      });

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "More actions" }));
      const exportBtn = await screen.findByRole("menuitem", { name: /Export/ });
      await user.click(exportBtn);

      await waitFor(() => {
        expect(window.automationsAPI.exportAutomation).toHaveBeenCalledWith("wf-sched");
        expect(window.fileExportAPI?.saveJson).toHaveBeenCalledWith(
          '{"id":"wf-sched","name":"Morning Briefing"}',
          expect.stringMatching(/^Morning-Briefing\.json$/),
        );
      });
    });
  });

  describe("initialEditAutomationName auto-open", () => {
    it("auto-opens the edit form for the matching automation", async () => {
      setupAPIs([CONDITION_AUTOMATION, SCHEDULE_AUTOMATION]);
      render(<AutomationsPanel isOpen={true} initialEditAutomationName="PR Watcher" />);

      // "Edit Automation" header + pre-filled name input confirm the auto-open.
      await waitFor(() => {
        expect(screen.getByText("Edit Automation")).toBeDefined();
      });
      const nameInput = screen.getByPlaceholderText<HTMLInputElement>("e.g. Morning Briefing");
      expect(nameInput.value).toBe("PR Watcher");
    });

    it("consumes each name only once — navigating back and re-rendering with the same prop does not re-open", async () => {
      setupAPIs([CONDITION_AUTOMATION]);
      const { rerender } = render(
        <AutomationsPanel isOpen={true} initialEditAutomationName="PR Watcher" />,
      );

      await waitFor(() => {
        expect(screen.getByText("Edit Automation")).toBeDefined();
      });

      // Cancel back to list view
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /cancel/i }));
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /new automation/i })).toBeDefined();
      });

      // Re-render with the same prop value — must NOT re-open edit
      rerender(<AutomationsPanel isOpen={true} initialEditAutomationName="PR Watcher" />);
      expect(screen.queryByText("Edit Automation")).toBeNull();
    });

    it("ignores a non-matching initialEditAutomationName and stays on list view", async () => {
      setupAPIs([CONDITION_AUTOMATION]);
      render(<AutomationsPanel isOpen={true} initialEditAutomationName="Does Not Exist" />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /new automation/i })).toBeDefined();
      });
      expect(screen.queryByText("Edit Automation")).toBeNull();
    });
  });
});
