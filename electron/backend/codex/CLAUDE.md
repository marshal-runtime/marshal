# codex/

Codex app-server adapter over the shared runtime client/session contract.

- `factory.ts` creates the client and delegates executable resolution to
  `process.ts`. The composition root passes Electron's authoritative
  `app.isPackaged` and `process.resourcesPath`; do not duplicate path math.
- `strategy.ts` composes the adapter directly through `LocalBackend`. Its
  compatibility origin stays `"copilot"` for legacy local-row validation,
  while `runtimeId: "codex"` owns isolation.
- Browser, device-code, and API-key login all flow through the shared typed
  runtime auth contract. Renderer code must not downcast to Codex types.
- `CODEX_HOME` is Marshal-owned and inherited API keys/tokens are stripped
  before the app-server starts.

## Known adapter limitations

These are current app-server/schema boundaries, not hidden parity claims:

- The app-server has no blocking pre-dispatch callback for native operations it
  auto-classifies as safe reads. Marshal runs threads with `untrusted`
  approvals (read-only sandbox by default, see "Config contract"), evaluates
  the host pre-tool hook when the item-start notification arrives, and
  interrupts on denial. A sufficiently fast native read may already have
  executed before that interruption lands.
- The pinned `thread/resume` schema does not accept `dynamicTools`. Resumed
  threads keep the tools from the original `thread/start`; `thread-tools.ts`
  records a hash per thread and `resumeSession` starts a replacement thread
  (handing the old context to the host via `takeResumeHandoff`) when the
  host's tools changed.
- URL-mode MCP elicitations can use the normal approval path. Structured form
  elicitations require response content the shared permission UI cannot
  provide, so the adapter declines or cancels them safely rather than
  fabricating form data.
- The packaged macOS `.app` wrapper preserves Tahoe AMFI compatibility, but
  the upstream launcher does not yet expose package-root information to every
  bundled-resource lookup. `rg` uses the managed helper path; other bundled
  resource lookups may fall back to system tools until upstream package-root
  support lands.
- Native multi-agent stays on for `multi_agent_version: "v2"` models
  (gpt-5.6-sol/terra): no config key removes the collaboration tools.
  `config.ts` sets `features.multi_agent_v2.root_agent_usage_hint_text = ""`
  to drop the "/root" team-leader message and keeps the `<multi_agent_mode>`
  "don't spawn unless asked" guard (`multi_agent_mode_hint_text`). `client.ts` maps child threads to their root session
  (`childThreadRoots`) and answers their server requests there; do not add
  config that claims to disable it.
- Rate-limit reset times come from `account/rateLimits/read` (5 s bound)
  with the last `account/rateLimits/updated` snapshot as fallback. A
  usage-limited `turn/completed` is held, with every later notification for
  that session, until the read returns.
- Auth failures (`codexErrorInfo` unauthorized, any upstream 401, a refused
  `account/chatgptAuthTokens/refresh`) report `errorType:
"authentication_failed"` (`AUTH_REQUIRED_ERROR_CODE`). Shared code
  detects auth by that code, not by the message text.
- A non-retrying `error` notification emits nothing and fires no hook; the
  failed `turn/completed` is the single error report. Keep it that way, or
  chats and goals see the failure twice.
- `handleTransportError` only closes sessions when the connection reports
  closed; `jsonl-rpc` also emits non-fatal handler errors on the same
  channel.

- Extra accounts (`codex@<id>:<model>`) run with `CODEX_HOME` set to
  `~/.marshal/marshal-codex-accounts/<id>` (`accounts.ts`). Homes are not
  shared. See "Runtime Accounts" in `docs/architecture/14-marshal-backend-abstraction.md`.

## Config contract (`config.ts`, `tool-surface.ts`, `native-tool-notes.ts`)

Every key below was checked against the pinned binary (codex 0.146.0-alpha.10.1)
with a mock Responses server and `codex debug prompt-input`; regenerate the
probe when the pin moves.

- **System prompt.** `systemMessage.mode === "replace"` becomes
  `baseInstructions` on thread/start and thread/resume (it replaces Codex's
  whole built-in "You are Codex" base prompt, nothing else) plus a "Codex tool notes" block built from
  Codex's own base instructions (the tool schemas carry the apply_patch grammar
  and `sandbox_permissions`, so the notes only keep conduct rules). Any other
  mode is `developerInstructions`. The multi-agent developer messages
  ("/root, the primary agent ...", `<multi_agent_mode>`) are separate and are
  not removed by `baseInstructions`; only the `multi_agent` feature switch does
  that. Whether a runtime gets the Marshal-owned
  prompt at all is `supportsNativePromptReplacement` in `common/runtime-config.ts`.
- **Sandbox.** `SessionSandboxConfig.mode` maps straight to the thread
  `sandbox`. `resolveSessionSandbox` derives `danger-full-access` for allow-all
  sessions (no OS sandbox, network included, no read-only-then-approve retry)
  and never for reviewers. `approvalPolicy: "untrusted"` stays on so Marshal's
  policy and audit log see every action. The model-facing `<permissions
  instructions>` follow the thread sandbox (verified on create and resume):
  read-only says "only permits reading files, network restricted";
  `danger-full-access` says "No filesystem sandboxing ... Network access is
  enabled", so the model is not told it is read-only.
- **Tool surface.** `availableTools` undefined = unrestricted. A list switches
  off native shell, web search, `update_plan`, `request_user_input` and
  multi-agent unless named; `apply_patch`/`view_image` cannot be removed.
  `features.goals` is always off. Non-eager host tools are deferred in the
  `marshal_host_tools` namespace (unrestricted sessions only); calls arrive
  with that namespace and `handleDynamicToolCall` accepts it.
- **Ephemeral.** `RuntimeSessionConfig.ephemeral` (set by `infer()`) maps to
  thread/start `ephemeral`.
- **Project docs.** Codex loads AGENTS.md itself; `project_doc_max_bytes: 0`
  when `projectContext === false` or the allowlist is empty. The
  repository-customizations prompt omits the root `AGENTS.md` for Codex.
- **Compaction.** `rpc.history.compact` = `thread/compact/start` settled by the
  compaction turn's `turn/completed` (`compaction.ts`).
- **Gauge.** `session.usage_info.currentTokens` is `tokenUsage.last.totalTokens`.
