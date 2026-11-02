# marshal-acp

Ad-hoc Claude/Copilot agent sessions over the Agent Client Protocol. Spawns an ACP-capable runtime (`claude-agent-acp` or `copilot --acp`), drives a prompt to completion, and persists the result as markdown under `~/.marshal-acp/sessions/`.

marshal-acp is the reusable ACP-driver core extracted from `marshal-review-queue`. `slot`, `runtimes/`, and `permission-policy` are imported by both tools — review-queue adds the queue + orchestrator on top; marshal-acp ships the lower-level driver and a thin CLI.

## Install

After cloning + `pnpm install`, `pnpm link --global` exposes `marshal-acp` (and `marshal-review-queue`) on `$PATH`.

```bash
pnpm install
pnpm link --global
```

Requires Node ≥ 22.18.

## Commands

| Command                                       | Effect                                                                                                                                                                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `marshal-acp init`                                  | Create `~/.marshal-acp/` + `~/.marshal-acp/config.json` with defaults. Idempotent.                                                                                                                                                                               |
| `marshal-acp prompt <title> <text>`                 | Run one ACP session (blocking). Persists `<ISO>-<slug>.md` under `~/.marshal-acp/sessions/`. Prints `session: <id>`, `file: <path>`, and the `resume:` / `open:` commands.                                                                                 |
| `marshal-acp prompt --resume <file> <title> <text>` | Programmatic follow-up: append a new turn to an existing session via ACP `session/load`. Same output shape.                                                                                                                                          |
| `marshal-acp prompt --detach <title> <text>`        | Non-blocking: spawn the session in a detached subprocess and return immediately. Same output shape; sessionId may show `[pending]` if session/new hasn't completed in the parent's 5s wait window (use `marshal-acp show <file>` once the agent finishes). |
| `marshal-acp open <file>`                           | Interactive: open a saved session in a Zellij tab via `launch-review.sh`. For programmatic follow-up use `marshal-acp prompt --resume`.                                                                                                                    |
| `marshal-acp list`                                  | Session files, newest-first.                                                                                                                                                                                                                         |
| `marshal-acp show <file>`                           | Print a session markdown. Accepts basename or absolute path.                                                                                                                                                                                         |
| `marshal-acp status`                                | In-flight + recent sessions. ⏳ running (with elapsed + PID), ❌ crashed (PID dead but marker still present), ✅ completed.                                                                                                                          |
| `marshal-acp wait <file>`                           | Block until a session completes. Prints full markdown on success (exit 0), crash log on failure (exit 2), times out (exit 1). `--timeout <seconds>` (default 900), `--poll-interval <seconds>` (default 3). Intended for async-shell integration.    |

`--help` works at the top level and per-command.

## Output shape

Every `marshal-acp prompt` invocation (blocking, `--resume`, or `--detach`) prints:

```
session: <full sessionId from ACP>
file:    <absolute path to the markdown>
resume:  marshal-acp prompt --resume <basename> "<title>" "<follow-up text>"
open:    marshal-acp open <basename>
```

## Config — `~/.marshal-acp/config.json`

```json
{
  "defaultRuntime": "claude",
  "defaultPermissionProfile": "default",
  "maxLifetimeMs": 1800000
}
```

- **`defaultRuntime`** — `"claude"` or `"copilot"`. Override via `--runtime`.
- **`defaultPermissionProfile`** — `"default"` (no policy denies; the runtime's permission prompts are the filter) or `"review"` (same deny list as `marshal-review-queue`: no PR writes, no `gh auth token`, no curl against api.github.com).
- **`maxLifetimeMs`** — hard ceiling on a single session's runtime. 30 min default. The slot SIGKILLs the ACP child on timeout.

## Storage layout

```
~/.marshal-acp/
  config.json
  sessions/
    2026-05-12T10-00-00-000Z-summarize-pr-42.md          # completed session
    2026-05-12T11-30-00-000Z-fix-issue-1234.md           # completed session
    2026-05-12T11-30-00-000Z-fix-issue-1234.md.running   # liveness marker while running
    2026-05-12T11-30-00-000Z-fix-issue-1234.md.log       # subprocess stderr (kept on crash)
```

Filename is `<ISO>-<slug>.md`. The slug is derived from `<title>`. ISO is millisecond-precision so concurrent same-title runs are still uniquely named. The full ACP sessionId lives in the file's frontmatter (used by `--resume` / `open`).

The `<file>.running` marker is JSON (`{ pid, startedAt }`) written by the detached subprocess on startup and deleted via try/finally on exit. `marshal-acp wait` and `marshal-acp status` use it to distinguish "running" from "crashed". The `<file>.log` captures the subprocess's stderr — useful when a session crashes silently (bad cwd, missing runtime, ACP handshake error).

Override the base directory via `MARSHAL_ACP_HOME=<path>` (tests use this).

## Skill driver

For programmatic invocation from AI assistants (Claude Code, Copilot CLI), `tools/marshal-acp/skill/` ships `SKILL.md` + `scripts/run.py`. The skill is dev-only — it isn't bundled with Marshal. The Python wrapper just shells out to `marshal-acp prompt` with the same flag set.

## Dev workflow

```bash
pnpm tools:test        # vitest --project tools (covers marshal-acp + review-queue)
pnpm tools:typecheck   # tsc --noEmit against both tools/ tsconfigs
```

No build step — Node 22.18+ strips the `.ts` source on the fly. CLI shebang is `#!/usr/bin/env node`.

Lint runs from the root `oxlint` invocation; `tools/` is included in its default scan and oxlint walks up to find the nearest `tsconfig.json` for type-aware checks.
