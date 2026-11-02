# cursor/

Low-level `RuntimeClient` / `RuntimeClientSession` adapter for `@cursor/sdk`.

`strategy.ts` is the product composition seam used by `create-backend.ts`.
Cursor is composed directly through `LocalBackend`; do not add a Copilot-style
provider facade. Its compatibility origin stays `"copilot"` for legacy
local-row validation, while `runtimeId: "cursor"` owns isolation.

## Authentication

Selecting Cursor shows Marshal's generic runtime sign-in card. `Sign in with Cursor`
runs `Cursor.auth.login()` and stores the minted key under Marshal app data.
`Use existing API key` persists a dashboard-minted user key to the same store.
`CURSOR_API_KEY` in the launch environment also authenticates. Team Admin keys
are not supported.

## Repository customization

Local agents load Cursor's `project` setting source, which lets the SDK apply
`.cursor/rules`, `AGENTS.md`, project skills, commands, and native subagents.
Marshal separately normalizes compatible `.github`, `.cursor`, and `.claude`
agents into the SDK's inline `agents` map so every repository agent remains
assignable. Cross-ecosystem skills and commands stay available through Marshal's
runtime-neutral skill catalog and tools. A session with `projectContext: false`
(a launch that replaced Marshal's prompt) loads no setting sources and no agents.

Marshal gives Cursor the updated prompt assembled by `electron/prompt`, or the
launch's replacement prompt. `session.ts` attaches either one to the first user
request in both append and replace mode, and never passes it through the SDK's
`systemPrompt` option, preserving Cursor's built-in system prompt and native
tool contract. Keep `tools` omitted for the standard Cursor toolset. A host tool
allowlist sends `tools: ["mcp"]`, the group that carries only the allowlisted
host tools; `tools: []` remains the intentional tool-free shape.

As of SDK `1.0.35`, native `systemPrompt` replacement still requires server-side
account access; callers without access fail on the first `send` with
`InvalidArgument` naming `--system-prompt`. Upgrading the SDK does not remove
this gate. Replacement is local-only, must be supplied again on resume, and
does not replace tool schemas, ambient rules/skills, or subagent prompts.

`send` acknowledges SDK run startup while the session consumes events in the
background; `sendAndWait` waits for completion. Cancellation marks the turn
before awaiting startup, cancels the returned run, and waits for local turn
cleanup. Native busy-turn steering uses `Run.steer`; only
`revert_to_followup` (or an absent steering method) queues a follow-up after
completion. A steering error propagates without cancelling the original run.

Image attachments with validated JPEG/PNG/GIF/WebP signatures are sent through
the SDK's inline image input. Other attachments remain escaped path metadata for
Cursor's permission-gated filesystem tools. Cursor's compact action invokes its
native `/summarize` command without replacing the backend session.

Runtime transfers read Cursor's saved native conversation through the public
SDK checkpoint store. This includes its retained summary and subsequent turns,
including legacy chats without a Marshal checkpoint. Reading never starts or
resumes an agent, sends `/summarize`, or fetches models. Source Marshal prompts,
root prompts, and archived summaries are excluded. The adapter also captures
`onStep` and `summary` updates as `session.context_checkpoint` for live tracking;
a summary replaces the earlier window and subsequent steps append to it.

Extra accounts (`cursor@<id>:<model>`) use their own credential store under
`<appData>/cursor-accounts/<id>` and ignore `CURSOR_API_KEY` from the launch
environment. See "Runtime Accounts" in
`docs/architecture/14-marshal-backend-abstraction.md`.

Legacy SDK facades without native checkpoint access reuse an attached session
for context reads. Temporary source sessions disconnect in `finally`;
disconnect and destroy release the client registration even if disposal fails.

Recovery enumerates all SDK run-history pages before resuming an orphaned
agent. Resumed sends retry only an active-run collision, once, through the
SDK's `local.force` crash-recovery option. Disconnect cancels owned running
turns before disposal; stream failures and failed compactions also cancel
unfinished native runs.
