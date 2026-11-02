---
name: marshal-pr-ops
description: Handle OmerMachluf/marshal PR operations for worktrees, mainline sync, rebases, conflict resolution, CI triage, targeted validation, and draft PR updates. Not for review findings; use /marshal-code-review.
allowed-tools:
  - Bash(git *)
  - Bash(gh pr *)
  - Bash(gh api repos/OmerMachluf/marshal/*)
  - Bash(pnpm *)
  - Bash(node *)
  - Bash(python *)
  - Grep
  - Glob
  - Read
  - Write
  - Agent
---

# PR Operations Skill

This skill handles the **operator workflow** around a Marshal PR without mixing that work into the live review prompt.

## Why this is separate

This skill exists to keep repeated operator runbooks out of the live review rubric. It adds value when a PR alternates between review work and operational work across many turns — rebasing, conflict resolution, CI triage, targeted reruns, and draft status updates — and you want that procedure to stay isolated from the review guidance.

Use it for:

- creating or switching worktrees for a PR branch
- identifying which remote points to `OmerMachluf/marshal` and syncing its `main` branch into the PR branch
- resolving merge or rebase conflicts
- running targeted validation commands for the touched files
- checking `gh pr checks`, failed jobs, and CI logs
- drafting PR status updates or follow-up comments for the author

## Boundaries

- **Do not do the code review here.** Use `/marshal-code-review` for review findings.
- **Do not mine historical reviewer patterns here.** Use `/derive-rules` for that.
- **Do not push, force-push, or post GitHub comments without explicit user approval.**
- **Do not assume personal paths, forks, or remote names.** Use the local repo, discover which remote points to `github.com/OmerMachluf/marshal`, and never hardcode user-specific directories.
- **Do not skip `pnpm run format:check` before commit/push when code or repo files changed.** Lint/tests do not replace the format check.

## Execution checklist

1. Inspect PR state with `gh pr view`, `gh pr checks`, `git status`, and `git branch -vv`.
2. Sync with the checked remote for `OmerMachluf/marshal` `main` using the repo's current branch strategy (merge vs rebase) and resolve conflicts surgically.
3. Run the smallest meaningful validation set for the changed files, then widen only if the touched surfaces demand it.
4. Before any commit or push for code or repo-file changes, always run `pnpm run format:check`. If it fails, fix the relevant files with the repo formatter (for example `pnpm exec oxfmt <paths>`) and rerun the check before proceeding.
5. If CI is failing, inspect the failing check or job logs before suggesting code changes.
6. Draft any PR update comment in chat first. Wait for explicit approval before posting it.

## Output style

Report:

1. current branch / PR state
2. operational actions taken
3. unresolved blockers, if any
4. a draft PR update comment when the user asks for one
