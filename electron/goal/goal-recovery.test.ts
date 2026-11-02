import { describe, expect, it, vi } from "vitest";

import type { GoalRecord } from "../../common/goal-contract";
import { createInitialGoalDocument, GoalRecoverySchema } from "../schemas/goal-schema";
import { StoredSessionSchema } from "../schemas/session-schema";
import { migrateStoredSessionGoal, type PersistedSession } from "../session-store";
import { GoalManager, type IGoalSessionStore } from "./goal-manager";

/**
 * Wholly-invalid saved-goal recovery: a goal that fails validation even after
 * salvage must not make the session unloadable, must not be silently deleted,
 * and must never be turned into an invented goal. Pinned contract: the parsed
 * goal value is quarantined value-faithfully in goalRecovery, the session
 * validates, a bounded recovery notice (without the retained copy) is surfaced
 * on the runtime snapshot, and setting a new goal resolves the notice while
 * the retained copy stays durably in the session.
 */

class MemoryGoalStore implements IGoalSessionStore {
  private readonly sessions = new Map<string, PersistedSession>();

  constructor(session: PersistedSession) {
    this.sessions.set(session.id, structuredClone(session));
  }

  loadSessionData(id: string): PersistedSession | null {
    const session = this.sessions.get(id);
    return session ? structuredClone(session) : null;
  }

  saveSessionData(session: PersistedSession): void {
    this.sessions.set(session.id, structuredClone(session));
  }
}

function makeSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id: "session-1",
    name: "Goal session",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    hasUnread: false,
    isActive: false,
    messages: [],
    ...overrides,
  };
}

function makeManager(store: IGoalSessionStore): GoalManager {
  return new GoalManager({
    store,
    emit: vi.fn<(sessionId: string, goal: GoalRecord | null) => void>(),
  });
}

const whollyInvalidGoal = {
  schemaVersion: 3,
  id: "",
  objective: 17,
  status: "definitely-not-a-status",
  nested: { deeply: ["broken"] },
};

describe("wholly-invalid saved-goal recovery", () => {
  it("quarantines a value-faithful copy and keeps the session schema-valid", () => {
    const raw: Record<string, unknown> = {
      ...makeSession(),
      goal: structuredClone(whollyInvalidGoal),
    };
    expect(migrateStoredSessionGoal(raw)).toBe("quarantined");
    expect(raw.goal).toBeUndefined();

    const recovery = GoalRecoverySchema.parse(raw.goalRecovery);
    expect(recovery.reason).toBe("invalid-document");
    // Value-faithful preservation: parsing the quarantined copy returns the
    // original parsed value exactly.
    expect(JSON.parse(recovery.raw)).toEqual(whollyInvalidGoal);

    // The quarantined session now passes the stored-session schema (it used to
    // fail entirely, forcing an archived fallback for the whole session).
    const parsed = StoredSessionSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect((parsed.data as { goalRecovery?: unknown }).goalRecovery).toEqual(recovery);
  });

  it("does not quarantine unsupported future versions (deliberately untouched)", () => {
    const raw: Record<string, unknown> = {
      ...makeSession(),
      goal: { schemaVersion: 99, objective: "from the future" },
    };
    expect(migrateStoredSessionGoal(raw)).toBe("unsupported-version");
    expect(raw.goal).toEqual({ schemaVersion: 99, objective: "from the future" });
    expect(raw.goalRecovery).toBeUndefined();
  });

  it("leaves an explicitly paused valid goal untouched", () => {
    const paused = {
      ...createInitialGoalDocument({ objective: "Ship the report" }),
      status: "paused" as const,
    };
    const raw: Record<string, unknown> = { ...makeSession(), goal: structuredClone(paused) };
    expect(migrateStoredSessionGoal(raw)).toBe("current");
    expect(raw.goal).toMatchObject({ objective: "Ship the report", status: "paused" });
    expect(raw.goalRecovery).toBeUndefined();
  });

  it("surfaces a bounded recovery notice on the runtime snapshot without the retained copy", () => {
    const rawJson = JSON.stringify(whollyInvalidGoal);
    const store = new MemoryGoalStore(
      makeSession({
        goalRecovery: {
          reason: "invalid-document",
          raw: rawJson,
          quarantinedAt: "2026-09-11T09:00:00.000Z",
        },
      }),
    );
    const snapshot = makeManager(store).getRuntimeSnapshot("session-1");
    expect(snapshot.goal).toBeNull();
    expect(snapshot.fence).toBeNull();
    expect(snapshot.recovery).toEqual({
      reason: "invalid-document",
      quarantinedAt: "2026-09-11T09:00:00.000Z",
      rawBytes: Buffer.byteLength(rawJson, "utf8"),
    });
    expect(JSON.stringify(snapshot)).not.toContain("definitely-not-a-status");
  });

  it("resolves the notice on a new goal while keeping the retained copy durably", () => {
    const rawJson = JSON.stringify(whollyInvalidGoal);
    const store = new MemoryGoalStore(
      makeSession({
        goalRecovery: {
          reason: "invalid-document",
          raw: rawJson,
          quarantinedAt: "2026-09-11T09:00:00.000Z",
        },
      }),
    );
    const manager = makeManager(store);
    const created = manager.createGoal("session-1", "Start over cleanly");
    expect(created.objective).toBe("Start over cleanly");

    // The retained copy survives the replacement; only the notice resolves.
    const session = store.loadSessionData("session-1");
    expect(session?.goal?.objective).toBe("Start over cleanly");
    expect(session?.goalRecovery).toMatchObject({
      reason: "invalid-document",
      raw: rawJson,
      resolvedAt: created.createdAt,
      resolvedByGoalId: created.id,
    });
    expect(manager.getRuntimeSnapshot("session-1").recovery).toBeUndefined();

    // The resolved record still passes the persisted-session schema.
    expect(StoredSessionSchema.safeParse(session).success).toBe(true);
  });

  it("keeps the quarantine stable across repeated loads", () => {
    const raw: Record<string, unknown> = {
      ...makeSession(),
      goal: structuredClone(whollyInvalidGoal),
    };
    expect(migrateStoredSessionGoal(raw)).toBe("quarantined");
    const retained = structuredClone(raw.goalRecovery);

    // A later load of the already-quarantined shape is a no-op: no
    // re-quarantine, and the retained copy is untouched.
    const reloaded: Record<string, unknown> = structuredClone(raw);
    expect(migrateStoredSessionGoal(reloaded)).toBe("none");
    expect(reloaded.goalRecovery).toEqual(retained);
    expect(StoredSessionSchema.safeParse(reloaded).success).toBe(true);
  });
});
