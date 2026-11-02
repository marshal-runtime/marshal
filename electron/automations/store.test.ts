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

import { AutomationManager } from "./manager";

describe("storage migration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renames marshal-workflows/ to marshal-automations/ and workflows.json to automations.json", () => {
    // After the directory rename, the code checks for workflows.json inside the
    // *new* marshal-automations/ directory (since the dir was just renamed).
    mockedFs.existsSync.mockImplementation((p) => {
      const s = String(p);
      // First guard: new dir doesn't exist yet → proceed with migration
      if (s.endsWith("marshal-automations")) return false;
      // Second guard: old dir exists → proceed with migration
      if (s.endsWith("marshal-workflows")) return true;
      // After dir rename, code checks for workflows.json inside marshal-automations/
      if (s.includes("marshal-automations") && s.includes("workflows.json")) return true;
      // automations.json not found triggers retry in loadAutomations
      if (s.includes("automations.json")) return false;
      return false;
    });
    mockedFs.renameSync.mockImplementation(() => undefined);
    mockedFs.readFileSync.mockReturnValue("[]");
    mockedFs.mkdirSync.mockImplementation(() => undefined);

    const wm = new AutomationManager();

    // Directory rename: marshal-workflows → marshal-automations
    expect(mockedFs.renameSync).toHaveBeenCalledWith(
      expect.stringContaining("marshal-workflows"),
      expect.stringContaining("marshal-automations"),
    );
    // File rename: workflows.json → automations.json
    expect(mockedFs.renameSync).toHaveBeenCalledWith(
      expect.stringContaining("workflows.json"),
      expect.stringContaining("automations.json"),
    );

    wm.destroy();
  });

  it("skips migration when marshal-automations/ already exists", () => {
    mockedFs.existsSync.mockImplementation((p) => {
      const s = String(p);
      if (s.includes("marshal-automations")) return true; // new dir already exists
      if (s.includes("marshal-workflows")) return true; // old dir also exists
      return false;
    });
    mockedFs.readFileSync.mockReturnValue("[]");

    const wm = new AutomationManager();

    // renameSync should NOT have been called — migration was skipped
    expect(mockedFs.renameSync).not.toHaveBeenCalled();

    wm.destroy();
  });

  it("does not throw when fs.renameSync fails, and loadAutomations retries migration", () => {
    let renameCalls = 0;
    mockedFs.existsSync.mockImplementation((p) => {
      const s = String(p);
      // Before retry: automations dir doesn't exist, old dir exists
      if (s.includes("marshal-automations") && s.includes("automations.json")) return false;
      if (s.includes("marshal-automations")) return false;
      if (s.includes("marshal-workflows")) return true;
      return false;
    });
    mockedFs.renameSync.mockImplementation(() => {
      renameCalls++;
      if (renameCalls <= 1) throw new Error("EPERM: operation not permitted");
      // Subsequent calls succeed
      return undefined;
    });
    mockedFs.readFileSync.mockReturnValue("[]");
    mockedFs.mkdirSync.mockImplementation(() => undefined);

    // Constructor should not throw even though renameSync fails
    let wm: AutomationManager | undefined;
    expect(() => {
      wm = new AutomationManager();
    }).not.toThrow();

    // loadAutomations triggers retry because automations file doesn't exist
    wm!.list();

    // renameSync was called at least twice (initial + retry)
    expect(renameCalls).toBeGreaterThanOrEqual(2);

    wm!.destroy();
  });

  it("migrates old workflowId/workflowName fields in history to automationId/automationName", () => {
    const oldHistoryRuns = [
      {
        id: "run-old",
        workflowId: "wf-legacy",
        workflowName: "Legacy Workflow",
        startedAt: "2025-06-01T09:00:00Z",
        status: "completed",
        stepResults: [{ stepId: "s1", status: "completed", output: "done" }],
      },
    ];

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p) => {
      const s = String(p);
      if (s.includes("automations.json"))
        return JSON.stringify([makeAutomation("wf-legacy", 1, 9, 0, true)]);
      if (s.includes("history")) return JSON.stringify(oldHistoryRuns);
      return "[]";
    });

    const wm = new AutomationManager();
    const history = wm.getHistory("wf-legacy");

    expect(history).toHaveLength(1);
    expect(history[0].automationId).toBe("wf-legacy");
    expect(history[0].automationName).toBe("Legacy Workflow");
    // The old fields should not be present (Zod .strip() removes them)
    expect(history[0]).not.toHaveProperty("workflowId");
    expect(history[0]).not.toHaveProperty("workflowName");

    wm.destroy();
  });
});

describe("history schema accepts gateway-mode statuses", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips a run with skipped run + step status through loadHistory", () => {
    const skippedRun = {
      id: "run-skipped",
      automationId: "wf-skip",
      startedAt: "2026-04-30T09:00:00Z",
      completedAt: "2026-04-30T09:00:01Z",
      status: "skipped",
      stepResults: [
        { stepId: "s1", status: "completed", output: "did step 1" },
        { stepId: "s2", status: "skipped" },
      ],
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p) => {
      const s = String(p);
      if (s.includes("automations.json"))
        return JSON.stringify([makeAutomation("wf-skip", 1, 9, 0, true)]);
      if (s.includes("history")) return JSON.stringify([skippedRun]);
      return "[]";
    });

    const wm = new AutomationManager();
    const history = wm.getHistory("wf-skip");

    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("skipped");
    expect(history[0].stepResults).toHaveLength(2);
    expect(history[0].stepResults[0].status).toBe("completed");
    expect(history[0].stepResults[1].status).toBe("skipped");

    wm.destroy();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAutomation(
  id: string,
  dayOfWeek: number,
  hour: number,
  minute: number,
  enabled: boolean,
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
    triggerType: "schedule",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
