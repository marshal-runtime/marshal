import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SwarmIntegrationRefs } from "./swarm-integration-ref";

const execFileAsync = promisify(execFile);
const RUN_ID = "owner-1.20260826T000000000Z";

describe("swarm integration refs", () => {
  let repository: string;
  let base: string;
  let ahead: string;
  let divergent: string;

  beforeAll(async () => {
    repository = await mkdtemp(path.join(tmpdir(), "swarm-integration-"));
    await git(repository, ["init", "--initial-branch", "main"]);
    await git(repository, ["config", "user.email", "swarm@example.test"]);
    await git(repository, ["config", "user.name", "Swarm"]);
    base = await commit(repository, "base.txt", "base");
    ahead = await commit(repository, "ahead.txt", "ahead");
    await git(repository, ["checkout", "-q", "-b", "island", base]);
    divergent = await commit(repository, "island.txt", "island");
    await git(repository, ["checkout", "-q", "main"]);
  }, 60_000);

  afterAll(async () => {
    await rm(repository, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("creates one ref per scope at exactly the captured head and is idempotent", async () => {
    const refs = new SwarmIntegrationRefs();

    const created = await refs.initialize(repository, RUN_ID, "marshal-program", base);
    const again = await refs.initialize(repository, RUN_ID, "marshal-program", ahead);

    expect(created.ref).toMatch(/^refs\/swarm\/.+\/integration\/marshal-program$/);
    expect(created.head).toBe(base);
    expect(again).toEqual(created);
    expect(await refs.read(repository, RUN_ID, "marshal-program")).toEqual(created);
  });

  it("fast-forwards, reports an unchanged head, and refuses a non-fast-forward island", async () => {
    const refs = new SwarmIntegrationRefs();
    await refs.initialize(repository, RUN_ID, "promote-scope", base);

    const promoted = await refs.promote(repository, RUN_ID, "promote-scope", ahead);
    const current = await refs.promote(repository, RUN_ID, "promote-scope", ahead);
    const island = await refs.promote(repository, RUN_ID, "promote-scope", divergent);

    expect(promoted).toEqual({
      status: "promoted",
      ref: refs.refFor(RUN_ID, "promote-scope"),
      head: ahead,
      previousHead: base,
    });
    expect(current.status).toBe("current");
    expect(island.status).toBe("stale");
    expect(island.head).toBe(ahead);
    expect(await refs.read(repository, RUN_ID, "promote-scope")).toEqual({
      ref: refs.refFor(RUN_ID, "promote-scope"),
      head: ahead,
    });
  });

  it("loses the compare-and-swap when the ref moved under it", async () => {
    const refs = new SwarmIntegrationRefs();
    const ref = refs.refFor(RUN_ID, "cas-scope");
    await refs.initialize(repository, RUN_ID, "cas-scope", base);
    const racing = new SwarmIntegrationRefs(async (repositoryPath, args) => {
      if (args[0] === "update-ref") {
        await git(repositoryPath, ["update-ref", ref, ahead, base]);
      }
      return gitText(repositoryPath, args);
    });

    const lost = await racing.promote(repository, RUN_ID, "cas-scope", ahead);

    expect(lost).toEqual({ status: "stale", ref, head: ahead });
  });

  it("answers containment against the current integration head", async () => {
    const refs = new SwarmIntegrationRefs();
    await refs.initialize(repository, RUN_ID, "island-scope", base);
    await refs.promote(repository, RUN_ID, "island-scope", ahead);

    expect(await refs.contains(repository, RUN_ID, "island-scope", base)).toBe(true);
    expect(await refs.contains(repository, RUN_ID, "island-scope", "refs/heads/island")).toBe(
      false,
    );
    expect(await refs.contains(repository, RUN_ID, "island-scope", "refs/heads/missing")).toBe(
      false,
    );
    expect(await refs.contains(repository, RUN_ID, "unknown-scope", base)).toBe(false);
  });

  it("refuses to promote a scope that was never initialised", async () => {
    const refs = new SwarmIntegrationRefs();

    await expect(refs.promote(repository, RUN_ID, "absent-scope", ahead)).rejects.toThrow(
      `Swarm integration ref "${refs.refFor(RUN_ID, "absent-scope")}" was never initialised.`,
    );
  });

  it("refuses a head that does not resolve in the declared repository", async () => {
    const refs = new SwarmIntegrationRefs();

    await expect(
      refs.initialize(repository, RUN_ID, "foreign-scope", "b".repeat(40)),
    ).rejects.toThrow(/does not resolve to a commit in this repository/);
  });
});

async function commit(repository: string, file: string, contents: string): Promise<string> {
  await writeFile(path.join(repository, file), `${contents}\n`, "utf8");
  await git(repository, ["add", file]);
  await git(repository, ["commit", "-q", "-m", contents]);
  return gitText(repository, ["rev-parse", "HEAD"]).then((value) => value.trim());
}

async function git(repository: string, args: readonly string[]): Promise<void> {
  await gitText(repository, args);
}

async function gitText(repository: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd: repository, windowsHide: true });
  return result.stdout;
}
