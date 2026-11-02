// electron/ipc/workflows-ipc.test.ts
//
// Hotfix1 tests — the handlers the renderer's Workflows tab depends on
// (especially `pickInstallDir`, `installLocal`, and `list`).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  dialog: { showOpenDialog: vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>() },
}));

import { dialog } from "electron";

import { testDouble } from "../testing/harness";
import type { WorkflowRunManager } from "../workflows/workflow-run-manager";
import { registerWorkflowsHandlers } from "./workflows-ipc";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors skills-ipc.test.ts pattern: handler captures any-typed for narrow `as` casts on test side
type Handler = (...args: any[]) => any;

interface TestSetup {
  handlers: Map<string, Handler>;
  manager: {
    listWorkflows: ReturnType<typeof vi.fn>;
    hasRenderer: ReturnType<typeof vi.fn>;
    listRuns: ReturnType<typeof vi.fn>;
    getRun: ReturnType<typeof vi.fn>;
    getEvents: ReturnType<typeof vi.fn>;
    runWorkflow: ReturnType<typeof vi.fn>;
    cancelRun: ReturnType<typeof vi.fn>;
    retryFromStep: ReturnType<typeof vi.fn>;
    installLocal: ReturnType<typeof vi.fn>;
    install: ReturnType<typeof vi.fn>;
    describeWorkflow: ReturnType<typeof vi.fn>;
    getScheduleForWorkflow: ReturnType<typeof vi.fn>;
    updateScheduleForWorkflow: ReturnType<typeof vi.fn>;
    disableScheduleForWorkflow: ReturnType<typeof vi.fn>;
    getRendererBundle: ReturnType<typeof vi.fn>;
    readArtifact: ReturnType<typeof vi.fn>;
    listArtifacts: ReturnType<typeof vi.fn>;
    listState: ReturnType<typeof vi.fn>;
    readState: ReturnType<typeof vi.fn>;
    compactState: ReturnType<typeof vi.fn>;
    clearWorkflowState: ReturnType<typeof vi.fn>;
    readArtifactByKey: ReturnType<typeof vi.fn>;
    getWorkflowStateValue: ReturnType<typeof vi.fn>;
    listWorkflowStateKeys: ReturnType<typeof vi.fn>;
    dispatchWorkflowAction: ReturnType<typeof vi.fn>;
    getWorkflowActionItem: ReturnType<typeof vi.fn>;
    approveWorkflowNotification: ReturnType<typeof vi.fn>;
    getRunIdForSession: ReturnType<typeof vi.fn>;
    getRunIdForHostSession: ReturnType<typeof vi.fn>;
    attachBroadcaster: ReturnType<typeof vi.fn>;
  };
}

function setup(): TestSetup {
  const handlers = new Map<string, Handler>();
  const manager = {
    listWorkflows: vi.fn<() => Promise<unknown[]>>(),
    hasRenderer: vi.fn<(id: string) => boolean>(() => false),
    listRuns: vi.fn<() => unknown[]>(() => []),
    getRun: vi.fn<(args: { runId: string }) => Promise<unknown>>(),
    getEvents: vi.fn<(args: { runId: string; fromSeq?: number }) => unknown[]>(() => []),
    runWorkflow: vi.fn<(args: unknown) => Promise<{ runId: string; runFamilyId: string }>>(),
    cancelRun:
      vi.fn<
        (args: { runId: string; reason?: string }) => Promise<{ ok: boolean; error?: string }>
      >(),
    retryFromStep:
      vi.fn<
        (args: {
          runId: string;
          stepId: string;
        }) => Promise<{ newRunId: string; runFamilyId: string }>
      >(),
    installLocal: vi.fn<
      (args: { sourceDir: string; overwrite?: boolean }) => Promise<{
        workflowId: string;
        installedAt: number;
        compiledBytes: number;
        warnings: string[];
      }>
    >(),
    install: vi.fn<() => Promise<unknown>>(),
    describeWorkflow: vi.fn<() => Promise<unknown>>(),
    getScheduleForWorkflow: vi.fn<() => unknown>(),
    updateScheduleForWorkflow: vi.fn<() => unknown>(),
    disableScheduleForWorkflow: vi.fn<() => unknown>(),
    getRendererBundle: vi.fn<() => Promise<unknown>>(),
    readArtifact: vi.fn<() => unknown>(),
    listArtifacts: vi.fn<() => unknown[]>(() => []),
    listState: vi.fn<() => unknown[]>(() => []),
    readState: vi.fn<() => unknown>(),
    compactState: vi.fn<() => Promise<unknown>>(),
    clearWorkflowState: vi.fn<() => Promise<unknown>>(),
    readArtifactByKey: vi.fn<() => unknown>(),
    getWorkflowStateValue: vi.fn<() => unknown>(),
    listWorkflowStateKeys: vi.fn<() => readonly string[]>(),
    dispatchWorkflowAction: vi.fn<() => Promise<unknown>>(),
    getWorkflowActionItem: vi.fn<() => Promise<unknown>>(),
    approveWorkflowNotification: vi.fn<() => Promise<unknown>>(),
    getRunIdForSession: vi.fn<() => string | undefined>(),
    getRunIdForHostSession: vi.fn<() => string | undefined>(),
    attachBroadcaster: vi.fn<(fn: (channel: string, payload: unknown) => void) => void>(),
  };
  const ipcHandle = vi.fn<(channel: string, handler: Handler) => void>(
    (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
  );
  registerWorkflowsHandlers({
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the mock is structurally compatible; the contract's generic IpcInvokeMap signature can't be expressed with a single vi.fn()
    ipcHandle: ipcHandle as unknown as Parameters<typeof registerWorkflowsHandlers>[0]["ipcHandle"],
    getWindow: () => null,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only stand-in; testDouble + vi.fn() cannot satisfy the full WorkflowRunManager surface
    workflowManager: testDouble<WorkflowRunManager>(manager),
  });
  return { handlers, manager };
}

describe("registerWorkflowsHandlers — handler registration", () => {
  it("registers every workflows:* channel the preload exposes", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      [
        "workflows:cancel",
        "workflows:getEvents",
        "workflows:getCommandCenter",
        "workflows:getRenderer",
        "workflows:getRun",
        "workflows:getRunForHostSession",
        "workflows:getStateValue",
        "workflows:installLocal",
        "workflows:listArtifacts",
        "workflows:list",
        "workflows:listRuns",
        "workflows:listState",
        "workflows:listStateKeys",
        "workflows:permissionResponse",
        "workflows:pickInstallDir",
        "workflows:putConfigValue",
        "workflows:readArtifact",
        "workflows:readArtifactByKey",
        "workflows:readState",
        "workflows:retryFromStep",
        "workflows:run",
        "workflows:compactState",
        "workflows:clearState",
        "workflows:dispatchAction",
        "workflows:disableSchedule",
        "workflows:getActionItem",
        "workflows:updateSchedule",
        "workflows:approveNotification",
      ].sort(),
    );
  });

  it("attaches an event broadcaster on construction", () => {
    const { manager } = setup();
    expect(manager.attachBroadcaster).toHaveBeenCalledTimes(1);
  });
});

describe("workflows:getRunForHostSession", () => {
  it("returns the durable run mapped to a workflow host session", async () => {
    const { handlers, manager } = setup();
    manager.getRunIdForHostSession.mockReturnValue("run-1");

    const result = await handlers.get("workflows:getRunForHostSession")!({}, "host-1");

    expect(result).toEqual({ success: true, runId: "run-1" });
    expect(manager.getRunIdForHostSession).toHaveBeenCalledWith("host-1");
  });
});

describe("workflows:updateSchedule", () => {
  it("delegates to WorkflowRunManager.updateScheduleForWorkflow", async () => {
    const { handlers, manager } = setup();
    manager.updateScheduleForWorkflow.mockReturnValue({
      key: "user-local:test-workflow",
      workflowId: "test-workflow",
      naturalLanguage: "every day at 9am",
      enabled: true,
    });

    const result = await handlers.get("workflows:updateSchedule")!(
      {},
      "test-workflow",
      "every day at 9am",
      { name: "Ada" },
      null,
    );

    expect(result.success).toBe(true);
    expect(manager.updateScheduleForWorkflow).toHaveBeenCalledWith({
      workflowId: "test-workflow",
      schedule: "every day at 9am",
      input: { name: "Ada" },
      repoPath: undefined,
    });
  });
});

describe("workflows:readArtifact", () => {
  it("returns artifact content from the manager", async () => {
    const { handlers, manager } = setup();
    manager.readArtifact.mockReturnValue({
      mime: "text/plain",
      encoding: "utf8",
      content: "hello",
    });

    const result = await handlers.get("workflows:readArtifact")!(
      {},
      "run-1",
      "artifacts/summary.txt",
    );

    expect(result).toMatchObject({ success: true, content: "hello" });
  });
});

describe("workflow dashboard data handlers", () => {
  it("reads artifacts by stable artifact key", async () => {
    const { handlers, manager } = setup();
    manager.readArtifactByKey.mockReturnValue({
      mime: "application/json",
      encoding: "utf8",
      content: '{"ok":true}',
    });

    const result = await handlers.get("workflows:readArtifactByKey")!(
      {},
      "run-1",
      "dashboard.json",
    );

    expect(result).toMatchObject({ success: true, content: '{"ok":true}' });
    expect(manager.readArtifactByKey).toHaveBeenCalledWith({
      runId: "run-1",
      key: "dashboard.json",
    });
  });

  it("exposes durable workflow state reads", async () => {
    const { handlers, manager } = setup();
    manager.getWorkflowStateValue.mockReturnValue({
      key: "oncall/dashboard",
      found: true,
      value: { incidentCount: 2 },
    });
    manager.listWorkflowStateKeys.mockReturnValue(["oncall/dashboard"]);

    const state = await handlers.get("workflows:getStateValue")!(
      {},
      "oncall-tracker",
      "oncall/dashboard",
    );
    const keys = await handlers.get("workflows:listStateKeys")!({}, "oncall-tracker", "oncall/");

    expect(state).toMatchObject({
      success: true,
      state: { found: true, value: { incidentCount: 2 } },
    });
    expect(keys).toEqual({ success: true, keys: ["oncall/dashboard"] });
  });

  it("dispatches workflow action items through the manager", async () => {
    const { handlers, manager } = setup();
    manager.dispatchWorkflowAction.mockResolvedValue({
      status: "started",
      item: {
        id: "incident-1",
        title: "Work incident",
        summary: "Investigate",
        workflowId: "pq-incident-incident-investigation",
        dispatch: { status: "active", linkedSessionId: "s-1", attempt: 1 },
      },
    });

    const request = {
      workflowId: "pq-incident-incident-investigation",
      itemId: "incident-1",
      title: "Work incident",
      prompt: "Investigate",
    };
    const result = await handlers.get("workflows:dispatchAction")!({}, request);

    expect(result.success).toBe(true);
    expect(result.result.status).toBe("started");
    expect(manager.dispatchWorkflowAction).toHaveBeenCalledWith(request);
  });

  it("clears workflow state through the manager", async () => {
    const { handlers, manager } = setup();
    manager.clearWorkflowState.mockResolvedValue({
      workflowId: "pq-incident-incident-investigation",
      scanned: 2,
      deleted: 2,
      deletedKeys: ["command-center-state", "system/action-center/a1"],
      preservedConfigKeys: [],
      errors: [],
    });
    const request = {
      workflowId: "pq-incident-incident-investigation",
      prefixes: ["system/action-center/"],
    };

    const result = await handlers.get("workflows:clearState")!({}, request);

    expect(result.success).toBe(true);
    expect(result.result.deleted).toBe(2);
    expect(manager.clearWorkflowState).toHaveBeenCalledWith(request);
  });

  it("approves notification outbox items through the manager", async () => {
    const { handlers, manager } = setup();
    manager.approveWorkflowNotification.mockResolvedValue({
      status: "started",
      item: {
        id: "notification:n1",
        title: "Send notification",
        summary: "Send",
        workflowId: "pq-incident-incident-investigation",
        dispatch: { status: "active", linkedSessionId: "s-1", attempt: 1 },
      },
    });
    const request = {
      workflowId: "pq-incident-incident-investigation",
      item: {
        id: "n1",
        title: "Notify",
        destination: "email",
        target: "dri@example.com",
        preparedBy: "steward",
        detailLevel: "summary",
        content: { summary: "summary", body: "body" },
        approval: { status: "pending" },
      },
    };

    const result = await handlers.get("workflows:approveNotification")!({}, request);

    expect(result.success).toBe(true);
    expect(manager.approveWorkflowNotification).toHaveBeenCalledWith(request);
  });
});

describe("workflows:list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps InstalledWorkflowSummary → WorkflowSummary and tags hasRenderer", async () => {
    const { handlers, manager } = setup();
    manager.listWorkflows.mockResolvedValue([
      {
        id: "test-workflow",
        displayName: "Test Workflow",
        description: "Tiny demo workflow.",
        source: "bundled",
        installedAt: 42,
        schemaVersion: 1,
        version: "0.1.0",
      },
    ]);
    manager.hasRenderer.mockImplementation((id: string) => id === "test-workflow");

    const result = await handlers.get("workflows:list")!({});

    expect(result.success).toBe(true);
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0]).toMatchObject({
      id: "test-workflow",
      displayName: "Test Workflow",
      hasRenderer: true,
      source: "bundled",
    });
  });

  it("returns a failure envelope (not throw) on loader error", async () => {
    const { handlers, manager } = setup();
    manager.listWorkflows.mockRejectedValue(new Error("boom"));
    const result = await handlers.get("workflows:list")!({});
    expect(result.success).toBe(false);
    expect(result.error).toBe("boom");
  });
});

describe("workflows:pickInstallDir", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns sourceDir when the user selects a folder", async () => {
    const { handlers } = setup();
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: ["C:/work/my-workflow"],
    });
    const result = await handlers.get("workflows:pickInstallDir")!({});
    expect(result).toEqual({ success: true, sourceDir: "C:/work/my-workflow" });
    expect(dialog.showOpenDialog).toHaveBeenCalledWith({
      properties: ["openDirectory"],
      title: "Pick a standalone workflow folder",
      buttonLabel: "Install to library",
    });
  });

  it("reports cancellation when the user closes the dialog", async () => {
    const { handlers } = setup();
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });
    const result = await handlers.get("workflows:pickInstallDir")!({});
    expect(result).toEqual({ success: true, cancelled: true });
  });

  it("reports cancellation when the user picks nothing (defensive)", async () => {
    const { handlers } = setup();
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [] });
    const result = await handlers.get("workflows:pickInstallDir")!({});
    expect(result).toEqual({ success: true, cancelled: true });
  });

  it("surfaces dialog failures via the envelope", async () => {
    const { handlers } = setup();
    vi.mocked(dialog.showOpenDialog).mockRejectedValue(new Error("dialog crashed"));
    const result = await handlers.get("workflows:pickInstallDir")!({});
    expect(result.success).toBe(false);
    expect(result.error).toBe("dialog crashed");
  });
});

describe("workflows:installLocal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to WorkflowRunManager.installLocal and forwards args", async () => {
    const { handlers, manager } = setup();
    manager.installLocal.mockResolvedValue({
      workflowId: "my-flow",
      installedAt: 123,
      compiledBytes: 10,
      warnings: [],
    });
    const result = await handlers.get("workflows:installLocal")!({}, "C:/work/my-workflow", true);
    expect(result.success).toBe(true);
    expect(result.workflowId).toBe("my-flow");
    expect(result.warnings).toBeUndefined();
    expect(manager.installLocal).toHaveBeenCalledWith({
      sourceDir: "C:/work/my-workflow",
      overwrite: true,
    });
  });

  it("propagates installer warnings to the renderer", async () => {
    const { handlers, manager } = setup();
    manager.installLocal.mockResolvedValue({
      workflowId: "my-flow",
      installedAt: 123,
      compiledBytes: 10,
      warnings: ["renderer.tsx ignored"],
    });
    const result = await handlers.get("workflows:installLocal")!({}, "/tmp/x");
    expect(result.warnings).toEqual(["renderer.tsx ignored"]);
  });

  it("omits overwrite when not provided", async () => {
    const { handlers, manager } = setup();
    manager.installLocal.mockResolvedValue({
      workflowId: "my-flow",
      installedAt: 1,
      compiledBytes: 1,
      warnings: [],
    });
    await handlers.get("workflows:installLocal")!({}, "/tmp/x");
    expect(manager.installLocal).toHaveBeenCalledWith({ sourceDir: "/tmp/x" });
  });

  it("returns a failure envelope when install throws", async () => {
    const { handlers, manager } = setup();
    manager.installLocal.mockRejectedValue(new Error("manifest missing"));
    const result = await handlers.get("workflows:installLocal")!({}, "/tmp/x");
    expect(result.success).toBe(false);
    expect(result.error).toBe("manifest missing");
  });
});

describe("workflows:permissionResponse", () => {
  it("acknowledges responses without throwing (V1 placeholder)", async () => {
    const { handlers } = setup();
    const result = await handlers.get("workflows:permissionResponse")!(
      {},
      { runId: "r", subagentSessionId: "s", cardId: "c", allow: true },
    );
    expect(result).toEqual({ success: true });
  });
});
