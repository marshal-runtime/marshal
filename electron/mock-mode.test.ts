import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { shouldUseRealE2EHandler } from "./e2e-stub-routing";
import { isMockMode, resolveE2EDataDir, setMockMode } from "./mock-mode";

const originalMockMode = isMockMode();
const originalGoalHarness = process.env.MARSHAL_GOAL_HARNESS;
const originalWorkspaceFixtures = process.env.MARSHAL_E2E_WORKSPACE_FIXTURES;

describe("E2E harness routing", () => {
  beforeEach(() => {
    setMockMode(false);
    delete process.env.MARSHAL_GOAL_HARNESS;
    delete process.env.MARSHAL_E2E_WORKSPACE_FIXTURES;
  });

  afterEach(() => {
    setMockMode(originalMockMode);
    if (originalGoalHarness === undefined) delete process.env.MARSHAL_GOAL_HARNESS;
    else process.env.MARSHAL_GOAL_HARNESS = originalGoalHarness;
    if (originalWorkspaceFixtures === undefined) {
      delete process.env.MARSHAL_E2E_WORKSPACE_FIXTURES;
    } else {
      process.env.MARSHAL_E2E_WORKSPACE_FIXTURES = originalWorkspaceFixtures;
    }
  });

  it("keeps standard E2E channels on their existing stubs by default", () => {
    setMockMode(true);

    expect(shouldUseRealE2EHandler("goal:get")).toBe(false);
    expect(shouldUseRealE2EHandler("workspace:listWorkspaces")).toBe(false);
  });

  it("routes canonical goal channels to real handlers only in mock goal harness mode", () => {
    process.env.MARSHAL_GOAL_HARNESS = "1";
    expect(shouldUseRealE2EHandler("goal:set")).toBe(false);

    setMockMode(true);
    expect(shouldUseRealE2EHandler("goal:get")).toBe(true);
    expect(shouldUseRealE2EHandler("goal:set")).toBe(true);
    expect(shouldUseRealE2EHandler("goal:pause")).toBe(true);
    expect(shouldUseRealE2EHandler("goal-harness:invoke")).toBe(false);
    expect(shouldUseRealE2EHandler("workspace:listWorkspaces")).toBe(false);
  });

  it("routes workspace channels to real handlers only in mock fixture mode", () => {
    process.env.MARSHAL_E2E_WORKSPACE_FIXTURES = "1";
    expect(shouldUseRealE2EHandler("workspace:listWorkspaces")).toBe(false);

    setMockMode(true);
    expect(shouldUseRealE2EHandler("workspace:listWorkspaces")).toBe(true);
    expect(shouldUseRealE2EHandler("workspace:listRepositoryAgents")).toBe(true);
    expect(shouldUseRealE2EHandler("sessions:list")).toBe(false);
  });

  it("keeps worker data directories isolated", () => {
    const first = resolveE2EDataDir({ MARSHAL_E2E_WORKER: "fixture-a" });
    const second = resolveE2EDataDir({ MARSHAL_E2E_WORKER: "fixture-b" });

    expect(first).not.toBe(second);
    expect(first).toMatch(/marshal-e2e-data-fixture-a$/);
    expect(second).toMatch(/marshal-e2e-data-fixture-b$/);
  });
});
