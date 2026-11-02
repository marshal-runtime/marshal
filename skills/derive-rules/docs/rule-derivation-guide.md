# Rule Derivation Guide

This process mines human GitHub review comments to discover recurring patterns that can become learned rules for `skills/marshal-code-review/agents/learned-patterns.md`.

## Overview

```
Extract -> Enrich -> Cluster+Count -> Dedup -> Draft -> Verify -> Activate
```

| Parameter         | Value                                      |
| ----------------- | ------------------------------------------ |
| Data source       | GitHub GraphQL v4 + REST v3 via `gh api`   |
| Target repository | `OmerMachluf/marshal`                               |
| Target branch     | `main`                                     |
| Candidate output  | `skills/marshal-code-review/docs/derived-rules/` |

---

## Constraints

**Scope boundaries:**

- Only mine pull requests merged into `OmerMachluf/marshal` `main`
- Keep learned rules in `skills/marshal-code-review/docs/derived-rules/`
- Do not copy learned rules into `skills/marshal-code-review/agents/main-process.md`, `renderer.md`, or `tests.md`
- Keep the status model explicit: `candidate`, `active`, `retired`
- Do not retire a rule or activate past the budget without explicit user approval

**Quality gates - do not activate a rule if:**

- It has fewer than 3 independent examples from different PRs
- It is already covered by `skills/marshal-code-review/agents/*.md` or an existing active rule
- It has no clear exceptions or negative boundary
- You cannot verify the rule against archived PRs without obvious false positives
- Activating it would exceed the 20-rule budget and you do not have a concrete retirement recommendation

---

## Input Prerequisites

- GitHub CLI authenticated: `gh auth status`
- Python 3
- Local checkout of the `m` repo

---

## Step 1: Extract Reviewer Comments

Pull human review comments from merged PRs over a 3-week window. The extractor mines **3 channels** by default:

| Channel         | Source                              | `filePath` value | Has `DiffHunk` |
| --------------- | ----------------------------------- | ---------------- | -------------- |
| `review-thread` | Inline code-anchored review threads | real file path   | yes            |
| `issue`         | Top-level PR discussion comments    | `(issue-level)`  | no             |
| `review-body`   | Formal review submissions with body | `(review-body)`  | no             |

```bash
python3 skills/derive-rules/scripts/marshal-extract-human-comments.py \
  --start-date 2026-03-01 \
  --end-date 2026-03-22 \
  --author default \
  --output human-comments-2026-03-01_2026-03-22.json
```

Use `--channels review-thread,issue,review-body` to restrict to a subset (default is all three).

- `--author default` uses the configured reviewer login allowlist. Use `--author "login1,login2"` for a custom set.
- `--author default` filters to OmerMachluf. Reviewer priority tiers come only from an optional local `--reviewer-profiles` file, which is never committed.
- The extractor searches `repo:<owner>/<repo> is:pr is:merged base:main merged:<range>` and then reads `reviewThreads`, `comments`, and `reviews` for each PR.
- Only thread-opening review comments are kept for `review-thread`. Bots, self-comments from the PR author, and very short comments are skipped across all channels.

Each extracted record contains:

| Field                             | Description                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `PullRequestNumber`               | GitHub pull request number                                                       |
| `Comment`                         | Reviewer comment text                                                            |
| `CommentKind`                     | Channel: `"review-thread"`, `"issue"`, or `"review-body"`                        |
| `filePath`                        | File the comment was left on, or sentinel `(issue-level)` / `(review-body)`      |
| `DiffHunk`                        | Review-exact diff snippet from GitHub (empty for issue and review-body channels) |
| `ReviewAuthor`                    | Reviewer login                                                                   |
| `ReviewerDisplayName`             | Display name from the checked-in reviewer profile, when configured               |
| `ReviewerPriority`                | Reviewer priority tier from the checked-in profile config                        |
| `IsTopPriorityReviewer`           | Whether the comment came from a top-priority reviewer                            |
| `ReviewerInDefaultAuthorFilter`   | Whether `--author default` would keep this reviewer                              |
| `ReviewState`                     | Review state (`COMMENTED`, `APPROVED`, `CHANGES_REQUESTED`) when available       |
| `CommitOid` / `OriginalCommitOid` | Commit SHAs GitHub anchors the comment to                                        |
| `IsResolved` / `IsOutdated`       | GitHub thread metadata for later interpretation (always false for non-thread)    |

---

## Step 2: Enrich with Diff Metadata

Normalize change type and backfill missing diff context from PR file metadata.

```bash
python3 skills/derive-rules/scripts/marshal-enrich-with-diff.py \
  --output enriched-2026-03-01_2026-03-22.json \
  human-comments-2026-03-01_2026-03-22.json
```

- `DiffHunk` remains the primary signal because it reflects exactly what the reviewer saw.
- When `DiffHunk` is missing, the script falls back to the PR file `patch`.
- The enriched output adds:
  - `ChangeType` (`edit`, `new_file`, `deleted_file`, `renamed_file`, `unknown`)
  - `PullRequestFileStatus` (raw GitHub file status)
  - `DiffSource` (`review_thread`, `pull_request_file`, `missing`)

---

## Step 3: Profile the Dataset

Count total records, unique PRs, unique files, change types, reviewer spread, top-priority reviewer coverage, and the proportion of exact-vs-fallback diff context. This tells you whether the run has enough signal before clustering.

---

## Step 4: Cluster + Count

Read through every comment and assign each to a semantic cluster. Clustering and counting should happen together so PR spread is exact.

**Do not use keyword matching alone.** Group by meaning. Examples like:

- "Please do not hardcode this setting"
- "Can we make this config driven?"
- "This should come from settings instead of being inline"

...belong to the same candidate if they describe the same implementable trigger.

**Required artifacts - the step is not complete without all three:**

1. **Indexed comment file** (`comments-indexed.txt`) with one line per record:
   `NNN | PR 786 | src/file.ts | <comment text>`
2. **Assignments list** tracking cluster decisions by index:
   `ASSIGNMENTS = ["C1", "X", "C1", None, ...]`
3. **PR spread summary** showing exact PR list, PR spread, and comment count per cluster

**Candidate threshold:** PR spread >= 3 and the trigger is specific enough to translate into durable review guidance.

If you are starting from imported heuristics instead of a blank clustering pass, use `skills/derive-rules/docs/reviewer-lens-backlog.md` as the hypothesis list. A backlog item still needs the same GitHub evidence bar before it becomes a candidate rule note.

---

## Step 5: Cross-Check Against the Existing Review Surface

Read all existing review guidance before writing anything. Drop or merge candidates that are already covered.

For this repo, check:

- `skills/marshal-code-review/agents/main-process.md`
- `skills/marshal-code-review/agents/renderer.md`
- `skills/marshal-code-review/agents/tests.md`
- `skills/marshal-code-review/docs/derived-rules/README.md`
- `skills/marshal-code-review/docs/derived-rules/*.md`

Remember: the rule files are the single source of truth for learned patterns. If a concern is already an `active` rule, do not rewrite it with different wording.

---

## Step 6: Assign the Review Surface

Decide which review surface the learned rule belongs to:

- **`main-process`** -> infrastructure, IPC, persistence, scripts, model/tool registration
- **`renderer`** -> React, UI state, accessibility, renderer-side composition
- **`tests`** -> mock validity, behavioral coverage, test-layer correctness

All learned rules are consumed by `skills/marshal-code-review/agents/learned-patterns.md`; the surface tag only tells that agent where the rule should fire.

---

## Step 7: Write a Concise Rule Note

Each rule file should stay review-time friendly. Keep the main body to:

- **Status** - `candidate`, `active`, or `retired`
- **Review surface** - `main-process`, `renderer`, or `tests`
- **Guideline** - one sentence
- **Why** - one sentence on the concrete risk
- **Detection signal** - what to look for, with path filter inline
- **Example** - one real inline code snippet showing the bad pattern
- **Exceptions** - when to stay silent

Put reviewer spread, PR counts, evidence URLs, and activation / retirement notes in a collapsed `<details>` section so provenance stays available without dominating the rule text.

---

## Step 8: Ground the Example in a Real Diff Hunk

Examples must come from actual PR comments in the dataset.

- **Positive example** - from a record where the reviewer flagged the pattern
- **Negative boundary** - can live in the `Exceptions` section or provenance details when it helps explain when to stay silent

Do not invent toy examples when the dataset already contains the real thing.

---

## Step 9: Iterate on Precision

If a candidate is too broad:

- tighten the detection signal
- narrow the path filter
- add stronger exceptions
- split the cluster into two narrower rules

Prompt-driven learned rules are especially sensitive to vague wording, so keep each rule concrete and bounded.

---

## Step 10: Verify Against Archived PRs

Because `marshal-code-review` is prompt-driven, verification is manual but still structured:

1. Re-open at least 2 positive PRs and confirm the candidate rule explains the historical comment accurately.
2. Check at least 1 negative PR where the surface pattern appears but the rule should stay silent.
3. If the rule is being activated, compare it against the core agent prompts and existing active rules to confirm it adds new signal rather than duplicating something stronger.

If the candidate cannot survive that check, keep it as a note or drop it.

---

## Step 11: Manage the Active Rule Budget

Cap active rules at **20**. When a new activation would exceed the budget:

1. Review the existing active rules and identify retirement candidates based on:
   - weakest evidence spread
   - low recent hit rate in the latest mining window
   - material overlap with a stronger active rule
   - obsolete or overly narrow surface coverage
2. Present those retirement candidates with reasons.
3. Wait for explicit approval before retiring anything or activating past the cap.

The derive-rules flow should recommend curation; it should not silently remove rules.

---

## Step 12: Activate, Park, or Retire

- **Activate** - mark the rule `active` in `skills/marshal-code-review/docs/derived-rules/` after explicit user approval; `agents/learned-patterns.md` will pick it up automatically
- **Park** - keep the rule as `candidate`
- **Retire** - mark the rule `retired` after explicit user approval and remove it from the active table in `README.md`
- **Drop** - remove it from the run output if the evidence or specificity is too weak

---

## Quality Bar

A rule is ready to activate when:

- it is grounded in at least 3 independent PRs
- the detection signal is specific and reviewable
- the exceptions are clear enough to avoid obvious false positives
- it adds new value beyond the current core prompts and active learned rules
- it fits within the active-rule budget or comes with a concrete retirement recommendation

---

## Anti-Patterns

- Activating a rule from a single PR
- Treating `isResolved` as proof that the reviewer was correct
- Writing vague rules like "code should be cleaner"
- Copying a learned rule into a core agent prompt
- Activating too many rules at once instead of curating the strongest set
