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
  resetRelayRouteAliasesForTests();
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
import type { RelayNotificationPublisher } from "../relay/experience-coordinator";
import { resetRelayRouteAliasesForTests } from "../relay/route-aliases";
import type { SendAndCollectResult, SessionManager, SwitchSessionResult } from "../sessions";
import { flushMicrotasks, testDouble } from "../testing/harness";
import { asInterval, asMulti } from "./testing/schedule-assertions";

const okResult = (text: string): SendAndCollectResult => ({ kind: "ok", text });
const timeoutResult = (text = ""): SendAndCollectResult => ({ kind: "timeout", text });
const noResponseResult = (): SendAndCollectResult => ({ kind: "no-response", text: "" });

describe("AutomationManager lifecycle", () => {
  let wm: AutomationManager;

  beforeEach(() => {
    wm = new AutomationManager();
  });

  afterEach(() => {
    wm.destroy();
  });

  it("list returns empty array when no automations file exists", () => {
    expect(wm.list()).toEqual([]);
  });

  it("getCurrentRun returns null when no automation is running", () => {
    expect(wm.getCurrentRun()).toBeNull();
  });

  it("start/stop/destroy do not throw", () => {
    expect(() => {
      wm.start();
      wm.start(); // idempotent — second call should not create a second timer
      wm.stop();
      wm.destroy();
    }).not.toThrow();
  });

  it("restore starts timer when enabled automations exist", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([makeAutomation("wf1", 1, 9, 0, true)]));
    expect(() => {
      wm.restore();
      wm.destroy();
    }).not.toThrow();
  });

  it("restore does not start timer when no enabled automations exist", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([makeAutomation("wf1", 1, 9, 0, false)]));
    expect(() => {
      wm.restore();
      // No timer started — destroy should be a no-op
      wm.destroy();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AutomationManager CRUD
// ---------------------------------------------------------------------------
describe("AutomationManager CRUD", () => {
  let wm: AutomationManager;

  beforeEach(() => {
    wm = new AutomationManager();
    mockedFs.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    wm.destroy();
  });

  it("create persists automation and returns it", () => {
    let written = "";
    mockedFs.writeFileSync.mockImplementation((_p, content) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test always passes string
      written = content as string;
    });

    const schedule = requireSchedule("every day at 9am");
    const automation = wm.create({ name: "Daily Report", steps: [], schedule });

    expect(automation.name).toBe("Daily Report");
    expect(automation.enabled).toBe(true);
    expect(automation.id).toBeTruthy();
    expect(written).toContain("Daily Report");
  });

  it("create with enabled=false creates disabled automation", () => {
    const schedule = requireSchedule("every day at 9am");
    const automation = wm.create({ name: "Test", steps: [], schedule, enabled: false });
    expect(automation.enabled).toBe(false);
  });

  it("update returns updated automation", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([makeAutomation("wf1", 1, 9, 0, true)]));

    const updated = wm.update("wf1", { name: "Updated Name" });
    expect(updated?.name).toBe("Updated Name");
  });

  it("update returns null for unknown id", () => {
    expect(wm.update("nonexistent", { name: "X" })).toBeNull();
  });

  it("delete returns true for existing automation", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([makeAutomation("wf1", 1, 9, 0, true)]));

    const deleted = wm.delete("wf1");
    expect(deleted).toBe(true);
  });

  it("delete returns false for unknown automation", () => {
    expect(wm.delete("nonexistent")).toBe(false);
  });

  it("delete backfills automationName onto history runs that lack it", () => {
    const historyRuns = [
      {
        id: "run-1",
        automationId: "wf1",
        startedAt: "2025-01-01T09:00:00Z",
        status: "completed",
        stepResults: [],
      },
    ];
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json"))
        return JSON.stringify([makeAutomation("wf1", 1, 9, 0, true)]);
      return JSON.stringify(historyRuns);
    });
    const written = new Map<string, string>();
    mockedFs.writeFileSync.mockImplementation((p, content) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test always passes string
      written.set(String(p), content as string);
    });

    wm.delete("wf1");

    const historyWrite = [...written.entries()].find(([p]) => p.includes("history"));
    expect(historyWrite).toBeDefined();
    const saved = JSON.parse(historyWrite![1]);
    expect(saved[0].automationName).toBe("Test Automation");
  });

  it("delete does not overwrite automationName already set on history runs", () => {
    const historyRuns = [
      {
        id: "run-1",
        automationId: "wf1",
        automationName: "Original Name",
        startedAt: "2025-01-01T09:00:00Z",
        status: "completed",
        stepResults: [],
      },
    ];
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json"))
        return JSON.stringify([makeAutomation("wf1", 1, 9, 0, true)]);
      return JSON.stringify(historyRuns);
    });
    const written = new Map<string, string>();
    mockedFs.writeFileSync.mockImplementation((p, content) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test always passes string
      written.set(String(p), content as string);
    });

    wm.delete("wf1");

    const historyWrite = [...written.entries()].find(([p]) => p.includes("history"));
    expect(historyWrite).toBeDefined();
    const saved = JSON.parse(historyWrite![1]);
    expect(saved[0].automationName).toBe("Original Name");
  });

  it("getAllHistory returns runs from all history files", () => {
    const runs1 = [
      {
        id: "r1",
        automationId: "wf1",
        automationName: "WF One",
        startedAt: "2025-01-01T09:00:00Z",
        status: "completed",
        stepResults: [],
      },
    ];
    const runs2 = [
      {
        id: "r2",
        automationId: "wf2",
        automationName: "WF Two",
        startedAt: "2025-01-02T09:00:00Z",
        status: "failed",
        stepResults: [],
      },
    ];
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readdirSync.mockReturnValue(testDouble(["wf1.json", "wf2.json"]));
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("wf1.json")) return JSON.stringify(runs1);
      if (String(p).includes("wf2.json")) return JSON.stringify(runs2);
      return "[]";
    });

    const all = wm.getAllHistory();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.id)).toContain("r1");
    expect(all.map((r) => r.id)).toContain("r2");
  });

  it("getAllHistory returns empty array when history dir does not exist", () => {
    mockedFs.existsSync.mockReturnValue(false);
    expect(wm.getAllHistory()).toEqual([]);
  });

  // --- Schema validation (SF-4) ---

  it("loadAutomations filters entries with wrong types via schema", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify([
        makeAutomation("wf1", 1, 9, 0, true),
        // Invalid entry: name is a number, not a string
        {
          id: "bad",
          name: 123,
          steps: [],
          schedule: {
            kind: "single",
            naturalLanguage: "test",
            days: [1],
            time: { hour: 9, minute: 0 },
            hour: 9,
            minute: 0,
          },
          enabled: true,
          triggerType: "schedule",
          createdAt: "",
          updatedAt: "",
        },
      ]),
    );
    const list = wm.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("wf1");
  });

  it("loadAutomations migrates old entries without triggerType before schema parse", () => {
    mockedFs.existsSync.mockReturnValue(true);
    // Entry missing `triggerType` — migration code should add "schedule" before schema validation
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify([
        {
          id: "old-wf",
          name: "Legacy Automation",
          steps: [{ id: "s1", label: "Step", prompt: "do" }],
          schedule: {
            kind: "single",
            naturalLanguage: "daily",
            days: [1],
            time: { hour: 8, minute: 0 },
            hour: 8,
            minute: 0,
          },
          enabled: false,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]),
    );
    const list = wm.list();
    expect(list).toHaveLength(1);
    expect(list[0].triggerType).toBe("schedule");
  });

  it("loadHistory filters malformed run entries via schema", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json"))
        return JSON.stringify([makeAutomation("wf1", 1, 9, 0, true)]);
      // History file with one valid and one invalid run
      return JSON.stringify([
        {
          id: "r1",
          automationId: "wf1",
          startedAt: "2025-01-01T09:00:00Z",
          status: "completed",
          stepResults: [],
        },
        // Invalid: status is not a valid enum value
        {
          id: "r2",
          automationId: "wf1",
          startedAt: "2025-01-01T09:00:00Z",
          status: "unknown-status",
          stepResults: [],
        },
      ]);
    });
    const history = wm.getHistory("wf1");
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe("r1");
  });

  it("importAutomations rejects entries with type-incorrect data via schema", () => {
    const schedule = requireSchedule("every day at 9am");
    const json = JSON.stringify([
      { name: "Valid", steps: [{ label: "A", prompt: "a" }], schedule },
      // name is a number — old manual checks would pass (has "name" key), but schema rejects
      { name: 42, steps: [{ label: "B", prompt: "b" }], schedule },
    ]);
    const results = wm.importAutomations(json);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Valid");
  });

  it("toggle enables a disabled automation", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([makeAutomation("wf1", 1, 9, 0, false)]));

    expect(wm.toggle("wf1", true)).toBe(true);
  });

  it("getHistory returns empty array when no history exists", () => {
    expect(wm.getHistory("wf1")).toEqual([]);
  });

  it("exportAutomation returns null for unknown id", () => {
    expect(wm.exportAutomation("nonexistent")).toBeNull();
  });

  it("exportAutomation returns JSON string for known automation", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([makeAutomation("wf1", 1, 9, 0, true)]));

    const json = wm.exportAutomation("wf1");
    expect(json).not.toBeNull();
    expect(JSON.parse(json!).name).toBe("Test Automation");
  });

  it("importAutomations returns empty array for invalid JSON", () => {
    expect(wm.importAutomations("not-json")).toEqual([]);
  });

  it("importAutomations imports a single automation object", () => {
    const schedule = requireSchedule("every day at 9am");
    const json = JSON.stringify({ name: "Solo", steps: [{ label: "S", prompt: "p" }], schedule });
    const results = wm.importAutomations(json);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Solo");
    expect(results[0].enabled).toBe(false);
  });

  it("importAutomations preserves model override on new imports", () => {
    const schedule = requireSchedule("every day at 9am");
    const json = JSON.stringify({
      name: "Solo Model",
      steps: [{ label: "S", prompt: "p" }],
      schedule,
      model: "claude-haiku-4.5",
    });
    const results = wm.importAutomations(json);
    expect(results).toHaveLength(1);
    expect(results[0].model).toBe("claude-haiku-4.5");
  });

  it("importAutomations imports multiple automations from a JSON array", () => {
    const schedule = requireSchedule("every day at 9am");
    const json = JSON.stringify([
      { name: "First", steps: [{ label: "A", prompt: "a" }], schedule },
      { name: "Second", steps: [{ label: "B", prompt: "b" }], schedule },
    ]);
    const results = wm.importAutomations(json);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.name)).toEqual(["First", "Second"]);
  });

  it("importAutomations skips invalid entries in an array", () => {
    const schedule = requireSchedule("every day at 9am");
    const json = JSON.stringify([
      { name: "Valid", steps: [{ label: "A", prompt: "a" }], schedule },
      { name: "No schedule" }, // missing steps + schedule
    ]);
    const results = wm.importAutomations(json);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Valid");
  });

  it("importAutomations skips duplicate names by default (no overwrite)", () => {
    const schedule = requireSchedule("every day at 9am");
    // Seed mocked fs with a pre-existing automation (existsSync=true so loadAutomations reads the file)
    const existing = [
      {
        id: "x1",
        name: "Existing",
        steps: [],
        schedule,
        enabled: true,
        createdAt: "",
        updatedAt: "",
        triggerType: "schedule",
      },
    ];
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(existing));

    const json = JSON.stringify({
      name: "Existing",
      steps: [{ label: "L2", prompt: "p2" }],
      schedule,
    });
    const results = wm.importAutomations(json);
    expect(results).toHaveLength(0);
  });

  it("importAutomations updates existing automation when overwrite is true", () => {
    const schedule = requireSchedule("every day at 9am");
    // Seed mocked fs with a pre-existing enabled automation (existsSync=true so loadAutomations reads the file)
    const existing = [
      {
        id: "orig-id",
        name: "Overwriteable",
        steps: [{ id: "s1", label: "Old", prompt: "old prompt" }],
        schedule,
        enabled: true,
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
        triggerType: "schedule",
      },
    ];
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(existing));

    const json = JSON.stringify({
      name: "Overwriteable",
      steps: [{ label: "New", prompt: "new prompt" }],
      schedule,
    });
    const results = wm.importAutomations(json, { overwrite: true });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("orig-id"); // same id — updated in place
    expect(results[0].steps[0].prompt).toBe("new prompt");
    expect(results[0].enabled).toBe(true); // enabled state preserved
  });

  it("create with permissions stores them on the automation", () => {
    const schedule = requireSchedule("every day at 9am");
    const perms: PermissionsConfig = {
      autoApproveReadOnly: true,
      tools: {},
      servers: {},
      allow: [],
    };
    const automation = wm.create({ name: "With Perms", steps: [], schedule, permissions: perms });
    expect(automation.permissions).toEqual(perms);
  });

  it("create without permissions has undefined permissions field", () => {
    const schedule = requireSchedule("every day at 9am");
    const automation = wm.create({ name: "No Perms", steps: [], schedule });
    expect(automation.permissions).toBeUndefined();
  });

  it("create with browserHeadless=true stores it on the automation", () => {
    const schedule = requireSchedule("every day at 9am");
    const automation = wm.create({
      name: "Headless",
      steps: [],
      schedule,
      browserHeadless: true,
    });
    expect(automation.browserHeadless).toBe(true);
  });

  it("create without browserHeadless has undefined field", () => {
    const schedule = requireSchedule("every day at 9am");
    const automation = wm.create({ name: "Default", steps: [], schedule });
    expect(automation.browserHeadless).toBeUndefined();
  });

  it("create with model stores it on the automation", () => {
    const schedule = requireSchedule("every day at 9am");
    const automation = wm.create({
      name: "Cheap Model",
      steps: [],
      schedule,
      model: "claude-haiku-4.5",
    });
    expect(automation.model).toBe("claude-haiku-4.5");
  });

  it("create with teamsNotify='auto' stores it on the automation", () => {
    const schedule = requireSchedule("every day at 9am");
    const automation = wm.create({
      name: "Quiet",
      steps: [],
      schedule,
      teamsNotify: "auto",
    });
    expect(automation.teamsNotify).toBe("auto");
  });

  it("create without teamsNotify has undefined field (manager treats as 'always')", () => {
    const schedule = requireSchedule("every day at 9am");
    const automation = wm.create({ name: "Default", steps: [], schedule });
    expect(automation.teamsNotify).toBeUndefined();
  });

  it("create stores explicit target session and project scope fields", () => {
    const schedule = requireSchedule("every day at 9am");
    const automation = wm.create({
      name: "Scoped",
      steps: [],
      schedule,
      targetSessionId: "target-session",
    });
    expect(automation.targetSessionId).toBe("target-session");

    const scoped = wm.create({
      name: "Repo Scoped",
      steps: [],
      schedule,
      workspaceName: "My Workspace",
      repoPath: "C:\\src\\repo",
    });
    expect(scoped.workspaceName).toBe("My Workspace");
    expect(scoped.repoPath).toBe("C:\\src\\repo");
  });

  it("create rejects combining explicit target session with project scope", () => {
    const schedule = requireSchedule("every day at 9am");
    expect(() =>
      wm.create({
        name: "Invalid",
        steps: [],
        schedule,
        targetSessionId: "target-session",
        workspaceName: "My Workspace",
      }),
    ).toThrow(/targetSessionId cannot be combined/);
  });

  it("loadAutomations preserves explicit target session and project scope fields", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify([
        {
          ...makeAutomation("wf-roundtrip", 1, 9, 0, true),
          targetSessionId: "target-session",
          workspaceName: "My Workspace",
          repoPath: "C:\\src\\repo",
        },
      ]),
    );

    const [automation] = wm.list();
    expect(automation.targetSessionId).toBe("target-session");
    expect(automation.workspaceName).toBe("My Workspace");
    expect(automation.repoPath).toBe("C:\\src\\repo");
  });

  it("update with teamsNotify='never' persists the new value", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([makeAutomation("wf1", 1, 9, 0, true)]));
    const updated = wm.update("wf1", { teamsNotify: "never" });
    expect(updated?.teamsNotify).toBe("never");
  });

  it("update without teamsNotify in the patch preserves the existing value", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify([{ ...makeAutomation("wf1", 1, 9, 0, true), teamsNotify: "auto" }]),
    );
    const updated = wm.update("wf1", { name: "Renamed" });
    expect(updated?.teamsNotify).toBe("auto");
  });

  it("update persists and clears explicit session/project scope fields", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify([{ ...makeAutomation("wf-scope", 1, 9, 0, true), targetSessionId: "old" }]),
    );
    const cleared = wm.update("wf-scope", {
      targetSessionId: undefined,
      repoPath: "C:\\src\\repo",
    });
    expect(cleared?.targetSessionId).toBeUndefined();
    expect(cleared?.repoPath).toBe("C:\\src\\repo");
  });

  it("update rejects combining explicit target session with project scope", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify([makeAutomation("wf-scope", 1, 9, 0, true)]),
    );
    expect(() =>
      wm.update("wf-scope", {
        targetSessionId: "target-session",
        repoPath: "C:\\src\\repo",
      }),
    ).toThrow(/targetSessionId cannot be combined/);
  });

  it("create with triggerType condition stores condition text", () => {
    const schedule = requireSchedule("every day at 9am");
    const automation = wm.create({
      name: "Condition task",
      steps: [{ id: "1", label: "Main", prompt: "notify me" }],
      schedule,
      triggerType: "condition",
      condition: "PR #123 is approved",
    });
    expect(automation.triggerType).toBe("condition");
    expect(automation.condition).toBe("PR #123 is approved");
  });

  it("update adds permissions to existing automation", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([makeAutomation("wf1", 1, 9, 0, true)]));

    const perms: PermissionsConfig = {
      autoApproveReadOnly: true,
      tools: {},
      servers: {},
      allow: [],
    };
    const updated = wm.update("wf1", { permissions: perms });
    expect(updated?.permissions).toEqual(perms);
  });

  it("update clears permissions when set to undefined", () => {
    const wfWithPerms = {
      ...makeAutomation("wf1", 1, 9, 0, true),
      permissions: {
        autoApproveReadOnly: true,
        tools: {},
        servers: {},
        allow: [],
      },
    };
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([wfWithPerms]));

    const updated = wm.update("wf1", { permissions: undefined });
    expect(updated?.permissions).toBeUndefined();
  });

  it("create defaults triggerType to schedule", () => {
    const schedule = requireSchedule("every day at 9am");
    const automation = wm.create({ name: "Normal", steps: [], schedule });
    expect(automation.triggerType).toBe("schedule");
    expect(automation.condition).toBeUndefined();
  });

  it("importAutomations drops unknown fields from payload (Zod schema enforcement)", () => {
    const schedule = requireSchedule("every day at 9am");
    const json = JSON.stringify({
      name: "SchemaTest",
      steps: [{ label: "S", prompt: "p", unknownStepField: "bad" }],
      schedule: { ...schedule, unknownScheduleField: "bad" },
      unknownTopLevel: "should-be-dropped",
      __proto__: { injected: true },
    });
    const results = wm.importAutomations(json);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("SchemaTest");
    // Unknown fields should not appear on the imported automation
    expect(results[0]).not.toHaveProperty("unknownTopLevel");
    expect(results[0]).not.toHaveProperty("__proto__.injected");
  });

  it("importAutomations rejects entries missing required fields after schema validation", () => {
    const json = JSON.stringify([
      { name: "No schedule or steps" },
      { steps: [{ label: "A", prompt: "a" }] }, // missing name + schedule
      { name: "No steps", schedule: requireSchedule("every day at 9am") }, // missing steps
    ]);
    const results = wm.importAutomations(json);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// update() bug fix regression tests
// ---------------------------------------------------------------------------
describe("AutomationManager update() — condition timer reconciliation", () => {
  let wm: AutomationManager;

  beforeEach(() => {
    vi.useFakeTimers();
    wm = new AutomationManager();
    mockedFs.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    wm.destroy();
    vi.useRealTimers();
  });

  it("stops condition timer when update() switches triggerType away from condition", () => {
    const conditionAuto = makeAutomation("wf-cond", 3, 9, 0, true, {
      triggerType: "condition",
      condition: "check inbox",
    });
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([conditionAuto]));

    // Start the condition monitor timer
    wm.restore();
    expect(wm.getConditionStatus("wf-cond").nextCheck).not.toBeNull();

    // Switch to schedule trigger
    const schedule = requireSchedule("every day at 9am");
    wm.update("wf-cond", { triggerType: "schedule", schedule });

    // Advance time — condition timer should NOT fire
    vi.advanceTimersByTime(60 * 60_000);
    expect(wm.getConditionStatus("wf-cond").nextCheck).toBeNull();
  });

  it("update() forces oneShot=true when triggerType stays condition", () => {
    const conditionAuto = makeAutomation("wf-cond2", 3, 9, 0, true, {
      triggerType: "condition",
      condition: "check inbox",
    });
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([conditionAuto]));

    const updated = wm.update("wf-cond2", { name: "renamed" });
    expect(updated!.oneShot).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CRUD round-trip: multi and interval schedules
// ---------------------------------------------------------------------------
describe("AutomationManager CRUD round-trip (multi/interval)", () => {
  let wm: AutomationManager;
  let lastWritten: string;

  beforeEach(() => {
    wm = new AutomationManager();
    lastWritten = "";
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.writeFileSync.mockImplementation((_p, content) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test always passes string
      lastWritten = content as string;
    });
  });

  afterEach(() => {
    wm.destroy();
  });

  it("create with multi schedule persists kind, times, and compat fields", () => {
    const schedule = requireSchedule("every day at 9am, 2pm, 6pm");
    const automation = wm.create({ name: "Multi Test", steps: [], schedule });
    const multi = asMulti(automation.schedule);
    expect(multi.times).toHaveLength(3);
    expect(multi.times[0]).toEqual({ hour: 9, minute: 0 });
    expect(automation.schedule.hour).toBe(9);
    expect(automation.schedule.minute).toBe(0);

    // Verify persisted JSON
    const saved = JSON.parse(lastWritten);
    expect(saved[0].schedule.kind).toBe("multi");
    expect(saved[0].schedule.times).toHaveLength(3);
  });

  it("create with interval schedule persists kind, intervalMinutes, and anchor", () => {
    const schedule = requireSchedule("every 30 minutes");
    const automation = wm.create({ name: "Interval Test", steps: [], schedule });
    expect(asInterval(automation.schedule).intervalMinutes).toBe(30);

    const saved = JSON.parse(lastWritten);
    expect(saved[0].schedule.kind).toBe("interval");
    expect(saved[0].schedule.intervalMinutes).toBe(30);
  });

  it("load round-trip preserves multi schedule", () => {
    const multiAutomation = {
      ...makeAutomation("wf-multi", 3, 9, 0, true),
      schedule: {
        kind: "multi",
        naturalLanguage: "every day at 9am, 2pm",
        days: [0, 1, 2, 3, 4, 5, 6],
        times: [
          { hour: 9, minute: 0 },
          { hour: 14, minute: 0 },
        ],
        hour: 9,
        minute: 0,
      },
    };
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify([multiAutomation]));

    const list = wm.list();
    expect(list).toHaveLength(1);
    expect(asMulti(list[0].schedule).times).toEqual([
      { hour: 9, minute: 0 },
      { hour: 14, minute: 0 },
    ]);
  });

  it("import/export round-trip preserves multi schedule", () => {
    // Create a multi automation
    const schedule = requireSchedule("weekdays at 9am and 5pm");
    wm.create({ name: "Export Test", steps: [], schedule });

    // Make list() read back what was written
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(lastWritten);

    // Export
    const exported = wm.exportAutomation(wm.list()[0].id);
    expect(exported).not.toBeNull();
    const parsed = JSON.parse(exported!);
    expect(parsed.schedule.kind).toBe("multi");

    // Re-import into a fresh manager
    const wm2 = new AutomationManager();
    mockedFs.existsSync.mockReturnValue(false);
    const results = wm2.importAutomations(exported!);
    expect(results).toHaveLength(1);
    expect(asMulti(results[0].schedule).times).toHaveLength(2);
    wm2.destroy();
  });

  it("update from single to multi preserves new schedule", () => {
    const singleSchedule = requireSchedule("every day at 9am");
    const automation = wm.create({ name: "Single", steps: [], schedule: singleSchedule });
    expect(automation.schedule.kind).toBe("single");

    // Load for update
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(lastWritten);

    const multiSchedule = requireSchedule("every day at 9am, 2pm, 6pm");
    const updated = wm.update(automation.id, { schedule: multiSchedule });
    expect(updated).not.toBeNull();
    expect(updated!.schedule.kind).toBe("multi");
  });
});

// ---------------------------------------------------------------------------
// AutomationManager schedule validation
// ---------------------------------------------------------------------------
describe("AutomationManager schedule validation", () => {
  let wm: AutomationManager;

  beforeEach(() => {
    wm = new AutomationManager();
    mockedFs.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    wm.destroy();
  });

  it("create rejects unparseable schedule for schedule-triggered automations", () => {
    expect(() =>
      wm.create({
        name: "Bad",
        steps: [{ id: "1", label: "Main", prompt: "test" }],
        schedule: {
          kind: "single",
          naturalLanguage: "sometime next week",
          days: [],
          time: { hour: 0, minute: 0 },
          hour: 0,
          minute: 0,
        },
        triggerType: "schedule",
      }),
    ).toThrow(/Could not parse schedule/);
  });

  it("create accepts valid schedule for schedule-triggered automations", () => {
    const automation = wm.create({
      name: "Good",
      steps: [{ id: "1", label: "Main", prompt: "test" }],
      schedule: {
        kind: "single",
        naturalLanguage: "every weekday at 9am",
        days: [],
        time: { hour: 0, minute: 0 },
        hour: 0,
        minute: 0,
      },
      triggerType: "schedule",
    });
    expect(automation.schedule.hour).toBe(9);
    expect(automation.schedule.days).toEqual([1, 2, 3, 4, 5]);
  });

  it("create skips schedule validation for condition-triggered automations", () => {
    expect(() =>
      wm.create({
        name: "Cond",
        steps: [{ id: "1", label: "Main", prompt: "test" }],
        schedule: {
          kind: "single",
          naturalLanguage: "",
          days: [],
          time: { hour: 0, minute: 0 },
          hour: 0,
          minute: 0,
        },
        triggerType: "condition",
        condition: "when inbox has new emails",
      }),
    ).not.toThrow();
  });

  it("update rejects unparseable schedule change", () => {
    let stored = "[]";
    mockedFs.writeFileSync.mockImplementation((_p, content) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test always passes string
      stored = content as string;
    });
    mockedFs.readFileSync.mockImplementation(() => stored);
    mockedFs.existsSync.mockReturnValue(true);

    const automation = wm.create({
      name: "Test",
      steps: [{ id: "1", label: "Main", prompt: "test" }],
      schedule: requireSchedule("every day at 9am"),
    });
    expect(() =>
      wm.update(automation.id, {
        schedule: {
          kind: "single",
          naturalLanguage: "whenever",
          days: [],
          time: { hour: 0, minute: 0 },
          hour: 0,
          minute: 0,
        },
      }),
    ).toThrow(/Could not parse schedule/);
  });

  it("update rejects condition→schedule transition without valid schedule", () => {
    let stored = "[]";
    mockedFs.writeFileSync.mockImplementation((_p, content) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test always passes string
      stored = content as string;
    });
    mockedFs.readFileSync.mockImplementation(() => stored);
    mockedFs.existsSync.mockReturnValue(true);

    const automation = wm.create({
      name: "Cond",
      steps: [{ id: "1", label: "Main", prompt: "test" }],
      schedule: {
        kind: "single",
        naturalLanguage: "",
        days: [],
        time: { hour: 0, minute: 0 },
        hour: 0,
        minute: 0,
      },
      triggerType: "condition",
      condition: "check something",
    });
    // Switching to schedule without providing one should fail
    expect(() => wm.update(automation.id, { triggerType: "schedule" })).toThrow(
      /schedule is required/i,
    );
  });

  it("repairSchedules fixes legacy broken data", () => {
    mockedFs.existsSync.mockReturnValue(true);
    const broken = [
      {
        id: "broken-1",
        name: "Broken",
        steps: [{ id: "1", label: "Main", prompt: "test" }],
        schedule: {
          kind: "single",
          naturalLanguage: "every weekday at 8am",
          days: [],
          time: { hour: 0, minute: 0 },
          hour: 0,
          minute: 0,
        },
        enabled: true,
        triggerType: "schedule",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(broken));
    const repaired = wm.repairSchedules();
    expect(repaired).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// One-shot auto-disable
// ---------------------------------------------------------------------------
describe("AutomationManager one-shot auto-disable", () => {
  let wm: AutomationManager;

  beforeEach(() => {
    wm = new AutomationManager();
    mockedFs.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    wm.destroy();
  });

  function makeMockSessionManager() {
    return {
      createSession: vi.fn<() => Promise<{ id: string }>>().mockResolvedValue({ id: "sess-1" }),
      appendMessage: vi.fn<(id: string, msg: Record<string, unknown>) => void>(),
      markUnread: vi.fn<() => void>(),
      sendAndCollect: vi
        .fn<() => Promise<SendAndCollectResult>>()
        .mockResolvedValue(okResult("step done")),
      getSession: vi.fn<() => Record<string, unknown> | null>().mockReturnValue(null),
      getSessionAsync: vi
        .fn<() => Promise<Record<string, unknown> | null>>()
        .mockResolvedValue(null),
      switchSession: vi
        .fn<() => Promise<{ kind: "hydrating" }>>()
        .mockResolvedValue({ kind: "hydrating" }),
      renameSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
  }

  it("disables a one-shot automation after successful completion", async () => {
    const wf = { ...makeAutomation("wf-os", 1, 9, 0, true), oneShot: true };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    const written = new Map<string, string>();
    mockedFs.writeFileSync.mockImplementation((p, content) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test always passes string
      written.set(String(p), content as string);
    });

    wm.setSessionManager(testDouble<SessionManager>(makeMockSessionManager()));
    await wm.runNow("wf-os");

    const wfWrite = [...written.entries()].find(([p]) => p.includes("automations.json"));
    expect(wfWrite).toBeDefined();
    const saved = JSON.parse(wfWrite![1]);
    expect(saved.find((w: { id: string }) => w.id === "wf-os")?.enabled).toBe(false);
  });

  it("does not disable a one-shot automation after a failed run", async () => {
    const wf = { ...makeAutomation("wf-os", 1, 9, 0, true), oneShot: true };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    const written = new Map<string, string>();
    mockedFs.writeFileSync.mockImplementation((p, content) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test always passes string
      written.set(String(p), content as string);
    });

    const sm = makeMockSessionManager();
    sm.sendAndCollect.mockRejectedValue(new Error("Step failed"));
    wm.setSessionManager(testDouble<SessionManager>(sm));
    await wm.runNow("wf-os");

    const wfWrite = [...written.entries()].find(([p]) => p.includes("automations.json"));
    // If automations.json was written, enabled must still be true (auto-disable should NOT have run).
    // wfWrite being undefined means nothing was written, which is also acceptable.
    const wfEnabled = wfWrite
      ? JSON.parse(wfWrite[1]).find((w: { id: string }) => w.id === "wf-os")?.enabled
      : undefined;
    expect(wfEnabled).not.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendToRelay fallback
//
// Regression: before the SendAndCollectResult refactor, sendAndCollect
// returned the sentinel strings "(timed out — no response)" / "(no response)"
// on non-ok resolves. The old `response || output` fallback only caught
// empty strings, so users saw the sentinel in the relay. Now the non-ok kinds
// are structurally distinct and sendToRelay falls back to raw output.
// ---------------------------------------------------------------------------

describe("AutomationManager sendToRelay sentinel fallback", () => {
  let wm: AutomationManager;
  const originalE2E = process.env.MARSHAL_E2E;

  beforeEach(() => {
    wm = new AutomationManager();
    mockedFs.existsSync.mockReturnValue(true);
    // sendToRelay is skipped entirely in E2E mode; make sure it runs here
    delete process.env.MARSHAL_E2E;
  });

  afterEach(() => {
    wm.destroy();
    if (originalE2E !== undefined) process.env.MARSHAL_E2E = originalE2E;
  });

  function makeMockSessionManager(
    stepResult: SendAndCollectResult,
    relayFormatResult: SendAndCollectResult,
  ) {
    // First call is the automation step, second is the relay-format reformat.
    const sendAndCollect = vi.fn<() => Promise<SendAndCollectResult>>();
    sendAndCollect.mockResolvedValueOnce(stepResult).mockResolvedValueOnce(relayFormatResult);
    return {
      createSession: vi.fn<() => Promise<{ id: string }>>().mockResolvedValue({ id: "sess-1" }),
      appendMessage: vi.fn<(id: string, msg: Record<string, unknown>) => void>(),
      markUnread: vi.fn<() => void>(),
      sendAndCollect,
      getSession: vi.fn<() => Record<string, unknown> | null>().mockReturnValue(null),
      getSessionAsync: vi
        .fn<() => Promise<Record<string, unknown> | null>>()
        .mockResolvedValue(null),
      switchSession: vi
        .fn<() => Promise<{ kind: "hydrating" }>>()
        .mockResolvedValue({ kind: "hydrating" }),
      renameSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
  }

  function makeMockRelayPublisher() {
    return {
      hasDestinations: vi.fn<() => boolean>().mockReturnValue(true),
      publish: vi
        .fn<(kind: string, text: string, sourceSessionId?: string) => Promise<void>>()
        .mockResolvedValue(undefined),
    };
  }

  async function runWithRelayResponse(relayFormatResult: SendAndCollectResult): Promise<string> {
    const wf = makeAutomation("wf-relay", 1, 9, 0, true);
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });

    const sm = makeMockSessionManager(okResult("real step output"), relayFormatResult);
    const relay = makeMockRelayPublisher();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    wm.setRelayPublisher(testDouble<RelayNotificationPublisher>(relay));

    await wm.runNow("wf-relay");
    await flushMicrotasks();

    expect(relay.publish).toHaveBeenCalledTimes(1);
    const [, text] = relay.publish.mock.calls[0];
    return text;
  }

  it("sends the LLM's formatted response when it is a real message", async () => {
    const text = await runWithRelayResponse(okResult("**Formatted:** real step output"));
    expect(text).not.toContain("Session ID:");
    expect(text).toContain("Route: reply `/route:t1` before your message");
    expect(text).toContain("**Formatted:** real step output");
  });

  it("falls back to raw step output when sendAndCollect times out", async () => {
    const text = await runWithRelayResponse(timeoutResult());
    expect(text).not.toContain("Session ID:");
    expect(text).toContain("real step output");
  });

  it("falls back to raw step output when sendAndCollect returns no-response", async () => {
    const text = await runWithRelayResponse(noResponseResult());
    expect(text).not.toContain("Session ID:");
    expect(text).toContain("real step output");
  });

  it("falls back to raw step output when sendAndCollect returns ok with empty text", async () => {
    // ok.text === "" shouldn't happen in practice (idle with empty accumulated
    // resolves as no-response), but guard against it anyway — an empty string
    // wouldn't be useful to a relay user.
    const text = await runWithRelayResponse(okResult(""));
    expect(text).not.toContain("Session ID:");
    expect(text).toContain("real step output");
  });
});

// ---------------------------------------------------------------------------
// teamsNotify modes
//
// V1 dispatch is deliberately content-independent in `auto` and `never` modes:
// the framework simply does not call sendToRelay. The agent decides per-run
// whether to notify by calling sendNotification during the step (taught
// via the buildStepPrompt addendum below). `always` preserves today's
// behavior verbatim (including the second-pass LLM reformat through the
// relay session — covered by the sentinel-fallback suite above).
// ---------------------------------------------------------------------------

describe("AutomationManager teamsNotify mode dispatch", () => {
  let wm: AutomationManager;
  const originalE2E = process.env.MARSHAL_E2E;

  beforeEach(() => {
    wm = new AutomationManager();
    mockedFs.existsSync.mockReturnValue(true);
    delete process.env.MARSHAL_E2E;
  });

  afterEach(() => {
    wm.destroy();
    if (originalE2E !== undefined) process.env.MARSHAL_E2E = originalE2E;
  });

  function makeMockSessionManager(stepText: string, stepResult?: SendAndCollectResult) {
    const sendAndCollect =
      vi.fn<
        (
          content: string,
          timeoutMs?: number,
          onEvent?: unknown,
          targetSessionId?: string,
        ) => Promise<SendAndCollectResult>
      >();
    // First call: the step. Second call (only in `always`): the relay reformat.
    sendAndCollect.mockResolvedValue(stepResult ?? okResult(stepText));
    return {
      createSession: vi.fn<() => Promise<{ id: string }>>().mockResolvedValue({ id: "sess-1" }),
      appendMessage: vi.fn<(id: string, msg: Record<string, unknown>) => void>(),
      markUnread: vi.fn<() => void>(),
      sendAndCollect,
      getSession: vi.fn<() => Record<string, unknown> | null>().mockReturnValue(null),
      getSessionAsync: vi
        .fn<() => Promise<Record<string, unknown> | null>>()
        .mockResolvedValue(null),
      switchSession: vi
        .fn<() => Promise<{ kind: "hydrating" }>>()
        .mockResolvedValue({ kind: "hydrating" }),
      renameSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
  }

  function makeMockRelayPublisher() {
    return {
      hasDestinations: vi.fn<() => boolean>().mockReturnValue(true),
      publish: vi
        .fn<(kind: string, text: string, sourceSessionId?: string) => Promise<void>>()
        .mockResolvedValue(undefined),
    };
  }

  async function runWith(
    teamsNotify: "always" | "auto" | "never" | undefined,
    stepText: string,
    stepResult?: SendAndCollectResult,
  ) {
    const wf = {
      ...makeAutomation("wf-mode", 1, 9, 0, true),
      teamsNotify,
    };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    const sm = makeMockSessionManager(stepText, stepResult);
    const relay = makeMockRelayPublisher();
    const pp = {
      registerSessionPermissions: vi.fn<(id: string, p: PermissionsConfig) => void>(),
      unregisterSessionPermissions: vi.fn<(id: string) => void>(),
      setDenyPrompt: vi.fn<(id: string) => void>(),
      clearDenyPrompt: vi.fn<(id: string) => void>(),
      markUnattended: vi.fn<(id: string) => void>(),
      clearUnattended: vi.fn<(id: string) => void>(),
    };
    wm.setSessionManager(testDouble<SessionManager>(sm));
    wm.setRelayPublisher(testDouble<RelayNotificationPublisher>(relay));
    wm.setPermissionPolicy(testDouble<PermissionPolicy>(pp));
    const run = await wm.runNow("wf-mode");
    await flushMicrotasks();
    return { sm, relay, pp, run };
  }

  it("missing teamsNotify field grandfathers to always — sends to the relay", async () => {
    const { relay } = await runWith(undefined, "the report");
    expect(relay.publish).toHaveBeenCalledTimes(1);
  });

  it("teamsNotify=always sends to the relay (today's behavior, unchanged)", async () => {
    const { relay } = await runWith("always", "the report");
    expect(relay.publish).toHaveBeenCalledTimes(1);
  });

  // Content-independence: `auto` mode must never dispatch through the
  // framework regardless of finalOutput. The agent's own sendNotification
  // calls during the run go through the tool's path, not this one.
  it.each([
    ["short filler", "."],
    ["multi-paragraph", "Found 3 things:\n\n1. one\n2. two\n3. three"],
    ["whitespace", "   \n  "],
  ])("teamsNotify=auto does not dispatch from framework (%s)", async (_label, stepText) => {
    const { relay } = await runWith("auto", stepText);
    expect(relay.publish).not.toHaveBeenCalled();
  });

  it("teamsNotify=never does not dispatch from framework", async () => {
    const { relay } = await runWith("never", "the report");
    expect(relay.publish).not.toHaveBeenCalled();
  });

  it("teamsNotify=always still skipped in MARSHAL_E2E mode", async () => {
    process.env.MARSHAL_E2E = "1";
    const { relay } = await runWith("always", "the report");
    expect(relay.publish).not.toHaveBeenCalled();
  });

  // Auto mode teaches the agent the per-run notify contract via the step
  // prompt; the other modes have no contract to teach (the framework
  // handles delivery, or doesn't, regardless of what the agent does).
  describe("step prompt addendum", () => {
    async function capturePromptForMode(teamsNotify: "always" | "auto" | "never" | undefined) {
      const { sm } = await runWith(teamsNotify, "ok");
      return sm.sendAndCollect.mock.calls[0]?.[0] ?? "";
    }

    it("includes the sendNotification contract for auto mode", async () => {
      const prompt = await capturePromptForMode("auto");
      expect(prompt).toContain("sendNotification");
      expect(prompt).toContain("never forwards it to the relay");
      // Must instruct the model to still emit a final summary line, otherwise
      // sendAndCollect's fail-closed path treats silent completions as errors.
      expect(prompt).toContain("one-line summary");
    });

    it("does not include the contract for always mode", async () => {
      const prompt = await capturePromptForMode("always");
      expect(prompt).not.toContain("sendNotification");
    });

    it("does not include the contract for never mode", async () => {
      const prompt = await capturePromptForMode("never");
      expect(prompt).not.toContain("sendNotification");
    });

    it("does not include the contract when field is missing (grandfather)", async () => {
      const prompt = await capturePromptForMode(undefined);
      expect(prompt).not.toContain("sendNotification");
    });
  });

  // Auto-mode dispatch path has no per-run permission overlay — sendNotification
  // is auto-approved via DEFAULT_TOOL_APPROVALS in common/marshal-tool-registry.ts. So
  // the only auto-mode-specific assertion left is the framework gate's
  // step-failure interaction: a no-response step is still marked failed and
  // does NOT dispatch through the framework.
  describe("auto mode interaction with step failure", () => {
    it("auto-mode no-response step is still marked failed and does not dispatch", async () => {
      const { run, relay } = await runWith("auto", "", noResponseResult());
      expect(run.status).toBe("failed");
      expect(relay.publish).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Step-level sentinel guard
//
// Regression: when the step's own sendAndCollect resolves with a sentinel
// (the step itself timed out or produced no content), the previous code
// marked the step "completed", persisted the sentinel as finalOutput, and
// forwarded it through sendToRelay. We now mark the step as failed and
// stop the run so the sentinel never propagates.
// ---------------------------------------------------------------------------

describe("AutomationManager step-level sentinel guard", () => {
  let wm: AutomationManager;
  const originalE2E = process.env.MARSHAL_E2E;

  beforeEach(() => {
    wm = new AutomationManager();
    mockedFs.existsSync.mockReturnValue(true);
    delete process.env.MARSHAL_E2E;
  });

  afterEach(() => {
    wm.destroy();
    if (originalE2E !== undefined) process.env.MARSHAL_E2E = originalE2E;
  });

  function makeMockSessionManager(stepResult: SendAndCollectResult) {
    return {
      createSession: vi.fn<() => Promise<{ id: string }>>().mockResolvedValue({ id: "sess-1" }),
      appendMessage: vi.fn<(id: string, msg: Record<string, unknown>) => void>(),
      markUnread: vi.fn<() => void>(),
      sendAndCollect: vi.fn<() => Promise<SendAndCollectResult>>().mockResolvedValue(stepResult),
      getSession: vi.fn<() => Record<string, unknown> | null>().mockReturnValue(null),
      getSessionAsync: vi
        .fn<() => Promise<Record<string, unknown> | null>>()
        .mockResolvedValue(null),
      switchSession: vi
        .fn<() => Promise<{ kind: "hydrating" }>>()
        .mockResolvedValue({ kind: "hydrating" }),
      renameSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
  }

  function makeMockRelayPublisher() {
    return {
      hasDestinations: vi.fn<() => boolean>().mockReturnValue(true),
      publish: vi
        .fn<(kind: string, text: string, sourceSessionId?: string) => Promise<void>>()
        .mockResolvedValue(undefined),
    };
  }

  async function runWithStepResult(stepResult: SendAndCollectResult) {
    const wf = makeAutomation("wf-guard", 1, 9, 0, true);
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    const sm = makeMockSessionManager(stepResult);
    const relay = makeMockRelayPublisher();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    wm.setRelayPublisher(testDouble<RelayNotificationPublisher>(relay));
    const run = await wm.runNow("wf-guard");
    await flushMicrotasks();
    return { run, relay };
  }

  it("marks the run as failed when a step times out", async () => {
    const { run, relay } = await runWithStepResult(timeoutResult());
    expect(run.status).toBe("failed");
    expect(run.stepResults[0].status).toBe("failed");
    expect(run.stepResults[0].error).toMatch(/timed out/i);
    expect(run.finalOutput).toBeUndefined();
    expect(relay.publish).not.toHaveBeenCalled();
  });

  it("marks the run as failed when a step produces no response", async () => {
    const { run, relay } = await runWithStepResult(noResponseResult());
    expect(run.status).toBe("failed");
    expect(run.stepResults[0].status).toBe("failed");
    expect(run.stepResults[0].error).toMatch(/no response/i);
    expect(run.finalOutput).toBeUndefined();
    expect(relay.publish).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Session pinning
// ---------------------------------------------------------------------------

describe("AutomationManager session pinning", () => {
  let wm: AutomationManager;

  beforeEach(() => {
    wm = new AutomationManager();
    wm.setPermissionPolicy(
      testDouble<PermissionPolicy>({
        registerSessionPermissions: vi.fn<(id: string, p: PermissionsConfig) => void>(),
        unregisterSessionPermissions: vi.fn<(id: string) => void>(),
        setDenyPrompt: vi.fn<(id: string) => void>(),
        clearDenyPrompt: vi.fn<(id: string) => void>(),
        markUnattended: vi.fn<(id: string) => void>(),
        clearUnattended: vi.fn<(id: string) => void>(),
      }),
    );
    mockedFs.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    wm.destroy();
  });

  function makeMockSessionManager() {
    return {
      createSession: vi.fn<() => Promise<{ id: string }>>().mockResolvedValue({ id: "sess-new" }),
      appendMessage: vi.fn<(id: string, msg: Record<string, unknown>) => void>(),
      markUnread: vi.fn<() => void>(),
      sendAndCollect: vi
        .fn<
          (
            content: string,
            timeoutMs?: number,
            onEvent?: unknown,
            targetSessionId?: string,
          ) => Promise<SendAndCollectResult>
        >()
        .mockResolvedValue(okResult("step output")),
      getSession: vi.fn<() => Record<string, unknown> | null>().mockReturnValue(null),
      getSessionAsync: vi
        .fn<() => Promise<Record<string, unknown> | null>>()
        .mockResolvedValue(null),
      switchSession: vi
        .fn<() => Promise<SwitchSessionResult>>()
        .mockResolvedValue({ kind: "hydrating" }),
      renameSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      deleteSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      getDefaultModel: vi.fn<() => string>().mockReturnValue("claude-opus-4.7"),
      updateSessionModelQuietly: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
  }

  it("creates and pins a session on first run", async () => {
    const wf = makeAutomation("wf-pin", 1, 9, 0, true);
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    const written = new Map<string, string>();
    mockedFs.writeFileSync.mockImplementation((p, content) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test always passes string
      written.set(String(p), content as string);
    });

    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const run = await wm.runNow("wf-pin");

    expect(sm.createSession).toHaveBeenCalledTimes(1);
    expect(run.sessionId).toBe("sess-new");

    // pinnedSessionId should be persisted
    const wfWrite = [...written.entries()].find(([p]) => p.includes("automations.json"));
    expect(wfWrite).toBeDefined();
    const saved = JSON.parse(wfWrite![1]);
    expect(saved.find((w: { id: string }) => w.id === "wf-pin")?.pinnedSessionId).toBe("sess-new");
  });

  it.each([
    { focus: undefined, expectedActive: true, expectedSwitches: 1 },
    { focus: false, expectedActive: false, expectedSwitches: 0 },
  ])("switches the window to the run session only when focus is $focus", async ({ focus, expectedActive, expectedSwitches }) => {
    const wf = makeAutomation("wf-focus", 1, 9, 0, true);
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});
    const sm = makeMockSessionManager();
    const switchTo = vi.fn<(sessionId: string) => void>();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    wm.setSessionCreatedCallback(switchTo);

    await wm.runNow("wf-focus", focus === undefined ? undefined : { focus });

    expect(sm.createSession).toHaveBeenCalledWith(
      undefined,
      undefined,
      expect.objectContaining({ setActive: expectedActive }),
    );
    expect(switchTo).toHaveBeenCalledTimes(expectedSwitches);
  });

  it("reuses the pinned session on subsequent runs", async () => {
    const wf = { ...makeAutomation("wf-pin2", 1, 9, 0, true), pinnedSessionId: "existing-sess" };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    // Session exists on disk
    sm.getSession.mockReturnValue({ id: "existing-sess", messages: [] });
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const run = await wm.runNow("wf-pin2");

    expect(sm.createSession).not.toHaveBeenCalled();
    expect(sm.switchSession).toHaveBeenCalledWith("existing-sess");
    expect(run.sessionId).toBe("existing-sess");
    // Sync cache hit must short-circuit the `??` — no async store round-trip.
    expect(sm.getSessionAsync).not.toHaveBeenCalled();
  });

  it("resumes an explicit target session instead of creating an automation-owned session", async () => {
    const wf = { ...makeAutomation("wf-target", 1, 9, 0, true), targetSessionId: "target-sess" };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    sm.getSession.mockReturnValue({
      id: "target-sess",
      messages: [{ id: "m1" }],
      model: "user-selected-model",
    });
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const run = await wm.runNow("wf-target");

    expect(sm.createSession).not.toHaveBeenCalled();
    expect(sm.updateSessionModelQuietly).not.toHaveBeenCalled();
    expect(sm.switchSession).toHaveBeenCalledWith("target-sess");
    expect(sm.sendAndCollect.mock.calls[0][3]).toBe("target-sess");
    expect(run.sessionId).toBe("target-sess");
    expect(run.status).toBe("completed");
  });

  it("records a visible failed run when an explicit target session is missing", async () => {
    const wf = {
      ...makeAutomation("wf-missing-target", 1, 9, 0, true),
      targetSessionId: "missing",
    };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    const written = new Map<string, string>();
    mockedFs.writeFileSync.mockImplementation((p, content) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test always passes string
      written.set(String(p), content as string);
    });

    const sm = makeMockSessionManager();
    sm.getSession.mockReturnValue(null);
    sm.getSessionAsync.mockResolvedValue(null);
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const run = await wm.runNow("wf-missing-target");

    expect(sm.createSession).not.toHaveBeenCalled();
    expect(run.status).toBe("failed");
    expect(run.finalOutput).toContain("Target session 'missing'");
    const historyWrite = [...written.entries()].find(([p]) => p.includes("history"));
    expect(historyWrite).toBeDefined();
    const savedRuns = JSON.parse(historyWrite![1]);
    expect(savedRuns[0].status).toBe("failed");
    expect(savedRuns[0].finalOutput).toContain("Target session 'missing'");
  });

  it("passes repository workspace scope when creating an automation-owned session", async () => {
    const wf = {
      ...makeAutomation("wf-repo-scope", 1, 9, 0, true),
      workspaceName: "Repo Workspace",
      repoPath: "C:\\src\\repo-worktree",
    };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    await wm.runNow("wf-repo-scope");

    expect(sm.createSession).toHaveBeenCalledWith(
      undefined,
      undefined,
      expect.objectContaining({
        workspaceName: "Repo Workspace",
        repoPath: "C:\\src\\repo-worktree",
      }),
    );
  });

  it("reuses a pinned session that resolves only via the async store (cold cache after restart)", async () => {
    // Regression: after an app restart the persisted store's in-memory
    // cache is empty, so the sync getSession returns null even though the
    // session exists on disk. Without the async fallback the automation
    // would treat the pin as deleted and spawn a new chat every restart.
    const wf = { ...makeAutomation("wf-cold", 1, 9, 0, true), pinnedSessionId: "cold-sess" };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    sm.getSession.mockReturnValue(null); // cold in-memory cache
    sm.getSessionAsync.mockResolvedValue({ id: "cold-sess", messages: [] }); // exists in the persisted store
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const run = await wm.runNow("wf-cold");

    expect(sm.createSession).not.toHaveBeenCalled();
    expect(sm.switchSession).toHaveBeenCalledWith("cold-sess");
    expect(run.sessionId).toBe("cold-sess");
  });

  it("updates model on reused pinned session when default changed", async () => {
    const wf = { ...makeAutomation("wf-model", 1, 9, 0, true), pinnedSessionId: "stale-sess" };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    sm.getSession.mockReturnValue({
      id: "stale-sess",
      messages: [{ id: "m1" }],
      model: "claude-opus-4.6-1m",
    });
    sm.getDefaultModel.mockReturnValue("claude-opus-4.7");
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const run = await wm.runNow("wf-model");

    // Should reuse (not create fresh) and update the model
    expect(sm.createSession).not.toHaveBeenCalled();
    expect(sm.updateSessionModelQuietly).toHaveBeenCalledWith("stale-sess", "claude-opus-4.7");
    expect(sm.switchSession).toHaveBeenCalledWith("stale-sess");
    expect(run.sessionId).toBe("stale-sess");
  });

  it("uses automation model override when creating pinned session", async () => {
    const wf = {
      ...makeAutomation("wf-model-create", 1, 9, 0, true),
      model: "claude-haiku-4.5",
    };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    await wm.runNow("wf-model-create");

    expect(sm.createSession).toHaveBeenCalledWith(
      "claude-haiku-4.5",
      undefined,
      expect.objectContaining({ name: "Test Automation" }),
    );
  });

  it("syncs reused pinned session to automation model override instead of default", async () => {
    const wf = {
      ...makeAutomation("wf-model-override", 1, 9, 0, true),
      pinnedSessionId: "override-sess",
      model: "claude-haiku-4.5",
    };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    sm.getSession.mockReturnValue({
      id: "override-sess",
      messages: [{ id: "m1" }],
      model: "claude-opus-4.7",
    });
    sm.getDefaultModel.mockReturnValue("gpt-5.5");
    wm.setSessionManager(testDouble<SessionManager>(sm));
    await wm.runNow("wf-model-override");

    expect(sm.updateSessionModelQuietly).toHaveBeenCalledWith("override-sess", "claude-haiku-4.5");
  });

  it("skips model update when pinned session already matches default", async () => {
    const wf = { ...makeAutomation("wf-same", 1, 9, 0, true), pinnedSessionId: "current-sess" };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    sm.getSession.mockReturnValue({
      id: "current-sess",
      messages: [{ id: "m1" }],
      model: "claude-opus-4.7",
    });
    sm.getDefaultModel.mockReturnValue("claude-opus-4.7");
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const run = await wm.runNow("wf-same");

    expect(sm.updateSessionModelQuietly).not.toHaveBeenCalled();
    expect(sm.switchSession).toHaveBeenCalledWith("current-sess");
    expect(run.sessionId).toBe("current-sess");
  });

  it("updates model on legacy pinned session with undefined model", async () => {
    const wf = { ...makeAutomation("wf-legacy", 1, 9, 0, true), pinnedSessionId: "legacy-sess" };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    sm.getSession.mockReturnValue({ id: "legacy-sess", messages: [] });
    sm.getDefaultModel.mockReturnValue("claude-opus-4.7");
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const run = await wm.runNow("wf-legacy");

    // undefined !== "claude-opus-4.7" → should update
    expect(sm.updateSessionModelQuietly).toHaveBeenCalledWith("legacy-sess", "claude-opus-4.7");
    expect(sm.switchSession).toHaveBeenCalledWith("legacy-sess");
    expect(run.sessionId).toBe("legacy-sess");
  });

  it("proceeds with automation when updateSessionModelQuietly throws", async () => {
    const wf = { ...makeAutomation("wf-throw", 1, 9, 0, true), pinnedSessionId: "throw-sess" };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    sm.getSession.mockReturnValue({
      id: "throw-sess",
      messages: [{ id: "m1" }],
      model: "old-model",
    });
    sm.getDefaultModel.mockReturnValue("new-model");
    sm.updateSessionModelQuietly.mockRejectedValue(new Error("backend unavailable"));
    wm.setSessionManager(testDouble<SessionManager>(sm));

    const run = await wm.runNow("wf-throw");

    expect(sm.updateSessionModelQuietly).toHaveBeenCalled();
    expect(run.status).toBe("completed");
  });

  it("creates a new pinned session when the old one was deleted", async () => {
    const wf = { ...makeAutomation("wf-pin3", 1, 9, 0, true), pinnedSessionId: "deleted-sess" };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    const written = new Map<string, string>();
    mockedFs.writeFileSync.mockImplementation((p, content) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test always passes string
      written.set(String(p), content as string);
    });

    const sm = makeMockSessionManager();
    sm.getSession.mockReturnValue(null); // not in cold cache
    sm.getSessionAsync.mockResolvedValue(null); // and not in the persisted store either — genuinely gone
    sm.createSession.mockResolvedValue({ id: "sess-recovered" });
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const run = await wm.runNow("wf-pin3");

    // Must consult the async store path before deciding it's deleted —
    // otherwise we'd recreate a session that merely wasn't cached yet.
    expect(sm.getSessionAsync).toHaveBeenCalledWith("deleted-sess");
    expect(sm.createSession).toHaveBeenCalledTimes(1);
    expect(run.sessionId).toBe("sess-recovered");

    // New pinnedSessionId should be persisted
    const wfWrite = [...written.entries()].find(([p]) => p.includes("automations.json"));
    expect(wfWrite).toBeDefined();
    const saved = JSON.parse(wfWrite![1]);
    expect(saved.find((w: { id: string }) => w.id === "wf-pin3")?.pinnedSessionId).toBe(
      "sess-recovered",
    );
  });

  it("creates a new pinned session when switchSession returns notFound (cross-window delete race)", async () => {
    const wf = { ...makeAutomation("wf-race", 1, 9, 0, true), pinnedSessionId: "racey-sess" };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    const written = new Map<string, string>();
    mockedFs.writeFileSync.mockImplementation((p, content) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test always passes string
      written.set(String(p), content as string);
    });

    const sm = makeMockSessionManager();
    // getSession returns the row (so we take the reuse branch), but the index
    // row vanishes before switchSession runs — returning notFound.
    sm.getSession.mockReturnValue({ id: "racey-sess", messages: [] });
    sm.switchSession.mockResolvedValue({ kind: "notFound" });
    sm.createSession.mockResolvedValue({ id: "sess-fresh" });
    wm.setSessionManager(testDouble<SessionManager>(sm));

    const run = await wm.runNow("wf-race");

    expect(sm.switchSession).toHaveBeenCalledWith("racey-sess");
    expect(sm.createSession).toHaveBeenCalledTimes(1);
    expect(run.sessionId).toBe("sess-fresh");

    const wfWrite = [...written.entries()].find(([p]) => p.includes("automations.json"));
    const saved = JSON.parse(wfWrite![1]);
    expect(saved.find((w: { id: string }) => w.id === "wf-race")?.pinnedSessionId).toBe(
      "sess-fresh",
    );
  });

  it("inserts a run-start divider when reusing a pinned session", async () => {
    const wf = { ...makeAutomation("wf-div", 1, 9, 0, true), pinnedSessionId: "pinned-sess" };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    sm.getSession.mockReturnValue({ id: "pinned-sess", messages: [] });
    wm.setSessionManager(testDouble<SessionManager>(sm));
    await wm.runNow("wf-div");

    // First appendMessage call should be the run-start divider
    const calls = sm.appendMessage.mock.calls;
    const dividerCall = calls.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any[]) => c[1].role === "system" && c[1].content.includes("Run started"),
    );
    expect(dividerCall).toBeDefined();
    expect(dividerCall![0]).toBe("pinned-sess");
  });

  it("manual runs switch to the pinned session", async () => {
    const wf = { ...makeAutomation("wf-manual", 1, 9, 0, true), pinnedSessionId: "pinned-sess" };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    sm.getSession.mockReturnValue({ id: "pinned-sess", messages: [] });
    wm.setSessionManager(testDouble<SessionManager>(sm));
    await wm.runNow("wf-manual");

    expect(sm.switchSession).toHaveBeenCalledWith("pinned-sess");
  });

  it("session name uses just the automation name", async () => {
    const wf = makeAutomation("wf-name", 1, 9, 0, true);
    wf.name = "Daily Report";
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    await wm.runNow("wf-name");

    expect(sm.createSession).toHaveBeenCalledWith(undefined, undefined, {
      name: "Daily Report",
      source: "automation",
      automationId: "wf-name",
      setActive: true,
      playwrightHeadless: false,
    });
  });

  it("creates a fresh session when pinned session exceeds message limit", async () => {
    const wf = { ...makeAutomation("wf-big", 1, 9, 0, true), pinnedSessionId: "old-sess" };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    const written = new Map<string, string>();
    mockedFs.writeFileSync.mockImplementation((p, content) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test always passes string
      written.set(String(p), content as string);
    });

    const sm = makeMockSessionManager();
    // Session exists but has 200+ messages (exceeds limit)
    sm.getSession.mockReturnValue({ id: "old-sess", messages: new Array(200).fill({}) });
    sm.createSession.mockResolvedValue({ id: "sess-fresh" });
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const run = await wm.runNow("wf-big");

    expect(sm.createSession).toHaveBeenCalledTimes(1);
    expect(run.sessionId).toBe("sess-fresh");

    // New pinnedSessionId should be persisted
    const wfWrite = [...written.entries()].find(([p]) => p.includes("automations.json"));
    expect(wfWrite).toBeDefined();
    const saved = JSON.parse(wfWrite![1]);
    expect(saved.find((w: { id: string }) => w.id === "wf-big")?.pinnedSessionId).toBe(
      "sess-fresh",
    );
  });

  // Regression guard: an earlier design suppressed the flag on manual runs via
  // `!isManual && (automation.browserHeadless ?? false)`. That carve-out was
  // dropped — browserHeadless must apply universally. If anyone reintroduces
  // the !isManual guard, this test fails because runNow sets isManual=true.
  it("executeAutomation does NOT suppress playwrightHeadless on manual Run-now (carve-out removed)", async () => {
    const wf = {
      ...makeAutomation("wf-manual-min", 1, 9, 0, true),
      browserHeadless: true,
    };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    await wm.runNow("wf-manual-min");

    expect(sm.createSession).toHaveBeenCalledWith(undefined, undefined, {
      name: "Test Automation",
      source: "automation",
      automationId: "wf-manual-min",
      setActive: true,
      playwrightHeadless: true,
    });
  });

  it("executeAutomation passes playwrightHeadless=true on schedule run when automation has it set", async () => {
    const wf = {
      ...makeAutomation("wf-sched-min", 1, 9, 0, true),
      browserHeadless: true,
    };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));

    // Invoke executeAutomation directly to simulate a non-manual (schedule) run.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- expose private method for testing
    const wmPriv = wm as unknown as {
      executeAutomation: (a: typeof wf, isManual: boolean) => Promise<unknown>;
    };
    await wmPriv.executeAutomation(wf, false);

    expect(sm.createSession).toHaveBeenCalledWith(undefined, undefined, {
      name: "Test Automation",
      source: "automation",
      automationId: "wf-sched-min",
      setActive: false,
      playwrightHeadless: true,
    });
  });

  it("rotates pinned session when effective flag changes (false stored → true effective)", async () => {
    const wf = {
      ...makeAutomation("wf-rotate", 1, 9, 0, true),
      pinnedSessionId: "old-sess",
      browserHeadless: true,
    };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    const written = new Map<string, string>();
    mockedFs.writeFileSync.mockImplementation((p, content) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test always passes string
      written.set(String(p), content as string);
    });

    const sm = makeMockSessionManager();
    // Stored session was created with the flag *off*; effective is *on* → rotate.
    sm.getSession.mockReturnValue({
      id: "old-sess",
      messages: [],
      playwrightHeadless: false,
    });
    sm.createSession.mockResolvedValue({ id: "sess-rotated" });
    wm.setSessionManager(testDouble<SessionManager>(sm));

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- expose private method for testing
    const wmPriv = wm as unknown as {
      executeAutomation: (a: typeof wf, isManual: boolean) => Promise<{ sessionId?: string }>;
    };
    const run = await wmPriv.executeAutomation(wf, false);

    // A *new* session was created with the requested flag.
    expect(sm.createSession).toHaveBeenCalledWith(undefined, undefined, {
      name: "Test Automation",
      source: "automation",
      automationId: "wf-rotate",
      setActive: false,
      playwrightHeadless: true,
    });
    // Rotation path doesn't switch to any session — fresh-create handles activation.
    expect(sm.switchSession).not.toHaveBeenCalled();
    expect(run.sessionId).toBe("sess-rotated");

    // pinnedSessionId on disk is updated to the new session id.
    const wfWrite = [...written.entries()].find(([p]) => p.includes("automations.json"));
    expect(wfWrite).toBeDefined();
    const saved = JSON.parse(wfWrite![1]);
    expect(saved.find((w: { id: string }) => w.id === "wf-rotate")?.pinnedSessionId).toBe(
      "sess-rotated",
    );
  });

  it("rotates pinned session when effective flag changes (true stored → false effective)", async () => {
    // Symmetric to the previous test: a previously-headless pinned session
    // can't be reused when the user toggles the flag off, because the
    // running Playwright MCP child has --headless baked into its launch args.
    const wf = {
      ...makeAutomation("wf-rotate-down", 1, 9, 0, true),
      pinnedSessionId: "headless-sess",
      browserHeadless: false,
    };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    sm.getSession.mockReturnValue({
      id: "headless-sess",
      messages: [],
      playwrightHeadless: true,
    });
    sm.createSession.mockResolvedValue({ id: "sess-rotated-down" });
    wm.setSessionManager(testDouble<SessionManager>(sm));

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- expose private method for testing
    const wmPriv = wm as unknown as {
      executeAutomation: (a: typeof wf, isManual: boolean) => Promise<{ sessionId?: string }>;
    };
    const run = await wmPriv.executeAutomation(wf, false);

    expect(sm.createSession).toHaveBeenCalledWith(undefined, undefined, {
      name: "Test Automation",
      source: "automation",
      automationId: "wf-rotate-down",
      setActive: false,
      playwrightHeadless: false,
    });
    expect(sm.switchSession).not.toHaveBeenCalled();
    expect(run.sessionId).toBe("sess-rotated-down");
  });

  it("reuses pinned session when effective flag matches stored value", async () => {
    const wf = {
      ...makeAutomation("wf-reuse-min", 1, 9, 0, true),
      pinnedSessionId: "match-sess",
      browserHeadless: true,
    };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    sm.getSession.mockReturnValue({
      id: "match-sess",
      messages: [],
      playwrightHeadless: true,
    });
    wm.setSessionManager(testDouble<SessionManager>(sm));

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- expose private method for testing
    const wmPriv = wm as unknown as {
      executeAutomation: (a: typeof wf, isManual: boolean) => Promise<{ sessionId?: string }>;
    };
    const run = await wmPriv.executeAutomation(wf, false);

    expect(sm.createSession).not.toHaveBeenCalled();
    expect(sm.switchSession).toHaveBeenCalledWith("match-sess");
    expect(run.sessionId).toBe("match-sess");
  });

  it("renames the pinned session when automation is renamed", async () => {
    const wf = { ...makeAutomation("wf-ren", 1, 9, 0, true), pinnedSessionId: "pin-sess" };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});
    mockedFs.existsSync.mockReturnValue(true);

    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    wm.update("wf-ren", { name: "New Name" });

    expect(sm.renameSession).toHaveBeenCalledWith("pin-sess", "New Name");
  });

  it("does not rename pinned session when name is unchanged", async () => {
    const wf = {
      ...makeAutomation("wf-ren2", 1, 9, 0, true),
      name: "Same Name",
      pinnedSessionId: "pin-sess",
    };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});
    mockedFs.existsSync.mockReturnValue(true);

    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    wm.update("wf-ren2", { name: "Same Name" });

    expect(sm.renameSession).not.toHaveBeenCalled();
  });

  it("strips pinnedSessionId from exports", () => {
    const wf = { ...makeAutomation("wf-exp", 1, 9, 0, true), pinnedSessionId: "local-only" };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.existsSync.mockReturnValue(true);

    const exported = wm.exportAutomation("wf-exp");
    expect(exported).toBeTruthy();
    const parsed = JSON.parse(exported!);
    expect(parsed.pinnedSessionId).toBeUndefined();
    expect(parsed.id).toBe("wf-exp");
  });

  it("cleans up pinned session on automation delete", async () => {
    const wf = { ...makeAutomation("wf-del", 1, 9, 0, true), pinnedSessionId: "orphan-sess" };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      if (String(p).includes("wf-del")) return "[]";
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});
    mockedFs.existsSync.mockReturnValue(true);

    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    wm.delete("wf-del");

    expect(sm.deleteSession).toHaveBeenCalledWith("orphan-sess", { cause: "automation" });
  });
});

// ---------------------------------------------------------------------------
// Schedule queue (multiple automations at same time)
// ---------------------------------------------------------------------------

describe("AutomationManager schedule queue", () => {
  let wm: AutomationManager;

  function makeMockSessionManager() {
    return {
      createSession: vi.fn<() => Promise<{ id: string }>>().mockResolvedValue({ id: "sess-1" }),
      appendMessage: vi.fn<(id: string, msg: Record<string, unknown>) => void>(),
      markUnread: vi.fn<() => void>(),
      sendAndCollect: vi
        .fn<() => Promise<SendAndCollectResult>>()
        .mockResolvedValue(okResult("done")),
      getSession: vi.fn<() => Record<string, unknown> | null>().mockReturnValue(null),
      getSessionAsync: vi
        .fn<() => Promise<Record<string, unknown> | null>>()
        .mockResolvedValue(null),
      switchSession: vi
        .fn<() => Promise<{ kind: "hydrating" }>>()
        .mockResolvedValue({ kind: "hydrating" }),
      renameSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      deleteSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    wm = new AutomationManager();
    wm.setPermissionPolicy(
      testDouble<PermissionPolicy>({
        setDenyPrompt: vi.fn<(id: string) => void>(),
        clearDenyPrompt: vi.fn<(id: string) => void>(),
        markUnattended: vi.fn<(id: string) => void>(),
        clearUnattended: vi.fn<(id: string) => void>(),
      }),
    );
    mockedFs.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    wm.destroy();
    vi.useRealTimers();
  });

  it("attests only the actual dispatched native step, never a queued or subsequent user turn", async () => {
    const automation = makeAutomation("wf-native", 3, 9, 0, true);
    mockedFs.readFileSync.mockImplementation((p) =>
      String(p).includes("automations.json") ? JSON.stringify([automation]) : "[]",
    );
    mockedFs.writeFileSync.mockImplementation(() => {});
    let nativeMessage: string | undefined;
    const sendAndCollect = vi
      .fn<SessionManager["sendAndCollect"]>()
      .mockImplementation(async (_prompt, _timeout, _event, sessionId, _attachments, options) => {
        expect(wm.getActiveExecution(sessionId!)).toBeUndefined();
        nativeMessage = options?.clientMessageId;
        await options?.onBackendDispatchStarting?.();
        expect(wm.getActiveExecution(sessionId!)).toMatchObject({
          automationId: "wf-native",
          clientMessageId: nativeMessage,
        });
        nativeMessage = "ordinary-user-message";
        expect(wm.getActiveExecution(sessionId!)).toBeUndefined();
        return okResult("done");
      });
    const sm = {
      ...makeMockSessionManager(),
      sendAndCollect,
      isActiveTurnMessage: (_id: string, messageId: string) => nativeMessage === messageId,
    };
    wm.setSessionManager(testDouble<SessionManager>(sm));
    await wm.runNow("wf-native");
    expect(sendAndCollect).toHaveBeenCalledOnce();
    expect(wm.getActiveExecution("sess-1")).toBeUndefined();
  });

  it("restores armed job markers as disabled and suspended, without dispatching a model turn", async () => {
    let persisted = JSON.stringify([
      {
        ...makeAutomation("wf-job", 3, 9, 0, true),
        applicationJob: { ownerKey: "owner", jobKey: "pr", jobId: "job", state: "armed" },
      },
    ]);
    mockedFs.readFileSync.mockImplementation((p) =>
      String(p).includes("automations.json") ? persisted : "[]",
    );
    mockedFs.writeFileSync.mockImplementation((p, value) => {
      if (String(p).includes("automations.json")) {
        if (typeof value !== "string") throw new Error("Expected serialized automation JSON.");
        persisted = value;
      }
    });
    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    wm.restore();
    expect(wm.list()[0]).toMatchObject({
      enabled: false,
      applicationJob: { state: "suspended-restart" },
    });
    expect(sm.sendAndCollect).not.toHaveBeenCalled();
  });

  it("runs all co-scheduled automations sequentially", async () => {
    // Three automations all scheduled at 9:00 on Wednesday (day 3)
    // Feb 18, 2026 is a Wednesday
    const wf1 = { ...makeAutomation("wf1", 3, 9, 0, true), name: "WF1" };
    const wf2 = { ...makeAutomation("wf2", 3, 9, 0, true), name: "WF2" };
    const wf3 = { ...makeAutomation("wf3", 3, 9, 0, true), name: "WF3" };

    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf1, wf2, wf3]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));

    // Start at 8:59 Wed — first timer tick (60s later) lands at exactly 9:00
    vi.setSystemTime(new Date(2026, 1, 18, 8, 59, 0));
    wm.restore();

    // Advance 60s → checkSchedules fires at 9:00:00 (first check, null path, exact minute match)
    await vi.advanceTimersByTimeAsync(60_000);
    // Stop scheduler to prevent infinite-timer loop, then flush promise chain
    wm.stop();
    await flushMicrotasks();

    // All 3 automations should have created sessions
    expect(sm.createSession).toHaveBeenCalledTimes(3);
  });

  it("does not double-queue an automation already pending", async () => {
    const wf1 = { ...makeAutomation("wf1", 3, 9, 0, true), name: "WF1" };

    // Make executeAutomation hang so wf1 stays running while second tick fires
    let resolveExecution!: () => void;
    const executionPromise = new Promise<void>((r) => {
      resolveExecution = r;
    });

    const sm = makeMockSessionManager();
    sm.sendAndCollect.mockImplementation(() => executionPromise.then(() => okResult("done")));
    wm.setSessionManager(testDouble<SessionManager>(sm));

    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf1]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    // Start at 8:59 — first tick at 9:00:00 triggers wf1
    vi.setSystemTime(new Date(2026, 1, 18, 8, 59, 0));
    wm.restore();

    // First tick at 9:00 — triggers wf1
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks(5);

    // wf1 is now running (execution hanging). Second tick — lastCheck is now 9:00, scheduled is 9:00
    // scheduled > lastCheck is false, so wf1 is NOT re-triggered
    await vi.advanceTimersByTimeAsync(60_000);
    wm.stop(); // stop scheduler
    await flushMicrotasks(5);

    // Resolve the execution
    resolveExecution();
    await flushMicrotasks();

    // Should only have run once, not twice
    expect(sm.createSession).toHaveBeenCalledTimes(1);
  });

  it("drains queued automations after a manual runNow completes", async () => {
    // Manual automation scheduled at 14:00 (won't trigger at 9:00)
    const wfManual = { ...makeAutomation("wf-manual", 3, 14, 0, true), name: "Manual" };
    const wfScheduled = { ...makeAutomation("wf-sched", 3, 9, 0, true), name: "Scheduled" };

    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wfManual, wfScheduled]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    // Make manual run hang until we resolve it
    let resolveManual!: () => void;
    const manualPromise = new Promise<void>((r) => {
      resolveManual = r;
    });
    const sm = makeMockSessionManager();
    let callCount = 0;
    sm.sendAndCollect.mockImplementation(() => {
      callCount++;
      // First call (manual run) hangs; subsequent calls resolve immediately
      if (callCount === 1) return manualPromise.then(() => okResult("manual done"));
      return Promise.resolve(okResult("done"));
    });
    wm.setSessionManager(testDouble<SessionManager>(sm));

    // Start at 8:59 — first tick lands at 9:00:00
    vi.setSystemTime(new Date(2026, 1, 18, 8, 59, 0));
    wm.restore();

    // User clicks "Run Now" on the manual automation
    const runNowPromise = wm.runNow("wf-manual");
    await flushMicrotasks(5);

    // Timer tick fires at 9:00 while manual run is in progress — queues wf-sched
    await vi.advanceTimersByTimeAsync(60_000);
    wm.stop();
    await flushMicrotasks(5);

    // Only 1 session so far (the manual run)
    expect(sm.createSession).toHaveBeenCalledTimes(1);

    // Manual run finishes → executeAutomation's finally calls drainQueue → scheduled runs
    resolveManual();
    await runNowPromise;
    await flushMicrotasks();

    // Both automations should have run
    expect(sm.createSession).toHaveBeenCalledTimes(2);
  });

  it("destroy clears pending queue", () => {
    // Start and immediately destroy — no crash, no stale timers
    wm.start();
    wm.destroy();
    // Calling destroy again should be safe.
    expect(() => wm.destroy()).not.toThrow();
  });

  it("sets denyPrompt for scheduled runs and clears after completion", async () => {
    const wf = { ...makeAutomation("wf1", 3, 9, 0, true), name: "Scheduled" };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const pp = {
      registerSessionPermissions: vi.fn<(id: string, p: PermissionsConfig) => void>(),
      unregisterSessionPermissions: vi.fn<(id: string) => void>(),
      setDenyPrompt: vi.fn<(id: string) => void>(),
      clearDenyPrompt: vi.fn<(id: string) => void>(),
      markUnattended: vi.fn<(id: string) => void>(),
      clearUnattended: vi.fn<(id: string) => void>(),
    };
    wm.setPermissionPolicy(testDouble<PermissionPolicy>(pp));

    vi.setSystemTime(new Date(2026, 1, 18, 8, 59, 0));
    wm.restore();

    await vi.advanceTimersByTimeAsync(60_000);
    wm.stop();
    await flushMicrotasks();

    expect(pp.setDenyPrompt).toHaveBeenCalledWith("sess-1");
    expect(pp.clearDenyPrompt).toHaveBeenCalledWith("sess-1");
    expect(pp.markUnattended).toHaveBeenCalledWith("sess-1");
    expect(pp.clearUnattended).toHaveBeenCalledWith("sess-1");
  });

  it("clears denyPrompt even when a scheduled step fails", async () => {
    const wf = { ...makeAutomation("wf1", 3, 9, 0, true), name: "FailingScheduled" };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    sm.sendAndCollect.mockRejectedValue(new Error("step exploded"));
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const pp = {
      registerSessionPermissions: vi.fn<(id: string, p: PermissionsConfig) => void>(),
      unregisterSessionPermissions: vi.fn<(id: string) => void>(),
      setDenyPrompt: vi.fn<(id: string) => void>(),
      clearDenyPrompt: vi.fn<(id: string) => void>(),
      markUnattended: vi.fn<(id: string) => void>(),
      clearUnattended: vi.fn<(id: string) => void>(),
    };
    wm.setPermissionPolicy(testDouble<PermissionPolicy>(pp));

    vi.setSystemTime(new Date(2026, 1, 18, 8, 59, 0));
    wm.restore();

    await vi.advanceTimersByTimeAsync(60_000);
    wm.stop();
    await flushMicrotasks();

    expect(pp.setDenyPrompt).toHaveBeenCalledWith("sess-1");
    expect(pp.clearDenyPrompt).toHaveBeenCalledWith("sess-1");
    expect(pp.markUnattended).toHaveBeenCalledWith("sess-1");
    expect(pp.clearUnattended).toHaveBeenCalledWith("sess-1");
  });
});

// ---------------------------------------------------------------------------
// End-to-end lifecycle: interval and multi schedules through the poll loop
// ---------------------------------------------------------------------------
describe("AutomationManager lifecycle (interval/multi)", () => {
  let wm: AutomationManager;

  function makeMockSessionManager() {
    return {
      createSession: vi.fn<() => Promise<{ id: string }>>().mockResolvedValue({ id: "sess-1" }),
      appendMessage: vi.fn<(id: string, msg: Record<string, unknown>) => void>(),
      markUnread: vi.fn<() => void>(),
      sendAndCollect: vi
        .fn<() => Promise<SendAndCollectResult>>()
        .mockResolvedValue(okResult("done")),
      getSession: vi.fn<() => Record<string, unknown> | null>().mockReturnValue(null),
      getSessionAsync: vi
        .fn<() => Promise<Record<string, unknown> | null>>()
        .mockResolvedValue(null),
      switchSession: vi
        .fn<() => Promise<{ kind: "hydrating" }>>()
        .mockResolvedValue({ kind: "hydrating" }),
      renameSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      deleteSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    wm = new AutomationManager();
    wm.setPermissionPolicy(
      testDouble<PermissionPolicy>({
        setDenyPrompt: vi.fn<(id: string) => void>(),
        clearDenyPrompt: vi.fn<(id: string) => void>(),
        markUnattended: vi.fn<(id: string) => void>(),
        clearUnattended: vi.fn<(id: string) => void>(),
      }),
    );
    mockedFs.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    wm.destroy();
    vi.useRealTimers();
  });

  it("interval schedule triggers on each slot through the poll loop", async () => {
    const intervalAutomation = {
      ...makeAutomation("wf-interval", 3, 0, 0, true),
      name: "Hourly Check",
      schedule: {
        kind: "interval" as const,
        naturalLanguage: "every hour",
        days: [0, 1, 2, 3, 4, 5, 6],
        intervalMinutes: 60,
        anchor: { hour: 0, minute: 0 },
        hour: 0,
        minute: 0,
      },
    };

    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([intervalAutomation]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));

    // Start at 08:59 Wed — first tick at 09:00
    vi.setSystemTime(new Date(2026, 1, 18, 8, 59, 0));
    wm.restore();

    // Tick 1 at 09:00 — first slot triggers
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(sm.createSession).toHaveBeenCalledTimes(1);

    // Tick 2 at 10:00 — second slot triggers
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await flushMicrotasks();
    expect(sm.createSession).toHaveBeenCalledTimes(2);

    wm.stop();
  });

  it("multi-time schedule triggers once per matching time through the poll loop", async () => {
    const multiAutomation = {
      ...makeAutomation("wf-multi", 3, 9, 0, true),
      name: "Morning Checks",
      schedule: {
        kind: "multi" as const,
        naturalLanguage: "every day at 9am and 10am",
        days: [0, 1, 2, 3, 4, 5, 6],
        times: [
          { hour: 9, minute: 0 },
          { hour: 10, minute: 0 },
        ],
        hour: 9,
        minute: 0,
      },
    };

    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([multiAutomation]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));

    // Start at 08:59 Wed — first tick at 09:00
    vi.setSystemTime(new Date(2026, 1, 18, 8, 59, 0));
    wm.restore();

    // Tick at 09:00 — 9am slot triggers
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(sm.createSession).toHaveBeenCalledTimes(1);

    // Advance to 10:00 — 10am slot triggers
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await flushMicrotasks();
    expect(sm.createSession).toHaveBeenCalledTimes(2);

    wm.stop();
  });
});

// ---------------------------------------------------------------------------
// Storage migration (marshal-workflows → marshal-automations)
// ---------------------------------------------------------------------------

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

describe("AutomationManager per-automation permissions", () => {
  let wm: AutomationManager;

  beforeEach(() => {
    wm = new AutomationManager();
    mockedFs.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    wm.destroy();
  });

  function makeMockSessionManager() {
    return {
      createSession: vi.fn<() => Promise<{ id: string }>>().mockResolvedValue({ id: "sess-1" }),
      appendMessage: vi.fn<(id: string, msg: Record<string, unknown>) => void>(),
      markUnread: vi.fn<() => void>(),
      sendAndCollect: vi
        .fn<() => Promise<SendAndCollectResult>>()
        .mockResolvedValue(okResult("step output")),
      getSession: vi.fn<() => Record<string, unknown> | null>().mockReturnValue(null),
      getSessionAsync: vi
        .fn<() => Promise<Record<string, unknown> | null>>()
        .mockResolvedValue(null),
      switchSession: vi
        .fn<() => Promise<{ kind: "hydrating" }>>()
        .mockResolvedValue({ kind: "hydrating" }),
      renameSession: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      getDefaultModel: vi.fn<() => string>().mockReturnValue("default-model"),
      updateSessionModelQuietly: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
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

  const testPerms: PermissionsConfig = {
    autoApproveReadOnly: true,
    tools: { "tool:listEmails": true },
    servers: {},
    allow: [],
  };

  it("registers permissions on execute when automation has custom permissions", async () => {
    const wf = { ...makeAutomation("wf1", 1, 9, 0, true), permissions: testPerms };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const pp = makeMockPermissionPolicy();
    wm.setPermissionPolicy(testDouble<PermissionPolicy>(pp));

    await wm.runNow("wf1");

    expect(pp.registerSessionPermissions).toHaveBeenCalledWith(
      "sess-1",
      testPerms,
      expect.any(Function),
    );
    expect(pp.unregisterSessionPermissions).toHaveBeenCalledWith("sess-1");
  });

  it("does not register permissions when automation has no custom permissions", async () => {
    const wf = makeAutomation("wf1", 1, 9, 0, true);
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const pp = makeMockPermissionPolicy();
    wm.setPermissionPolicy(testDouble<PermissionPolicy>(pp));

    await wm.runNow("wf1");

    expect(pp.registerSessionPermissions).not.toHaveBeenCalled();
    expect(pp.unregisterSessionPermissions).not.toHaveBeenCalled();
  });

  it("unregisters permissions even when a step fails", async () => {
    const wf = { ...makeAutomation("wf1", 1, 9, 0, true), permissions: testPerms };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    sm.sendAndCollect.mockRejectedValue(new Error("step failed"));
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const pp = makeMockPermissionPolicy();
    wm.setPermissionPolicy(testDouble<PermissionPolicy>(pp));

    await wm.runNow("wf1");

    expect(pp.registerSessionPermissions).toHaveBeenCalledWith(
      "sess-1",
      testPerms,
      expect.any(Function),
    );
    expect(pp.unregisterSessionPermissions).toHaveBeenCalledWith("sess-1");
  });

  it("re-registers permissions on session reuse (second run)", async () => {
    const wf = {
      ...makeAutomation("wf1", 1, 9, 0, true),
      permissions: testPerms,
      pinnedSessionId: "pinned-1",
    };
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    sm.getSession.mockReturnValue({ messages: [] });
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const pp = makeMockPermissionPolicy();
    wm.setPermissionPolicy(testDouble<PermissionPolicy>(pp));

    // First run
    await wm.runNow("wf1");
    expect(pp.registerSessionPermissions).toHaveBeenCalledTimes(1);
    expect(pp.unregisterSessionPermissions).toHaveBeenCalledTimes(1);

    // Second run — same pinned session, permissions re-registered fresh
    await wm.runNow("wf1");
    expect(pp.registerSessionPermissions).toHaveBeenCalledTimes(2);
    expect(pp.unregisterSessionPermissions).toHaveBeenCalledTimes(2);
  });

  it("does not set denyPrompt for manual runs (runNow)", async () => {
    const wf = makeAutomation("wf1", 1, 9, 0, true);
    mockedFs.readFileSync.mockImplementation((p) => {
      if (String(p).includes("automations.json")) return JSON.stringify([wf]);
      return "[]";
    });
    mockedFs.writeFileSync.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    wm.setSessionManager(testDouble<SessionManager>(sm));
    const pp = makeMockPermissionPolicy();
    wm.setPermissionPolicy(testDouble<PermissionPolicy>(pp));

    await wm.runNow("wf1");

    expect(pp.setDenyPrompt).not.toHaveBeenCalled();
    expect(pp.clearDenyPrompt).not.toHaveBeenCalled();
    expect(pp.markUnattended).not.toHaveBeenCalled();
    expect(pp.clearUnattended).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AutomationManager — condition check permissions
// ---------------------------------------------------------------------------
