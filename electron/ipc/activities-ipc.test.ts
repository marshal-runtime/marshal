import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ActivitiesAggregatedResult,
  HeartbeatSettingsEnvelope,
  HeartbeatStatusEnvelope,
} from "../../common/marshal-ipc-contract";
import { registerActivitiesHandlers } from "./activities-ipc";

// ---------------------------------------------------------------------------
// Mock factories — typed to match the backend.automation surface (Phase 3a-1
// rewire). Heartbeat status/settings now flow through `backend.automation`
// (envelope shapes); only `getLogs` still hits the local HeartbeatManager.
// ---------------------------------------------------------------------------

function createMockHeartbeatLogProvider() {
  return {
    getLogs: vi.fn<(lines: number) => unknown[]>().mockReturnValue([]),
  };
}

function createMockBackendAutomation() {
  const supportedStatus: HeartbeatStatusEnvelope = {
    supported: true,
    enabled: true,
    lastRun: null,
    nextRun: null,
    running: false,
  };
  const supportedSettings: HeartbeatSettingsEnvelope = {
    supported: true,
    intervalMinutes: 30,
    schedule: "work-hours",
    prompt: "",
    controllable: {
      enabled: true,
      intervalMinutes: true,
      schedule: true,
      prompt: true,
      permissions: true,
      workDays: true,
      workStartHour: true,
      workEndHour: true,
    },
  };
  return {
    getHeartbeatStatus: vi
      .fn<() => Promise<HeartbeatStatusEnvelope>>()
      .mockResolvedValue(supportedStatus),
    getHeartbeatConfig: vi
      .fn<() => Promise<HeartbeatSettingsEnvelope>>()
      .mockResolvedValue(supportedSettings),
  };
}

function createMockAutomationManager() {
  return {
    list: vi
      .fn<() => Array<{ id: string; triggerType: string; enabled: boolean }>>()
      .mockReturnValue([]),
    getAllHistory: vi.fn<() => unknown[]>().mockReturnValue([]),
    getConditionStatus: vi
      .fn<
        (id: string) => {
          lastCheck: string | null;
          nextCheck: string | null;
          lastError: string | null;
        }
      >()
      .mockReturnValue({ lastCheck: null, nextCheck: null, lastError: null }),
  };
}

// ---------------------------------------------------------------------------
// Setup helper — captures the registered handler via a mock ipcHandle
// ---------------------------------------------------------------------------

function setup() {
  type HandlerFn = (event: unknown, logLines?: number) => Promise<ActivitiesAggregatedResult>;
  let handler: HandlerFn | undefined;

  const ipcHandle = vi.fn<(channel: string, fn: HandlerFn) => void>((channel, fn) => {
    if (channel === "activities:getAll") handler = fn;
  });

  const heartbeatManager = createMockHeartbeatLogProvider();
  const automation = createMockBackendAutomation();
  const automationManager = createMockAutomationManager();
  const sessionManager = {
    getBackendProvider: vi.fn<() => { automation: typeof automation }>(() => ({ automation })),
  };

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: partial mocks for handler registration
  registerActivitiesHandlers({
    heartbeatManager,
    sessionManager,
    automationManager,
    ipcHandle,
  } as unknown as Parameters<typeof registerActivitiesHandlers>[0]);

  const call = (logLines?: number) => handler!({}, logLines);

  return { call, heartbeatManager, automation, automationManager };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("activities:getAll", () => {
  it("returns aggregated data via backend.automation (and getLogs from the local manager)", async () => {
    const { call, heartbeatManager, automation, automationManager } = setup();

    const result = await call();

    // Phase 3a-1: status/settings come from the backend, NOT from
    // heartbeatManager directly — gateway mode would otherwise see stale
    // copilot-shaped data.
    expect(automation.getHeartbeatStatus).toHaveBeenCalled();
    expect(automation.getHeartbeatConfig).toHaveBeenCalled();
    // Logs still hit the local manager (marshal exposes no log RPC).
    expect(heartbeatManager.getLogs).toHaveBeenCalled();
    expect(automationManager.list).toHaveBeenCalled();
    expect(automationManager.getAllHistory).toHaveBeenCalled();

    expect(result).toMatchObject({
      success: true,
      heartbeatStatus: { enabled: true, lastRun: null, nextRun: null, running: false },
      heartbeatSettings: {
        // `enabled` is mirrored from status (envelope no longer carries it).
        enabled: true,
        intervalMinutes: 30,
        schedule: "work-hours",
        prompt: "",
      },
      heartbeatLogs: [],
      automations: [],
      allAutomationRuns: [],
      conditionStatuses: {},
    });
  });

  it("returns undefined heartbeat fields when the backend reports { supported: false }", async () => {
    // Gateway-mode disconnected scenario: envelopes are { supported: false },
    // and the activities response should surface that as missing heartbeat
    // data rather than crashing or fabricating defaults.
    const { call, automation } = setup();
    automation.getHeartbeatStatus.mockResolvedValueOnce({ supported: false });
    automation.getHeartbeatConfig.mockResolvedValueOnce({ supported: false });

    const result = await call();

    expect(result.success).toBe(true);
    expect(result.heartbeatStatus).toBeUndefined();
    expect(result.heartbeatSettings).toBeUndefined();
  });

  it("passes logLines parameter to getLogs()", async () => {
    const { call, heartbeatManager } = setup();

    await call(50);

    expect(heartbeatManager.getLogs).toHaveBeenCalledWith(50);
  });

  it("defaults logLines to 100 when not provided", async () => {
    const { call, heartbeatManager } = setup();

    await call();

    expect(heartbeatManager.getLogs).toHaveBeenCalledWith(100);
  });

  it("includes condition statuses only for enabled condition automations", async () => {
    const { call, automationManager } = setup();

    automationManager.list.mockReturnValue([
      { id: "sched-1", triggerType: "schedule", enabled: true },
      { id: "cond-enabled", triggerType: "condition", enabled: true },
      { id: "cond-disabled", triggerType: "condition", enabled: false },
    ]);

    automationManager.getConditionStatus.mockReturnValue({
      lastCheck: "2026-01-01T00:00:00Z",
      nextCheck: null,
      lastError: null,
    });

    const result = await call();

    expect(automationManager.getConditionStatus).toHaveBeenCalledTimes(1);
    expect(automationManager.getConditionStatus).toHaveBeenCalledWith("cond-enabled");
    expect(result.conditionStatuses).toEqual({
      "cond-enabled": { lastCheck: "2026-01-01T00:00:00Z", nextCheck: null, lastError: null },
    });
  });

  it("returns empty conditionStatuses when no condition automations exist", async () => {
    const { call, automationManager } = setup();

    automationManager.list.mockReturnValue([
      { id: "sched-1", triggerType: "schedule", enabled: true },
      { id: "sched-2", triggerType: "schedule", enabled: false },
    ]);

    const result = await call();

    expect(automationManager.getConditionStatus).not.toHaveBeenCalled();
    expect(result.conditionStatuses).toEqual({});
  });

  it("returns { success: false, error } when a manager throws", async () => {
    const { call, automation } = setup();

    automation.getHeartbeatStatus.mockRejectedValueOnce(new Error("heartbeat exploded"));

    const result = await call();

    expect(result).toMatchObject({
      success: false,
      error: "Error: heartbeat exploded",
    });
  });

  it("conditionStatuses is a plain Record, not a Map", async () => {
    const { call, automationManager } = setup();

    automationManager.list.mockReturnValue([
      { id: "cond-1", triggerType: "condition", enabled: true },
    ]);

    const result = await call();

    expect(result.conditionStatuses).toBeInstanceOf(Object);
    expect(result.conditionStatuses).not.toBeInstanceOf(Map);
    expect(Object.keys(result.conditionStatuses ?? {})).toEqual(["cond-1"]);
  });
});
