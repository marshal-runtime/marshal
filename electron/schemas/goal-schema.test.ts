import { describe, expect, it } from "vitest";

import {
  GOAL_DOCUMENT_SCHEMA_VERSION,
  GOAL_INITIAL_EPOCH,
  goalFenceFor,
} from "../../common/goal-contract";
import {
  createInitialGoalDocument,
  GoalDocumentV2Schema,
  migrateGoalDocumentForPersistence,
} from "./goal-schema";

describe("minimal goal schema", () => {
  it("creates the canonical GoalRecord and two-field fence", () => {
    const goal = createInitialGoalDocument({
      id: "goal-1",
      objective: "Ship the minimal goal architecture",
      criteria: ["Focused tests pass"],
      now: "2026-08-21T00:00:00.000Z",
    });

    expect(goal).toEqual({
      schemaVersion: GOAL_DOCUMENT_SCHEMA_VERSION,
      id: "goal-1",
      epoch: GOAL_INITIAL_EPOCH,
      objective: "Ship the minimal goal architecture",
      criteria: ["Focused tests pass"],
      status: "pursuing",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
      startedPursuingAt: "2026-08-21T00:00:00.000Z",
      progress: [],
      openQuestions: [],
      assumptions: [],
      decisions: [],
      state: {},
      continuationCount: 0,
      activeMs: 0,
      tokensUsed: 0,
    });
    expect(goalFenceFor(goal)).toEqual({ goalId: "goal-1", epoch: 1 });
  });

  it("rejects fields from the deleted validation and evidence architecture", () => {
    const goal = createInitialGoalDocument({ objective: "Stay minimal" });

    expect(
      GoalDocumentV2Schema.safeParse({
        ...goal,
        validationGraph: { nodes: [] },
      }).success,
    ).toBe(false);
    expect(
      GoalDocumentV2Schema.safeParse({
        ...goal,
        evidence: [],
      }).success,
    ).toBe(false);
  });

  it("migrates useful legacy context without restoring removed subsystems", () => {
    const result = migrateGoalDocumentForPersistence({
      id: "legacy-goal",
      objective: "Migrate me",
      acceptanceCriteria: ["Preserve criterion"],
      status: "pursuing",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T01:00:00.000Z",
      lifecycleEpoch: 4,
      progressNote: "One useful update",
      scratchpad: { branch: "repair" },
      continuationCount: 2,
    });

    expect(result).toMatchObject({
      kind: "migrated",
      document: {
        schemaVersion: GOAL_DOCUMENT_SCHEMA_VERSION,
        id: "legacy-goal",
        epoch: 4,
        criteria: ["Preserve criterion"],
        status: "paused",
        progress: ["One useful update"],
        state: { branch: "repair" },
        continuationCount: 2,
      },
    });
    if (result.kind !== "migrated") throw new Error("Expected the legacy goal to migrate");
    expect(result.document).not.toHaveProperty("validationGraph");
    expect(result.document).not.toHaveProperty("evidence");
    expect(result.document).not.toHaveProperty("operations");
  });

  it("fails closed for future and malformed persisted records", () => {
    expect(
      migrateGoalDocumentForPersistence({
        schemaVersion: GOAL_DOCUMENT_SCHEMA_VERSION + 1,
        id: "future",
      }),
    ).toEqual({
      kind: "unsupported-version",
      version: GOAL_DOCUMENT_SCHEMA_VERSION + 1,
    });
    expect(migrateGoalDocumentForPersistence({ id: "missing-objective" })).toEqual({
      kind: "invalid",
    });
  });
});
