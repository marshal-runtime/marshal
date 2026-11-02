# marshal-review-queue

Background PR review queue for `OmerMachluf/marshal`. Spawns Claude or Copilot via the Agent Client Protocol, runs reviews headlessly (max 5 concurrent by default), persists each review as a markdown file under `~/.marshal-review-queue/reviews/pr-<n>.md`, and never auto-posts to GitHub.

## How it works (the 60-second tour)

1. You configure a repo (cwd + dashboard command) in `~/.marshal-review-queue/state.json`.
2. `marshal-review-queue ensure` spawns a local daemon detached. It listens on a Unix socket (POSIX) or named pipe (Windows) — no TCP, no browser-reachable port.
3. `marshal-review-queue tick` (or a Marshal automation / cron job) tells the daemon to run one pass: it shells out to your dashboard JSON, picks up to N PRs in priority order, and spawns one ACP child per slot.
4. Each ACP child runs the `/marshal-code-review` skill against its PR. Markdown is written under `reviews/pr-<n>.md` with frontmatter capturing the session ID, runtime, status, and telemetry.
5. When a review completes, the slot frees and the next queued PR starts automatically.
6. You read the markdown, decide what to post, and (if you want to continue the conversation) run `marshal-review-queue resume <pr>` to open a Zellij tab on the same session ID.

## Install (one-time)

Daemon dependencies are merged into the repo-root `package.json` as devDependencies (they don't ship inside the Electron build). No build step — Node 22.18+ runs `.ts` source directly via built-in type stripping:

```bash
# At repo root
pnpm install            # installs daemon deps alongside Marshal's own
pnpm link --global      # exposes `marshal-review-queue` on $PATH (bin points at tools/review-queue/src/marshal-review-queue-cli.ts)
```

To uninstall: `pnpm unlink --global marshal` from the repo root.

Other useful root scripts: `pnpm tools:test` (vitest `--project tools`, covers review-queue + marshal-acp), `pnpm tools:typecheck`.

Requires Node ≥ 22.18 (type stripping is on by default; earlier 22.x needed `--experimental-strip-types`).

## Configuration

After the first run, edit `~/.marshal-review-queue/state.json` to point at your repo:

```json
{
  "config": {
    "maxConcurrent": 5,
    "cooldownMinutes": 60,
    "defaultRuntime": "claude",
    "followUpOnTruncation": true,
    "reviewRetentionHours": 24,
    "repos": {
      "default": {
        "cwd": "/Users/me/repos/m-tanstack-query",
        "dashboardCmd": ["python3", "skills/marshal-review-dashboard/scripts/list-prs.py", "--json"]
      }
    }
  }
}
```

Knobs:

- **`maxConcurrent`** — slot pool size. Each running slot is one ACP child process; budget your API spend accordingly.
- **`cooldownMinutes`** — minimum gap between iterations on the same PR. Stops re-reviewing on rapid force-pushes.
- **`defaultRuntime`** — `"claude"` or `"copilot"`. Per-PR override available via `state.json: prs[<n>].runtimeOverride`.
- **`followUpOnTruncation`** — when a session ends with no synthesis section AND the body shows mid-narration markers ("waiting on X", "N of M complete"), send one follow-up `session/prompt` asking the agent to synthesize. Default `true`. Set `false` to disable and accept truncated bodies on large PRs (e.g. for cost reasons).
- **`reviewRetentionHours`** — controls the retention sweep. Default `24`; set to `0` to disable. A row in any of `confirmed`, `dismissed`, `failed`, `crashed`, or `pending-confirmation` becomes a sweep candidate when it hasn't appeared in the dashboard for this many hours; the daemon then runs `gh pr view --json state,closedAt` to **verify the PR is actually merged or closed before deleting anything** — dashboard absence alone can also mean "failing CI" or "outside lookback window," neither of which should reap. If the verified PR is still open, `lastSeenAt` is bumped so we don't re-check it on every tick. The `gh` check is what protects a still-open `pending-confirmation` review you haven't gotten around to posting yet — that PR comes back OPEN and the row stays.
- **`repos.default`** — the only repo currently supported. Multi-repo is a future hook; non-`default` keys are silently ignored today.

The daemon validates with zod on every read; bad config errors loudly to `daemon.log`.

## Commands

| Command                            | Effect                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `marshal-review-queue ensure`            | Spawns the daemon detached if not running. Idempotent.                                                                                                                                                                                                                                  |
| `marshal-review-queue tick`              | One pass: read dashboard → diff state → re-rank → fill slots → cancel stale.                                                                                                                                                                                                            |
| `marshal-review-queue status`            | Print `~/.marshal-review-queue/status.md`.                                                                                                                                                                                                                                                    |
| `marshal-review-queue show <pr>`         | Print `~/.marshal-review-queue/reviews/pr-<pr>.md`.                                                                                                                                                                                                                                           |
| `marshal-review-queue resume <pr>`       | Open a Zellij tab on the PR's last session via `launch-review.sh --resume-session`.                                                                                                                                                                                                     |
| `marshal-review-queue confirm <pr>`      | Mark `confirmed`. You posted manually; queue stops touching the row.                                                                                                                                                                                                                    |
| `marshal-review-queue dismiss <pr>`      | Mark `dismissed`. Same effect, different intent.                                                                                                                                                                                                                                        |
| `marshal-review-queue requeue <pr>`      | Force re-review at the current head SHA, bypassing cooldown. State-only — call `tick` next to actually start the slot.                                                                                                                                                                  |
| `marshal-review-queue cancel <pr>`       | Cancel a running or queued review.                                                                                                                                                                                                                                                      |
| `marshal-review-queue keep-context <pr>` | Resume the prior ACP session on the next iteration of this PR (via `session/load`) instead of starting fresh. One-shot — consumed on the next slot spawn. Use this after `resume`-ing and having a meaningful chat with the agent that you want preserved when the author pushes a fix. |
| `marshal-review-queue stop`              | Drain in-flight reviews (mark them `crashed`) and exit.                                                                                                                                                                                                                                 |
| `marshal-review-queue logs [--follow]`   | Tail `daemon.log`.                                                                                                                                                                                                                                                                      |

## Triggering ticks

Pick one or both:

### Marshal automation (preferred while Marshal is open)

In Marshal's automations UI, create:

- Schedule: every 30 minutes
- Single step prompt:
  > Use the shell to run: `marshal-review-queue tick`. Don't analyze the output, don't post anything anywhere.

### OS scheduled task (works when Marshal is closed)

**macOS / Linux** (`crontab -e`):

```
*/30 * * * * /usr/local/bin/marshal-review-queue tick > /dev/null 2>&1
```

**Windows** (Task Scheduler, basic task, every 30 min):

```
Program: C:\Users\<you>\AppData\Roaming\npm\marshal-review-queue.cmd
Arguments: tick
```

(Path varies; run `where marshal-review-queue` to find yours after `pnpm link --global`.)

## Storage layout

```
~/.marshal-review-queue/
  reviews/pr-<n>.md      # one file per PR, iterations appended
  status.md              # human-readable snapshot
  state.json             # daemon-internal source of truth
  daemon.log             # rolling daemon log
  daemon.pid             # PID + lockfile (single-instance enforcement)
  daemon.sock            # POSIX only; Windows uses \\.\pipe\marshal-review-queue
```

Override base via `MARSHAL_REVIEW_QUEUE_HOME=/path/to/home`. Override socket via `MARSHAL_REVIEW_QUEUE_SOCKET=/custom/socket`.

## Comment safety — defense in depth

The "no auto-posting" guarantee is enforced at the **agent's own SDK / CLI layer**, BEFORE its permission classifier gets to opine. Adversarial probes (logged in commit `e570b6ba`) confirmed that without this, both Claude (`auto` and `default` modes) and Copilot will silently post `gh pr comment` with zero permission requests surfaced to us.

Three layers, in order of effectiveness:

1. **Runtime-native deny rules (the real enforcement).**
   - Claude: `_meta.claudeCode.options.settings.permissions.deny` carrying `Bash(gh pr comment*)`, `Bash(gh api*--method POST*)`, `Bash(curl*api.github.com*)`, etc. Verified blocking in `runtimes/claude.ts:POLICY_DENY`.
   - Copilot: repeated `--deny-tool 'shell(gh pr comment:*)'` CLI flags. `--deny-tool` takes precedence over `--allow-all-tools`. Verified blocking in `runtimes/copilot.ts:POLICY_DENY`.
2. **ACP permission callback (regex backstop).** When the runtime DOES surface a tool request (rare in `auto` mode), `permission-policy.ts:isToolUseAllowed` runs a second-pass regex against the same write shapes. Belt-and-suspenders for any pattern the runtime classifier might miss.
3. **Empty `GH_TOKEN` in child env.** Best-effort — note that `gh` CLI uses its own stored OAuth (`~/AppData/Roaming/GitHub CLI/`), so this layer only catches direct `curl` / `wget` with `Authorization: token $GH_TOKEN`.

Per the security note above: `runtimes/claude.ts` and `runtimes/copilot.ts` and the second-pass regex in `permission-policy.ts` all live in `tools/marshal-acp/src/` now — they're shared between this tool and the standalone `marshal-acp` CLI for ad-hoc agent sessions. Review-queue continues to pass `{ profile: "review" }` so its calls keep the PR-write deny list active.

`marshal-review-queue confirm` does NOT post for you. You always paste the review yourself in a resumed Zellij session via `marshal-review-queue resume <pr>`.

### The `Iteration.cwd` invariant

Each iteration in `state.json` records the `cwd` its ACP session was created in. `resume` and `keep-context` use this when present and fall back to `config.repos.default.cwd` when absent (legacy rows). Don't drop this field — the moment you reconfigure `config.repos.default.cwd` (e.g. to a dedicated review worktree), in-flight `pending-confirmation` sessions need their original cwd to find the on-disk Claude session at `~/.claude/projects/<encoded-cwd>/sessions/<id>.jsonl`.

## Dev workflow

From the repo root:

```bash
pnpm tools:test       # vitest --project tools (covers review-queue + marshal-acp)
pnpm tools:typecheck  # tsc --noEmit against both tools/ tsconfigs
```

Lint runs as part of root `lint-staged` on commit. No build step — edits to
`tools/review-queue/src/marshal-review-*.ts` are picked up on next CLI invocation.

## Telemetry in review files

Each review's frontmatter records what happened in the underlying ACP session:

```yaml
iterations:
  - sha: 7f3a9c2…
    sessionId: cc-abc-123
    agentRuntime: claude
    startedAt: 2026-05-11T11:48:00Z
    completedAt: 2026-05-11T11:58:14Z
    status: pending-confirmation
    stopReason: end_turn # why the agent ended — `end_turn` (voluntary) vs `max_tokens` etc.
    usageOutputTokens: 11493 # last model call's output tokens (NOT cumulative)
```

The H2 iteration header also surfaces the runtime + stopReason inline:

```
## Iteration 1 · `7f3a9c2…` · claude (latest, pending-confirmation, stop=end_turn, out=11493t)
```

## Limitations (v1)

- **Single repo.** `config.repos.default` is the only entry consulted. Multi-repo support is a config-shape hook, not implemented.
- **Truncation recovery is Claude-only.** The follow-up heuristic in `slot.ts:needsSynthesisFollowUp` targets the marshal-code-review skill's narration shape. Copilot reviews don't dispatch sub-agents and don't trigger truncation, so this is fine in practice.
- **`marshal-review-queue logs --follow`** uses `tail -f`; not available on Windows by default. Use `Get-Content -Wait` in PowerShell instead, or run `node -e "require('node:fs').createReadStream(...)"`.
- **`out=` token count is per-call, not cumulative**. ACP's `usage.outputTokens` on the `session/prompt` response appears to report the last model call only. For a real total you'd need to sum the `usage_update` notification stream — not currently done.
- **Cost.** Real reviews run real Claude/Copilot API calls. A maintainer-tier XL PR consumed ~11k output tokens + ~700k cached read tokens in validation. Budget accordingly — keep `maxConcurrent` low if reviewing many PRs.
