import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceInstanceIdentity } from "../../common/marshal-ipc-contract";
import { captureWorkspaceBinding } from "../workspace-role-identity";
import { resolveRuntimeWorkspaceIds, runtimeWorkspaceScopeId } from "./runtime-workspace-identity";

const execFileAsync = promisify(execFile);
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Runtime workspace identity", () => {
  it("shares project identity across linked worktrees but not distinct repositories", async () => {
    const root = await temporaryDirectory();
    const repository = path.join(root, "repository");
    const firstWorktree = path.join(root, "first-worktree");
    const secondWorktree = path.join(root, "second-worktree");
    const distinctRepository = path.join(root, "distinct-repository");
    await initializeRepository(repository, true);
    await git(repository, ["worktree", "add", "-q", "-b", "first-worktree", firstWorktree]);
    await git(repository, ["worktree", "add", "-q", "-b", "second-worktree", secondWorktree]);
    await initializeRepository(distinctRepository, false);

    const [first, second, distinct] = await Promise.all([
      workspaceIds(firstWorktree),
      workspaceIds(secondWorktree),
      workspaceIds(distinctRepository),
    ]);

    expect(first.projectId).toBe(second.projectId);
    expect(first.workspaceId).not.toBe(second.workspaceId);
    expect(distinct.projectId).not.toBe(first.projectId);
  });

  it("preserves path and filesystem-bound project identity outside Git repositories", async () => {
    const root = await temporaryDirectory();
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const captured = captureWorkspaceBinding("workspace", workspace);

    await expect(
      resolveRuntimeWorkspaceIds(captured.canonicalPath, captured.binding.identity),
    ).resolves.toEqual({
      workspaceId: runtimeWorkspaceScopeId(
        "workspace",
        captured.canonicalPath,
        captured.binding.identity,
      ),
      projectId: runtimeWorkspaceScopeId(
        "project",
        captured.canonicalPath,
        captured.binding.identity,
      ),
    });
  });

  it.runIf(process.platform === "win32")("normalizes path casing on Windows", () => {
    const identity: WorkspaceInstanceIdentity = {
      version: 1,
      device: "1",
      inode: "2",
      birthtimeNs: "3",
    };

    expect(runtimeWorkspaceScopeId("project", String.raw`Q:\Repo\.git`, identity)).toBe(
      runtimeWorkspaceScopeId("project", String.raw`q:\repo\.GIT`, identity),
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "marshal-runtime-workspace-identity-"));
  tempDirectories.push(directory);
  return directory;
}

async function workspaceIds(workspace: string) {
  const captured = captureWorkspaceBinding("workspace", workspace);
  return resolveRuntimeWorkspaceIds(captured.canonicalPath, captured.binding.identity);
}

async function initializeRepository(repository: string, commit: boolean): Promise<void> {
  await mkdir(repository);
  await git(repository, ["init", "-q"]);
  if (!commit) return;
  await git(repository, ["config", "user.email", "marshal-runtime@example.test"]);
  await git(repository, ["config", "user.name", "Marshal Runtime"]);
  await writeFile(path.join(repository, "tracked.txt"), "tracked\n", "utf8");
  await git(repository, ["add", "tracked.txt"]);
  await git(repository, ["commit", "-q", "-m", "initial"]);
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], { cwd, windowsHide: true });
}
