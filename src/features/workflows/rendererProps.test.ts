import type { RunSnapshot } from "@common/workflows-contract";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { adaptWorkflowRendererProps } from "./rendererProps";

const SNAPSHOT: RunSnapshot = {
  runId: "run-1",
  runFamilyId: "family-1",
  workflowId: "oncall-tracker",
  workflowVersion: "1.0.0",
  status: "running",
  startedAt: 100,
  repoPath: "C:\\repo\\oncall",
  steps: [
    {
      id: "0:overview",
      label: "overview",
      parentStepKey: "",
      status: "succeeded",
      startedAt: 100,
      endedAt: 200,
    },
  ],
  agents: {},
  artifacts: [
    {
      key: "dashboard.json",
      storageKey: "artifacts/dashboard.json",
      namespace: "run",
      mime: "application/json",
      sizeBytes: 16,
      writtenAt: 250,
    },
  ],
  capacity: {},
  events: { lastSeq: 3 },
};

describe("adaptWorkflowRendererProps", () => {
  let originalApi: typeof window.workflowsAPI;
  type WorkflowsApi = NonNullable<typeof window.workflowsAPI>;

  beforeEach(() => {
    originalApi = window.workflowsAPI;
  });

  afterEach(() => {
    Object.defineProperty(window, "workflowsAPI", {
      configurable: true,
      value: originalApi,
    });
  });

  test("maps run data and exposes dashboard artifact/state/history helpers", async () => {
    const api = {
      readArtifactByKey: vi.fn<WorkflowsApi["readArtifactByKey"]>(async () => ({
        success: true,
        mime: "application/json",
        encoding: "utf8" as const,
        content: '{"incidentCount":2}',
      })),
      getStateValue: vi.fn<WorkflowsApi["getStateValue"]>(async () => ({
        success: true,
        state: {
          key: "oncall/dashboard",
          found: true,
          value: { activeIncidents: 1 },
        },
      })),
      listStateKeys: vi.fn<WorkflowsApi["listStateKeys"]>(async () => ({
        success: true,
        keys: ["oncall/dashboard"],
      })),
      listRuns: vi.fn<WorkflowsApi["listRuns"]>(async () => ({
        success: true,
        runs: [
          {
            runId: "run-1",
            runFamilyId: "family-1",
            workflowId: "oncall-tracker",
            status: "running",
            startedAt: 100,
            finishedAt: null,
          },
        ],
      })),
      getRun: vi.fn<WorkflowsApi["getRun"]>(async () => ({ success: true, snapshot: SNAPSHOT })),
    };
    Object.defineProperty(window, "workflowsAPI", { configurable: true, value: api });

    const view = adaptWorkflowRendererProps({
      runSnapshot: SNAPSHOT,
      artifacts: SNAPSHOT.artifacts,
    });

    expect(view.run).toMatchObject({
      runId: "run-1",
      workflowId: "oncall-tracker",
      status: "running",
    });
    expect(view.artifacts[0]).toMatchObject({ key: "dashboard.json" });

    await expect(view.dashboard.readJsonArtifact("dashboard.json")).resolves.toEqual({
      incidentCount: 2,
    });
    await expect(view.dashboard.getState("oncall/dashboard")).resolves.toEqual({
      activeIncidents: 1,
    });
    await expect(view.dashboard.listStateKeys("oncall/")).resolves.toEqual(["oncall/dashboard"]);
    await expect(view.dashboard.listRunHistory({ limit: 1 })).resolves.toHaveLength(1);
    await expect(view.dashboard.getRun("run-1")).resolves.toMatchObject({ runId: "run-1" });

    expect(api.readArtifactByKey).toHaveBeenCalledWith("run-1", "dashboard.json");
    expect(api.getStateValue).toHaveBeenCalledWith("oncall-tracker", "oncall/dashboard");
    expect(api.listRuns).toHaveBeenCalledWith("oncall-tracker", "C:\\repo\\oncall");
  });
});
