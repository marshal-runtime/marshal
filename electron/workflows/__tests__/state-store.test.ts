import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

import {
  StoreQuotaExceededError,
  WorkflowStateStore,
  WorkflowStoreSchemaError,
} from "../state-store";

let tmpRoot: string;
let runsRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wf-state-"));
  runsRoot = path.join(tmpRoot, "marshal-workflow-runs");
  fs.mkdirSync(runsRoot, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("WorkflowStateStore", () => {
  it("persists, lists, validates, and deletes workflow-scoped values", async () => {
    const store = new WorkflowStateStore({ rootDir: runsRoot });
    await store.put("wf", "cursor", { lastSeen: "2026-06-12T00:00:00Z" });

    expect(store.get("wf", "cursor", z.object({ lastSeen: z.string() }))).toEqual({
      lastSeen: "2026-06-12T00:00:00Z",
    });
    expect(store.listKeys("wf")).toEqual(["cursor"]);

    await store.delete("wf", "cursor");
    expect(store.get("wf", "cursor")).toBeUndefined();
  });

  it("linearizes concurrent patches on the same key", async () => {
    const store = new WorkflowStateStore({ rootDir: runsRoot });
    await Promise.all(
      Array.from({ length: 100 }, () =>
        store.patch<number>("wf", "counter", (prev) => (prev ?? 0) + 1, z.number()),
      ),
    );

    expect(store.get("wf", "counter", z.number())).toBe(100);
  });

  it("throws a typed schema error when a stored value does not match", async () => {
    const store = new WorkflowStateStore({ rootDir: runsRoot });
    await store.put("wf", "cursor", { lastSeen: 123 });

    expect(() => store.get("wf", "cursor", z.object({ lastSeen: z.string() }))).toThrow(
      WorkflowStoreSchemaError,
    );
  });

  it("enforces the per-value quota", async () => {
    const store = new WorkflowStateStore({ rootDir: runsRoot });
    await expect(store.put("wf", "big", "x".repeat(300 * 1024))).rejects.toThrow(
      StoreQuotaExceededError,
    );
  });

  it("lists prefix-scoped entries with durable metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T09:00:00Z"));
    const store = new WorkflowStateStore({ rootDir: runsRoot });

    await store.put(
      "wf",
      "shards/2026-06/a",
      { shift: "primary" },
      { ttlMs: 60_000, runId: "run-1" },
    );
    await store.put("wf", "shards/2026-06/b", { shift: "backup" });
    await store.put("wf", "other/key", true);

    expect(store.listKeys("wf", "shards/2026-06/")).toEqual([
      "shards/2026-06/a",
      "shards/2026-06/b",
    ]);
    expect(store.listEntries("wf", "shards/2026-06/")).toEqual([
      expect.objectContaining({
        key: "shards/2026-06/a",
        writtenAt: Date.parse("2026-06-12T09:00:00Z"),
        ttlMs: 60_000,
        expiresAt: Date.parse("2026-06-12T09:01:00Z"),
        runId: "run-1",
      }),
      expect.objectContaining({
        key: "shards/2026-06/b",
        writtenAt: Date.parse("2026-06-12T09:00:00Z"),
      }),
    ]);
    expect(store.getEntry("wf", "shards/2026-06/a", z.object({ shift: z.string() }))).toEqual(
      expect.objectContaining({
        key: "shards/2026-06/a",
        value: { shift: "primary" },
      }),
    );
  });

  it("compacts expired or old prefix entries and reports freed bytes", async () => {
    vi.useFakeTimers();
    const store = new WorkflowStateStore({ rootDir: runsRoot });
    vi.setSystemTime(new Date("2026-06-10T00:00:00Z"));
    await store.put("wf", "shards/a", "old");
    await store.put("wf", "keep/outside-prefix", "old");

    vi.setSystemTime(new Date("2026-06-12T00:00:00Z"));
    await store.put("wf", "shards/b", "new");

    const result = await store.compact("wf", {
      prefix: "shards/",
      olderThanMs: 24 * 60 * 60 * 1000,
    });

    expect(result).toMatchObject({
      scanned: 2,
      deleted: 1,
      deletedKeys: ["shards/a"],
    });
    expect(result.bytesFreed).toBeGreaterThan(0);
    expect(store.listKeys("wf")).toEqual(["keep/outside-prefix", "shards/b"]);
  });

  it("shards productized on-call shift cursors by workflow and hashed key", async () => {
    const store = new WorkflowStateStore({ rootDir: runsRoot });
    const currentCursorKey = "shift-cursor/dataflows/current";
    const priorShiftKey = "shift-cursor/dataflows/2026-06-06";

    await store.put("oncall-workflow", currentCursorKey, {
      latestShiftEnd: "2026-06-13T00:00:00Z",
      driAlias: "ci",
    });
    await store.put("oncall-workflow", priorShiftKey, {
      latestShiftEnd: "2026-06-06T00:00:00Z",
      driAlias: "previous",
    });
    await store.put("pq-incident-incident-investigation", currentCursorKey, {
      latestShiftEnd: "2026-06-13T00:00:00Z",
      owningTeam: "POWERQUERYONLINE\\DataflowsOn-CallEngineers",
    });

    expect(new Set(store.listKeys("oncall-workflow", "shift-cursor/dataflows/"))).toEqual(
      new Set([currentCursorKey, priorShiftKey]),
    );
    expect(store.get("pq-incident-incident-investigation", currentCursorKey)).toEqual({
      latestShiftEnd: "2026-06-13T00:00:00Z",
      owningTeam: "POWERQUERYONLINE\\DataflowsOn-CallEngineers",
    });

    const stateRoot = path.join(path.dirname(runsRoot), "marshal-workflow-state");
    const oncallValues = path.join(stateRoot, "oncall-workflow", "values");
    expect(new Set(fs.readdirSync(oncallValues))).toEqual(
      new Set([`${hashKey(currentCursorKey)}.json`, `${hashKey(priorShiftKey)}.json`]),
    );
    const pqCursorPath = path.join(
      stateRoot,
      "pq-incident-incident-investigation",
      "values",
      `${hashKey(currentCursorKey)}.json`,
    );
    expect(fs.existsSync(pqCursorPath)).toBe(true);
  });
});

function hashKey(key: string): string {
  return createHash("sha1").update(key).digest("hex");
}
