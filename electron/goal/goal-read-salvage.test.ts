import { describe, expect, it } from "vitest";

import {
  createInitialGoalDocument,
  GoalRecoverySchema,
  migrateGoalDocumentForPersistence,
} from "../schemas/goal-schema";
import { migrateStoredSessionGoal } from "../session-store";

/**
 * Goal-read salvage: the strict v2 goal schema (with a strict
 * sourceInstruction sub-schema) is embedded in StoredSessionSchema, so an
 * unknown future field inside sourceInstruction used to fail the WHOLE
 * session load. Pinned contract: salvage PRESERVES the known intent-pointer
 * fields (messageId/excerpt) — it never silently discards the user's
 * original-instruction link; goals invalid beyond that stay "invalid"
 * (deferred limitation, documented at migrateStoredSessionGoal — no
 * destructive cleanup rides this port).
 */

function v2Goal(): Record<string, unknown> {
  const document: unknown = structuredClone(
    createInitialGoalDocument({
      objective: "Ship the report",
      criteria: ["report exists"],
      sourceInstruction: { messageId: "m-1", excerpt: "ship the report please" },
    }),
  );
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("goal document must be an object");
  }
  return { ...document };
}

describe("goal document read salvage", () => {
  it("preserves the intent pointer when sourceInstruction carries an unknown future field", () => {
    const goal = v2Goal();
    goal.sourceInstruction = {
      messageId: "m-1",
      excerpt: "ship the report please",
      futureField: "from-a-newer-writer",
    };

    const result = migrateGoalDocumentForPersistence(goal);
    expect(result.kind).toBe("migrated");
    if (result.kind !== "migrated") return;
    // PRESERVATION, not deletion: the known fields survive verbatim.
    expect(result.document.sourceInstruction).toEqual({
      messageId: "m-1",
      excerpt: "ship the report please",
    });
    expect(result.document.objective).toBe("Ship the report");
    expect(result.document.status).toBe("pursuing");
  });

  it("drops only a sourceInstruction whose known fields are themselves unreadable", () => {
    const goal = v2Goal();
    goal.sourceInstruction = { messageId: 42, excerpt: null };

    const result = migrateGoalDocumentForPersistence(goal);
    expect(result.kind).toBe("migrated");
    if (result.kind !== "migrated") return;
    expect(result.document.sourceInstruction).toBeUndefined();
    expect(result.document.objective).toBe("Ship the report");
  });

  it("keeps authoritative validation strict: goals invalid beyond sourceInstruction stay invalid", () => {
    const result = migrateGoalDocumentForPersistence({ schemaVersion: 2, id: 42 });
    expect(result.kind).toBe("invalid");
    // The session migration quarantines them instead of destroying them: the
    // parsed value is re-serialized value-faithfully into goalRecovery.raw so
    // the session loads and the loss stays visible and recoverable.
    const session: Record<string, unknown> = { id: "s-1", goal: { schemaVersion: 2, id: 42 } };
    expect(migrateStoredSessionGoal(session)).toBe("quarantined");
    expect(session.goal).toBeUndefined();
    const recovery = GoalRecoverySchema.parse(session.goalRecovery);
    expect(recovery.reason).toBe("invalid-document");
    expect(JSON.parse(recovery.raw)).toEqual({ schemaVersion: 2, id: 42 });
  });

  it("keeps valid goals byte-faithful through the session migration", () => {
    const session: Record<string, unknown> = { id: "session-2", goal: v2Goal() };
    expect(migrateStoredSessionGoal(session)).toBe("current");
    expect(session.goal).toMatchObject({
      sourceInstruction: { messageId: "m-1", excerpt: "ship the report please" },
    });
  });
});
