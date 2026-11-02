# Rule Discovery from GitHub PR Comments

Process for mining historical human review comments from merged GitHub pull requests in `OmerMachluf/marshal`, discovering repeatable review patterns, and maintaining learned rules for `skills/marshal-code-review/agents/learned-patterns.md`.

## Pipeline

```
Extract -> Enrich -> Cluster+Count -> Dedup -> Draft -> Verify -> Activate
```

Each run should be self-contained. Because `m` has lower PR volume than Sydney, start with a 3-week window by default so the dataset has enough density to reach the 3-PR evidence threshold.

## Rule Discovery Process

1. **Extract** - Collect human review-thread opening comments from merged PRs targeting `OmerMachluf/marshal` `main`. The extractor uses GitHub search to find merged PRs in the date window, then reads `reviewThreads` so each record stays tied to a specific file path and review comment. Implementation: `marshal-extract-human-comments.py`.

2. **Enrich** - Normalize change type and diff context for each extracted comment. GitHub already provides `diffHunk` on review comments, so enrichment mostly backfills missing context from PR file metadata and annotates each record with a normalized `ChangeType`. Implementation: `marshal-enrich-with-diff.py`.

3. **Cluster + Count** - Group comments by semantic theme and compute exact PR spread for each candidate pattern. Treat paraphrases as the same cluster when they point to the same implementable trigger.

4. **Dedup** - Compare candidates against the live review surface:
   - hand-curated core prompts in `skills/marshal-code-review/agents/*.md`
   - learned rule files in `skills/marshal-code-review/docs/derived-rules/*.md`

5. **Draft** - Write concise candidate rule notes under `skills/marshal-code-review/docs/derived-rules/`. These files are the single source of truth for learned patterns.

6. **Verify** - Re-check candidate rules against archived PRs with both positive and negative examples before activation.

7. **Activate / Retire** - With explicit approval, move rules between `candidate`, `active`, and `retired`. Active rules are picked up by `skills/marshal-code-review/agents/learned-patterns.md`; core prompts stay hand-curated.

## Key Files

### Scripts

| File                                           | Phase   | Purpose                                                                            |
| ---------------------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `../scripts/marshal-extract-human-comments.py` | Extract | Pulls GitHub review-thread opening comments from merged PRs on `OmerMachluf/marshal` `main` |
| `../scripts/marshal-enrich-with-diff.py`       | Enrich  | Adds normalized change type metadata and PR patch fallback context                 |

### Configuration

| File                                | Purpose                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |

### Documentation

| File                                                     | Purpose                                                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `rule-derivation-guide.md`                               | End-to-end guide from extraction to activation                                                 |
| `marshal-data-exploration.md`                            | GitHub data model, filter pipeline, and GraphQL/REST queries                                   |
| `reviewer-lens-backlog.md`                               | Seed backlog of imported reviewer heuristics that still need GitHub evidence before activation |
| `../../marshal-code-review/docs/derived-rules/README.md` | Status model, active-rule budget, and the current candidate/active/retired rule tables         |

## Design Decisions

- **GitHub-native extraction** - Use `gh api graphql` and `gh api`. GitHub already exposes review-thread metadata, diff hunks, and PR file statuses.
- **Direct repo targeting** - The scripts default to `OmerMachluf/marshal` so the workflow works the same for direct clones and fork-based worktrees.
- **Three-week default window** - `m` is smaller than the Sydney repo, so a 21-day default improves the odds of finding 3 independent examples per candidate.
- **Reviewer profiles are checked in** - Keep the default reviewer allowlist and priority tiers in JSON so the extractor stays shared, auditable, and repo-native.
- **Learned rules live next to the review skill** - This repo has no separate guard-rule repository, so rule files are kept under `skills/marshal-code-review/docs/derived-rules/`.
- **Core agents stay hand-curated** - Historical comments shape learned rules, but those rules are applied by `agents/learned-patterns.md`, not copied into the core prompts.
- **Manual activation / retirement gate** - `marshal-code-review` is prompt-driven rather than a deterministic rule engine, so every status change still needs a human decision.
- **Active rule budget** - Cap active rules at 20 so the learned-patterns pass stays bounded and curated.
