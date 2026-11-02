---
name: derive-rules
description: Mine historical OmerMachluf/marshal PR review comments to derive learned rules for marshal-code-review. Not for live PR review, PR ops, or code fixes.
allowed-tools:
  - Bash(gh api *)
  - Bash(gh auth status)
  - Bash(python *)
  - Bash(python3 *)
  - Grep
  - Glob
  - Read
  - Write
---

# Rule Derivation Guide

This skill mines human GitHub review comments on merged `OmerMachluf/marshal` pull requests targeting `OmerMachluf/marshal` `main` and turns repeated feedback into concise rule files for `skills/marshal-code-review/docs/derived-rules/`.

GitHub already stores the review-exact `diffHunk` on pull request review comments, so the workflow stays simple:

```
Extract -> Enrich -> Cluster+Count -> Dedup -> Draft -> Verify -> Activate
```

## Constraints

- Scope the dataset to pull requests merged into `OmerMachluf/marshal` `main`.
- Mine all 3 reviewer channels by default (review-thread, issue, review-body). Skip bots, self-comments from the PR author, replies, and trivial comments.
- Keep learned rules in `skills/marshal-code-review/docs/derived-rules/`; do not copy them into `skills/marshal-code-review/agents/main-process.md`, `renderer.md`, or `tests.md`.
- Keep the status model explicit: `candidate`, `active`, `retired`.
- `--author default` filters to OmerMachluf. Pass `--reviewer-profiles <file>` only for a local, uncommitted profile file; never commit other people's GitHub logins.
- Keep imported reviewer heuristics in `skills/derive-rules/docs/reviewer-lens-backlog.md` until GitHub evidence validates them.
- Activate a rule only when it has at least 3 independent examples across different PRs.
- Cap active rules at **20**. If a new activation would exceed the budget, surface retirement candidates based on weak evidence, low recent hit rate, or overlap with stronger active rules, but do not retire anything without explicit approval.

## Execution

1. Verify prerequisites:
   - `gh auth status`
   - Python 3
   - local checkout of the `m` repo
2. Extract comments with `skills/derive-rules/scripts/marshal-extract-human-comments.py`. Use `--author default` when you want the checked-in high-signal reviewer subset. By default all 3 channels are mined (`--channels review-thread,issue,review-body`); pass `--channels` to restrict to a subset.
3. Enrich them with `skills/derive-rules/scripts/marshal-enrich-with-diff.py`.
4. Read `docs/rule-derivation-guide.md`, `docs/marshal-data-exploration.md`, `docs/reviewer-lens-backlog.md`, and `../marshal-code-review/docs/derived-rules/README.md` before clustering.
5. Cross-check candidates against:
   - `skills/marshal-code-review/agents/main-process.md`
   - `skills/marshal-code-review/agents/renderer.md`
   - `skills/marshal-code-review/agents/tests.md`
   - `skills/marshal-code-review/docs/derived-rules/*.md`
6. Draft concise candidate rules with:
   - `Guideline`
   - `Why`
   - `Detection signal`
   - `Example`
   - `Exceptions`
   - collapsed provenance (`details`) for reviewer spread and evidence links
7. Verify on archived PRs before proposing activation or retirement.
8. If a new activation would exceed the 20-rule budget, recommend retirement candidates instead of auto-removing anything.

## GitHub-specific notes

- `reviewThreads.comments(first: 1)` selects only the thread-opening comment.
- `diffHunk` is already review-exact, so enrichment mostly normalizes file change types and backfills missing context from the PR file patch.
- GitHub has no "won't fix" / "by design" thread status. Treat `isResolved` and `isOutdated` as metadata, not as proof that feedback was accepted or rejected.
