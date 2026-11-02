import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/mock", getPath: () => "/mock" },
  dialog: {
    showMessageBox: vi.fn<() => Promise<{ response: number }>>(() =>
      Promise.resolve({ response: 1 }),
    ),
  },
}));

import type { IpcInvokeMap } from "../../common/marshal-ipc-contract";
import { callIpc, testDouble } from "../testing/harness";
import { registerAutomationsHandlers } from "./automations-ipc";
import type { IpcDeps } from "./types";

type BackendOrigin = "copilot" | "gateway";

interface FakeAutomationBackend {
  listAutomations: ReturnType<typeof vi.fn>;
  createAutomation: ReturnType<typeof vi.fn>;
  updateAutomation: ReturnType<typeof vi.fn>;
  toggleAutomation: ReturnType<typeof vi.fn>;
  deleteAutomation: ReturnType<typeof vi.fn>;
  getAutomationRuns: ReturnType<typeof vi.fn>;
  getAllAutomationRuns: ReturnType<typeof vi.fn>;
  getCurrentRun: ReturnType<typeof vi.fn>;
  triggerAutomationNow: ReturnType<typeof vi.fn>;
  exportAutomation: ReturnType<typeof vi.fn>;
  importAutomations: ReturnType<typeof vi.fn>;
  getConditionStatus: ReturnType<typeof vi.fn>;
  getHeartbeatConfig: ReturnType<typeof vi.fn>;
  getHeartbeatStatus: ReturnType<typeof vi.fn>;
  updateHeartbeatConfig: ReturnType<typeof vi.fn>;
  triggerHeartbeatNow: ReturnType<typeof vi.fn>;
}

interface FakeBackendProvider {
  origin: BackendOrigin;
  automation: FakeAutomationBackend;
}

function makeFakeBackend(origin: BackendOrigin = "copilot"): FakeBackendProvider {
  return {
    origin,
    automation: {
      listAutomations: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
      createAutomation: vi.fn<() => Promise<string>>().mockResolvedValue("new-id"),
      updateAutomation: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      toggleAutomation: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      deleteAutomation: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      getAutomationRuns: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
      getAllAutomationRuns: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
      getCurrentRun: vi.fn<() => Promise<unknown>>().mockResolvedValue(null),
      triggerAutomationNow: vi
        .fn<() => Promise<{ runId?: string }>>()
        .mockResolvedValue({ runId: "r1" }),
      exportAutomation: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
      importAutomations: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
      getConditionStatus: vi
        .fn<
          () => Promise<{
            lastCheck: string | null;
            nextCheck: string | null;
            lastError: string | null;
          }>
        >()
        .mockResolvedValue({ lastCheck: null, nextCheck: null, lastError: null }),
      getHeartbeatConfig: vi.fn<() => Promise<unknown>>(),
      getHeartbeatStatus: vi.fn<() => Promise<unknown>>(),
      updateHeartbeatConfig: vi.fn<() => Promise<unknown>>(),
      triggerHeartbeatNow: vi.fn<() => Promise<unknown>>(),
    },
  };
}

describe("registerAutomationsHandlers — routes through backend.automation", () => {
  let ipcHandle: ReturnType<typeof vi.fn>;
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let backend: FakeBackendProvider;
  let automationManager: {
    getCurrentRun: ReturnType<typeof vi.fn>;
  };
  let sessionManager: {
    addEventListener: ReturnType<typeof vi.fn>;
    getBackendProvider: () => FakeBackendProvider;
  };
  const getWindow = () => null;

  beforeEach(() => {
    handlers = new Map();
    ipcHandle = vi.fn<(channel: string, handler: (...args: unknown[]) => unknown) => void>(
      (channel, handler) => {
        handlers.set(channel, handler);
      },
    );
    backend = makeFakeBackend();
    automationManager = {
      getCurrentRun: vi.fn<() => null>(() => null),
    };
    sessionManager = {
      addEventListener: vi.fn<() => () => void>(() => () => {}),
      getBackendProvider: () => backend,
    };
  });

  // Thin wrapper over the typed callIpc helper. Args + return narrow from
  // IpcInvokeMap, so the per-call-site `(... as { success: boolean; ... })`
  // casts at the test sites become unnecessary.
  function callHandler<K extends keyof IpcInvokeMap>(
    channel: K,
    ...args: Parameters<IpcInvokeMap[K]>
  ): Promise<Awaited<ReturnType<IpcInvokeMap[K]>>> {
    return callIpc(handlers, channel, ...args);
  }

  function register(opts?: { tenantPolicyProvider?: { get: () => Record<string, unknown> } }) {
    registerAutomationsHandlers({
      sessionManager: testDouble(sessionManager),
      getWindow: testDouble(getWindow),
      ipcHandle: testDouble<IpcDeps["ipcHandle"]>(ipcHandle),
      ...opts,
    });
  }

  it("automations:create rejects when disableAutomations is true", async () => {
    register({ tenantPolicyProvider: { get: () => ({ disableAutomations: true }) } });
    const result = await callHandler("automations:create", {
      name: "test",
      steps: [],
      schedule: { naturalLanguage: "", days: [], hour: 0, minute: 0 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("disabled");
    expect(backend.automation.createAutomation).not.toHaveBeenCalled();
  });

  it("automations:toggle rejects enable when disableAutomations is true", async () => {
    register({ tenantPolicyProvider: { get: () => ({ disableAutomations: true }) } });
    const result = await callHandler("automations:toggle", "wf-1", true);
    expect(result.success).toBe(false);
    expect(result.error).toContain("disabled");
    expect(backend.automation.toggleAutomation).not.toHaveBeenCalled();
  });

  it("automations:create succeeds when no tenant policy (backend returns canonical AutomationData)", async () => {
    backend.automation.createAutomation.mockResolvedValue({
      id: "wf-42",
      name: "test",
      steps: [],
      schedule: { naturalLanguage: "", days: [], hour: 0, minute: 0 },
    });
    register();
    const result = await callHandler("automations:create", {
      name: "test",
      steps: [],
      schedule: { naturalLanguage: "", days: [], hour: 0, minute: 0 },
    });
    expect(result.success).toBe(true);
    expect(result.automation?.id).toBe("wf-42");
    // No follow-up listAutomations round-trip — backend returns the
    // canonical shape directly (review comments 4 + 14 + Pattern A).
    expect(backend.automation.createAutomation).toHaveBeenCalled();
    expect(backend.automation.listAutomations).not.toHaveBeenCalled();
  });

  it("automations:list returns backend.automation.listAutomations()", async () => {
    const fake = [{ id: "a1", name: "one" }];
    backend.automation.listAutomations.mockResolvedValue(fake);
    register();
    const result = await callHandler("automations:list");
    expect(result.success).toBe(true);
    expect(result.automations).toEqual(fake);
  });

  it("automations:getCurrentRun delegates to backend.automation.getCurrentRun polymorphically", async () => {
    backend.automation.getCurrentRun.mockResolvedValueOnce({ id: "live-run" });
    register();
    const result = await callHandler("automations:getCurrentRun");
    expect(result.success).toBe(true);
    expect(result.run).toEqual({ id: "live-run" });
    expect(backend.automation.getCurrentRun).toHaveBeenCalled();
    // No origin branch in the IPC handler — automationManager is never
    // consulted for this route. Previously asserted a rule-5-exempt
    // `if (origin === "copilot")` branch; the interface is symmetric now.
    expect(automationManager.getCurrentRun).not.toHaveBeenCalled();
  });

  it("automations:getCurrentRun returns null when the backend returns null (gateway path)", async () => {
    backend.automation.getCurrentRun.mockResolvedValueOnce(null);
    register();
    const result = await callHandler("automations:getCurrentRun");
    expect(result.success).toBe(true);
    expect(result.run).toBeNull();
  });

  it("automations:getAllHistory delegates to backend.automation.getAllAutomationRuns (single bulk call)", async () => {
    backend.automation.getAllAutomationRuns.mockResolvedValue([
      { id: "r1", automationId: "a1" },
      { id: "r2", automationId: "a2" },
      { id: "r3", automationId: "a2" },
    ]);
    register();
    const result = await callHandler("automations:getAllHistory");
    expect(result.success).toBe(true);
    expect(backend.automation.getAllAutomationRuns).toHaveBeenCalledTimes(1);
    expect(backend.automation.listAutomations).not.toHaveBeenCalled();
    expect(backend.automation.getAutomationRuns).not.toHaveBeenCalled();
    expect(result.runs?.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("automations:delete calls backend.automation.deleteAutomation", async () => {
    register();
    const result = await callHandler("automations:delete", "wf-1");
    expect(result.success).toBe(true);
    expect(backend.automation.deleteAutomation).toHaveBeenCalledWith("wf-1");
  });

  it("automations:update reports missing automation after update", async () => {
    backend.automation.listAutomations.mockResolvedValue([]);
    register();
    const result = await callHandler("automations:update", "nope", { name: "x" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("automations:export delegates to backend.automation.exportAutomation", async () => {
    backend.automation.exportAutomation.mockResolvedValue('{"name":"x"}');
    register();
    const result = await callHandler("automations:export", "wf-1");
    expect(result.success).toBe(true);
    expect(result.json).toBe('{"name":"x"}');
    expect(backend.automation.exportAutomation).toHaveBeenCalledWith("wf-1");
  });

  it("automations:export returns error when backend returns null", async () => {
    backend.automation.exportAutomation.mockResolvedValue(null);
    register();
    const result = await callHandler("automations:export", "missing");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("automations:import rejects when disableAutomations is true", async () => {
    register({ tenantPolicyProvider: { get: () => ({ disableAutomations: true }) } });
    const result = await callHandler(
      "automations:import",
      JSON.stringify({ name: "test", steps: [], schedule: {} }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("disabled");
    expect(backend.automation.importAutomations).not.toHaveBeenCalled();
  });

  it("automations:import routes a no-conflict payload through backend.importAutomations", async () => {
    const imported = [{ id: "wf-imported-1", name: "Imported" }];
    backend.automation.listAutomations.mockResolvedValue([]);
    backend.automation.importAutomations.mockResolvedValue(imported);
    register();
    const result = await callHandler(
      "automations:import",
      JSON.stringify([{ name: "Imported", steps: [], schedule: {} }]),
    );
    expect(result.success).toBe(true);
    expect(result.automations).toEqual(imported);
    expect(backend.automation.importAutomations).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ overwrite: false }),
    );
  });

  it("automations:getConditionStatus delegates to backend.automation.getConditionStatus", async () => {
    backend.automation.getConditionStatus.mockResolvedValue({
      lastCheck: "2026-01-01",
      nextCheck: "2026-01-02",
      lastError: "boom",
    });
    register();
    const result = await callHandler("automations:getConditionStatus", "wf-1");
    expect(result.success).toBe(true);
    expect(result.lastCheck).toBe("2026-01-01");
    expect(result.nextCheck).toBe("2026-01-02");
    expect(result.lastError).toBe("boom");
  });
});
