# Reviewer lens backlog

These backlog items came from an earlier review-skill comparison. The table below now tracks their current evidence status. Any lens that is still only a hypothesis or candidate should stay out of `marshal-code-review` until the normal GitHub derivation pipeline finds at least 3 independent PRs, a clear negative example, and a concrete activation decision.

## Seeded lenses

| Lens                              | What to look for                                                                                                                  | Likely surfaces                                                         | Validation note                                                                                                                                                | Status         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Race / data consistency           | Read-modify-write flows, stale caches, or split ownership where one surface can overwrite newer state from another                | `electron/`, IPC handlers, settings/session persistence, shared stores  | Strong evidence, but the live prompts already cover single-source-of-truth, in-memory/on-disk sync, startup restoration, and stale-state cleanup.              | covered        |
| Stale state / timing              | Async responses, timers, or debounced work that can apply after the user navigates away or changes the active target              | `src/**/*.tsx`, `src/**/*.ts`, interactive panels, editors, async hooks | Strong evidence, but it mostly overlaps the active renderer cleanup-and-rollback rule. Keep it only as a mining prompt for narrower timeout/divergence splits. | covered        |
| Shared-component regressions      | A shared component changes without auditing sibling consumers, visual states, or neighboring panels that reuse the same primitive | `src/components/`, `src/shared/`, design-system wrappers                | Current evidence mostly collapsed into existing shadcn/Tailwind/neighbor-consistency guidance instead of true shared-component consumer regressions.           | not ready      |
| Keyboard-focus visibility         | Hover-only affordances, tooltip parity gaps, or focus states that disappear for keyboard users                                    | `src/**/*.tsx`, accessibility-sensitive UI, Radix/shadcn wrappers       | Existing renderer accessibility guidance already covers tooltip parity, keyboard focus, and tab-order issues; current evidence adds little beyond that.        | not ready      |
| Magic string to constant / config | Repeated literals for routes, policy keys, tool names, or state labels that should come from a shared constant or config source   | `electron/`, `common/`, `src/`, settings/policy/tool registration code  | Candidate note drafted from four past PRs. The cluster is novel, but still one-reviewer and too heterogeneous for activation.                                  | candidate-only |

## How to use this backlog

1. Treat each row as a clustering prompt, not as a rule.
2. Pull GitHub evidence with `marshal-extract-human-comments.py` and `marshal-enrich-with-diff.py`.
3. Record reviewer spread, exact PR spread, and at least one negative example before drafting a candidate note.
4. Activate only after the evidence bar in `rule-derivation-guide.md` is met.
