import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { captureWorkspaceBinding } from "../../workspace-role-identity";
import { resolveRuntimeWorkspaceIds } from "../runtime-workspace-identity";
import { MemoryProjectResolver } from "./memory-project";

const execFileAsync = promisify(execFile);
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MemoryProjectResolver", () => {
  it("gives every worktree of one repository the runtime's project id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "marshal-memory-project-"));
    tempDirectories.push(root);
    const repository = path.join(root, "repository");
    const worktree = path.join(root, "worktree");
    await mkdir(repository);
    await git(repository, ["init", "-q"]);
    await git(repository, ["config", "user.email", "marshal-memory@example.test"]);
    await git(repository, ["config", "user.name", "Marshal Memory"]);
    await writeFile(path.join(repository, "tracked.txt"), "tracked\n", "utf8");
    await git(repository, ["add", "tracked.txt"]);
    await git(repository, ["commit", "-q", "-m", "initial"]);
    await git(repository, ["worktree", "add", "-q", "-b", "memory-worktree", worktree]);
    const resolver = new MemoryProjectResolver();

    const [main, linked] = await Promise.all([
      resolver.resolve(repository),
      resolver.resolve(worktree),
    ]);
    const captured = captureWorkspaceBinding("workspace", worktree);
    const runtimeIds = await resolveRuntimeWorkspaceIds(
      captured.canonicalPath,
      captured.binding.identity,
    );

    expect(main?.projectId).toBe(linked?.projectId);
    expect(linked?.projectId).toBe(runtimeIds.projectId);
    expect(linked?.workspaceId).toBe(runtimeIds.workspaceId);
    expect(linked?.workspacePath).toBe(captured.canonicalPath);
    expect(resolver.peek(worktree)).toEqual(linked);
  });

  it("resolves a missing workspace to undefined without caching the failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "marshal-memory-project-"));
    tempDirectories.push(root);
    const workspace = path.join(root, "later");
    const resolver = new MemoryProjectResolver();

    await expect(resolver.resolve(workspace)).resolves.toBeUndefined();
    expect(resolver.peek(workspace)).toBeUndefined();
    await expect(resolver.resolve(undefined)).resolves.toBeUndefined();

    await mkdir(workspace);
    await expect(resolver.resolve(workspace)).resolves.toMatchObject({
      projectId: expect.stringMatching(/^project-/),
    });
  });
});

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd, windowsHide: true });
}
