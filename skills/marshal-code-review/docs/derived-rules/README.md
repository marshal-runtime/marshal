<!-- Marshal-owned code-review guidance. -->
# Derived Review Rules

This directory holds learned review rules mined from historical GitHub pull request comments. These rule files are the single source of truth for `../../agents/learned-patterns.md`; the core review agents stay hand-curated.

## Status model

- `candidate` — evidence-backed note that is not used during live review yet
- `active` — applied by `../../agents/learned-patterns.md`
- `retired` — kept for provenance, but ignored during live review

## Rule format

Keep each rule concise at review time:

- status + review surface
- **Guideline**
- **Why**
- **Detection signal** (include path filter inline)
- **Example**
- **Exceptions**

Keep evidence metadata, reviewer spread, and activation notes in a collapsed `details` block so the rule stays scannable during review.

## Active rule budget

Cap active rules at **20**. When a new activation would exceed the budget, `derive-rules` must surface retirement candidates based on weak evidence, low recent hit rate in the latest mining window, or overlap with a stronger active rule. Do not retire a rule or activate past the cap without explicit approval.

## Activation bar

Only activate a candidate when it:

- is grounded in at least 3 independent PRs
- adds new signal beyond the core agent prompts and existing active rules
- has clear exceptions or a negative boundary
- survives a manual replay against archived PRs
- fits within the 20-rule budget or comes with a concrete retirement recommendation

## Current candidates

| Rule                                                  | Status      | Review surface | Evidence              | Notes                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ----------- | -------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-04-06-magic-string-to-constant-config-drift.md` | `candidate` | `main-process` | 4 PRs / 4 comments    | Novel config/schema drift cluster; keep parked until the cluster narrows or widens.                                                                                                                                                                      |
| `2026-05-04-review-output-discipline.md`              | `candidate` | orchestrator   | 17 PRs / ~17 comments | Skill-posting behavior, not a code-review rule. Worth promoting to a SKILL.md note rather than activating as a learned-patterns rule. **Now partially superseded by `2026-05-06-ai-generated-code-comment-noise.md` (active) for the code-author half.** |

## Active rules

| Rule                                            | Status   | Review surface                   | Notes                                                                                                                                                                                                                                        |
| ----------------------------------------------- | -------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-05-06-ai-generated-code-comment-noise.md` | `active` | `renderer` (also `main-process`) | Activated 2026-05-06: 6+ PRs of evidence ("agent added a ton of comments"). Three flag classes — trivial restatement (A), historical narration (B), mojibake — plus an explicit Class C "do NOT flag" list so load-bearing comments survive. |

## Retired rules

| Rule                                                        | Retired    | Superseded by                                                                                 |
| ----------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `2026-03-31-renderer-effect-cleanup.md`                     | 2026-05-06 | `agents/react.md` §2 ("Effects need cleanup; subscriptions need stable callbacks")            |
| `2026-04-21-reuse-existing-codebase-primitives.md`          | 2026-05-06 | `agents/renderer-primitives.md` §1 ("Reuse existing codebase primitives")                     |
| `2026-03-31-model-facing-contract-honesty.md`               | 2026-05-06 | `agents/main-process.md` Input Validation & Security ("Model-facing contract honesty" bullet) |
| `2026-03-31-platform-native-paths-and-fail-fast-scripts.md` | 2026-05-06 | `agents/main-process.md` Cross-platform parity ("Build / release / support scripts" bullet)   |

Files are kept on disk for provenance and historical evidence; `agents/learned-patterns.md` ignores any rule with `Status: retired`.
