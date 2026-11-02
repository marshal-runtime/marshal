import { act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { installMockAPIs, renderHook } from "@/test-utils";
import type {
  ActivitiesAPI,
  HeartbeatLogEntry,
  HeartbeatSettings,
  HeartbeatStatus,
  AutomationData,
  AutomationRunData,
} from "@/types/electron";

import { useActivitiesPanelData } from "./useActivitiesPanelData";

// --- Test data ---

const mockHeartbeatStatus: HeartbeatStatus = {
  enabled: true,
  lastRun: "2026-03-06T10:00:00Z",
  nextRun: null,
  running: false,
};
const mockHeartbeatSettings: HeartbeatSettings = {
  enabled: true,
  intervalMinutes: 30,
  schedule: "work-hours",
  prompt: "check things",
};
const mockHeartbeatLogs: HeartbeatLogEntry[] = [
  { timestamp: "2026-03-06T10:00:00Z", message: "Heartbeat ran", type: "start" },
];

const mockAutomations: AutomationData[] = [
  {
    id: "wf-1",
    name: "Daily standup",
    steps: [],
    schedule: { naturalLanguage: "every day", days: [], hour: 9, minute: 0 },
    triggerType: "schedule",
    enabled: true,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
  },
  {
    id: "wf-2",
    name: "Condition automation",
    steps: [],
    schedule: { naturalLanguage: "", days: [], hour: 0, minute: 0 },
    triggerType: "condition",
    enabled: true,
    createdAt: "2026-03-02T00:00:00Z",
    updatedAt: "2026-03-02T00:00:00Z",
  },
];

const mockAutomationRuns: AutomationRunData[] = [
  {
    id: "run-1",
    automationId: "wf-1",
    startedAt: "2026-03-06T09:00:00Z",
    status: "completed",
    stepResults: [],
  },
];

function setupMocks() {
  installMockAPIs({
    activitiesAPI: {
      getAll: vi.fn<ActivitiesAPI["getAll"]>().mockResolvedValue({
        success: true,
        heartbeatStatus: mockHeartbeatStatus,
        heartbeatSettings: mockHeartbeatSettings,
        heartbeatLogs: mockHeartbeatLogs,
        automations: mockAutomations,
        allAutomationRuns: mockAutomationRuns,
        conditionStatuses: {
          "wf-2": {
            lastCheck: "2026-03-06T09:55:00Z",
            nextCheck: "2026-03-06T10:00:00Z",
            lastError: null,
          },
        },
      }),
    },
  });
}

/** Flush all pending microtasks/promises and advance fake timers for TanStack Query scheduling. */
async function flushPromises() {
  for (let i = 0; i < 10; i++) {
    // eslint-disable-next-line no-await-in-loop -- sequential test steps
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });
  }
}

describe("useActivitiesPanelData", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setupMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not fetch when isOpen is false", async () => {
    renderHook(() => useActivitiesPanelData(false));

    await flushPromises();

    expect(window.activitiesAPI!.getAll).not.toHaveBeenCalled();
  });

  it("fetches all activities data when isOpen is true", async () => {
    const { result } = renderHook(() => useActivitiesPanelData(true));

    await flushPromises();

    expect(window.activitiesAPI!.getAll).toHaveBeenCalledTimes(1);
    expect(window.activitiesAPI!.getAll).toHaveBeenCalledWith(100);
    expect(result.current.heartbeatStatus).toEqual(mockHeartbeatStatus);
    expect(result.current.heartbeatSettings).toEqual(mockHeartbeatSettings);
    expect(result.current.heartbeatLogs).toEqual(mockHeartbeatLogs);
  });

  it("fetches automation list and history when isOpen is true", async () => {
    const { result } = renderHook(() => useActivitiesPanelData(true));

    await flushPromises();

    expect(result.current.automations).toEqual(mockAutomations);
    expect(result.current.allAutomationRuns).toEqual(mockAutomationRuns);
  });

  it("converts condition statuses Record to Map", async () => {
    const { result } = renderHook(() => useActivitiesPanelData(true));

    await flushPromises();

    expect(result.current.conditionStatuses.size).toBe(1);

    const status = result.current.conditionStatuses.get("wf-2");
    expect(status).toEqual({
      lastCheck: "2026-03-06T09:55:00Z",
      nextCheck: "2026-03-06T10:00:00Z",
      lastError: null,
    });
  });

  it("polls every 30s while isOpen is true", async () => {
    renderHook(() => useActivitiesPanelData(true));

    // Wait for initial fetch
    await flushPromises();
    expect(window.activitiesAPI!.getAll).toHaveBeenCalledTimes(1);

    // Advance by 30s for first poll tick
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flushPromises();
    expect(window.activitiesAPI!.getAll).toHaveBeenCalledTimes(2);

    // Advance by another 30s for second poll tick
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flushPromises();
    expect(window.activitiesAPI!.getAll).toHaveBeenCalledTimes(3);
  });

  it("stops polling when isOpen becomes false", async () => {
    const { rerender } = renderHook(({ isOpen }) => useActivitiesPanelData(isOpen), {
      initialProps: { isOpen: true },
    });

    // Wait for initial fetch
    await flushPromises();
    expect(window.activitiesAPI!.getAll).toHaveBeenCalledTimes(1);

    // First poll
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await flushPromises();
    expect(window.activitiesAPI!.getAll).toHaveBeenCalledTimes(2);

    // Close the panel
    rerender({ isOpen: false });

    // Advance well past the poll interval — should not fire again
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await flushPromises();
    expect(window.activitiesAPI!.getAll).toHaveBeenCalledTimes(2);
  });
});
