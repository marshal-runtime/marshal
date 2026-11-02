import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { it, expect } from "vitest";

import { restoreWorkspace } from "../../../../marshal-cloud-workers/src/workspace";
import { captureCloudWorkspace } from "./workspace";
const exec = promisify(execFile);
it("transfers committed history, edits, untracked files and deletions, excludes ignored credentials, and restores once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cloud-transfer-"));
  const source = path.join(dir, "source");
  const target = path.join(dir, "target");
  const state = path.join(dir, "state");
  await mkdir(source);
  await mkdir(state);
  const git = (...args: string[]) => exec("git", ["-C", source, ...args]);
  try {
    await git("init");
    await git("config", "user.name", "Fixture");
    await git("config", "user.email", "fixture@example.com");
    await writeFile(path.join(source, "tracked.txt"), "original");
    await writeFile(path.join(source, "deleted.txt"), "delete me");
    await writeFile(path.join(source, ".gitignore"), ".env\nignored.txt\n");
    await git("add", ".");
    await git("commit", "-m", "base");
    const commit = (await git("rev-parse", "HEAD")).stdout.trim();
    await writeFile(path.join(source, "tracked.txt"), "local edit");
    await rm(path.join(source, "deleted.txt"));
    await writeFile(path.join(source, "untracked.txt"), "untracked");
    await writeFile(path.join(source, ".env"), "SECRET");
    await writeFile(path.join(source, "ignored.txt"), "ignored");
    const snapshot = await captureCloudWorkspace(source);
    expect(snapshot.files.some((f) => f.path === ".env" || f.path === "ignored.txt")).toBe(false);
    await restoreWorkspace(target, state, snapshot);
    expect((await exec("git", ["-C", target, "rev-parse", "HEAD"])).stdout.trim()).toBe(commit);
    expect(await readFile(path.join(target, "tracked.txt"), "utf8")).toBe("local edit");
    expect(await readFile(path.join(target, "untracked.txt"), "utf8")).toBe("untracked");
    await expect(readFile(path.join(target, "deleted.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeFile(path.join(target, "tracked.txt"), "worker edit");
    await restoreWorkspace(target, state, snapshot);
    expect(await readFile(path.join(target, "tracked.txt"), "utf8")).toBe("worker edit");
    await symlink("/etc/passwd", path.join(source, "link"));
    await expect(captureCloudWorkspace(source)).rejects.toThrow("symlinks");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
