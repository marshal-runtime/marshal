// Marshal-owned test
import { describe, it, expect, vi } from "vitest";

import type { AutomationData, AutomationRunData } from "../../../common/marshal-ipc-contract";
import type { IHeartbeatManager } from "../types";
import { CopilotAutomationBackend, type IAutomationManagerForBackend } from "./automation";

const AUTO: AutomationData = {
  id: "auto-1",
  name: "Test",
  steps: [{ id: "s1", label: "t", prompt: "hi" }],
  schedule: { naturalLanguage: "weekdays 9am", days: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
  enabled: true,
  createdAt: "2026-04-22T10:00:00Z",
  updatedAt: "2026-04-22T10:00:00Z",
  triggerType: "schedule",
};

type FakeAutomationManager = {
  [K in keyof IAutomationManagerForBackend]: ReturnType<
    typeof vi.fn<IAutomationManagerForBackend[K]>
  >;
};

type FakeHeartbeatManager = {
  [K in keyof IHeartbeatManager]: ReturnType<typeof vi.fn<IHeartbeatManager[K]>>;
};

function makeFakeManager(): FakeAutomationManager {
  return {
    list: vi.fn<IAutomationManagerForBackend["list"]>().mockReturnValue([AUTO]),
    create: vi
      .fn<IAutomationManagerForBackend["create"]>()
      .mockReturnValue({ ...AUTO, id: "created-id" }),
    update: vi.fn<IAutomationManagerForBackend["update"]>().mockReturnValue(AUTO),
    toggle: vi.fn<IAutomationManagerForBackend["toggle"]>().mockReturnValue(true),
    delete: vi.fn<IAutomationManagerForBackend["delete"]>().mockReturnValue(true),
    getHistory: vi.fn<IAutomationManagerForBackend["getHistory"]>().mockReturnValue([]),
    getAllHistory: vi.fn<IAutomationManagerForBackend["getAllHistory"]>().mockReturnValue([]),
    getCurrentRun: vi.fn<IAutomationManagerForBackend["getCurrentRun"]>().mockReturnValue(null),
    runNow: vi.fn<IAutomationManagerForBackend["runNow"]>().mockResolvedValue({
      id: "run-1",
      automationId: "auto-1",
      startedAt: new Date().toISOString(),
      status: "completed",
      stepResults: [],
    }),
    exportAutomation: vi
      .fn<IAutomationManagerForBackend["exportAutomation"]>()
      .mockReturnValue(null),
    importAutomations: vi
      .fn<IAutomationManagerForBackend["importAutomations"]>()
      .mockReturnValue([]),
    getConditionStatus: vi
      .fn<IAutomationManagerForBackend["getConditionStatus"]>()
      .mockReturnValue({ lastCheck: null, nextCheck: null, lastError: null }),
  };
}

function makeFakeHeartbeat(): FakeHeartbeatManager {
  return {
    getSettings: vi
      .fn<IHeartbeatManager["getSettings"]>()
      // Partial — the envelope merges settings + { supported: true }.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Test fake; fields not exercised in assertions.
      .mockReturnValue({} as ReturnType<IHeartbeatManager["getSettings"]>),
    saveSettings: vi.fn<IHeartbeatManager["saveSettings"]>(),
    getStatus: vi
      .fn<IHeartbeatManager["getStatus"]>()
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Test fake; fields not exercised in assertions.
      .mockReturnValue({} as ReturnType<IHeartbeatManager["getStatus"]>),
    runNow: vi.fn<IHeartbeatManager["runNow"]>().mockResolvedValue(undefined),
    start: vi.fn<IHeartbeatManager["start"]>(),
    stop: vi.fn<IHeartbeatManager["stop"]>(),
  };
}

describe("CopilotAutomationBackend", () => {
  it("toggleAutomation delegates to AutomationManager.toggle", async () => {
    const am = makeFakeManager();
    const be = new CopilotAutomationBackend();
    be.setAutomationManager(am);
    await be.toggleAutomation("auto-1", false);
    expect(am.toggle).toHaveBeenCalledWith("auto-1", false);
  });

  it("triggerAutomationNow delegates to AutomationManager.runNow and returns the AutomationRunData", async () => {
    const am = makeFakeManager();
    const be = new CopilotAutomationBackend();
    be.setAutomationManager(am);
    const result = await be.triggerAutomationNow("auto-1");
    expect(am.runNow).toHaveBeenCalledWith("auto-1");
    expect(result?.id).toBe("run-1");
    expect(result?.automationId).toBe("auto-1");
  });

  it("triggerAutomationNow subscribes to run-activity ticks while a run is in flight and unsubscribes on settle", async () => {
    const am = makeFakeManager();
    let resolveRun!: (value: AutomationRunData | null) => void;
    const runPromise = new Promise<AutomationRunData | null>((res) => {
      resolveRun = res;
    });
    am.runNow.mockReturnValueOnce(runPromise);
    const unsubscribe = vi.fn<() => void>();
    const subscribe = vi.fn<(listener: () => void) => () => void>(() => unsubscribe);
    const be = new CopilotAutomationBackend();
    be.setAutomationManager(am);
    be.setRunActivitySubscriber(subscribe);

    const inFlight = be.triggerAutomationNow("auto-1");
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

    resolveRun({
      id: "run-2",
      automationId: "auto-1",
      automationName: "auto-1",
      startedAt: "2026-01-01T00:00:00Z",
      status: "completed",
      stepResults: [],
    });
    await inFlight;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("createAutomation returns the canonical AutomationData from the manager", async () => {
    const am = makeFakeManager();
    const be = new CopilotAutomationBackend();
    be.setAutomationManager(am);
    const result = await be.createAutomation(AUTO);
    expect(result.id).toBe("created-id");
    expect(result.name).toBe(AUTO.name);
  });

  it("deleteAutomation is idempotent (returns void when manager returns false)", async () => {
    const am = makeFakeManager();
    am.delete.mockReturnValue(false);
    const be = new CopilotAutomationBackend();
    be.setAutomationManager(am);
    await expect(be.deleteAutomation("missing")).resolves.toBeUndefined();
  });

  it("wraps heartbeat settings with supported: true envelope", async () => {
    const am = makeFakeManager();
    const hb = makeFakeHeartbeat();
    const be = new CopilotAutomationBackend();
    be.setAutomationManager(am);
    be.setHeartbeatManager(hb);
    const cfg = await be.getHeartbeatConfig();
    expect(cfg.supported).toBe(true);
  });

  it("wraps heartbeat status with supported: true envelope", async () => {
    const am = makeFakeManager();
    const hb = makeFakeHeartbeat();
    const be = new CopilotAutomationBackend();
    be.setAutomationManager(am);
    be.setHeartbeatManager(hb);
    const status = await be.getHeartbeatStatus();
    expect(status.supported).toBe(true);
  });

  it("updateHeartbeatConfig routes non-enabled fields through saveSettings", async () => {
    const hb = makeFakeHeartbeat();
    const be = new CopilotAutomationBackend();
    be.setAutomationManager(makeFakeManager());
    be.setHeartbeatManager(hb);
    const r = await be.updateHeartbeatConfig({ prompt: "hello", intervalMinutes: 30 });
    expect(r.ok).toBe(true);
    expect(hb.saveSettings).toHaveBeenCalledWith({ prompt: "hello", intervalMinutes: 30 });
    expect(hb.start).not.toHaveBeenCalled();
    expect(hb.stop).not.toHaveBeenCalled();
  });

  it("updateHeartbeatConfig({ enabled: true }) calls start() (NOT saveSettings) — off→on lifecycle", async () => {
    const hb = makeFakeHeartbeat();
    const be = new CopilotAutomationBackend();
    be.setAutomationManager(makeFakeManager());
    be.setHeartbeatManager(hb);
    const r = await be.updateHeartbeatConfig({ enabled: true });
    expect(r.ok).toBe(true);
    // saveSettings doesn't start a stopped timer (its `if (this.timer)` guard
    // skips the off→on case). start() is the proper lifecycle entry point.
    expect(hb.saveSettings).not.toHaveBeenCalled();
    expect(hb.start).toHaveBeenCalled();
    expect(hb.stop).not.toHaveBeenCalled();
  });

  it("updateHeartbeatConfig({ enabled: false }) calls stop() (NOT saveSettings)", async () => {
    const hb = makeFakeHeartbeat();
    const be = new CopilotAutomationBackend();
    be.setAutomationManager(makeFakeManager());
    be.setHeartbeatManager(hb);
    const r = await be.updateHeartbeatConfig({ enabled: false });
    expect(r.ok).toBe(true);
    expect(hb.saveSettings).not.toHaveBeenCalled();
    expect(hb.start).not.toHaveBeenCalled();
    expect(hb.stop).toHaveBeenCalled();
  });

  it("updateHeartbeatConfig with combined { enabled: true, prompt } saves prompt then starts", async () => {
    const hb = makeFakeHeartbeat();
    const be = new CopilotAutomationBackend();
    be.setAutomationManager(makeFakeManager());
    be.setHeartbeatManager(hb);
    const r = await be.updateHeartbeatConfig({ enabled: true, prompt: "go" });
    expect(r.ok).toBe(true);
    expect(hb.saveSettings).toHaveBeenCalledWith({ prompt: "go" });
    expect(hb.start).toHaveBeenCalled();
  });

  it("updateHeartbeatConfig({}) is a no-op", async () => {
    const hb = makeFakeHeartbeat();
    const be = new CopilotAutomationBackend();
    be.setAutomationManager(makeFakeManager());
    be.setHeartbeatManager(hb);
    const r = await be.updateHeartbeatConfig({});
    expect(r.ok).toBe(true);
    expect(hb.saveSettings).not.toHaveBeenCalled();
    expect(hb.start).not.toHaveBeenCalled();
    expect(hb.stop).not.toHaveBeenCalled();
  });

  it("triggerHeartbeatNow returns ok:true after calling the manager", async () => {
    const am = makeFakeManager();
    const hb = makeFakeHeartbeat();
    const be = new CopilotAutomationBackend();
    be.setAutomationManager(am);
    be.setHeartbeatManager(hb);
    const r = await be.triggerHeartbeatNow();
    expect(hb.runNow).toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });

  it("throws when managers are not wired", async () => {
    const be = new CopilotAutomationBackend();
    await expect(be.listAutomations()).rejects.toThrow(/manager/i);
  });
});
