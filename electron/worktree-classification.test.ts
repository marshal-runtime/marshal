import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectWorktreeWorkspaceNames,
  isWorktreeRepoPath,
  isWorktreeWorkspaceName,
} from "./worktree-path";

/**
 * Guards the classifier behind the sidebar's worktree grouping. The bug it
 * fixes was reported as "every worktree agent became its own workspace" — one
 * real profile rendered 309 sidebar groups, nearly all single-session
 * throwaway worktrees.
 *
 * The false-positive cases matter more than the false-negative ones: wrongly
 * classifying a real workspace buries it inside the worktree group, which is
 * worse than leaving one stray worktree ungrouped.
 */
describe("isWorktreeRepoPath", () => {
  const configuredRoot = path.resolve("/configured/root");

  it("classifies a worktree under the configured root", () => {
    expect(isWorktreeRepoPath(path.join(configuredRoot, "feature-1a2b3c4d"), configuredRoot)).toBe(
      true,
    );
  });

  it("classifies a worktree under a root that is no longer configured", () => {
    // The reported profile had live worktrees under two roots simultaneously;
    // only one of them can ever be `settings.worktreeDir`.
    expect(isWorktreeRepoPath("Q:\\m-worktrees\\feature-1a2b3c4d", configuredRoot)).toBe(true);
    expect(
      isWorktreeRepoPath(
        "C:\\Users\\someone\\.marshal\\m-worktrees\\other-5e6f7a8b",
        configuredRoot,
      ),
    ).toBe(true);
  });

  it("classifies the post-rebrand directory name too", () => {
    // Existing worktrees keep their pre-rebrand absolute path because
    // `resolveWorktreesDir` deliberately does not migrate them, so BOTH names
    // stay live indefinitely.
    expect(
      isWorktreeRepoPath("/home/someone/.marshal/marshal-worktrees/x-1a2b3c4d", undefined),
    ).toBe(true);
  });

  it("does not classify an ordinary repo checkout", () => {
    expect(isWorktreeRepoPath("Q:\\src\\repos\\myrepo", configuredRoot)).toBe(false);
    expect(isWorktreeRepoPath("/home/someone/projects/my-app", configuredRoot)).toBe(false);
  });

  it("does not classify a sibling directory whose name merely starts with the root", () => {
    expect(isWorktreeRepoPath(`${configuredRoot}-backup/thing`, configuredRoot)).toBe(false);
  });

  it("does not classify the worktree root itself", () => {
    // The root is a container, not a checkout; treating it as a worktree would
    // fold a workspace bound to it into the worktree group.
    expect(isWorktreeRepoPath(configuredRoot, configuredRoot)).toBe(false);
  });

  it("does not classify a directory that merely mentions worktrees in its name", () => {
    // A real profile had user-added workspaces under `.../Web-worktrees/...`.
    // Those are repos the user deliberately added and must keep their own group.
    expect(isWorktreeRepoPath("Q:\\src\\PowerQuery\\Web-worktrees\\some-branch", undefined)).toBe(
      false,
    );
    expect(isWorktreeRepoPath("/home/someone/my-worktrees-notes", configuredRoot)).toBe(false);
  });

  it("still classifies by segment when no root is configured", () => {
    expect(isWorktreeRepoPath("Q:/m-worktrees/feature-1a2b3c4d", undefined)).toBe(true);
    expect(isWorktreeRepoPath("Q:/src/repos/m", undefined)).toBe(false);
  });
});

/**
 * Name-shape classification is what rescues the overwhelming majority of rows:
 * worktrees get deleted, and once the directory is gone the name is the only
 * evidence left. In the reported profile only 3 of 309 referenced workspaces
 * still existed.
 */
describe("isWorktreeWorkspaceName", () => {
  it("classifies the <base>-<8 hex> shape that createWorktreeWorkspace mints", () => {
    expect(isWorktreeWorkspaceName("story2193133-pq-pr4-close-apply-e96e0b61")).toBe(true);
    expect(isWorktreeWorkspaceName("nav-consolidation-5a711886")).toBe(true);
  });

  it("classifies a name carrying the collision uniquifier", () => {
    expect(isWorktreeWorkspaceName("feature-1a2b3c4d-2")).toBe(true);
  });

  it("does not classify a plain workspace name", () => {
    for (const name of ["PowerQuery", "PBI", "Monitoring", "pq-desktop", "Scratchpad"]) {
      expect(isWorktreeWorkspaceName(name)).toBe(false);
    }
  });

  it("does not classify an all-digit suffix that could be a date", () => {
    // `randomUUID().slice(0, 8)` is all digits ~2.3% of the time, so this costs
    // a few stray groups — deliberately, because `release-20260726` is a name a
    // user could plausibly choose and burying it would be the worse failure.
    expect(isWorktreeWorkspaceName("release-20260726")).toBe(false);
    expect(isWorktreeWorkspaceName("cc-integration-review-test-35777319")).toBe(false);
  });

  it("does not classify a suffix of the wrong length or alphabet", () => {
    expect(isWorktreeWorkspaceName("feature-1a2b3c4")).toBe(false);
    expect(isWorktreeWorkspaceName("feature-1a2b3c4d5")).toBe(false);
    expect(isWorktreeWorkspaceName("feature-1a2b3g4d")).toBe(false);
    expect(isWorktreeWorkspaceName("feature-1A2B3C4D")).toBe(false);
  });

  it("classifies a name that is itself an absolute path under a worktree root", () => {
    // Some rows in the reported profile stored an absolute path as the
    // workspace name.
    expect(
      isWorktreeWorkspaceName("C:\\Users\\a\\.marshal\\m-worktrees\\pr-15657215-43412061"),
    ).toBe(true);
  });

  it("does not classify a user's own external repo worktrees", () => {
    expect(isWorktreeWorkspaceName("Q:\\src\\PowerQuery\\Web-worktrees\\fix-cloudtest-yml")).toBe(
      false,
    );
    expect(isWorktreeWorkspaceName("Q:\\src\\PowerQuery\\Web.worktrees\\build-automation")).toBe(
      false,
    );
  });
});

describe("collectWorktreeWorkspaceNames", () => {
  it("resolves one verdict per name so a group cannot split in two", () => {
    // Same workspace, two sessions, only one of which still records a repoPath.
    // Per-session classification would render this name twice: once inside the
    // worktree group and once as its own.
    const names = collectWorktreeWorkspaceNames(
      [
        { workspaceName: "release-20260726", repoPath: "Q:\\m-worktrees\\release-20260726" },
        { workspaceName: "release-20260726" },
      ],
      undefined,
    );
    expect([...names]).toEqual(["release-20260726"]);
  });

  it("rescues a name whose shape is inconclusive using a sibling session's repoPath", () => {
    const names = collectWorktreeWorkspaceNames(
      [{ workspaceName: "cleanup-24495386", repoPath: "Q:\\m-worktrees\\cleanup-24495386" }],
      undefined,
    );
    expect(names.has("cleanup-24495386")).toBe(true);
  });

  it("leaves real workspaces out", () => {
    const names = collectWorktreeWorkspaceNames(
      [
        { workspaceName: "PowerQuery", repoPath: "Q:\\src\\PowerQuery\\Web" },
        { workspaceName: "PBI" },
        { workspaceName: undefined, repoPath: "Q:\\m-worktrees\\x-1a2b3c4d" },
      ],
      undefined,
    );
    expect([...names]).toEqual([]);
  });

  it("classifies by name alone once the worktree directory is gone", () => {
    const names = collectWorktreeWorkspaceNames(
      [{ workspaceName: "story2193133-config-fallback-ee83cced" }],
      undefined,
    );
    expect([...names]).toEqual(["story2193133-config-fallback-ee83cced"]);
  });
});
