import path from "node:path";

/**
 * A path segment for the directory we create subagent worktrees in — both the
 * current name and the pre-rebrand one, since existing worktrees keep the
 * absolute path they were created with (`resolveWorktreesDir` deliberately does
 * not migrate them; the git links inside are absolute).
 *
 * Anchored on a leading slash so it matches `.../m-worktrees/x` but NOT a
 * user's own `.../Web-worktrees/x` — those are repos the user added
 * deliberately and must keep their own sidebar group.
 *
 * TODO(marshal-sunset): drop the legacy `m-worktrees` alternative once no
 * install still holds worktrees created under the pre-rebrand directory.
 */
const WORKTREE_PATH_SEGMENT = /\/(?:m|marshal)-worktrees\//i;

/**
 * `createWorktreeWorkspace` mints `<base>-<8 hex>` from
 * `randomUUID().slice(0, 8)`, with an optional `-<n>` uniquifier appended on
 * collision. That shape is the only evidence that survives the worktree being
 * deleted, which is the common case: in the profile that surfaced this bug only
 * 3 of 309 referenced workspaces still existed in the registry.
 */
const WORKTREE_NAME_SUFFIX = /-([0-9a-f]{8})(?:-\d+)?$/;

/**
 * Whether `repoPath` is a subagent worktree checkout rather than a workspace
 * the user created.
 *
 * `worktreeRoot` alone is not sufficient: `settings.worktreeDir` moves, and
 * existing worktrees keep the absolute path they were created with, so one real
 * profile had live worktrees under two different roots at once. The segment
 * check catches those; the root check catches a root pointed somewhere that
 * does not carry our directory name.
 */
export function isWorktreeRepoPath(repoPath: string, worktreeRoot: string | undefined): boolean {
  if (WORKTREE_PATH_SEGMENT.test(repoPath.replace(/\\/g, "/"))) return true;
  if (worktreeRoot === undefined) return false;
  const relative = path.relative(worktreeRoot, path.resolve(repoPath));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Whether a workspace *name* was minted for a subagent worktree, judged from
 * the name alone — this is what classifies the sessions whose worktree is
 * already deleted.
 *
 * Requires at least one `a`-`f` in the suffix even though `randomUUID` can
 * produce all digits (~2.3% of the time). An all-digit 8-character suffix is
 * indistinguishable from a date a user might genuinely use
 * (`release-20260726`), and the two failure modes are not symmetric: missing a
 * worktree leaves one extra sidebar group, while a false positive buries a
 * workspace the user cares about inside the worktree group. Measured against a
 * real 309-workspace profile this costs 3 stray groups and produces zero false
 * positives.
 */
export function isWorktreeWorkspaceName(workspaceName: string): boolean {
  if (WORKTREE_PATH_SEGMENT.test(workspaceName.replace(/\\/g, "/"))) return true;
  const match = WORKTREE_NAME_SUFFIX.exec(workspaceName);
  return match !== null && /[a-f]/.test(match[1]);
}

/**
 * The workspace names in `sessions` that are subagent worktrees rather than
 * workspaces the user created.
 *
 * Resolved per *name* rather than per session on purpose: the sidebar groups by
 * name, so two sessions sharing a name reaching opposite verdicts would split
 * one workspace across two groups. A name is a worktree if its shape says so,
 * or if any session under it is checked out inside a worktree root.
 */
export function collectWorktreeWorkspaceNames(
  sessions: readonly { workspaceName?: string; repoPath?: string }[],
  worktreeRoot: string | undefined,
): Set<string> {
  const worktreeNames = new Set<string>();
  for (const session of sessions) {
    const name = session.workspaceName;
    if (!name || worktreeNames.has(name)) continue;
    if (
      isWorktreeWorkspaceName(name) ||
      (session.repoPath !== undefined && isWorktreeRepoPath(session.repoPath, worktreeRoot))
    ) {
      worktreeNames.add(name);
    }
  }
  return worktreeNames;
}
