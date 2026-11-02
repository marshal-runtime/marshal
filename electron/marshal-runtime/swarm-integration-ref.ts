import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { swarmIntegrationRef } from "@marshal/swarm";

const execFileAsync = promisify(execFile);

/** The current integration ref for one (run, repository) and the commit it names. */
export interface SwarmIntegrationHead {
  readonly ref: string;
  readonly head: string;
}

export type SwarmIntegrationPromotion =
  | {
      readonly status: "promoted";
      readonly ref: string;
      readonly head: string;
      readonly previousHead: string;
    }
  | { readonly status: "current"; readonly ref: string; readonly head: string }
  | { readonly status: "stale"; readonly ref: string; readonly head: string };

/** Git invocation seam. Production runs `git` inside the scope's repository. */
export type SwarmIntegrationGit = (
  repositoryPath: string,
  args: readonly string[],
) => Promise<string>;

/**
 * The moving integration state of a swarm run is a git ref per declared
 * repository and nothing else: `refs/swarm/<run>/integration/<scope>`, named by
 * the Runtime-owned `swarmIntegrationRef`. It is never checked out, never
 * appears in `git branch`, and is recoverable from git alone, so no event,
 * receipt, or ledger records it.
 *
 * Every advance is a compare-and-swap `git update-ref <ref> <new> <old>` after
 * proving `<old>` is an ancestor of `<new>`, which makes promotion atomic,
 * crash-safe, and correct across processes without a lock.
 */
export class SwarmIntegrationRefs {
  constructor(private readonly git: SwarmIntegrationGit = runGit) {}

  refFor(runId: string, scope: string): string {
    return swarmIntegrationRef(runId, scope);
  }

  /**
   * Creates the ref at exactly `head` when it does not exist yet, using
   * `update-ref`'s empty old value so a concurrent creation cannot be
   * clobbered. An existing ref is returned untouched.
   */
  async initialize(
    repositoryPath: string,
    runId: string,
    scope: string,
    head: string,
  ): Promise<SwarmIntegrationHead> {
    const ref = this.refFor(runId, scope);
    const existing = await this.readRef(repositoryPath, ref);
    if (existing !== undefined) return { ref, head: existing };
    // Resolving in this repository is what proves the captured head belongs to
    // the scope it was declared for.
    const commit = await this.resolveCommit(repositoryPath, head);
    try {
      await this.git(repositoryPath, ["update-ref", ref, commit, ""]);
    } catch (error) {
      const raced = await this.readRef(repositoryPath, ref);
      if (raced === undefined) throw error;
      return { ref, head: raced };
    }
    return { ref, head: commit };
  }

  async read(
    repositoryPath: string,
    runId: string,
    scope: string,
  ): Promise<SwarmIntegrationHead | undefined> {
    const ref = this.refFor(runId, scope);
    const head = await this.readRef(repositoryPath, ref);
    return head === undefined ? undefined : { ref, head };
  }

  /**
   * Fast-forward-only compare-and-swap. A candidate that already is the
   * integration head is `current`; one that does not contain the integration
   * head — or that loses the swap to a concurrent promotion — is `stale` and
   * remains an island for a reconciler to fold in.
   */
  async promote(
    repositoryPath: string,
    runId: string,
    scope: string,
    candidate: string,
  ): Promise<SwarmIntegrationPromotion> {
    const ref = this.refFor(runId, scope);
    const current = await this.readRef(repositoryPath, ref);
    if (current === undefined) {
      throw new Error(`Swarm integration ref "${ref}" was never initialised.`);
    }
    const commit = await this.resolveCommit(repositoryPath, candidate);
    if (commit === current) return { status: "current", ref, head: current };
    if (!(await this.isAncestor(repositoryPath, current, commit))) {
      return { status: "stale", ref, head: current };
    }
    try {
      await this.git(repositoryPath, ["update-ref", ref, commit, current]);
    } catch {
      const settled = await this.readRef(repositoryPath, ref);
      return { status: "stale", ref, head: settled ?? current };
    }
    return { status: "promoted", ref, head: commit, previousHead: current };
  }

  /** True when `commit` is already reachable from the integration head. */
  async contains(
    repositoryPath: string,
    runId: string,
    scope: string,
    commit: string,
  ): Promise<boolean> {
    const current = await this.read(repositoryPath, runId, scope);
    if (!current) return false;
    const resolved = await this.lookupCommit(repositoryPath, commit);
    if (resolved === undefined) return false;
    return this.isAncestor(repositoryPath, resolved, current.head);
  }

  /** The commit a revision names, or `undefined` when it no longer exists. */
  resolveOptional(repositoryPath: string, revision: string): Promise<string | undefined> {
    return this.lookupCommit(repositoryPath, revision);
  }

  async isAncestor(repositoryPath: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.git(repositoryPath, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch (error) {
      if (isGitExitCode(error, 1)) return false;
      throw error;
    }
  }

  private readRef(repositoryPath: string, ref: string): Promise<string | undefined> {
    return this.lookupCommit(repositoryPath, ref);
  }

  private async resolveCommit(repositoryPath: string, revision: string): Promise<string> {
    const commit = await this.lookupCommit(repositoryPath, revision);
    if (commit === undefined) {
      throw new Error(
        `Swarm integration revision "${revision}" does not resolve to a commit in this repository.`,
      );
    }
    return commit;
  }

  private async lookupCommit(
    repositoryPath: string,
    revision: string,
  ): Promise<string | undefined> {
    let stdout: string;
    try {
      stdout = await this.git(repositoryPath, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${revision}^{commit}`,
      ]);
    } catch (error) {
      if (isGitExitCode(error, 1)) return undefined;
      throw error;
    }
    const commit = stdout.trim();
    return /^[0-9a-f]{40,64}$/i.test(commit) ? commit : undefined;
  }
}

async function runGit(repositoryPath: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd: repositoryPath,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}

function isGitExitCode(error: unknown, code: number): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
