# Should I author a workflow?

Marshal has three orchestration primitives, increasingly heavyweight. Pick
the lightest one that fits — burning a workflow on a single-task job is the
worst possible UX failure.

## Tier 1 — Single `spawnSubagent`

✅ Use when:

- One coherent side task ("go refactor this file in a worktree")
- One agent identity does the whole job
- The user will read the subagent's chat transcript directly
- Total work fits in one model context window

❌ Don't use when:

- You need to do the same task to >3 items in parallel
- The result needs assembly across multiple subagents

Cost: ~5s spawn, no persistence beyond the session.

## Tier 2 — Chat-driven loop (parent agent orchestrates)

✅ Use when:

- 2–5 spawned subagents, one phase
- The parent agent can hand-roll the join (await each handle, summarize)
- The output is a chat reply, not a reusable artifact
- One-shot — user won't run it again

❌ Don't use when:

- You'd need >5 concurrent subagents (chat agent context bloats)
- You want to retry from a specific step after a crash
- You need a custom UI
- The user said "I want to run this every week / regularly / again"

Cost: parent agent's context burns 1 turn per spawn + 1 turn per reply. No
persistence of the orchestration plan.

## Tier 3 — Full workflow (this skill)

✅ Use when ANY of:

- ≥6 subagents OR ≥2 distinct phases
- Fan-out over a programmatic list (PRs, repos, files, customers)
- Quality gates ("only file a bug if reviewer says PASS")
- Manually re-runnable from a Library tab
- Custom UI (grid, board, dashboard)
- Crash-resumable / retry-from-step

Cost: ~10 min author time, esbuild compile (~1s), persistent record per run,
custom IPC events.

## Decision examples

| User request                                                  | Tier                     | Why                                                                               |
| ------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| "Fix the lint error in src/foo.ts"                            | 1                        | Single task, single agent.                                                        |
| "Apply this codemod to core-lib, web-app, and cli"            | 2 or 3                   | 3 items, sequential is fine — but if you want PR-per-repo with QA gates, go to 3. |
| "Review every open PR on octocat/foo and post a Slack digest" | 3                        | Fan-out, aggregate, side-effect. Reuse: yes.                                      |
| "Translate README to fr, de, ja, pt-BR with reviewers"        | 3                        | Per-unit review → review-rework-loop pattern.                                     |
| "Run the WSR pipeline" (multi-phase ops investigation)        | 3                        | Multi-phase, custom renderer wanted, crash-resumable.                             |
| "What's the last commit on main?"                             | 1                        | One shell call.                                                                   |
| "Summarize last week's standups"                              | 2                        | Fetch + summarize, no reuse, chat reply.                                          |
| "Every Monday at 9am, post a standup reminder"                | (use `createAutomation`) | Time-based, no orchestration. Not a workflow.                                     |

## Default if uncertain

If Step 1 of the procedure ends with you still unsure, default to **Tier 2**
plus ask "want me to make this a reusable workflow?". Promotion from Tier 2
→ Tier 3 is cheap (a workflow can wrap the same set of spawns), so err on
simplicity first.
