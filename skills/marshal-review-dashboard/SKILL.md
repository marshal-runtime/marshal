---
name: marshal-review-dashboard
description: Lists open PRs in OmerMachluf/marshal grouped by what needs my attention — unreviewed, stale-my-review (author pushed after I commented), and my own PRs with new feedback. Prefetches diffs + comments into a local cache so downstream `/marshal-code-review` runs don't re-hit `gh`. Prints a ready-to-paste Zellij launcher per PR.
allowed-tools:
  - Bash(python3 skills/marshal-review-dashboard/scripts/list-prs.py:*)
  - Bash(python3 skills/marshal-code-review/scripts/fetch-pr-cache.py:*)
  - Bash(gh pr list *)
  - Bash(gh pr view *)
  - Bash(gh pr diff *)
  - Bash(gh pr checks *)
  - Bash(gh auth status *)
  - Bash(gh api repos/OmerMachluf/marshal/*)
  - Read
---

# PR Review Dashboard (OmerMachluf/marshal)

Structured view of the PR queue so I can decide what to review next without scrolling through the GitHub UI.

## What it does

Runs `list-prs.py` to bucket open PRs updated within the lookback window into three groups:

| Bucket                                     | Rule                                                                                               | What the report shows                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Needs review**                           | PR author is not me AND I have no reviews/comments on it.                                          | Title, author, last push, which (if any) non-creator commenters are already engaged. |
| **Stale — author pushed after my comment** | PR author is not me AND I've commented/reviewed AND the head commit is newer than my last comment. | How long since my last comment and how many commits were pushed since.               |
| **My PRs with new feedback**               | PR author is me AND someone else commented/reviewed AFTER my last push.                            | Who commented and when.                                                              |

Anything that matches none of the three (e.g. a PR I already reviewed with no new push, or my own PR with no new feedback) is dropped from the report.

PRs are also hidden by default when any of the four merge-blocking checks is failing — **Chore**, **Unit Tests**, **E2E Tests**, or **Lint & Format**. There's no point reviewing code the author already needs to touch again. A footer section lists each hidden PR with the failing categories so they're not silently swallowed; pass `--include-failing` to surface them anyway. Pending / in-progress checks don't trigger the filter — only `bucket == "fail"` counts. ("Chore" covers the GitHub "PR template" workflow — i.e., the description doesn't match the template.)

The output puts **Stale** before **Needs review** because re-engaging on a PR I've already touched is usually more time-efficient than picking up a fresh one. Within **Needs review**, PRs are sorted by author trust tier:

| Tier         | Source                                                                                                                           | Marker         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `maintainer` | PR has the `maintainer` label (added by `.github/scripts/marshal-pr-labeler.cjs` from the global `*` rule in `docs/CODEOWNERS`). | `(maintainer)` |
| `trusted`    | PR author is in the local gitignored `skills/marshal-review-dashboard/.trusted-contributors` file.                               | `(trusted)`    |
| `other`      | Neither.                                                                                                                         | (no marker)    |

The trusted-contributors file is per-reviewer — gitignored on purpose so each reviewer keeps their own list. Format: one GitHub login per line, with or without a leading `@`; blank lines and `#` comments allowed. Inline comments after `#` are also stripped:

```
# Promoted from contributor 2026-Q1, regression-aware reviewer
@alice-example
bob-example  # paged me into this area, deserves priority
```

Within each tier, PRs keep gh's default ordering (most recently updated first).

Each entry is tagged with a size bucket — `XS`/`S`/`M`/`L`/`XL` — derived from `additions + deletions`:

| Bucket | Range (added+removed) | Rough review budget |
| ------ | --------------------- | ------------------- |
| `XS`   | `< 100`               | trivial, <5 min     |
| `S`    | `< 500`               | 10–20 min           |
| `M`    | `< 1500`              | 30–45 min           |
| `L`    | `< 3500`              | 1–2 hours           |
| `XL`   | `≥ 3500`              | dedicated session   |

The raw `+added/-removed across N files` count is printed under each entry for a sanity check.

## Running it

```bash
# default: last 7 days, hide own PRs, skip drafts, prefetch cache, human output
python3 skills/marshal-review-dashboard/scripts/list-prs.py

# narrow the window
python3 skills/marshal-review-dashboard/scripts/list-prs.py --days 3

# show own PRs (the "My PRs with new feedback" bucket)
python3 skills/marshal-review-dashboard/scripts/list-prs.py --include-mine

# exclude additional authors (repeatable, case-insensitive)
python3 skills/marshal-review-dashboard/scripts/list-prs.py --exclude-author somebody --exclude-author another

# include drafts
python3 skills/marshal-review-dashboard/scripts/list-prs.py --include-drafts

# skip the cache prefetch (faster, but /marshal-code-review will fetch on demand)
python3 skills/marshal-review-dashboard/scripts/list-prs.py --no-prefetch

# include PRs whose CI is failing (Chore / Unit Tests / E2E / Lint & Format)
python3 skills/marshal-review-dashboard/scripts/list-prs.py --include-failing

# machine-readable
python3 skills/marshal-review-dashboard/scripts/list-prs.py --json

# override auto-detected login (if you're signed into multiple GitHub accounts)
python3 skills/marshal-review-dashboard/scripts/list-prs.py --me your-login
```

Human output prints each PR followed by a ready-to-paste launcher that calls `launch-review.sh` with the PR number:

```
bash "<repo>/skills/marshal-review-dashboard/scripts/launch-review.sh" 1147
```

Pasting that into your shell opens a new terminal window running a shared Zellij session (`marshal-review`). Each PR lands as a tab inside that session, cwd'd to the repo, with Claude Code started interactively and `/marshal-code-review <pr-url>` pre-populated — just press Enter to begin. Re-running the same command focuses the existing tab instead of duplicating it.

Platform notes:

- **Windows**: spawns a Windows Terminal window (requires `wt.exe`).
- **macOS**: spawns a terminal app window (requires `brew install zellij`). Probe order is Ghostty → iTerm → Terminal.app, with overrides via `MARSHAL_REVIEW_TERMINAL=Ghostty|iTerm|Terminal` or the `$TERMINAL` env var.
- **Linux**: backgrounds zellij; attach manually with `zellij attach marshal-review`.

If you close the terminal window the zellij session keeps running detached. Subsequent launches will silently add tabs to it but won't open a new visible window. To bring an orphaned session back on screen (macOS):

```bash
bash skills/marshal-review-dashboard/scripts/launch-review.sh --reattach
```

Render PR references as Markdown links, for example `[#<number>](https://github.com/OmerMachluf/marshal/pull/<number>)`.

## Cache behaviour

Unless `--no-prefetch` is passed, each surfaced PR triggers `skills/marshal-code-review/scripts/fetch-pr-cache.py`, which writes seven artifacts under `<tempfile.gettempdir()>/marshal-code-review/pr-<n>/` — `/tmp/marshal-code-review/pr-<n>/` on macOS/Linux, `C:\Users\<user>\AppData\Local\Temp\marshal-code-review\pr-<n>\` on Windows. The `--json` mode of the cache script prints the resolved absolute directory as `"dir"` for downstream consumers:

- `head-sha` — the commit SHA whose artifacts are cached (used for staleness checks)
- `metadata.json` — PR metadata from `gh pr view`
- `diff.patch` — `gh pr diff` output
- `reviews.json` — formal reviews
- `pulls-comments.json` — inline review comments
- `issues-comments.json` — discussion comments
- `checks.json` — CI check status

The `marshal-code-review` skill reads from this cache first and only falls back to `gh` if artifacts are missing or the head SHA has changed. With the cache warm, sub-agents do not need any `gh` permission prompts.

## JSON shape (for the future workflow layer)

```json
{
  "generated_at": "2026-04-20T10:00:00+00:00",
  "me": "your-login",
  "window_days": 3,
  "buckets": {
    "needs_review": [ { "number": 1152, "title": "...", "author": "...", "url": "...", "last_push_at": "...", "other_commenters": [...], "additions": 302, "deletions": 67, "changed_files": 8, "size_bucket": "S", "tier": "maintainer", "blocking_failures": [], "zellij_command": "..." } ],
    "stale_my_review": [ ... ],
    "my_prs_with_feedback": [ ... ],
    "hidden_failing_ci": [ { ..., "blocking_failures": ["Lint & Format"], "source_bucket": "needs_review" } ]
  }
}
```

`zellij_command` is included per entry so a launcher that consumes the JSON doesn't need to rebuild the command.

## When to invoke the skill

- Starting a review session and wanting a queue.
- Checking if anyone responded to a review I posted.
- Batch-deciding which PRs to schedule for the day.

Not a replacement for `marshal-code-review` itself — this is the "which PR next?" step before the "review this PR" step.
