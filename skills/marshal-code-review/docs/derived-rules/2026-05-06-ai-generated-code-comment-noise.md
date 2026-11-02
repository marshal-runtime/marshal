<!-- Marshal-owned code-review guidance. -->
# AI-generated code-comment noise

- Status: active
- Review surface: `renderer` (also fires in `main-process` files when comment density is the smell)

## Guideline

Flag inline code comments added in the diff that **describe what well-named code already does** or **narrate history that belongs in git/PR description**, while explicitly leaving alone any comment that genuinely earns its place. The bar is: _if a future reader would still understand the code with this comment removed, the comment is noise._ CLAUDE.md is the source of truth: "default to writing no comments; only add one when the WHY is non-obvious."

The rule's job is to surface the **trivial** and the **historical/contextual-noise** classes — not to enforce a comment-free codebase. Be precise about which comments are flagged so authors can keep the load-bearing ones.

## Why

This is the project's single most-repeated review feedback that has no detector today. Every recurrence costs the author a re-spin and the reviewer an inline comment with substantively the same content ("agent added a ton of comments", "let's reduce the amount", "do we really need this comment"). Surfacing it during review — pre-merge — converts a recurring class of churn into a single quick pass.

A second, related smell is **non-ASCII visual noise from tool round-tripping** — em-dashes, smart quotes, or mojibake (e.g. `ΓÇö` for `—`) appearing in source files. These tend to come from the same code paths (AI-generated content pasted from rendered docs, or files round-tripped through a tool that mis-decoded the bytes). The detection signal is different but the trigger and remediation overlap, so they're folded into this rule.

## Detection signal

Path filter: any file under `src/`, `electron/`, `common/`, `shared/`, `e2e/`, `e2e-real/`. Exclude `*.test.*`/`*.spec.*` (test files routinely use comments to label scenarios — out of scope).

Two flag-worthy classes (positive findings) and one explicit non-flag class (always leave alone).

### Class A — Trivial restatement (flag)

The comment paraphrases the next 1–3 statements. A reader who can read the code can read the comment; nothing is added.

- `// Normalize the path` immediately above `path = path.toLowerCase().trim()`
- `// Loop through items` above a `for` loop with self-evident body
- `// Set default value` above `const x = opts.x ?? DEFAULT`
- `// Initialize state` above `const [foo, setFoo] = useState(initial)`

### Class B — Historical / contextual narration (flag)

The comment narrates _what changed_ or _why we touched this_ — content that belongs in the commit message, PR description, or git blame, not in the source. These age into permanent confusion: a reader 6 months later sees "previously this used X" with no idea what X was or whether the migration is done.

- `// Changed from sync to async to support large files`
- `// Was previously useState, now useReducer for predictability`
- `// Replaced custom polyfill with native API`
- `// Renamed from oldFooBar — keeping comment for searchability`
- `// (was 5000ms, lowered after telemetry showed user impact)`
- `// TODO: this used to be inline; extracted in PR #1234`
- `// We tried X first but it didn't work, so now Y`

### Class C — Genuinely load-bearing (do NOT flag)

These comments explain something a careful reader of the code _cannot infer_. They earn their place. The rule must explicitly skip them.

- **Non-obvious WHY**: hidden constraint, surprising platform behavior, known SDK/library bug being worked around. Example: `// The auth SDK silently ignores its openBrowser option on this code path`.
- **Subtle invariants** that the type system can't express: `// must run before sessionManager.init() — inverter wiring depends on it`
- **Performance / safety footguns**: `// O(n²) intentional — n is bounded to 8 by upstream`
- **Issue/ADR references with rationale**: `// Workaround for #1234 — Electron 32 broke spawn on Windows`
- **Public-API JSDoc** with `@param`/`@returns`/`@throws` annotations, even on simple functions, when the file exports for other modules to consume.
- **Type-system-defeating tricks** that need explanation: `// double-cast through unknown — IPC return types lose discriminated-union narrowing`

When in doubt, don't flag — the cost of a missed noise comment is one trivial line; the cost of asking the author to delete a load-bearing one is real.

### Detection triggers

In the diff, fire on:

1. **Trivial-restatement density.** > 2 Class-A comments in a single new function, or > 3 across a file's net-new code.
2. **Any Class-B historical narration**, even one occurrence — these are pure cost.
3. **Non-public docblock recap.** A `/** ... */` on an unexported helper whose body is "this function does X" prose where X is also the function name.
4. **Smart-quote / em-dash / mojibake in source files.** Detect `[–—'']` in `.ts`/`.tsx`/`.js`/`.cjs`/`.json`/`.yml` files, or the CP437→UTF-8 mojibake pattern (`ΓÇö` `ΓÇô` `ΓÇ£` `ΓÇ¥` `ΓÇÿ` `ΓÇÖ`). String literals shown to users are exempt; comments and identifiers are not.

**Output discipline:** roll up to one finding per PR, listing 2–4 representative offenders and naming the class (A/B). Do not enumerate every line; that defeats the rule's own goal. Suggested phrasing: _"X comments in this PR fall into Class A (trivial restatement) or Class B (historical narration). Examples: `<file:line>`, `<file:line>`. CLAUDE.md says default to no comments; the load-bearing ones in this diff at `<file:line>` and `<file:line>` are fine, just remove the others."_ — naming the load-bearing ones explicitly is how the author trusts the finding and acts on it without a back-and-forth.

## Example

From a review of `src/features/chat/components/ModelPicker.tsx`:

> The model for some reason added a ton of comments, let's reduce the amount

From a review of `src/App.tsx`:

> On this commit specifically agent added a ton of comments, most of them are low value IMO but I will let you decide if they should be kept

From a review of `src/shared/hooks/useIpcMutation.ts`:

> Do we really need this comment. Typescript should complain if shape changes

From a review of `electron/backend/types.ts`:

> I am not a fan of these weird character changes, can we remove them — and the follow-up review-body finding documents UTF-8 mojibake (CP437→UTF-8 double-encoding) across 10 files in that PR

## Exceptions

- Public-API JSDoc with `@param`/`@returns` annotations — keep.
- A single line explaining a non-obvious _why_: a hidden constraint, a known SDK bug, a subtle invariant, a workaround for a specific issue. Keep these exactly as CLAUDE.md says.
- Comments inside `*.test.*` files that delineate Arrange/Act/Assert sections or scenario descriptions — out of scope.
- Markdown files (`*.md`) for narrative content with em-dashes — keep them; the smart-quote check is for source files only.
- References to specific issue numbers, ADRs, or PR links that won't be obvious from blame — keep, even if short.

<details>
<summary>Provenance</summary>

**Mining run:** 2026-05-06, 21-day window (2026-04-15 → 2026-05-06). Combined with the May 4 cluster-analysis observation under cluster 17 (3 PRs), total ~6 PRs of distinct evidence across two reviewers.

**Inline review-thread instances** (this window):

- `src/App.tsx` — an upstream reviewer, 2026-04-25..05-06 — "agent added a ton of comments, most of them are low value IMO"
- `src/features/chat/components/ModelPicker.tsx` — an upstream reviewer — "The model for some reason added a ton of comments, let's reduce the amount"
- `src/shared/hooks/useIpcMutation.ts` — an upstream reviewer — "Do we really need this comment. Typescript should complain if shape changes"

**Mojibake / smart-quote variant**:

- `electron/backend/types.ts` — an upstream reviewer — "I am not a fan of these weird character changes, can we remove them"; follow-up review-body documents 10 files with `ΓÇö` mojibake

**Existing CLAUDE.md guidance** (the rule is enforcement, not new policy):

> Default to writing no comments. Only add one when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a reader. If removing the comment wouldn't confuse a future reader, don't write it.

**Why this is novel signal beyond the core agent prompts**:

- `lint-cast-hygiene.md` covers suppressions and type casts, not comment volume.
- `react.md` and `react-query.md` focus on hook shape and data flow, not comment text.
- `main-process.md` covers infrastructure correctness, not stylistic comment hygiene.
- The closest existing surface is `renderer-primitives.md` (CLAUDE.md adherence broadly), but it doesn't include a comment-volume detection.

**Activation candidacy**: meets the 3-PR bar (3 in this window, ~6 with May 4 carryover). However, the **20-rule budget already has 4 active rules** with 2 candidates already (`magic-string-to-constant`, `review-output-discipline`), so activating this would push to 5/20 — within budget. The decision is whether to activate or park. Recommendation: **park as `candidate`** for one more mining cycle, since the false-positive risk on the comment-density heuristic (#1) is non-trivial and the rule benefits from a sharper signal before it fires in live review. The mojibake variant (#4) is unambiguous and could be activated alone if the comment-density part proves noisy.

</details>
