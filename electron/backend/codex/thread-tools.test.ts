import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CodexDynamicToolSpec } from "./config";
import { CodexThreadToolStore, hashDynamicTools } from "./thread-tools";

function spec(name: string, inputSchema: Record<string, unknown>, description = name) {
  return { type: "function", name, description, inputSchema } satisfies CodexDynamicToolSpec;
}

describe("hashDynamicTools", () => {
  it("ignores tool order, key order, and descriptions", () => {
    const first = hashDynamicTools([
      spec("alpha", { type: "object", properties: { a: { type: "string" } } }),
      spec("beta", { type: "object" }),
    ]);
    const second = hashDynamicTools([
      spec("beta", { type: "object" }, "reworded"),
      spec("alpha", { properties: { a: { type: "string" } }, type: "object" }),
    ]);
    expect(second).toBe(first);
  });

  it("changes when a tool is added, removed, renamed, or its schema changes", () => {
    const base = [spec("alpha", { type: "object" })];
    const hashes = new Set([
      hashDynamicTools(base),
      hashDynamicTools([...base, spec("beta", { type: "object" })]),
      hashDynamicTools([]),
      hashDynamicTools([spec("alpha2", { type: "object" })]),
      hashDynamicTools([spec("alpha", { type: "object", required: ["x"] })]),
    ]);
    expect(hashes.size).toBe(5);
  });
});

describe("CodexThreadToolStore", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function codexHome(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-thread-tools-"));
    roots.push(root);
    return root;
  }

  it("persists hashes across instances and forgets deleted threads", async () => {
    const home = await codexHome();
    const store = new CodexThreadToolStore(home);
    await store.set("thread-1", "hash-1");
    await store.set("thread-2", "hash-2");
    await store.delete("thread-2");

    const reloaded = new CodexThreadToolStore(home);
    await expect(reloaded.get("thread-1")).resolves.toBe("hash-1");
    await expect(reloaded.get("thread-2")).resolves.toBeUndefined();
  });

  it("ignores a corrupt or malformed store instead of failing resume", async () => {
    const home = await codexHome();
    await writeFile(path.join(home, "marshal-thread-tools.json"), "{not json");
    await expect(new CodexThreadToolStore(home).get("thread-1")).resolves.toBeUndefined();

    await writeFile(
      path.join(home, "marshal-thread-tools.json"),
      JSON.stringify({ "thread-1": 7, "thread-2": "ok" }),
    );
    const store = new CodexThreadToolStore(home);
    await expect(store.get("thread-1")).resolves.toBeUndefined();
    await expect(store.get("thread-2")).resolves.toBe("ok");
  });

  it("writes only a plain thread-to-hash map next to the rollouts", async () => {
    const home = await codexHome();
    await new CodexThreadToolStore(home).set("thread-1", "hash-1");
    expect(
      JSON.parse(await readFile(path.join(home, "marshal-thread-tools.json"), "utf8")),
    ).toEqual({
      "thread-1": "hash-1",
    });
  });

  it("stays memory-only without a CODEX_HOME", async () => {
    const store = new CodexThreadToolStore();
    await store.set("thread-1", "hash-1");
    await expect(store.get("thread-1")).resolves.toBe("hash-1");
  });
});
