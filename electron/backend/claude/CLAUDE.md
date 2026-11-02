# claude/

Low-level `RuntimeClient` / `RuntimeClientSession` adapter for
`@anthropic-ai/claude-agent-sdk`.

`strategy.ts` is the product composition seam used by `create-backend.ts`.
Claude Agent is composed directly through `LocalBackend`; do not add a
Copilot-style provider facade. Its compatibility origin stays `"copilot"` for
legacy local-row validation, while `runtimeId: "claude"` owns isolation.

## Session lifecycle

Each Marshal session owns one persistent streaming-input `query()` and one Claude
CLI subprocess. `createSession()` allocates a UUID locally and passes it as
`Options.sessionId`, so Marshal has a stable backend ID before the first paid
turn. `resumeSession()` uses that same persistent shape with `Options.resume`.
Subsequent `send()` calls enqueue `SDKUserMessage` values into the query rather
than spawning one process per turn. This is required for live `interrupt()`,
`setModel()`, MCP control methods, and low-latency multi-turn use.
The client factory always supplies a tracked local spawner, including in
production, so force-stop paths can terminate every owned Claude subprocess
rather than only the first session. The spawner drains stderr continuously,
and Windows force-stop synchronously tree-kills every tracked root PID before
direct-kill fallbacks.

Image attachments with validated JPEG/PNG/GIF/WebP signatures are sent as
base64 image content blocks within conservative cross-provider size limits.
Other files, oversized/invalid images, and directories are represented only by
escaped path metadata so Claude can inspect them through its permission-gated
Read/Glob/Grep tools; their contents are never injected into the prompt.

## Isolation and authentication

The adapter loads the SDK's `project` setting source so repository `CLAUDE.md`,
`.claude/rules`, skills, commands, and agents remain available. It keeps
`strictMcpConfig: true` and a Marshal-owned `CLAUDE_CONFIG_DIR`; user and local
settings are not imported. Marshal appends legacy system messages to the
`claude_code` preset, or passes the complete Marshal-owned prompt as a custom
string when replacement mode is active. It also supplies normalized agents from
the repository's supported conventions. A session with `projectContext: false`
(a launch that replaced Marshal's prompt) loads no setting sources, no skills,
and no agents. Claude Code's own auto-memory is off for every session
(`settings.autoMemoryEnabled: false`): Marshal memory is the single memory
channel. Notes that auto-memory already wrote under the Marshal-owned config
directory (`projects/*/memory/`) are left untouched.
Every session passes `thinking: { type: "adaptive", display: "summarized" }`:
Opus 5.5 and later default thinking display to "omitted", so without it long
thinking streams no reasoning and the chat looks stuck. `settings.showThinkingSummaries`
does not change the API request; the CLI maps the option for older models
(verified on Haiku 4.5).
Browser login runs the bundled Claude CLI's
official `auth login --claudeai` flow and persists its refreshable credentials
inside that directory. It also supports Anthropic API keys and official
cloud-provider environment credentials. Inherited OAuth environment tokens are
still stripped so Marshal never imports or copies credentials from another app.
Environment-key filtering is case-insensitive so Windows cannot bypass the
OAuth boundary with mixed-case variable names.
The factory sets the same config directory in the Electron host before importing
the SDK because `getSessionMessages()` and `deleteSession()` memoize that host
environment value separately from the query subprocess.
Runtime handoff reads retained history directly with `getSessionMessages()`;
it does not start or resume a Claude query just to export context.

Packaged builds resolve Claude only from the unpacked platform package under
`resources/app.asar.unpacked/node_modules/`. On macOS the resolver prefers the
Tahoe AMFI `.app` wrapper produced by afterPack, then falls back to the flat
binary. Development leaves `pathToClaudeCodeExecutable` unset so the SDK uses
its normal optional-package resolution.

## Lean prompt flags

Three experiments shape the Claude prompt for sessions created while they are
on, each stamped on the session: `experiments.leanPrompt`
(`MARSHAL_LEAN_PROMPT=0|1`, trimmed tooling/host/runtime sections and native
tool list), `experiments.leanRepoRules` (`MARSHAL_LEAN_REPO_RULES=0|1`,
repository-rule index) and `experiments.leanCore` (`MARSHAL_LEAN_CORE=0|1`,
rewritten behavior core and deeper section trims). All OFF must stay
byte-identical to the legacy output — `electron/prompt/golden/` holds the
fixtures. In this adapter the only effect is
`RuntimeSessionConfig.disabledBuiltInTools` becoming the SDK's
`disallowedTools` (`AskUserQuestion`, `Workflow`), driven by `leanPrompt`; it
removes those tools from the model's context while the rest of the
`claude_code` preset and any `availableTools` allowlist behave as before.
Design and rollback steps per flag: `docs/architecture/04-marshal-session-lifecycle.md`
("Lean prompt flags").

## Host tools and MCP

Host `RuntimeTool`s run through one in-process SDK MCP server named `marshal`.
The SDK defers MCP tool schemas behind ToolSearch by default; a tool with
`eagerLoad` is registered with `alwaysLoad` so its schema is present from the
first turn (the core runtime tools use this). When the session has a
`scriptingTool` (trusted TypeScript), the PreToolUse hook adds non-blocking
context to script-shaped `Bash` commands (`../local/scripting-nudge.ts`)
pointing the agent at that tool. Detection ignores quoted text and heredoc
bodies and counts pipe stages per command, not across `;`/`&&` chains. The
scripting tool's optional `toolCallHint` adds context to `Bash` and `Grep` the
same way: concept-shaped code searches (several words or alternatives) get the
TypeScript call to `knowledge.search` when that capability exists in the
session's runtime scope (`../../marshal-runtime/code-search-nudge.ts`).
Interactive OAuth for remote MCP servers remains app-owned: the SDK reports
`needs-auth`, and Marshal must complete OAuth then provide an authorization
header.

Extra accounts (`claude@<id>:<model>`) get their own `CLAUDE_CONFIG_DIR` under
`~/.marshal/marshal-claude-accounts/<id>` with `projects/` linked to the host
config dir; see `accounts.ts` and "Runtime Accounts" in
`docs/architecture/14-marshal-backend-abstraction.md`.

## Plan usage and token keep-alive

`ClaudeRuntimeClient.getUsage()` (`usage.ts` holds the normalizers) reads plan rate limits through a
short-lived no-prompt query using `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`
with `skipBehaviors: true`. It never starts a model turn and works for any account config dir without
a live session; keep the experimental call confined to this adapter and fail soft if the SDK changes.
Per-turn `rate_limit_event` messages are recorded per config dir in `claudeRateLimitEvents`
(`utilization` is a 0-1 fraction, `resetsAt` is unix seconds) and only used when the fetch fails.

The CLI refreshes an OAuth token only when the account is used, when it is within five minutes of
expiry, and serializes refreshes per config dir with `.oauth_refresh.lock`. Marshal never refreshes
tokens itself; `RuntimeAccountsKeepAlive` keeps idle accounts alive by reading their usage on a
schedule. Never log or read credential values from the keychain entry
`Claude Code-credentials-<sha256(config dir)[:8]>` or `<dir>/.credentials.json`; the hash is derived
from the exact `CLAUDE_CONFIG_DIR` string, so changing an account's directory path signs it out.
