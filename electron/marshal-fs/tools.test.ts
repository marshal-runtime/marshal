import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ISettingsManager } from "../backend/ports";
import { testDouble } from "../testing/harness";
import { getSelfFsTools } from "./tools";

let root = "";

const call = async (
  name: string,
  args: Record<string, unknown>,
  grants: { read: string[]; write: string[] } = { read: [], write: [] },
): Promise<string> => {
  const tools = getSelfFsTools({
    getWorkspaceDir: () => root,
    getEffectiveFolderGrants: () => grants,
    // Minimal settingsManager stub: no out-of-workspace grants.
    settingsManager: testDouble<Pick<ISettingsManager, "get">>({
      get: () => testDouble({ permissions: {} }),
    }),
  });
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool.handler(args, testDouble({}));
};

beforeEach(async () => {
  // realpath so the workspace root matches what the handler's realpath guard
  // resolves — on macOS os.tmpdir() (/var/...) symlinks to /private/var/....
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "selffs-")));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("listLocalFiles", () => {
  it("returns structured entries with type and size", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "hello");
    await fs.mkdir(path.join(root, "sub"));
    const out = JSON.parse(await call("listLocalFiles", { path: root }));
    expect(out.success).toBe(true);
    const names = out.entries.map((e: { name: string }) => e.name).sort();
    expect(names).toEqual(["a.txt", "sub"]);
    const file = out.entries.find((e: { name: string }) => e.name === "a.txt");
    expect(file).toMatchObject({ type: "file", size: 5 });
  });

  it("returns success:false for a path outside scope", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "outside-")));
    const out = JSON.parse(await call("listLocalFiles", { path: outside }));
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/outside allowed folders|denied/i);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("allows a path under a folder granted via getEffectiveFolderGrants (session-effective)", async () => {
    const granted = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "granted-")));
    await fs.writeFile(path.join(granted, "g.txt"), "hi");
    const out = JSON.parse(
      await call("listLocalFiles", { path: granted }, { read: [granted], write: [] }),
    );
    expect(out.success).toBe(true);
    expect(out.entries.map((e: { name: string }) => e.name)).toContain("g.txt");
    await fs.rm(granted, { recursive: true, force: true });
  });

  it("denies a symlink inside root whose target is outside scope", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "outside-")));
    const link = path.join(root, "escape");
    await fs.symlink(outside, link);
    const out = JSON.parse(await call("listLocalFiles", { path: link }));
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/symlink target outside|outside allowed/i);
    await fs.rm(outside, { recursive: true, force: true });
  });
});

describe("statLocalPath", () => {
  it("returns size and type flags", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "hello");
    const out = JSON.parse(await call("statLocalPath", { path: path.join(root, "a.txt") }));
    expect(out).toMatchObject({ success: true, isFile: true, isDirectory: false, size: 5 });
  });

  it("returns success:false for a path outside scope", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "outside-")));
    const out = JSON.parse(await call("statLocalPath", { path: path.join(outside, "x.txt") }));
    expect(out.success).toBe(false);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("returns success:false with an ENOENT message for an in-scope missing file", async () => {
    const out = JSON.parse(await call("statLocalPath", { path: path.join(root, "nope.txt") }));
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/ENOENT|no such file/i);
  });

  it("allows a file under a folder granted via getEffectiveFolderGrants", async () => {
    const granted = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "granted-")));
    await fs.writeFile(path.join(granted, "g.txt"), "hello");
    const out = JSON.parse(
      await call(
        "statLocalPath",
        { path: path.join(granted, "g.txt") },
        { read: [granted], write: [] },
      ),
    );
    expect(out).toMatchObject({ success: true, isFile: true, size: 5 });
    await fs.rm(granted, { recursive: true, force: true });
  });
});

describe("createLocalDirectory", () => {
  it("creates nested directories", async () => {
    const target = path.join(root, "x", "y", "z");
    const out = JSON.parse(await call("createLocalDirectory", { path: target }));
    expect(out.success).toBe(true);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });

  it("creates a directory under a folder granted for write (session-effective)", async () => {
    const granted = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wgrant-")));
    const target = path.join(granted, "newdir", "child");
    const out = JSON.parse(
      await call("createLocalDirectory", { path: target }, { read: [], write: [granted] }),
    );
    expect(out.success).toBe(true);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
    await fs.rm(granted, { recursive: true, force: true });
  });

  it("denies mkdir under a read-only grant (write needs an independent write grant)", async () => {
    const granted = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rgrant-")));
    const out = JSON.parse(
      await call(
        "createLocalDirectory",
        { path: path.join(granted, "x") },
        { read: [granted], write: [] },
      ),
    );
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/outside allowed folders|denied/i);
    await fs.rm(granted, { recursive: true, force: true });
  });
});

describe("moveLocalPath", () => {
  it("renames a file within scope", async () => {
    const src = path.join(root, "a.txt");
    const dst = path.join(root, "b.txt");
    await fs.writeFile(src, "hi");
    const out = JSON.parse(await call("moveLocalPath", { source: src, destination: dst }));
    expect(out.success).toBe(true);
    expect(await fs.readFile(dst, "utf8")).toBe("hi");
    await expect(fs.stat(src)).rejects.toThrow(/ENOENT/);
  });

  it("denies moving from an ungranted source", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "outside-")));
    const src = path.join(outside, "secret.txt");
    await fs.writeFile(src, "x");
    const out = JSON.parse(
      await call("moveLocalPath", { source: src, destination: path.join(root, "x.txt") }),
    );
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/outside allowed folders|denied/i);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("falls back to copy+remove when rename throws EXDEV (cross-device move)", async () => {
    const src = path.join(root, "a.txt");
    await fs.mkdir(path.join(root, "sub"));
    const dst = path.join(root, "sub", "b.txt");
    await fs.writeFile(src, "payload");
    // Simulate a cross-device rename (the Windows D:->C: case): EXDEV forces the
    // fs.cp + fs.rm fallback.
    const exdev = Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    vi.spyOn(fs, "rename").mockRejectedValueOnce(exdev);
    const out = JSON.parse(await call("moveLocalPath", { source: src, destination: dst }));
    expect(out.success).toBe(true);
    expect(await fs.readFile(dst, "utf8")).toBe("payload");
    await expect(fs.stat(src)).rejects.toThrow(/ENOENT/);
  });

  it("reports partial failure when the EXDEV copy lands but source removal fails", async () => {
    const src = path.join(root, "a.txt");
    await fs.mkdir(path.join(root, "sub"));
    const dst = path.join(root, "sub", "b.txt");
    await fs.writeFile(src, "payload");
    const exdev = Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    vi.spyOn(fs, "rename").mockRejectedValueOnce(exdev);
    vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("permission denied"));
    const out = JSON.parse(await call("moveLocalPath", { source: src, destination: dst }));
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/copied to .* but source removal failed/i);
    // The copy landed; the destination must reflect that real state.
    expect(await fs.readFile(dst, "utf8")).toBe("payload");
  });

  it("denies moving an in-scope source that is a sensitive path", async () => {
    // Point home at the workspace root so the built-in ~/.ssh deny pattern
    // resolves under it — the source is in-scope but sensitive, so the move's
    // source-side sensitive-path re-check must reject it.
    vi.spyOn(os, "homedir").mockReturnValue(root);
    const ssh = path.join(root, ".ssh");
    await fs.mkdir(ssh);
    await fs.writeFile(path.join(ssh, "id_rsa"), "KEY");
    const out = JSON.parse(
      await call("moveLocalPath", {
        source: path.join(ssh, "id_rsa"),
        destination: path.join(root, "leaked.txt"),
      }),
    );
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/sensitive/i);
  });
});

describe("empty / missing path", () => {
  it("rejects listLocalFiles with an empty path", async () => {
    const out = JSON.parse(await call("listLocalFiles", { path: "" }));
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/required/i);
  });

  it("rejects listLocalFiles with a missing path arg", async () => {
    const out = JSON.parse(await call("listLocalFiles", {}));
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/required/i);
  });

  it("rejects moveLocalPath with an empty source", async () => {
    const out = JSON.parse(
      await call("moveLocalPath", { source: "", destination: path.join(root, "x.txt") }),
    );
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/required/i);
  });

  it("rejects moveLocalPath with an empty destination", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "hi");
    const out = JSON.parse(
      await call("moveLocalPath", { source: path.join(root, "a.txt"), destination: "" }),
    );
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/required/i);
  });
});

describe("getLocalFileTree", () => {
  it("does not report truncated for a small tree", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "x");
    await fs.mkdir(path.join(root, "sub"));
    await fs.writeFile(path.join(root, "sub", "b.txt"), "y");
    const out = JSON.parse(await call("getLocalFileTree", { path: root }));
    expect(out.success).toBe(true);
    expect(out.truncated).toBe(false);
  });

  it("reports truncated:true once the 5000-entry cap is exceeded", async () => {
    // One entry past MAX_ENTRIES (5000) so the walk hits the cap and drops the rest.
    await Promise.all(
      Array.from({ length: 5001 }, (_, i) => fs.writeFile(path.join(root, `f${i}.txt`), "")),
    );
    const out = JSON.parse(await call("getLocalFileTree", { path: root }));
    expect(out.success).toBe(true);
    expect(out.truncated).toBe(true);
  });

  it("denies a tree read outside scope", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "outside-")));
    const out = JSON.parse(await call("getLocalFileTree", { path: outside }));
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/outside allowed folders|denied/i);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("does not recurse into a symlinked directory (treated as a leaf, no loop)", async () => {
    // A symlink to an ancestor would loop if followed; Dirent.isDirectory() is
    // false for symlinks, so the walk lists it without recursing — and the
    // realpath/visited guard backstops any path that does resolve to a seen dir.
    await fs.mkdir(path.join(root, "a"));
    await fs.writeFile(path.join(root, "a", "f.txt"), "x");
    await fs.symlink(root, path.join(root, "a", "loop"));
    const out = JSON.parse(await call("getLocalFileTree", { path: root }));
    expect(out.success).toBe(true);
    const a = out.tree.find((n: { name: string }) => n.name === "a");
    const loop = a.children.find((n: { name: string }) => n.name === "loop");
    expect(loop).toBeDefined();
    expect(loop.children).toBeUndefined();
  });

  it("treats a NaN maxDepth as the default (does not disable the depth cap)", async () => {
    // nest deeper than the default depth of 5
    const segments = Array.from({ length: 8 }, (_, i) => `d${i}`);
    await fs.mkdir(path.join(root, ...segments), { recursive: true });
    const out = JSON.parse(await call("getLocalFileTree", { path: root, maxDepth: NaN }));
    expect(out.success).toBe(true);
    // Default depth is 5: walk depth 1..5 yields nodes d0..d4; d5 and below are pruned.
    let node = out.tree[0];
    let depth = 1;
    while (node?.children?.length) {
      node = node.children[0];
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(5);
  });
});
