import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  claudeAccountConfigDir,
  ensureClaudeAccountConfigDir,
  withoutLaunchCredentials,
} from "./accounts";

describe("Claude account config dirs", () => {
  let root: string;
  let hostDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "marshal-claude-accounts-"));
    hostDir = path.join(root, "host");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("places accounts under Marshal's home and rejects unsafe ids", () => {
    expect(claudeAccountConfigDir("work", root)).toBe(
      path.join(root, ".marshal", "marshal-claude-accounts", "work"),
    );
    expect(() => claudeAccountConfigDir("../escape", root)).toThrow("Invalid Claude account id");
  });

  it("shares the host transcripts folder with the account", async () => {
    const accountDir = await ensureClaudeAccountConfigDir(hostDir, "work", { homeDir: root });
    await writeFile(path.join(accountDir, "projects", "transcript.jsonl"), "{}\n");

    expect((await lstat(path.join(accountDir, "projects"))).isSymbolicLink()).toBe(true);
    expect(await readdir(path.join(hostDir, "projects"))).toEqual(["transcript.jsonl"]);
  });

  it("is idempotent", async () => {
    await ensureClaudeAccountConfigDir(hostDir, "work", { homeDir: root });
    const accountDir = await ensureClaudeAccountConfigDir(hostDir, "work", { homeDir: root });

    expect((await lstat(path.join(accountDir, "projects"))).isSymbolicLink()).toBe(true);
  });

  it("leaves an account's own transcripts folder and foreign links in place", async () => {
    const accountDir = claudeAccountConfigDir("work", root);
    await mkdir(path.join(accountDir, "projects"), { recursive: true });
    await ensureClaudeAccountConfigDir(hostDir, "work", { homeDir: root });
    expect((await lstat(path.join(accountDir, "projects"))).isDirectory()).toBe(true);

    const otherDir = claudeAccountConfigDir("home", root);
    await mkdir(otherDir, { recursive: true });
    await mkdir(path.join(root, "elsewhere"));
    await symlink(path.join(root, "elsewhere"), path.join(otherDir, "projects"), "dir");
    await ensureClaudeAccountConfigDir(hostDir, "home", { homeDir: root });
    expect((await lstat(path.join(otherDir, "projects"))).isSymbolicLink()).toBe(true);
  });

  it("drops launch-environment credentials for extra accounts", () => {
    expect(
      withoutLaunchCredentials({ ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", PATH: "/bin" }),
    ).toEqual({ PATH: "/bin" });
  });
});
