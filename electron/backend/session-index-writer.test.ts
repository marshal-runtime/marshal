import { describe, it, expect, vi } from "vitest";

import type { SessionMetadata } from "../../common/marshal-ipc-contract";
import { SessionIndexWriter } from "./types";
import type { IndexOperations, SessionsIndex } from "./types";

function makeOps(initial: SessionMetadata[] = []): {
  ops: IndexOperations;
  snapshots: SessionMetadata[][];
} {
  const snapshots: SessionMetadata[][] = [];
  const state: SessionsIndex = {
    sessions: [...initial],
    activeSessionId: null,
  };
  const ops: IndexOperations = {
    async withLock(fn) {
      const result = fn(state);
      snapshots.push(state.sessions.map((s) => ({ ...s })));
      return result;
    },
    emitChanged: vi.fn<() => void>(),
  };
  return { ops, snapshots };
}

function gwMeta(id: string, backendId?: string): SessionMetadata {
  return {
    id,
    name: id,
    createdAt: "",
    updatedAt: "",
    hasUnread: false,
    isActive: false,
    runtimeId: "gateway",
    backendOrigin: "gateway",
    backendId,
  };
}

function copMeta(id: string): SessionMetadata {
  return {
    id,
    name: id,
    createdAt: "",
    updatedAt: "",
    hasUnread: false,
    isActive: false,
    runtimeId: "copilot",
    backendOrigin: "copilot",
  };
}

function localMeta(runtimeId: string, id: string, backendId?: string): SessionMetadata {
  return {
    ...copMeta(id),
    runtimeId,
    backendId,
  };
}

describe("SessionIndexWriter", () => {
  it("upsert adds a new row when none exists", async () => {
    const { ops, snapshots } = makeOps();
    const writer = new SessionIndexWriter("gateway", "gateway", ops);
    await writer.upsert(gwMeta("s1", "b1"));
    expect(snapshots[0]).toHaveLength(1);
    expect(snapshots[0][0]).toMatchObject({ id: "s1", backendId: "b1" });
  });

  it("upsert merges into an existing row by id", async () => {
    const { ops, snapshots } = makeOps([gwMeta("s1", "b1")]);
    const writer = new SessionIndexWriter("gateway", "gateway", ops);
    const updated: SessionMetadata = { ...gwMeta("s1", "b1"), name: "renamed" };
    await writer.upsert(updated);
    expect(snapshots[0]).toHaveLength(1);
    expect(snapshots[0][0].name).toBe("renamed");
  });

  it("rejects writes whose backendOrigin doesn't match the writer's origin", async () => {
    const { ops } = makeOps();
    const writer = new SessionIndexWriter("gateway", "gateway", ops);
    await expect(writer.upsert({ ...copMeta("s-cop"), runtimeId: "gateway" })).rejects.toThrow(
      /mismatched origin/,
    );
  });

  it("remove deletes rows matching the writer's runtime + backendId", async () => {
    const { ops, snapshots } = makeOps([gwMeta("s1", "b1"), copMeta("c1")]);
    const writer = new SessionIndexWriter("gateway", "gateway", ops);
    await writer.remove("b1");
    expect(snapshots[0].map((s) => s.id).sort()).toEqual(["c1"]); // gw row pruned, cop row untouched
  });

  it("replaceAll swaps only the writer's runtime rows", async () => {
    const { ops, snapshots } = makeOps([gwMeta("old-gw-1", "b1"), copMeta("cop-1")]);
    const writer = new SessionIndexWriter("gateway", "gateway", ops);
    await writer.replaceAll([gwMeta("new-gw-2", "b2")]);
    const ids = snapshots[0].map((s) => s.id).sort();
    expect(ids).toEqual(["cop-1", "new-gw-2"]);
  });

  it("replaceAll rejects if any entry mismatches origin", async () => {
    const { ops } = makeOps();
    const writer = new SessionIndexWriter("gateway", "gateway", ops);
    await expect(
      writer.replaceAll([gwMeta("ok", "b"), { ...copMeta("bad"), runtimeId: "gateway" }]),
    ).rejects.toThrow(/mismatched origin/);
  });

  it("upsert matches existing row by (origin, backendId) and preserves local id", async () => {
    // Seed: locally-created gateway row with marshal-assigned local id
    // and cloud-assigned backendId (cloud sessionId from sessions.create).
    const { ops, snapshots } = makeOps([gwMeta("local-uuid", "cloud-xyz")]);
    const writer = new SessionIndexWriter("gateway", "gateway", ops);
    // Incoming reconcile row: parseGatewayRow output, where both id and
    // backendId are the cloud sessionId (different from the local id).
    const incoming: SessionMetadata = {
      ...gwMeta("cloud-xyz", "cloud-xyz"),
      name: "from-snapshot",
    };
    await writer.upsert(incoming);
    expect(snapshots[0]).toHaveLength(1);
    expect(snapshots[0][0].id).toBe("local-uuid");
    expect(snapshots[0][0].backendId).toBe("cloud-xyz");
    expect(snapshots[0][0].name).toBe("from-snapshot");
  });

  it("replaceAll preserves local ids for rows matched by backendId", async () => {
    const { ops, snapshots } = makeOps([gwMeta("local-uuid", "cloud-xyz")]);
    const writer = new SessionIndexWriter("gateway", "gateway", ops);
    await writer.replaceAll([{ ...gwMeta("cloud-xyz", "cloud-xyz"), name: "from-snapshot" }]);
    expect(snapshots[0]).toHaveLength(1);
    expect(snapshots[0][0].id).toBe("local-uuid");
    expect(snapshots[0][0].backendId).toBe("cloud-xyz");
  });

  it("every write invokes ops.emitChanged", async () => {
    const emit = vi.fn<() => void>();
    const state: SessionsIndex = { sessions: [], activeSessionId: null };
    const ops: IndexOperations = {
      async withLock(fn) {
        return fn(state);
      },
      emitChanged: emit,
    };
    const writer = new SessionIndexWriter("gateway", "gateway", ops);
    await writer.upsert(gwMeta("s1", "b1"));
    await writer.remove("b1");
    await writer.replaceAll([gwMeta("s2", "b2")]);
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it("keeps different local runtimes isolated even when they share backendOrigin", async () => {
    const { ops, snapshots } = makeOps([
      localMeta("copilot", "copilot-1", "shared"),
      localMeta("codex", "codex-1", "shared"),
    ]);
    const writer = new SessionIndexWriter("codex", "copilot", ops);

    await writer.replaceAll([localMeta("codex", "remote-codex", "shared")]);

    expect(snapshots[0]).toEqual([
      expect.objectContaining({ id: "copilot-1", runtimeId: "copilot" }),
      expect.objectContaining({ id: "codex-1", runtimeId: "codex" }),
    ]);
  });

  it("does not merge an id collision from another runtime", async () => {
    const { ops, snapshots } = makeOps([localMeta("copilot", "same-id")]);
    const writer = new SessionIndexWriter("codex", "copilot", ops);

    await writer.upsert(localMeta("codex", "same-id"));

    expect(snapshots[0]).toEqual([
      expect.objectContaining({ id: "same-id", runtimeId: "copilot" }),
      expect.objectContaining({ id: "same-id", runtimeId: "codex" }),
    ]);
  });

  it("derives missing runtimeId from backendOrigin without migrating gateway rows to copilot", async () => {
    const legacyGateway = { ...gwMeta("gateway-legacy", "cloud-1"), runtimeId: undefined };
    const legacyCopilot = { ...copMeta("copilot-legacy"), runtimeId: undefined };
    const { ops, snapshots } = makeOps([legacyGateway, legacyCopilot]);
    const writer = new SessionIndexWriter("gateway", "gateway", ops);

    await writer.replaceAll([gwMeta("gateway-new", "cloud-2")]);

    expect(snapshots[0].map((session) => session.id).sort()).toEqual([
      "copilot-legacy",
      "gateway-new",
    ]);
  });
});
