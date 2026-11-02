import { describe, expect, it, vi } from "vitest";

import type { CommandCenterEvent, CommandCenterSnapshot } from "./command-center-contract";
import {
  createEmptyCommandCenterSnapshot,
  markCommandCenterDegraded,
  reduceCommandCenterEvent,
  replayCommandCenterEvents,
} from "./command-center-reducer";

function base(seq: number, ts = 1000) {
  return { schemaVersion: 1, redactionVersion: 1, globalSeq: seq, ts } as const;
}

describe("command-center reducer", () => {
  it("replays deterministically", () => {
    const events: CommandCenterEvent[] = [
      { ...base(0, 20), type: "session.lifecycle", sessionId: "s2", lifecycle: "created" },
      { ...base(1, 10), type: "session.lifecycle", sessionId: "s1", lifecycle: "created" },
      { ...base(2, 20), type: "session.lifecycle", sessionId: "s3", lifecycle: "created" },
    ];

    expect(replayCommandCenterEvents(events)).toEqual(replayCommandCenterEvents([...events]));
  });

  it("uses stable sorting by timestamp then id", () => {
    const snapshot = replayCommandCenterEvents([
      { ...base(0, 20), type: "session.lifecycle", sessionId: "b", lifecycle: "created" },
      { ...base(1, 20), type: "session.lifecycle", sessionId: "a", lifecycle: "created" },
      { ...base(2, 30), type: "session.lifecycle", sessionId: "c", lifecycle: "created" },
    ]);

    expect(snapshot.sessions.map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("matches sequential reducer semantics across every event collection", () => {
    const supported: CommandCenterEvent[] = [
      { ...base(0, 10), type: "session.lifecycle", sessionId: "s1", lifecycle: "created" },
      {
        ...base(1, 20),
        type: "relationship.upsert",
        relationshipId: "rel1",
        fromId: "s1",
        toId: "run1",
        kind: "session-run",
      },
      {
        ...base(2, 30),
        type: "tool.observed",
        toolCallId: "tool1",
        sessionId: "s1",
        toolName: "shell",
        kind: "shell",
        status: "succeeded",
        argKeys: ["z", "a"],
      },
      {
        ...base(3, 40),
        type: "file.observed",
        fileId: "file1",
        sessionId: "s1",
        fileLabel: "app.ts",
        fileKind: "file",
      },
      {
        ...base(4, 50),
        type: "artifact.observed",
        artifactId: "artifact1",
        sessionId: "s1",
        artifactLabel: "report",
        artifactKind: "document",
      },
      { ...base(5, 60), type: "todo.upsert", todoId: "todo1", title: "One", status: "pending" },
      { ...base(6, 70), type: "todo.delete", todoId: "todo1" },
      { ...base(7, 80), type: "todo.upsert", todoId: "todo1", title: "Two", status: "done" },
      {
        ...base(8, 90),
        type: "run.upsert",
        runId: "run1",
        label: "Run",
        status: "running",
      },
      {
        ...base(9, 100),
        type: "blocker.upsert",
        blockerId: "blocker1",
        label: "Blocked",
        severity: "warning",
        status: "active",
      },
    ];
    const events: unknown[] = [...supported, { type: "future.event" }];
    const sequential = events.reduce<CommandCenterSnapshot>(
      (snapshot, event) => reduceCommandCenterEvent(snapshot, event),
      createEmptyCommandCenterSnapshot(),
    );

    expect(replayCommandCenterEvents(events)).toEqual(sequential);
  });

  it("bulk-indexes a 20k-event replay with a fixed collection-sort bound", () => {
    const events: CommandCenterEvent[] = Array.from({ length: 20_000 }, (_, index) => ({
      ...base(index, index),
      type: "todo.upsert",
      todoId: `todo-${index}`,
      title: `Todo ${index}`,
      status: "pending",
    }));
    const sort = vi.spyOn(Array.prototype, "sort");

    const snapshot = replayCommandCenterEvents(events);
    const sortCalls = sort.mock.calls.length;
    sort.mockRestore();

    expect(sortCalls).toBe(8);
    expect(snapshot.todos).toHaveLength(20_000);
    expect(snapshot.todos[0]).toMatchObject({ id: "todo-19999", updatedAt: 19_999 });
    expect(snapshot.replay.lastDurableSeq).toBe(19_999);
  });

  it("tracks relationships", () => {
    const snapshot = replayCommandCenterEvents([
      {
        ...base(0),
        type: "relationship.upsert",
        relationshipId: "r1",
        fromId: "s1",
        toId: "run1",
        kind: "session-run",
      },
    ]);

    expect(snapshot.relationships[0]).toMatchObject({ id: "r1", fromId: "s1", toId: "run1" });
  });

  it("upserts and deletes todos", () => {
    const snapshot = replayCommandCenterEvents([
      { ...base(0), type: "todo.upsert", todoId: "t1", title: "Review", status: "pending" },
      { ...base(1), type: "todo.upsert", todoId: "t1", title: "Review", status: "done" },
      { ...base(2), type: "todo.delete", todoId: "t1" },
    ]);

    expect(snapshot.todos).toEqual([]);
  });

  it("preserves goalId and goalLabel on todos", () => {
    const snapshot = replayCommandCenterEvents([
      {
        ...base(0),
        type: "todo.upsert",
        todoId: "t1",
        title: "Build",
        status: "pending",
        goalId: "goal-a",
        goalLabel: "First request",
      },
    ]);

    expect(snapshot.todos[0]).toMatchObject({
      id: "t1",
      goalId: "goal-a",
      goalLabel: "First request",
    });
  });

  it("skips unknown degraded replay inputs", () => {
    const snapshot = replayCommandCenterEvents([{ type: "future.event" }]);

    expect(snapshot.replay.skippedEvents).toBe(1);
  });

  it("marks append failures as degraded without mutating collections", () => {
    const snapshot = markCommandCenterDegraded(createEmptyCommandCenterSnapshot(), "disk failed");

    expect(snapshot.replay.status).toBe("degraded");
    expect(snapshot.sessions).toEqual([]);
  });

  it("keeps IPC-visible fields privacy-safe", () => {
    const snapshot = reduceCommandCenterEvent(createEmptyCommandCenterSnapshot(), {
      ...base(0),
      type: "tool.observed",
      toolCallId: "tool1",
      sessionId: "session1",
      toolName: "shell",
      kind: "shell",
      status: "started",
      argKeys: ["command"],
      argsHash: "hmac",
    });
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain("content");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("path");
    expect(serialized).not.toContain("commandText");
  });
});
