---
name: publish-pr
description: Guide a contributor through opening a Marshal PR with a fully-filled template. Loads docs/pull_request_template.md at runtime, asks the right questions, and creates the PR with `gh pr create`. Use when the user says "publish PR", "open a PR", "create pull request", or otherwise indicates they're ready to publish work.
allowed-tools:
  - Bash(git *)
  - Bash(gh pr *)
  - Bash(gh repo *)
  - Bash(gh api *)
  - Read
  - Write
  - Glob
  - Grep
---

# Publish PR Skill

Walks the user through filling in the Marshal PR template before opening
a pull request. The template is the **single source of truth** — this
skill loads `docs/pull_request_template.md` at runtime so it never
drifts when the template evolves.

## Why this skill exists

PRs against `OmerMachluf/marshal` are gated by a `PR template` check that fails
unless every required section has content and the platform / marshal-code-review
checkboxes are filled. Doing this by hand is tedious and easy to forget;
this skill turns it into a guided conversation that produces a
template-compliant body and creates the PR.

## Boundaries

- **Do not run `pnpm test`, `pnpm lint`, or `pnpm typecheck`.** CI handles
  those — they're slow and not the point of this skill.
- **Do not push commits without explicit user approval.** Offer to push
  if the branch isn't published yet, but wait for the user's `yes`.
- **Do not create the PR before showing the user the assembled body.**
  They review and approve the body first.
- **Do not assume the user already ran `/marshal-code-review`.** Ask. If they
  haven't, strongly suggest it.
- **Do not try to attach screenshots via the API.** GitHub's image
  uploader is web-only — write a placeholder and remind the user to
  drag-drop screenshots after publish.

## Execution checklist

### 1. Sanity-check the branch

- `git status` is clean (no uncommitted changes). Abort if dirty — ask
  the user to commit or stash first.
- Confirm the user is not on `main`.
- Confirm there are commits ahead of `origin/main` (otherwise there's
  nothing to publish).

### 2. Load the template

Read `docs/pull_request_template.md` from the repo root. Parse the
top-level `## ` headers in order. The skill walks through whatever
sections exist — never hardcode a section list. If the template file is
missing or moved, fall back to a built-in section set and warn the user
the skill is out of date.

**Decide which template to offer** — default unless every chore
condition is satisfied:

1. **Author is a CODEOWNER.** Read `docs/CODEOWNERS`, parse the `*`
   line, check `gh api user --jq .login` against it. If not a
   CODEOWNER → use the default template.
2. **Diff is in the chore allowlist.** Run `git diff --name-only main..HEAD`
   and confirm every path matches one of: `package.json`,
   `pnpm-lock.yaml`, `skills/`, `.github/`, `scripts/`, `docs/`. If any
   file is under `electron/` or `src/`, or anywhere else → use the
   default template.
3. **Title prefix is allowlisted.** The skill drafts a title from
   commit messages in step 3 below. _After drafting_, check that the
   prefix matches `chore(deps|skills|ci|internal):`, `chore: bump to v…`,
   or `docs(internal):`. If the drafted title doesn't match, either
   adjust the title (with the user's confirmation) or fall back to the
   default template.

If all three pass, offer the chore template; otherwise, default. Never
silently switch — tell the user which template is being used and why.
If the user wants to override the decision (e.g., the heuristics
mis-classify), let them.

### 3. Pre-fill what's mechanically derivable

For each section, draft a starting point from repo state:

- **`## What`** — synthesize from `git log main..HEAD --oneline` (1-3
  sentences, model writes it).
- **`## Why`** — draft from commit message bodies; the user edits.
- **`## Linked issue`** — parse the branch name for `#N`, parse commit
  messages for `Fixes #N` / `Refs #N`. If multiple matches, ask which
  one. If none, ask the user for the issue number.
- **`## Scope`** — draft from `git diff --stat main..HEAD` grouped by
  directory.

### 4. Walk through what isn't derivable

- **`## Test plan`** — interactive. Suggest platform-specific surfaces
  from the diff (e.g., touching `electron/window-taskbar.ts` flags
  both Windows and macOS).
- **Platform checkboxes** — ask "macOS, Windows, both, or N/A?" and
  render the boxes accordingly.
- **`## Screenshots`** — if any `src/**/*.tsx` files changed, write
  the placeholder text _"*To be added after publish — see comment
  below.*"_ into the section. After PR creation, **print a clear
  reminder** to drag-drop screenshots into the GitHub web UI. (GitHub's
  image upload doesn't work via API — this is a documented limitation,
  not a bug to fix.)

### 5. Pre-publish question — marshal-code-review

This is the single most important question the skill asks.

> **"Did you run `/marshal-code-review` on this branch already?"**

- If **yes** → check the box in `## Test plan`, continue.
- If **no** → strongly suggest running it first. Offer to invoke
  `/marshal-code-review` inline. If the user declines, leave the checkbox
  unchecked and warn that the enforcement workflow will fail. Author
  chooses: do the work now, or do it after the red X.

### 6. Show, approve, create

- Print the full assembled PR body for review.
- Ask: "Edit anything, or open the PR?"
- After approval, write the body to a tempfile and run:
  ```bash
  gh pr create --base main --body-file <tempfile> [--draft if requested]
  ```
- Print the resulting PR URL.
- If the diff has UI changes, also print the screenshot reminder and
  optionally `gh pr view --web` to make it one-click.

## Failure modes

| Symptom                          | What to do                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `gh` CLI not installed           | Print the body and instruct the user to paste it into a PR they create manually. |
| Branch not pushed yet            | Offer to run `git push -u origin <branch>` for them, or instruct.                |
| Multiple linked-issue candidates | Ask which one.                                                                   |
| Template file missing or moved   | Fall back to the default section set and warn the user the skill needs updating. |
| User on `main`                   | Refuse — ask them to create a feature branch first.                              |
| Working tree dirty               | Refuse — ask them to commit or stash first.                                      |

## Output

A single PR URL printed at the end, plus a reminder to add screenshots
manually if the diff included UI changes. No summary message — the URL
is enough.
