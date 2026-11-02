import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { SessionMetadata } from "../../common/marshal-ipc-contract";
import { CommandCenterActivityDetailStore } from "./activity-detail-store";
import { CommandCenterManager } from "./manager";
import { CommandCenterPrivacyNormalizer } from "./privacy-normalizer";
import { CommandCenterRepository } from "./repository";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
  },
}));

class TestActivityDetailStore extends CommandCenterActivityDetailStore {
  override reload = vi.fn<() => void>();
  override recordToolStart = vi.fn<CommandCenterActivityDetailStore["recordToolStart"]>();
  override recordToolResult = vi.fn<CommandCenterActivityDetailStore["recordToolResult"]>();
  override getSessionActivity = vi.fn<CommandCenterActivityDetailStore["getSessionActivity"]>(
    (rootSessionId: string, sessions: readonly SessionMetadata[]) => ({
      rootSessionId,
      sessionIds: sessions.map((session) => session.id),
      safeSessionIds: [],
      fileChanges: [],
      sources: [],
    }),
  );

  constructor(
    recordToolStart: CommandCenterActivityDetailStore["recordToolStart"],
    filePath: string,
  ) {
    super(filePath);
    this.recordToolStart.mockImplementation(recordToolStart);
  }
}

function makeManager(recordToolStart: (input: unknown) => void) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "cc-manager-"));
  const repository = new CommandCenterRepository({ rootDir: path.join(tempRoot, "repo") });
  const normalizer = new CommandCenterPrivacyNormalizer(path.join(tempRoot, "salt.enc"));
  const activityDetails = new TestActivityDetailStore(
    recordToolStart as CommandCenterActivityDetailStore["recordToolStart"],
    path.join(tempRoot, "details.enc"),
  );
  return {
    manager: new CommandCenterManager(repository, normalizer, activityDetails),
    activityDetails,
  };
}

describe("CommandCenterManager", () => {
  it("does not run activity detail writes synchronously on tool start", async () => {
    const { manager, activityDetails } = makeManager(() => {});

    manager.onToolActivity({
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "apply_patch",
      args: { patch: "*** Begin Patch\n*** Update File: src/app.ts\n*** End Patch" },
    });

    expect(activityDetails.recordToolStart).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(activityDetails.recordToolStart).toHaveBeenCalledTimes(1);
    });
  });

  it("swallows activity detail write failures", async () => {
    const { manager, activityDetails } = makeManager(() => {
      throw new Error("activity write failed");
    });

    expect(() => {
      manager.onToolActivity({
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "apply_patch",
      });
    }).not.toThrow();

    await vi.waitFor(() => {
      expect(activityDetails.recordToolStart).toHaveBeenCalledTimes(1);
    });
  });

  it("clears pending tool starts when a session goes idle", () => {
    const { manager } = makeManager(() => {});

    manager.onToolActivity({
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "grep",
      args: { pattern: "needle" },
    });

    expect(manager._getPendingToolStartCountForTests()).toBe(1);

    manager.onSafeBackendEvent({ type: "idle", sessionId: "session-1" });

    expect(manager._getPendingToolStartCountForTests()).toBe(0);
  });

  it("bounds pending tool starts when completion events are missing", () => {
    const { manager } = makeManager(() => {});

    for (let index = 0; index < 1_010; index++) {
      manager.onToolActivity({
        sessionId: "session-1",
        toolCallId: `tool-${index}`,
        toolName: "grep",
        args: { index },
      });
    }

    expect(manager._getPendingToolStartCountForTests()).toBe(1_000);
  });

  it("keeps observer-derived event writes explicitly best-effort", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "cc-manager-observer-"));
    const repository = new CommandCenterRepository({
      rootDir: path.join(tempRoot, "repo"),
      eventLogAppender: () => {
        throw Object.assign(new Error("access denied"), { code: "EACCES" });
      },
      recoveryRetryDelaysMs: [],
    });
    const manager = new CommandCenterManager(
      repository,
      new CommandCenterPrivacyNormalizer(path.join(tempRoot, "salt.enc")),
      new CommandCenterActivityDetailStore(path.join(tempRoot, "details.enc")),
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() =>
      manager.onSessionLifecycle({
        sessionId: "session-1",
        lifecycle: "created",
        source: "user",
      }),
    ).not.toThrow();
    await vi.waitFor(() => {
      expect(repository.getSnapshot().replay.status).toBe("degraded");
      expect(
        warning.mock.calls.some((args) =>
          args.some((value) =>
            String(value).includes("Best-effort Command Center observer append failed"),
          ),
        ),
      ).toBe(true);
    });
  });

  describe("replaceSessionGoalTodos", () => {
    it("replaces the active goal's list and removes stale entries", async () => {
      const { manager } = makeManager(() => {});

      const first = await manager.replaceSessionGoalTodos({
        sessionId: "session-1",
        goalLabel: "Initial goal",
        todos: [
          { localId: "1", title: "1. one", status: "pending" },
          { localId: "2", title: "2. two", status: "pending" },
          { localId: "3", title: "3. three", status: "pending" },
        ],
      });
      expect(first.snapshot.todos).toHaveLength(3);

      const second = await manager.replaceSessionGoalTodos({
        sessionId: "session-1",
        todos: [
          { localId: "1", title: "1. one updated", status: "done" },
          { localId: "2", title: "2. two", status: "in_progress" },
        ],
      });
      // Same goal: stale entry "3" is dropped, others updated in place.
      expect(second.goalId).toBe(first.goalId);
      expect(second.snapshot.todos).toHaveLength(2);
      expect(second.snapshot.todos.every((t) => t.goalId === first.goalId)).toBe(true);
      expect(second.snapshot.todos.map((t) => t.title).sort()).toEqual([
        "1. one updated",
        "2. two",
      ]);
    });

    it("preserves prior goal history when starting a new goal", async () => {
      const { manager } = makeManager(() => {});

      const first = await manager.replaceSessionGoalTodos({
        sessionId: "session-1",
        goalLabel: "Goal A",
        todos: [
          { localId: "1", title: "1. a-one", status: "done" },
          { localId: "2", title: "2. a-two", status: "done" },
        ],
      });

      const second = await manager.replaceSessionGoalTodos({
        sessionId: "session-1",
        startNewGoal: true,
        goalLabel: "Goal B",
        todos: [{ localId: "1", title: "1. b-one", status: "pending" }],
      });

      expect(second.goalId).not.toBe(first.goalId);
      const goalIds = new Set(second.snapshot.todos.map((t) => t.goalId));
      expect(goalIds.size).toBe(2);
      // Goal A's todos are still present in the snapshot.
      const goalATodos = second.snapshot.todos.filter((t) => t.goalId === first.goalId);
      expect(goalATodos.map((t) => t.title).sort()).toEqual(["1. a-one", "2. a-two"]);
      // Goal B has only its single todo.
      const goalBTodos = second.snapshot.todos.filter((t) => t.goalId === second.goalId);
      expect(goalBTodos).toHaveLength(1);
    });

    it("scopes todos by goal id so colliding local ids do not overwrite history", async () => {
      const { manager } = makeManager(() => {});

      const a = await manager.replaceSessionGoalTodos({
        sessionId: "session-1",
        todos: [{ localId: "1", title: "1. first goal item", status: "done" }],
      });
      const b = await manager.replaceSessionGoalTodos({
        sessionId: "session-1",
        startNewGoal: true,
        todos: [{ localId: "1", title: "1. second goal item", status: "pending" }],
      });

      // Local id collision but distinct persisted ids -> 2 rows.
      expect(b.snapshot.todos).toHaveLength(2);
      const titles = b.snapshot.todos.map((t) => t.title).sort();
      expect(titles).toEqual(["1. first goal item", "1. second goal item"]);
      expect(a.goalId).not.toBe(b.goalId);
    });
  });
});
