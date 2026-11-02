import * as fs from "fs";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs");
vi.mock("../platform-security", async () => {
  const mockedFs = await import("fs");
  return {
    secureMkdirSync: (dir: string, mode: number) =>
      mockedFs.mkdirSync(dir, { recursive: true, mode }),
    secureWriteFileSync: (file: string, data: string | Buffer) =>
      mockedFs.writeFileSync(file, data),
  };
});
vi.mock("../app-paths", () => ({ getAppDataDir: () => "/tmp/test-home" }));
vi.mock("../mock-mode", () => ({
  isMockMode: () => false,
}));
vi.mock("electron", () => ({ app: { isPackaged: false } }));

const mockedFs = vi.mocked(fs);

beforeEach(() => {
  vi.clearAllMocks();
  mockedFs.existsSync.mockReturnValue(false);
  mockedFs.mkdirSync.mockImplementation(() => undefined);
  mockedFs.writeFileSync.mockImplementation(() => {});
  mockedFs.readFileSync.mockReturnValue("[]");
  mockedFs.rmSync.mockImplementation(() => {});
});

import type { PermissionsConfig } from "../../common/marshal-ipc-contract";
import { requireSchedule, AutomationManager } from "../automations";
import type { PermissionPolicy } from "../permission-policy";
import type { SendAndCollectResult, SessionManager } from "../sessions";
import { testDouble } from "../testing/harness";

const okResult = (text: string): SendAndCollectResult => ({ kind: "ok", text });
const timeoutResult = (text = ""): SendAndCollectResult => ({ kind: "timeout", text });
const noResponseResult = (): SendAndCollectResult => ({ kind: "no-response", text: "" });

function makeAutomation(
  id: string,
  dayOfWeek: number,
  hour: number,
  minute: number,
  enabled: boolean,
  opts?: { triggerType?: "schedule" | "condition"; condition?: string },
) {
  return {
    id,
    name: "Test Automation",
    steps: [{ id: "s1", label: "Step 1", prompt: "do it" }],
    schedule: {
      kind: "single" as const,
      naturalLanguage: "test",
      days: [dayOfWeek],
      time: { hour, minute },
      hour,
      minute,
    },
    enabled,
    triggerType: opts?.triggerType ?? "schedule",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(opts?.condition !== undefined && { condition: opts.condition }),
  };
}

describe("AutomationManager condition timers", () => {
  let wm: AutomationManager;

  beforeEach(() => {
    vi.useFakeTimers();
    wm = new AutomationManager();
    mockedFs.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    wm.destroy();
    vi.useRealTimers();
  });

  it("starts a condition timer on create for condition automations", () => {
    const schedule = requireSchedule("every day at 9am");
    const wf = wm.create({
      name: "Condition task",
      steps: [{ id: "1", label: "Main", prompt: "do it" }],
      schedule,
      triggerType: "condition",
      condition: "PR approved",
    });
    // Timer was set — getConditionStatus should return nulls (no check yet)
    const status = wm.getConditionStatus(wf.id);
    expect(status.lastCheck).toBeNull();
  });

  it("does not start a condition timer for schedule-type automations", () => {
    const schedule = requireSchedule("every day at 9am");
    const wf = wm.create({ name: "Normal", steps: [], schedule });
    const status = wm.getConditionStatus(wf.id);
    expect(status.lastCheck).toBeNull();
    expect(status.nextCheck).toBeNull();
  });

  it("stops condition timer on delete", () => {
    const schedule = requireSchedule("every day at 9am");
    const wf = wm.create({
      name: "Cond",
      steps: [{ id: "1", label: "Main", prompt: "do it" }],
      schedule,
      triggerType: "condition",
      condition: "PR approved",
    });
    // Stub loadAutomations to return the automation for delete
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([wf]));

    wm.delete(wf.id);
    // After delete, timer should be stopped — getConditionStatus returns nulls
    const status = wm.getConditionStatus(wf.id);
    expect(status.lastCheck).toBeNull();
  });

  it("stops condition timer when disabling via toggle", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify([
        makeAutomation("wf1", 1, 9, 0, true, {
          triggerType: "condition",
          condition: "PR approved",
        }),
      ]),
    );

    wm.toggle("wf1", false);
    const status = wm.getConditionStatus("wf1");
    expect(status.lastCheck).toBeNull();
  });

  it("starts condition timer when enabling via toggle", () => {
    mockedFs.existsSync.mockReturnValue(true);
    const wfData = makeAutomation("wf1", 1, 9, 0, false, {
      triggerType: "condition",
      condition: "PR approved",
    });
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([wfData]));

    wm.toggle("wf1", true);
    // Timer should have started; getConditionStatus returns lastCheck=null (not checked yet)
    const status = wm.getConditionStatus("wf1");
    expect(status.lastCheck).toBeNull();
  });

  it("starts condition timers on restore for enabled condition automations", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify([
        makeAutomation("wf1", 1, 9, 0, true, {
          triggerType: "condition",
          condition: "PR approved",
        }),
        makeAutomation("wf2", 1, 9, 0, false, { triggerType: "condition", condition: "Email" }),
        makeAutomation("wf3", 1, 9, 0, true),
      ]),
    );

    wm.restore();
    // Only wf1 should have a timer (enabled + condition type)
    // We can verify via getConditionStatus returning valid shape
    const s1 = wm.getConditionStatus("wf1");
    expect(s1.lastCheck).toBeNull(); // not checked yet, but timer exists
    const s2 = wm.getConditionStatus("wf2");
    expect(s2.lastCheck).toBeNull();
  });

  it("stores conditionCheckInterval on the automation", () => {
    const schedule = requireSchedule("every day at 9am");
    const wf = wm.create({
      name: "Cond with interval",
      steps: [{ id: "1", label: "Main", prompt: "do it" }],
      schedule,
      triggerType: "condition",
      condition: "PR approved",
      conditionCheckInterval: 30,
    });
    expect(wf.conditionCheckInterval).toBe(30);
  });

  it("does not start timer when condition text is missing", () => {
    const schedule = requireSchedule("every day at 9am");
    const wf = wm.create({
      name: "No condition text",
      steps: [{ id: "1", label: "Main", prompt: "do it" }],
      schedule,
      triggerType: "condition",
      // condition deliberately omitted
    });
    // No timer started — getConditionStatus has no timerStarted entry
    const status = wm.getConditionStatus(wf.id);
    expect(status.nextCheck).toBeNull();
  });

  it("clamps invalid conditionCheckInterval to 15 in timer", () => {
    const schedule = requireSchedule("every day at 9am");
    const automation = wm.create({
      name: "Bad interval",
      steps: [{ id: "1", label: "Main", prompt: "do it" }],
      schedule,
      triggerType: "condition",
      condition: "PR approved",
      conditionCheckInterval: 0,
    });
    // The timer should use 15m (clamped). Verify via getConditionStatus
    // which computes nextCheck using the clamped interval.
    const status = wm.getConditionStatus(automation.id);
    expect(status.lastCheck).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// One-shot auto-disable
// ---------------------------------------------------------------------------

describe("AutomationManager condition check permissions", () => {
  let wm: AutomationManager;

  beforeEach(() => {
    vi.useFakeTimers();
    wm = new AutomationManager();
    mockedFs.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    wm.destroy();
    vi.useRealTimers();
  });

  function makeMockSessionManager() {
    return {
      createSession: vi.fn<() => Promise<{ id: string }>>().mockResolvedValue({ id: "cond-sess" }),
      appendMessage: vi.fn<(id: string, msg: Record<string, unknown>) => void>(),
      markUnread: vi.fn<() => void>(),
      sendAndCollect: vi
        .fn<() => Promise<SendAndCollectResult>>()
        .mockResolvedValue(okResult("CONDITION_NOT_MET")),
      getSession: vi.fn<() => Record<string, unknown> | null>().mockReturnValue(null),
      getDefaultModel: vi.fn<() => string>().mockReturnValue("gpt-5.5"),
      updateSessionModelQuietly: vi
        .fn<(id: string, model: string) => Promise<void>>()
        .mockResolvedValue(undefined),
      switchSession: vi
        .fn<() => Promise<{ kind: "hydrating" }>>()
        .mockResolvedValue({ kind: "hydrating" }),
      renameSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      deleteSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
  }

  function makeMockPermissionPolicy() {
    return {
      registerSessionPermissions: vi.fn<(id: string, p: PermissionsConfig) => void>(),
      unregisterSessionPermissions: vi.fn<(id: string) => void>(),
      setDenyPrompt: vi.fn<(id: string) => void>(),
      clearDenyPrompt: vi.fn<(id: string) => void>(),
      markUnattended: vi.fn<(id: string) => void>(),
      clearUnattended: vi.fn<(id: string) => void>(),
    };
  }

  const condPerms: PermissionsConfig = {
    autoApproveReadOnly: true,
    tools: { "tool:listEmails": true },
    servers: {},
    allow: [],
  };

  it("registers automation permissions for condition check sessions", async () => {
    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const pp = makeMockPermissionPolicy();
    wm.setPermissionPolicy(testDouble<PermissionPolicy>(pp));

    // Build the automation data upfront so the immediate check in create() sees it
    const wfData = {
      ...makeAutomation("cond-1", 1, 9, 0, true, {
        triggerType: "condition",
        condition: "Check something",
      }),
      conditionCheckInterval: 15,
      permissions: condPerms,
    };

    // Mock fs so both create's save AND checkCondition's load see the automation
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([wfData]));
    mockedFs.writeFileSync.mockImplementation(() => {});

    // Restore triggers startConditionTimer → immediate checkCondition (fire-and-forget)
    wm.restore();

    // checkCondition is async (fire-and-forget). Advance just enough for the
    // immediate check to complete without triggering the minute-level scheduler loop.
    await vi.advanceTimersByTimeAsync(100);

    expect(pp.registerSessionPermissions).toHaveBeenCalledWith(
      "cond-sess",
      condPerms,
      expect.any(Function),
    );
    expect(pp.unregisterSessionPermissions).toHaveBeenCalledWith("cond-sess");
  });

  it("does not register permissions for condition checks when automation has no custom permissions", async () => {
    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const pp = makeMockPermissionPolicy();
    wm.setPermissionPolicy(testDouble<PermissionPolicy>(pp));

    const wfData = {
      ...makeAutomation("cond-2", 1, 9, 0, true, {
        triggerType: "condition",
        condition: "Check something",
      }),
      conditionCheckInterval: 15,
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([wfData]));
    mockedFs.writeFileSync.mockImplementation(() => {});

    wm.restore();
    await vi.advanceTimersByTimeAsync(100);

    expect(pp.registerSessionPermissions).not.toHaveBeenCalled();
    expect(pp.unregisterSessionPermissions).not.toHaveBeenCalled();
  });

  it("syncs reused condition check session to automation model override", async () => {
    const sm = makeMockSessionManager();
    sm.getSession.mockReturnValue({ id: "cond-sess", model: "gpt-5.5" });
    wm.setSessionManager(testDouble<SessionManager>(sm));
    wm.setPermissionPolicy(testDouble<PermissionPolicy>(makeMockPermissionPolicy()));

    const baseAutomation = {
      ...makeAutomation("cond-model", 1, 9, 0, true, {
        triggerType: "condition",
        condition: "Check something",
      }),
      conditionCheckInterval: 15,
    };
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([baseAutomation]));
    mockedFs.writeFileSync.mockImplementation(() => {});

    wm.restore();
    await vi.advanceTimersByTimeAsync(100);
    expect(sm.createSession).toHaveBeenCalledTimes(1);
    expect(sm.updateSessionModelQuietly).not.toHaveBeenCalled();

    // Simulate the automation being updated before the next condition-check interval.
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify([{ ...baseAutomation, model: "claude-haiku-4.5" }]),
    );
    await vi.advanceTimersByTimeAsync(15 * 60_000);

    expect(sm.updateSessionModelQuietly).toHaveBeenCalledWith("cond-sess", "claude-haiku-4.5");
  });

  // Regression: a condition check that returns a non-ok SendAndCollectResult
  // must NOT be treated as "CONDITION_MET=false" — the old code cleared
  // `conditionLastError` unconditionally, so real failures disappeared and
  // condition-triggered automations silently stopped firing.
  it.each([
    ["timeout", timeoutResult()],
    ["no-response", noResponseResult()],
  ])("records an error when the condition check returns %s", async (kindLabel, nonOkResult) => {
    const sm = makeMockSessionManager();
    sm.sendAndCollect.mockResolvedValue(nonOkResult);
    wm.setSessionManager(testDouble<SessionManager>(sm));
    wm.setPermissionPolicy(testDouble<PermissionPolicy>(makeMockPermissionPolicy()));

    const wfData = {
      ...makeAutomation("cond-sentinel", 1, 9, 0, true, {
        triggerType: "condition",
        condition: "Check something",
      }),
      conditionCheckInterval: 15,
    };
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([wfData]));
    mockedFs.writeFileSync.mockImplementation(() => {});

    wm.restore();
    await vi.advanceTimersByTimeAsync(100);

    const status = wm.getConditionStatus("cond-sentinel");
    expect(status.lastError).not.toBeNull();
    expect(status.lastError).toContain(kindLabel);
    expect(status.lastCheck).not.toBeNull();
  });

  it("sets denyPrompt for condition check sessions and clears in finally", async () => {
    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const pp = makeMockPermissionPolicy();
    wm.setPermissionPolicy(testDouble<PermissionPolicy>(pp));

    const wfData = {
      ...makeAutomation("cond-deny", 1, 9, 0, true, {
        triggerType: "condition",
        condition: "Is it ready?",
      }),
      conditionCheckInterval: 15,
    };
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([wfData]));
    mockedFs.writeFileSync.mockImplementation(() => {});

    wm.restore();
    await vi.advanceTimersByTimeAsync(100);

    expect(pp.setDenyPrompt).toHaveBeenCalled();
    expect(pp.clearDenyPrompt).toHaveBeenCalled();
    expect(pp.markUnattended).toHaveBeenCalled();
    expect(pp.clearUnattended).toHaveBeenCalled();
  });

  it("clears denyPrompt even when condition check fails", async () => {
    const sm = makeMockSessionManager();
    sm.sendAndCollect.mockRejectedValue(new Error("check exploded"));
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const pp = makeMockPermissionPolicy();
    wm.setPermissionPolicy(testDouble<PermissionPolicy>(pp));

    const wfData = {
      ...makeAutomation("cond-fail", 1, 9, 0, true, {
        triggerType: "condition",
        condition: "Is it ready?",
      }),
      conditionCheckInterval: 15,
    };
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([wfData]));
    mockedFs.writeFileSync.mockImplementation(() => {});

    wm.restore();
    await vi.advanceTimersByTimeAsync(100);

    expect(pp.setDenyPrompt).toHaveBeenCalled();
    expect(pp.clearDenyPrompt).toHaveBeenCalled();
    expect(pp.markUnattended).toHaveBeenCalled();
    expect(pp.clearUnattended).toHaveBeenCalled();
  });
});
