---
name: marshal-acp-prompt
description: "Dispatch an ad-hoc Claude or Copilot sub-agent via ACP, persist the response as markdown under ~/.marshal-acp/sessions/. Dev-only. Use when the user wants to spin up a sub-agent with shell access — 'summarize this PR', 'investigate the test flake', 'audit telemetry calls'. Sessions take 30 seconds to 5+ minutes; blocking mode WILL block that long, don't abort. For >30s tasks pass --detach (fire-and-forget) and then run `marshal-acp wait <basename>` to block until done — on async-shell hosts (Marshal, Codespaces) run wait as an async job and read its output when the host notifies completion. Always surface the file path + resume + open commands to the user."
---

# marshal-acp-prompt — ad-hoc agent sessions

Dev-only skill. Not bundled with the Electron build — for use by AI assistants (Claude Code, Copilot CLI) running against the OmerMachluf/marshal clone.

## When to use

Use **marshal-acp-prompt** when the right answer is "dispatch a fresh agent with shell tools" rather than "answer from the chat". Good triggers:

- "Run a sub-agent to summarize the changes in this PR."
- "Have an agent investigate why the relay e2e test is failing."
- "Spin up an agent to read through `electron/sessions.ts` and report what it does."
- "Run an agent to audit the telemetry calls."

Don't use this skill for:

- Conversational questions answerable from existing chat context.
- Anything you can do in two grep / read steps.
- Tasks that need to land changes in the chat's editor (the agent runs in its own sub-session and writes to a markdown file, not the editor).

## How it works

`marshal-acp prompt <title> <prompt-text>` shells out to the `marshal-acp` CLI (installed by `pnpm link --global` from the repo root). The CLI:

1. Spawns the configured runtime (`claude-agent-acp` or `copilot --acp`) cwd'd to the current workspace.
2. Drives a single ACP `session/new` + `session/prompt` turn to completion.
3. Persists the full session — title, runtime, sessionId, cwd, prompt, response, telemetry — as `~/.marshal-acp/sessions/<ISO>-<sessionId-short>-<slug>.md`.
4. Returns the session id + file path on stdout.

The session file is the durable artifact. Subsequent commands:

- `marshal-acp show <file>` — print it
- `marshal-acp resume <file>` — open the session in a Zellij tab for further interaction
- `marshal-acp prompt --resume <file> <title> <follow-up>` — programmatically add another turn to the same file

## Invocation

The skill's `scripts/run.py` is the entry point:

```
python3 tools/marshal-acp/skill/scripts/run.py --title "<short label>" --prompt "<full instruction>"
```

Optional flags:

- `--runtime claude|copilot` — override `~/.marshal-acp/config.json` defaultRuntime.
- `--profile review|default` — `default` (the marshal-acp default) has no policy denies; `review` uses marshal-review-queue's deny list (no PR writes, no `gh auth token`, no curl against api.github.com).
- `--cwd <path>` — override the working directory (defaults to the current dir).
- `--detach` — non-blocking. Spawn the session in a detached subprocess and return immediately. Useful for long-running tasks (PR reviews, large audits, anything 30s+) when you don't want to block the chat waiting for the agent. Without `--detach`, the script blocks until the agent finishes and the response is fully written.

After the script returns, the path it prints is the session markdown. In `--detach` mode the file fills in over the next ~10-60s — check it with `marshal-acp show <basename>` once the agent finishes.

The script always prints four lines:

```
session: <full sessionId>      (or "[pending]" if --detach and session/new hasn't completed yet)
file:    <absolute path>
resume:  marshal-acp prompt --resume <basename> "<title>" "<follow-up text>"
open:    marshal-acp open <basename>
```

`resume` adds another programmatic turn to the same session (and writes the response into the same markdown file). `open` opens the session in a Zellij tab for manual back-and-forth.

## Examples

Summarize a PR (long-running — use `--detach`):

```
python3 tools/marshal-acp/skill/scripts/run.py \
  --title "summarize pr 1970" \
  --prompt "/marshal-code-review https://github.com/OmerMachluf/marshal/pull/1970" \
  --detach
```

Investigate a flaky test (also long, detach):

```
python3 tools/marshal-acp/skill/scripts/run.py \
  --title "debug 28-workspace-scope flake" \
  --prompt "Read e2e/28-workspace-scope.test.ts and the latest two CI failures. Identify the most likely root cause. Don't fix anything yet — just report." \
  --detach
```

Quick audit (blocking — short enough to wait):

```
python3 tools/marshal-acp/skill/scripts/run.py \
  --title "audit telemetry guards" \
  --prompt "Find every call to addLogSink in electron/ and report which ones lack a guard against duplicate registration."
```

**Blocking vs `--detach` rule of thumb:** if the prompt asks for something that should take more than ~30s, prefer `--detach` so the chat stays responsive. Quick reads / summaries / one-grep tasks can stay blocking.

## CRITICAL: handling the response

The agent runs are slow. **Typical session length: 30 seconds to 5 minutes.** Some (large PR reviews, multi-step investigations) run 10+ minutes. The script's exit doesn't mean the agent finished — that's only true in blocking mode.

### Blocking mode (no `--detach`)

The Python script `subprocess.run()`'s the marshal-acp CLI which blocks the whole time the agent is working. **You MUST let the call complete — do not abort it, do not assume it's hung.** If you see no output for 60+ seconds that is normal; the agent is thinking / reading / running tools. The full response is in the script's stdout once it returns.

### Detach mode (`--detach`)

The script returns in ~5 seconds with the file path. **The agent is STILL RUNNING in the background** — you have not seen its response yet. The right way to wait for completion is `marshal-acp wait`:

```
marshal-acp wait <basename> --timeout 900
```

`wait` blocks until the agent finishes (or the timeout fires) and prints the full session markdown to stdout on success. Exit codes:

- `0` — agent completed; markdown is in stdout.
- `1` — timeout fired (defaults to 15 minutes).
- `2` — agent crashed; the subprocess's stderr is printed to stderr.

**On host platforms with async-shell support (Marshal's `powershell(mode="async")`, GitHub Codespaces background tasks):** spawn `marshal-acp wait` as an async job after the `--detach` returns. The host will notify you when wait exits; read its output and present results to the user. This is the preferred pattern — no manual polling.

**On platforms without async-shell:** `marshal-acp wait` is still blocking, so calling it directly works but the chat is blocked for the wait duration. Alternative: poll manually with `marshal-acp status` (shows ⏳ / ✅ / ❌ for each session) and `marshal-acp show <basename>` once status shows ✅.

A done file's frontmatter contains a `completedAt:` line:

```
---
title: debug 28-workspace-scope flake
sessionId: e5254c5d-...
runtime: claude
...
startedAt: 2026-05-13T10:00:00.000Z
completedAt: 2026-05-13T10:03:42.118Z   ← present means done
turns:
  - at: 2026-05-13T10:00:00.000Z
    ...
---
```

While running there's a `<basename>.running` marker file. When the subprocess exits cleanly the marker is removed and `completedAt:` lands in the frontmatter. If the marker is gone but `completedAt:` is absent, the subprocess crashed — check `<basename>.log` for stderr.

### What to tell the user

After invoking the skill, always surface to the user:

- The file path (`~/.marshal-acp/sessions/<basename>.md`) so they can read it directly any time.
- That the agent is running (detach) or completed (blocking).
- The `resume:` and `open:` commands for follow-up.

## Notes

- **Title is required.** Short and concrete (4–8 words). Shows up in filenames + `marshal-acp list`. Don't reuse old titles.
- **Title ≠ prompt.** Title is for human scanning; prompt is what the agent executes.
- Session files may contain code edits or shell commands the agent ran. They're proposed, not landed.
- If `marshal-acp` isn't on PATH (`command -v marshal-acp` returns nothing), run `pnpm install && pnpm link --global` from the repo root and re-open the shell.
