---
name: marshal-code-review
description: Review PRs and code diffs for OmerMachluf/marshal only. Not for worktrees, rebases, CI polling, or PR update comments; use /marshal-pr-ops.
allowed-tools:
  - Bash(python3 skills/marshal-code-review/scripts/fetch-pr-cache.py:*)
  - Bash(gh pr diff *)
  - Bash(gh pr view *)
  - Bash(gh pr checks *)
  - Bash(gh api --method GET repos/OmerMachluf/marshal/*)
  - Bash(git diff *)
  - Bash(git log *)
  - Bash(gh pr review *)
  - Bash(gh pr comment *)
  - Grep
  - Glob
  - Read
  - Agent
---

# Code Review Skill

This skill orchestrates structured code reviews for the OmerMachluf/marshal (Marshal) codebase. It dispatches hand-curated core review agents plus a learned-patterns agent that applies active rules mined from historical human review comments.

---

## Review Philosophy

**High signal, low noise.** Only report findings with high confidence (>=80/100) that they are real issues. No style nits, no "consider using X" filler. Every comment should either prevent a bug, fix an architecture violation, or highlight a missing test that matters.

**Understand before judging.** Before flagging anything, understand the full context: read the PR description, the surrounding code (not just the diff), and the project's established patterns. A change that looks wrong in isolation often makes sense in context.

**Be concrete.** Every finding must have: what's wrong, why it matters, and how to fix it (with code when possible). Vague feedback is worse than no feedback.

---

## Review surfaces

- **Core agents stay hand-curated.** All agent prompts live in `agents/` (see the [Sub-Agent Prompt Files](#sub-agent-prompt-files) table for the full inventory) and cover architectural invariants, correctness, and repo conventions that we maintain by hand.
- **Learned rules stay separate.** `agents/learned-patterns.md` is the only place that applies empirical rules mined from historical PR comments.
- **Derived rule files are the single source of truth.** `docs/derived-rules/*.md` carry the learned rule text and status (`candidate`, `active`, `retired`). Do not copy active rules into the core agent prompts.

---

## Prerequisites

**Run from the local repo clone.** This skill is most effective when the working directory is the OmerMachluf/marshal repository. Sub-agents use Grep, Glob, and Read to examine surrounding code, check for existing patterns, verify all callers, and compare the diff against the actual codebase — the diff alone is never enough for a high-quality review. If a PR changes `HorizonPanel.tsx`, the agent should also read `ActivitiesPanel.tsx` and other panels to check consistency with neighbors.

**The PR branch may not be checked out.** The local working tree may be on a different branch than the PR under review. The diff provided to sub-agents is the authoritative source for what the PR adds, changes, or removes. Sub-agents must NOT use Read/Grep to verify that changes shown in the diff exist on disk — they won't if the branch differs. Sub-agents SHOULD use Read/Grep to examine surrounding context not shown in the diff: neighboring files, established patterns, existing callers, and sibling implementations.

**Fetch existing PR comments** before starting the review so you don't duplicate feedback already given. Use the on-disk cache (see Step 1) — it already contains the comment payloads.

---

## Execution Strategy

### Step 1: Populate the PR cache, then read from disk

Before issuing any `gh` calls yourself, refresh the on-disk cache for the PR and capture its location plus the ready-to-paste sub-agent dispatch block:

```bash
python3 skills/marshal-code-review/scripts/fetch-pr-cache.py <number> \
    --json --max-cache-age 300 --agent-instructions
# -> {"pr": 1234, "status": "cached"|"fetched", "head": "...", "dir": "<absolute-path>", ...}
#    (followed by a markdown block — paste this verbatim into every Agent dispatch)
```

The `--json` output includes a `"dir"` field with the **absolute, platform-correct cache directory** (resolved via `Path.resolve()`, so usable from any cwd / drive). The default location is `<tempfile.gettempdir()>/marshal-code-review/pr-<number>/` — e.g. `/tmp/marshal-code-review/pr-1234/` on macOS/Linux, `C:\Users\<user>\AppData\Local\Temp\marshal-code-review\pr-1234\` on Windows.

The `--agent-instructions` flag prints a **ready-to-paste markdown block** containing the cache path, the list of files to read, and a fail-loudly sanity check ("if the Read fails, stop and report 'cache directory not accessible' as your only finding"). **Paste this block verbatim into every Agent dispatch.** Centralizing it in the script means: same wording for all 17 sub-agents, no per-agent customization, no chance of forgetting the path.

`--max-cache-age 300` tells the script that if the cache is fresher than 5 minutes, trust it without issuing another `gh pr view` to re-check the head SHA — so when the dashboard prefetched seconds ago, this is a pure-disk sub-second no-op with zero `gh` calls. If the cache is older, or missing entirely, the script refetches all artifacts atomically.

The cache directory contains:

| File                   | What it is                                               | Replaces                         |
| ---------------------- | -------------------------------------------------------- | -------------------------------- |
| `head-sha`             | The commit SHA these artifacts correspond to             | —                                |
| `metadata.json`        | PR metadata (title, body, author, files, mergeable, ...) | `gh pr view`                     |
| `diff.patch`           | The PR diff                                              | `gh pr diff`                     |
| `reviews.json`         | Formal reviews                                           | `gh api .../pulls/<n>/reviews`   |
| `pulls-comments.json`  | Inline review comments                                   | `gh api .../pulls/<n>/comments`  |
| `issues-comments.json` | Discussion comments                                      | `gh api .../issues/<n>/comments` |
| `checks.json`          | CI check status                                          | `gh pr checks`                   |

**Read from these files instead of re-issuing the `gh` commands.** The whole point of the cache is that you — and especially sub-agents — should avoid shelling out to `gh` for read data. Keep `gh` for write actions (posting reviews/comments) and for one-off follow-ups where the cache doesn't have the shape you need.

The review-dashboard skill (`marshal-review-dashboard`) prefetches this cache for every surfaced PR, so in the common case the script call is a no-op when you start a review.

### Step 2: Categorize changed files

Classify each changed file into one or more dispatch categories. A file may match multiple categories.

| Category                  | File patterns                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Dispatched agents                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **always-on**             | (any PR)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `merit`, `lint-cast-hygiene`                                                |
| **main-process**          | `electron/`, `common/`, root config files, build scripts, `.github/workflows/`                                                                                                                                                                                                                                                                                                                                                                                               | `main-process`                                                              |
| **backend-abstraction**   | `electron/backend/**`, `electron/sessions.ts`, `electron/main.ts` (when backend imports added/removed), `common/**` interface files                                                                                                                                                                                                                                                                                                                                          | `backend-abstraction`                                                       |
| **electron-architecture** | `electron/**` excluding pure types/test files                                                                                                                                                                                                                                                                                                                                                                                                                                | `electron-architecture`                                                     |
| **renderer**              | `src/components/`, `src/features/`, `src/hooks/`, `src/pages/`, `src/types/`, `src/styles/`, `src/App.tsx`                                                                                                                                                                                                                                                                                                                                                                   | `react-query`, `react-query-best-practices`, `react`, `renderer-primitives` |
| **telemetry-surface**     | Path-match: `src/services/telemetry/**`, `electron/ipc/diagnostics-ipc.ts`, `common/marshal-logger.ts`. Structural-match: new `**/*Panel.tsx` or new file in `src/features/`. **Content-match: any diff that adds new `console.*` / `createLogger` / `addLogSink` / `TelemetryPath_*` / `NonInteractiveElementMonitor_*` / `MonitoredButton` calls** — covers most `electron/**` and `src/**` changes. The agent self-silences when no telemetry/logging surface is touched. | `telemetry-logger`                                                          |
| **tests**                 | `*.test.*`, `*.spec.*`, `e2e/`, `src/test-utils.*`, `electron/e2e-stubs.*`, OR any production-code change                                                                                                                                                                                                                                                                                                                                                                    | `tests-coverage`, `tests-quality`                                           |
| **bug-fix-PR**            | PR title starts with `fix:`/`hotfix:` OR body contains `fixes #`/`closes #`/`resolves #`                                                                                                                                                                                                                                                                                                                                                                                     | + `tests-regression-pin`                                                    |
| **architecture-doc**      | `docs/architecture/**` is in the diff, OR any code file under `electron/**` or `common/**` is in the diff (since arch docs describe those folders and the doc may need updates).                                                                                                                                                                                                                                                                                             | `architecture-doc-sync`                                                     |
| **compliance**            | `electron/auth/**`, `electron/audit-log*.ts`, `electron/ipc/mcp-oauth-ipc*.ts`, `electron/settings-store.ts`, `common/marshal-ipc-contract.ts` schema additions, `electron-builder.json5`, `scripts/sign-windows-artifacts.cjs`, OR any test file adding tenant / client / UPN / token literals as fixture data                                                                                                                                                              | `compliance`                                                                |
| **fragile-area**          | Path-match: `electron/sessions.ts`, `electron/permission-policy.ts`, `electron/preload.cjs`, `common/marshal-ipc-contract.ts`, `src/features/chat/**` (scroll/animation), `src/PopoutApp.tsx`, `**/chatWindowManager*`. Surfaces that have historically broken in ways tests don't catch — mirror of `tools/pr-agents/src/marshal-pr-fragile-paths.ts`.                                                                                                                      | `fragile-area`                                                              |
| **active-learned-rules**  | path-overlap with paths declared in any rule under this skill's `docs/derived-rules/*.md` (status: `active`). **Read these from the skill's own folder, NOT from the PR-under-review's working tree** (which won't have them — they live in `skills/marshal-code-review/docs/derived-rules/`).                                                                                                                                                                               | `learned-patterns`                                                          |

A file matching `electron/backend/gateway-backend.ts` will trigger **all of** `main-process`, `backend-abstraction`, and `electron-architecture` — three agents reviewing the same file from three angles. Dedup is handled at synthesis (Step 4).

### Step 2.5: Framing pass

Three orchestrator-level passes — their combined output is the **Framing** block in the output format. Skip entirely for trivial diffs (<20 lines, single file, no UI surface).

**Partial-conversion audit.** Whenever the diff shows a _partial_ conversion of a pattern — some callsites moved to a new shape, others left in the old shape — audit the un-converted siblings. Applies to feature PRs and bug-fix PRs alike: the shape is the same, only the trigger differs.

Common shapes:

- **Bug-fix parallel cleanup paths** — canonical: `deleteSession` and `deleteAllSessions` both need the same `Map.clear()`. Sibling action that wasn't fixed is the most common bug-fix miss.
- **Event broadcasts widening from 1:1 to 1:N** — canonical: a past PR converted 3 of N `webContents.send` calls to `chatWindowManager.broadcast`, but left `settings:changed` and `automations:changed` un-converted, silently breaking popout windows for theme / experiments-flag surfaces. When a new fan-out helper appears, every existing single-recipient send becomes a candidate for conversion.
- **Call-site migrations to a new signature** — N-1 of N callers updated; the missed one will fail at runtime or silently take stale defaults.
- **Hardcoded values extracted to a constant for some instances but not others** — covered separately by the `magic-string-to-constant` derived rule, but flag here too if the rule didn't fire.
- **Base-class methods added but not overridden in every subclass** — overlaps with `backend-abstraction` rule 3 (no-op implementations need a justification comment); flag here when the override is missing entirely.

Procedure:

1. Identify the conversion shape from the diff (old form → new form).
2. Grep the codebase for the un-converted form.
3. For each surviving callsite, judge convert-needed vs intentionally-left vs ambiguous.
4. Surface un-converted siblings as 🟡 Important findings _and_ pass them as hints to relevant downstream agents (most often `electron-architecture`, `tests-coverage`, `main-process`). If all siblings landed the conversion, note it positively.

**Architecture cost vs benefit (thinned).** Read the description for the claimed user-visible benefit, then weigh against complexity added: new abstraction with a single caller, new manager class for a one-off helper, new persisted-state type for ephemeral data, large diff for a minor refinement, new dependency where a built-in alternative exists. Before flagging, grep for existing utilities or patterns that could have delivered the same result with less code.

Frame disproportionate-complexity findings as **Questions** (in the Questions output section) rather than Findings — the author has context the orchestrator may lack. The signal "this looks like more machinery than the goal warrants — what's the case for this shape over <simpler alternative>?" is more useful than a hard "this is over-engineered" claim.

**User-flow walkthrough.** Triggers: PR introduces a new `BrowserWindow` lifecycle, a new IPC namespace, a new top-level renderer entry point (`src/main.tsx` routing branch, new `*App.tsx`), or a new top-level interaction surface that the user can navigate to. Skip entirely for backend-only PRs and PRs that touch no user-visible surface.

Enumerate 5–8 concrete user actions and trace the IPC/state path for each. Sample shapes:

- User toggles a setting in main → does it propagate to the new surface?
- User performs a destructive action → what happens to dependent state in other surfaces?
- User exits via close-window / quit-app / kill-process → what teardown runs?
- User clicks a link inside the new surface → what navigates?
- User opens N copies of the new surface → does anything assume cardinality of 1?
- User triggers a flow that the new surface doesn't render — does it correctly stay invisible?

Output as **Questions**, not Findings. The signal "I traced X and got Y — is that intended?" is more useful than a hard claim. Cap at 5–8 actions to keep noise bounded; consolidate overlapping traces into one question. Pass anything alarming as a hint to downstream agents (most often `electron-architecture` and `react`) so they can tighten the trace into a finding if the path is genuinely broken.

**Merit framing has been moved to a dedicated `merit` subagent** (always-on). Architecture-fit-shape findings are now generated by the `electron-architecture` and `backend-abstraction` agents; this orchestrator-level pass keeps only cost-vs-benefit Questions, the partial-conversion audit, and the user-flow walkthrough above.

### Step 2.7: Existing-comment digest

Before dispatching, read `pulls-comments.json` (inline review comments) and `issues-comments.json` (PR discussion comments) — already in cache from Step 1. From these, produce a brief inline digest of **existing reviewer findings** for inclusion in every agent's dispatch context.

Format the digest as one bullet per substantive comment:

```
**Existing reviewer findings (from prior comments):**
- @OmerMachluf — `electron/sessions.ts:438` — wedge in `sendAndCollect` cleanup path needs sibling fix in `deleteSession`
- @OmerMachluf — `src/features/chat/Lexical.tsx` — typeahead plugin should use LexicalTypeaheadMenuPlugin instead of custom hook
- @OmerMachluf — PR-level — animations need gifs for review
```

Skip: bot comments, comments under 30 chars, "LGTM"/approval-only comments without substantive findings, comments that are already replies in a thread (in_reply_to set), comments by the PR author.

The digest is passed verbatim to every dispatched agent as part of its context (alongside the diff, metadata, etc.).

If the PR has no existing reviewer comments, the digest is omitted from the dispatch context — no special handling required.

**Bot-agent stickies.** The same `issues-comments.json` also carries CI-agent sticky comments, each tagged with an `<!-- marshal-agent:<name> -->` HTML marker posted by the `marshal-pr-agents.yml` workflow — `merit-bot` emits `marshal-agent:merit`, `complexity-tag` emits `marshal-agent:complexity`, `barnacle` emits `marshal-agent:barnacle`. These are **not** human findings: keep them out of the reviewer digest above (the "Skip: bot comments" rule still applies). But **do** capture them into a separate `botStickies` map keyed by agent name (`merit` → that comment's body with the marker line stripped). Step 3 uses this map to skip any local subagent whose CI counterpart already ran the identical evaluation. If no `marshal-agent:*` stickies are present, `botStickies` is empty and Step 3 dispatches normally.

### Step 3: Decide dispatch strategy

**Small PRs** (<50 changed lines across <3 files, single core category): Do a single-pass review yourself. Use the Read tool to load the relevant core agent prompt file(s) from `agents/` within this skill's directory (e.g., `agents/react.md`, `agents/react-query.md`, `agents/renderer-primitives.md` for a component-only PR; `agents/main-process.md` for an IPC handler; etc. — see the Sub-Agent Prompt Files table for the full roster), then also read `agents/learned-patterns.md` if any active rules exist. No sub-agent needed — you are the reviewer, the agent files are your rubric.

**Larger or multi-category PRs**: Spawn sub-agents in parallel — one per matched core category, plus `learned-patterns` when any active rules exist. For each sub-agent, spawn a general-purpose Agent with **model: "sonnet"** for faster execution.

**No orchestrator-level pre-filtering.** If a category matches a path pattern in the Step 2 table, dispatch **every agent listed for that category** — no exceptions. Do NOT skip an agent based on a guess about what it will find ("this is just preferences, no TanStack Query", "this looks like only a primitive, react won't have anything"). That reasoning belongs _inside_ the agent — every agent has a "no findings" clean-pass output line for exactly this case, and an agent that finds nothing is far cheaper than the angle you miss by skipping it. Specifically:

- The **renderer** category is a **quad** — `react-query` + `react-query-best-practices` + `react` + `renderer-primitives`. Any `src/features/**`, `src/components/**`, `src/hooks/**` change dispatches all four. They have overlapping surface and complementary lenses (load-bearing data-flow shape, TanStack v5 best-practice 💡 niceties, component shape, primitive reuse); skipping any one defeats the design. The two `react-query*` agents are deliberately split: load-bearing codebase-learned 🟡 rules in `react-query`, TanStack v5 nice-to-haves at 💡 in `react-query-best-practices`.
- The **tests** category is a **pair** — `tests-coverage` + `tests-quality`. Same principle.
- The **always-on** pair (`merit` + `lint-cast-hygiene`) runs on every PR regardless of category match.
- **Skip a local subagent when its CI bot counterpart already posted.** For any agent whose name is in the `botStickies` map from Step 2.7 (today: `merit`, via the `merit-bot` CI job — the same rule applies to `complexity` once a complexity subagent exists), do **not** dispatch the local subagent: the CI bot ran the identical evaluation against the same diff, and dispatching again pays for it twice. Instead, fold that bot's sticky body into the existing-comment digest passed to the remaining agents, as `**CI agent \`<name>\`\*\* — <one-line summary of its finding>`, so their `acknowledgment`-kind dedup (see the dispatch template) compares against it exactly as against a human reviewer's prior finding. The bot's findings still reach the rollup via the digest and the Acknowledgements section; you just don't re-run the pass. When `botStickies` is empty (a local run before CI has posted, or CI disabled), dispatch the agent normally.

Pass the following context to every dispatched agent:

- **Cache-data preamble** — paste the markdown block emitted by `fetch-pr-cache.py --agent-instructions` (captured in Step 1) **verbatim** as the FIRST content block in every Agent dispatch. This block centralizes the cache directory path, the don't-call-`gh` rule, and the fail-loudly sanity check. Do NOT hand-roll a substitute or paraphrase — using the same wording in every dispatch is the entire point of centralizing it. If the dispatched agent reports cache-not-accessible per the sanity check, stop the review and surface the cache failure to the user instead of falling back to the agent's review on partial data.
- **PR description** — extracted from `metadata.json` (title + body), so the agent understands intent and can read the PR through the author's lens.
- **Repository context** — working tree path, branch-checkout caveat, and pointer to `CLAUDE.md`.
- **Existing-comment digest** — from Step 2.7, if any, with dedup instructions.
- **Structured-output instructions** — severity cap and findings-count soft cap for this agent.

Use this dispatch template (fill in the `<...>` placeholders) so every agent gets the same shape:

```
You are running the `<AGENT-NAME>` sub-agent for an marshal-code-review of PR #<N> (OmerMachluf/marshal, "<PR-TITLE>").

Read your full agent prompt first from:
`<repo>/skills/marshal-code-review/agents/<AGENT-NAME>.md`

<AGENT-INSTRUCTIONS-BLOCK>
   ← paste the markdown block printed by `fetch-pr-cache.py --agent-instructions` verbatim here.
   It contains the absolute cache directory, the list of files to read, and the
   fail-loudly sanity check.

**Repository context:**
- Working tree: <cwd>
- The PR branch may NOT be checked out. Trust the diff for new/changed code.
  Use Read/Grep only for surrounding context (neighboring files, established patterns).
- Project conventions: `CLAUDE.md` at the repo root.

<EXISTING-COMMENT-DIGEST>
   ← from Step 2.7, if any. Include the dedup instruction:
   "For each potential finding, compare against the digest. If a prior reviewer already
    raised the same concern at the same file/line/area: emit `kind: \"acknowledgment\"`
    with `reviewer: @<login>` field, do NOT duplicate the substantive finding. If you
    genuinely disagree, emit your finding normally with `note: \"differs from <reviewer>\"`.
    If your finding is novel, emit normally."

Output findings as a structured list: kind (finding|question|acknowledgment), severity (🔴|🟡|💡), file:line, issue, why, fix. Cap: <SEVERITY-CAP>. Soft cap of <N> findings.
```

The `<AGENT-INSTRUCTIONS-BLOCK>` is the centralized way to pass the cache path. It lives in `fetch-pr-cache.py:agent_instructions_block()` so all 17 agents get identical wording, the same absolute path, and the same fail-loudly verification step. Don't hand-write the path — paste the script's output.

**Note on per-agent preambles:** Each agent file in `agents/` contains a `**PR data on disk.**` paragraph that covers similar ground (cache path, don't-call-`gh`, file list). These are now redundant with the orchestrator-injected `<AGENT-INSTRUCTIONS-BLOCK>` but intentionally left in place as a fallback — if an orchestrator invocation forgets to inject the block, the agent's own preamble still guides it. The orchestrator-injected block is the canonical source; the per-agent preambles are belt-and-suspenders. Cleanup of those agent-level paragraphs is a separate task and is not done in this commit.

Run agents in the background when possible so they execute in parallel.

### Step 4: Synthesize

After all sub-agents complete:

1. **Dedup by `(file, line, root-cause-class)`** — when two agents flag the same triple, keep the finding from the more specific agent. Specificity ordering (highest → lowest):
   1. `backend-abstraction`
   2. `electron-architecture`
   3. `react-query`
   4. `react`
   5. `renderer-primitives`
   6. `compliance`
   7. `main-process`
   8. `telemetry-logger`
   9. `architecture-doc-sync`
   10. `tests-regression-pin`
   11. `tests-coverage`
   12. `tests-quality`
   13. `learned-patterns`
   14. `lint-cast-hygiene`
   15. `react-query-best-practices`
   16. `merit`

   `compliance` sits above `main-process` because it owns the most specific lens on identity / auth / persisted-state surfaces — when both flag the same `electron/auth/**` line, the compliance framing is the one to keep.

   `react-query-best-practices` sits low because its findings are 💡 Suggestion-only — when any 🟡 / 🔴 agent flags the same surface, the deeper finding wins.

2. **Apply per-agent severity caps** — never escalate a finding past its originating agent's cap. Caps in the agent inventory table.

3. **Per-agent findings cap of 5** (some agents declare lower caps in their own prompt — see the agent file). If any agent emits more than its cap, the agent itself was supposed to consolidate.

4. **Aggressive dedup beyond exact-triple matches.** Two findings count as duplicates and should collapse to one if **any** of these hold:
   - **Same `(file, line)`** — even if the root-cause-class words differ, if the line is the same the reviewer reads it as one issue. Pick the more specific agent (per ordering above) and append a _"(also surfaced by `<other-agent>` from a different angle)"_ note rather than a second bullet.
   - **Same exported symbol or hook name** within the same file — e.g. `react` flags `useFoo` for dependency-array correctness while `react-query` flags `useFoo` for missing `staleTime`. Collapse to one rollup finding (use the cluster-rollup format from §5 below) even if the cluster threshold of 3 isn't hit — _2 agents on the same symbol is enough_ for this dedup.
   - **Same finding restated under different rule numbers across the SAME agent** — e.g. `react-query` R-2 Pattern A finding and `react-query` R-10 finding for the same `useMutation` block. The agent should already have consolidated; if not, the orchestrator does.

5. **Global findings cap of 12 post-dedup.** Even after the per-agent cap and dedup above, 17 agents firing on a multi-category PR can exceed what a reviewer reads. After dedup and cluster-rollup (§7 below), if the visible-finding count exceeds 12:
   - Drop lowest-severity 💡 Suggestions first until ≤ 12.
   - If 💡 alone don't get below 12, drop lowest-specificity 🟡 (per the ordering above).
   - **Never drop 🔴 Critical** — they always surface.
   - Emit a one-line footer: _"N additional 💡 suggestions consolidated: <comma-separated list of one-phrase summaries>"_ so the reviewer sees what was elided.

   Token cost is not the constraint — reviewer attention is. The first 12 findings are read; the 13th onward isn't.

6. **Cross-cutting concerns** — issues that span categories (e.g. IPC contract change in `common/marshal-ipc-contract.ts` that needs renderer-side mock updates) — surface once, with a "see also" cross-reference to the secondary agent's finding.

7. **Cluster and roll up shape findings.** Before routing by kind, scan post-dedup findings for clusters that share a root cause. The orchestrator's job here is to recognize cross-agent symptom patterns that no individual agent can see — each agent only views the diff through its own lens, so when N lenses independently flag the same surface, the _real_ finding is usually shape-level.

   **Cluster definition.** A cluster is **≥ 3 findings** spanning **≥ 2 different agents** that share **at least one** of:
   - **Same exported symbol or hook name** (`useMcpOAuthPrompt`, `SessionManager.initiateMcpOAuth`, `<HorizonPanel>`).
   - **Same file** when the file is < ~250 lines (i.e. the findings really are about the same unit, not coincidentally co-located).
   - **Same IPC handler / event channel name** (`mcps:initiateOAuth`, `mcp:server-status`).
   - **Same data flow chain** (a query key + a mutation + a subscription that all reference the same domain object).

   If a cluster qualifies, emit **one** rollup finding with `kind: "rollup"` and severity = max child severity, **possibly escalated by one tier** when the cluster crosses a known shape pattern (see below). The child findings stay listed under "downstream symptoms of [rollup]" — they're not deleted, just demoted to bullet points under the rollup so reviewers see "fix the shape, these specific bugs go away" instead of N independent fix-lists.

   **Known escalation patterns** (escalate severity one tier when the cluster shape matches):

   | Pattern                                        | Symptoms typical of this shape                                                                                                                                                      | Recommended target shape                                                                                                                                  |
   | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | **Hook returning JSX as event-bus dispatcher** | `react` flags hook-returns-JSX + dead subscribers; `react-query` flags Pattern-A async write + double-invalidate; `tests-regression-pin` flags missing test for cancel/cleanup path | `useSyncExternalStore` over a typed module store + dialog as a real component + `useMutation` + boot-time IPC wiring                                      |
   | **Parallel state stores for server data**      | `react-query` flags two query keys for same data OR query+useState mirror; `react` flags addEventListener-driven setState in same component                                         | Single `useQuery` + `invalidateQueries` from boot-wired IPC (R-7 / R-8 of `react-query.md`)                                                               |
   | **God-class with multiple notification fans**  | `electron-architecture` flags two parallel push paths in same class; `main-process` flags multiple consumers reading divergent state                                                | Extract a `connectXForwarder()` per concern; one outbound channel per concern                                                                             |
   | **Partial-conversion miss**                    | Step 2.5 partial-conversion audit + ≥ 2 agents flag inconsistent guards across siblings (e.g. stdio guard added to N-of-N callsites, accessToken guard added to N-1)                | Apply the conversion to every sibling — the agent that flagged the missing one is right; the cluster signals the conversion was incomplete, not stylistic |

   **Output shape.** When emitting a rollup, use this format:

   ```markdown
   ### 🔴 [Rollup] <one-line shape description>

   <2–4 sentences explaining the shape and why every individual finding traces to it>

   | Symptom (downstream finding)      | Caused by (rollup root)     |
   | --------------------------------- | --------------------------- |
   | <child finding 1, with file:line> | <which aspect of the shape> |
   | <child finding 2, with file:line> | <which aspect of the shape> |
   | …                                 | …                           |

   **Target shape (mechanical refactor):** <code or concrete description>

   This dissolves: <list of child finding IDs>. Pin the regressions independently in case the rollup lands later: <subset that should ALSO get a regression test even if the rollup isn't done in this PR>.
   ```

   **What NOT to roll up.** Don't synthesize a rollup just because two agents touched the same file — they often legitimately review different aspects (`react` flags effect cleanup, `renderer-primitives` flags shadcn reuse — these are independent and should stay independent). The bar is "do these symptoms share a root cause that a shape change would dissolve?" — if the answer is no, leave them as separate findings. False rollups hide individual fixes behind a refactor that may not happen.

   **When the cluster doesn't escalate.** If the cluster meets the count threshold but doesn't match an escalation pattern, still emit the rollup but keep severity = max child. The value is in the framing ("here's why these fixes co-occur"), not in elevating priority.

   Canonical: `useMcpOAuthPrompt` — 4 findings across `react`, `react-query`, `tests-regression-pin`, and `learned-patterns` (near-miss). Initial pass listed them as 4 independent 🟡 items. The rollup synthesis recognized the "hook returning JSX as event-bus dispatcher" shape, escalated to 🔴 Critical, and pointed at `useSyncExternalStore` + boot-time wiring as the mechanical fix that dissolved 3 of the 4 children.

8. **Route by `kind` field**:
   - `kind: "finding"` → Findings section
   - `kind: "question"` → Questions section
   - `kind: "acknowledgment"` → Acknowledgements section
   - `kind: "rollup"` → Findings section, ordered FIRST within its severity tier (rollups are the load-bearing fixes; individual findings underneath are downstream)

   Acknowledgments do NOT count against the 5-finding cap (they're not new findings, just attribution to prior reviewers). Rollups likewise do NOT count against the cap, but each child finding subsumed under a rollup DOES count once (don't double-count).

9. **Produce the output** in the standard format (Summary → Framing → Findings → What's good → Acknowledgements → Questions).

---

## Sub-Agent Prompt Files

The review criteria for each agent are in the `agents/` directory within this skill:

| File                                   | Group | When to dispatch                                                                                                                                                                                                                                                                                        | Severity cap  |
| -------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `agents/merit.md`                      | α     | always                                                                                                                                                                                                                                                                                                  | 🟡 Important  |
| `agents/lint-cast-hygiene.md`          | α     | always                                                                                                                                                                                                                                                                                                  | 🟡 Important  |
| `agents/backend-abstraction.md`        | β     | `electron/backend/**`, `electron/sessions.ts`, interface files in `common/`                                                                                                                                                                                                                             | 🔴 Critical   |
| `agents/electron-architecture.md`      | β     | `electron/**` (excluding pure types/tests)                                                                                                                                                                                                                                                              | 🔴 Critical   |
| `agents/main-process.md`               | β     | `electron/`, `common/`, build/CI/scripts                                                                                                                                                                                                                                                                | 🔴 Critical   |
| `agents/telemetry-logger.md`           | β/γ   | Path: `src/services/telemetry/**`, `electron/ipc/diagnostics-ipc.ts`, `common/marshal-logger.ts`. Structural: new panel / new feature file. Content: diff adds `console.*`, `createLogger`, `addLogSink`, or any telemetry instrumentation. Agent self-silences when no telemetry surface is touched.   | 🟡 Important  |
| `agents/react-query.md`                | γ     | `src/**/*.{ts,tsx}` — load-bearing codebase-learned rules (R-1..R-10)                                                                                                                                                                                                                                   | 🟡 Important  |
| `agents/react-query-best-practices.md` | γ     | `src/**/*.{ts,tsx}` — TanStack v5 nice-to-haves (`signal`, `select`, granular invalidation, paginated/infinite, variables-path optimistic, N+1 IPC)                                                                                                                                                     | 💡 Suggestion |
| `agents/react.md`                      | γ     | `src/**/*.{ts,tsx}`                                                                                                                                                                                                                                                                                     | 🟡 Important  |
| `agents/renderer-primitives.md`        | γ     | `src/components/**`, `src/features/**`, `src/components/ui/**`, `src/styles/**`                                                                                                                                                                                                                         | 🟡 Important  |
| `agents/tests-coverage.md`             | δ     | any production-code change OR test/spec/e2e file change                                                                                                                                                                                                                                                 | 🟡 Important  |
| `agents/tests-quality.md`              | δ     | same as `tests-coverage`                                                                                                                                                                                                                                                                                | 🟡 Important  |
| `agents/tests-regression-pin.md`       | ε     | PR is a bug fix (`fix:`/`hotfix:` prefix or body has `fixes #`/`closes #`/`resolves #`)                                                                                                                                                                                                                 | 🔴 Critical   |
| `agents/architecture-doc-sync.md`      | ε     | `docs/architecture/**` in diff, OR `electron/**` / `common/**` (code that arch docs describe)                                                                                                                                                                                                           | 🔴 Critical   |
| `agents/compliance.md`                 | ε     | auth/audit/persisted-state surfaces, build/release config, or test files seeding identity fixtures (see Step 2 dispatch table)                                                                                                                                                                          | 🟡 Important  |
| `agents/fragile-area.md`               | ε     | diff touches a fragile surface — `electron/sessions.ts`, `electron/permission-policy.ts`, `electron/preload.cjs`, `common/marshal-ipc-contract.ts`, chat scroll (`src/features/chat/**`), popout (`src/PopoutApp.tsx`, `chatWindowManager`). Mirrors `tools/pr-agents/src/marshal-pr-fragile-paths.ts`. | 🔴 Critical   |
| `agents/learned-patterns.md`           | ε     | path-overlap with paths declared in any active rule in this skill's `docs/derived-rules/` (read from `skills/marshal-code-review/docs/derived-rules/`, NOT from the PR-under-review's working tree)                                                                                                     | 💡 (max 🟡)   |

`docs/derived-rules/*.md` are the single source of truth for learned rules. Core agent prompts stay hand-curated; do not fold active rules back into them.

Group meaning (Step 3):

- α = always-on
- β = main-process surface
- γ = renderer surface
- δ = tests
- ε = conditional

---

## Output Format

Structure the final review as:

1. **Summary** — One paragraph: what the PR does, overall assessment, confidence level.
2. **Framing** — Output from Step 2.5. Omit if all passes came up clean and the Summary already reflects that.
3. **Findings** — Ordered by severity (🔴 Critical -> 🟡 Important -> 💡 Suggestion). Each with:
   - File and line reference
   - What the issue is
   - Why it matters (connecting to the review principle)
   - Concrete fix (with code when possible)
4. **What's good** — Patterns worth calling out as positive. Don't skip this — positive reinforcement of good patterns is high value.
5. **Acknowledgements** — list of prior reviewer findings that the agents agreed with but did not duplicate. Format: `**@<reviewer>** on <file:line> — <one-sentence summary of their finding>. Agreed.` Omit this section if no prior findings were acknowledged.
6. **Questions** — Things that aren't wrong but need the author's explanation before approval. Frame as genuine questions, not rhetorical criticism.

**If no high-confidence issues exist**, say so clearly and summarize why the PR looks good. A clean review is a valid outcome.

---

## Posting Rules

Always present the draft review in chat first and wait for the user to say "post it", "submit", "LGTM", or similar explicit approval before calling `gh pr review`. This applies to all review actions — approvals, comments, and inline review threads.
