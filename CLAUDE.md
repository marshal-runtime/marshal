# CLAUDE.md

This file is the entry-point reference for coding agents and human contributors working in this repo. It captures technical conventions, repo-specific anti-patterns, and the boundaries that have to stay intact.

Marshal is an Electron + React 19 + TypeScript desktop AI assistant with pluggable Copilot, Claude, Codex, Cursor, and Gateway runtimes. It connects to MCP servers for browser automation (Playwright), serves File System Access as a built-in capability (Marshal self-tools plus runtime file built-ins), and runs shell commands through a permission-gated tier system. Runtime-specific SDK and transport details stay behind the shared backend contracts so product behavior does not become tied to one provider. The five backend-abstraction rules below are the load-bearing ones; see [`skills/marshal-code-review/agents/backend-abstraction.md`](skills/marshal-code-review/agents/backend-abstraction.md) for the full review rubric (PR canonicals, sub-rules, common leakage patterns).

## Commands

```bash
pnpm install                                # Public npm dependencies + Playwright browsers (auto-skips under $CI)
pnpm install:skills                         # Symlink repo skills into .claude/skills and .github/skills
pnpm dev                                    # Vite dev server with HMR
pnpm electron:dev                           # Full vite build, then launch Electron
pnpm electron:debug                         # Same, with CDP on :9222 (for e2e-real)
# NOTE: set `MARSHAL_DEV_FEATURES=true` at build time to expose diagnostics, hidden experiments,
# and other developer surfaces (`__MARSHAL_DEV_FEATURES__`). Off by default.
pnpm test                                   # All vitest projects (unit + node + browser)
pnpm test src/shell/Header.test.tsx         # Single test file
pnpm test:watch                             # Watch mode
pnpm test:coverage                          # Coverage report
pnpm test:e2e                               # Playwright E2E suite
pnpm test:e2e:file e2e/automations.marshal.test.ts  # Single E2E file (no retries)
pnpm test:e2e:real                          # Real-account CDP suite — needs `electron:debug` running
pnpm lint                                   # Oxlint, zero warnings, type-aware
pnpm lint:files src/                        # Lint a specific path
pnpm format                                 # oxfmt auto-fix
pnpm format:check                           # Check formatting without fixing
pnpm typecheck                              # tsc --noEmit
pnpm build:vite                             # Vite build only — fastest "does it compile" check
pnpm build                                  # Full release: prebuild + vite + electron-builder
```

## Architecture at a glance

Two Electron processes communicate exclusively through a typed IPC contract.

- **Main process** (`electron/`) — windows/lifecycle, IPC handlers, session lifecycle, MCP child processes, permission policy, Copilot SDK + Gateway clients, runtime auth, telemetry.
- **Renderer process** (`src/`) — React 19 UI. Talks to main only through IPC. `electron/preload.cjs` exposes one global per namespace via `contextBridge.exposeInMainWorld` — see that file for the full list. There is no umbrella `window.electronAPI`.
- **Shared** (`common/`) — code reachable from both processes. `common/marshal-ipc-contract.ts` is the **single source of truth** for IPC types: `IpcInvokeMap`, event maps, domain types, and the `InvokeMethodsFor<"namespace">` helper that derives renderer API types so renaming a channel becomes a compile error.

A handful of files carry most of the weight: `electron/main.ts` (composition root), `electron/preload.cjs` (renderer bridge — one global per IPC namespace), `common/marshal-ipc-contract.ts` (~2,400 lines, all IPC type changes start here), `electron/ipc/ipc-handle.ts` (the `ipcHandle()` wrapper — use it, never raw `ipcMain.handle`), `electron/backend/` (per-backend subdirs with their own scoped `CLAUDE.md`), `electron/sessions.ts` (backend-agnostic, oxlint-blocked from importing `electron/backend/{copilot,gateway}/**`), and `common/marshal-logger.ts` (`createLogger(tag)` — bare `console.*` is lint-blocked).

## Cross-platform parity

**Write code with cross-platform in mind.** You're not expected to actually run every change on both macOS and Windows — most contributors only have one dev machine. But when the diff touches a cross-platform-risky surface — `process.platform` branches, new `path.join` / `path.resolve` callsites, child-process spawning (`windowsHide`, `sidecar/node-runner.exe`), `afterPack` script edits, build/release YAML — test the other side or say which side went untested.

The specific patterns reviewers flag (bundled-node spawning for MCP children, `windowsHide: true` in spawn options, ARM64/x64 binary pruning in `afterPack`) live in [`skills/marshal-code-review/agents/main-process.md`](skills/marshal-code-review/agents/main-process.md). When in doubt, read that section before working on infra-shaped code.

**MCP server spawning**: All platforms spawn the bundled Node binary at `resources/node/node[.exe]`. Windows still routes through `sidecar/node-runner.exe` for windowless spawn — it forwards to the bundled node and clears `NODE_OPTIONS`. See `buildMcpCommand()`.

## Backend abstraction — five rules

The whole point is that adding a third backend should not require touching shared code. Rules are numbered because code comments (in `common/marshal-ipc-contract.ts` and `electron/backend/local/provider.ts`) and the `skills/marshal-code-review/agents/backend-abstraction.md` rubric cite them by number — keep the numbering stable.

1. **`electron/sessions.ts` must not import from `electron/backend/gateway/**`or`electron/backend/copilot/**`.** Enforced by oxlint `no-restricted-imports`. If you reach for one of these imports, the right move is almost always a method on `ISessionBackend` or a port in `electron/backend/ports.ts`.
2. **Shared code may read `backend.origin` only for compatibility/transport validation. Session visibility and ownership use `backend.runtimeId` plus `resolveSessionRuntimeId()`; never use origin as the runtime partition.** Never branch behavior on `backend.origin === "gateway"`. If you need per-backend behavior, use a polymorphic method or an explicit capability.
3. **`ISessionBackend` only declares methods implementable by every backend.** No "this only makes sense for gateway" optional members. A no-op implementation is fine, but it must carry a one-line justification comment. `DesktopCapabilitiesFlags` on copilot all start `false` "for interface symmetry per CLAUDE.md rule 3" — the exact phrase exists in `common/marshal-ipc-contract.ts` and must keep working.
4. **Per-backend machinery lives in `electron/backend/<name>/`; runtime-neutral local machinery lives in `electron/backend/local/`.** Shared wiring is `main.ts` only — that's the composition root and is exempt from rule 2.
5. **Every new method on `ISessionBackend` / `IToolBackend` / `IAutomationBackend` needs a case in `electron/backend/conformance.test.ts`.** That's how we prove both backends satisfy the contract. Skipping this is the most common reason a Gateway-only feature ships broken on Copilot.

**Invariant.** `runtimeId` is the durable session partition. Missing `runtimeId` derives from `backendOrigin`; rows missing both fields are pre-spec Copilot sessions. `SessionIndexWriter` partitions by runtime ID and separately validates origin. Gateway rows must carry both `runtimeId: "gateway"` and `backendOrigin: "gateway"` end-to-end; never reinterpret them as Copilot.

For backend-specific details, see [`electron/backend/local/CLAUDE.md`](electron/backend/local/CLAUDE.md), [`electron/backend/copilot/CLAUDE.md`](electron/backend/copilot/CLAUDE.md), [`electron/backend/claude/CLAUDE.md`](electron/backend/claude/CLAUDE.md), [`electron/backend/codex/CLAUDE.md`](electron/backend/codex/CLAUDE.md), [`electron/backend/cursor/CLAUDE.md`](electron/backend/cursor/CLAUDE.md), and [`electron/backend/gateway/CLAUDE.md`](electron/backend/gateway/CLAUDE.md).

## Conventions enforced in PR review

A mix of positive patterns (do this) and anti-patterns (don't do that), derived from `skills/marshal-code-review/` rules and recurring review feedback. The list below is the surface that triggers a flag often enough to be worth codifying; the canonical depth lives in the subagent files under `skills/marshal-code-review/agents/`. Each rule has a _why_ — follow the spirit, not just the letter.

### Comments

- **No comments that restate the code or narrate the change.** Default to writing no comments; only add one when the WHY is non-obvious — a hidden constraint, an incident anchor, a subtle invariant, a workaround for a specific bug. "// fetch the user" above `fetchUser()` is noise. "// migrated from v0.22.47" is noise. If removing the comment wouldn't confuse a future reader who has the diff and git blame, don't write it.
- **Do not delete incident-anchor comments during cleanup.** Comments that name a real version/incident (e.g. "needed to avoid the v0.22.47 redirect loop") are load-bearing — preserve them even when the surrounding code changes.

### IPC handler stack (5 layers)

Missing any layer fails silently or only at runtime. In order:

1. **`common/marshal-ipc-contract.ts`** — add the channel to `IpcInvokeMap` and the relevant namespace API interface (or extend `InvokeMethodsFor<"…">`).
2. **`electron/ipc/<area>-ipc.ts`** — register with `ipcHandle("namespace:method", handler)`. Do **not** call `ipcMain.handle` directly; the wrapper is what routes to E2E stubs and dedupes telemetry.
3. **`electron/preload.cjs`** — expose via `window.electronAPI.namespace.method(...)`.
4. **`electron/e2e-stubs.ts`** — _only_ if the handler depends on the Copilot SDK. Handlers backed by real managers (settings, heartbeat, automations, etc.) intentionally fall through — don't stub them.
5. **`src/test-utils.tsx`** — _only_ if a unit test asserts on the call.

All handlers return `{ success: boolean; error?: string; …data }` (the `IpcResult` envelope). Don't hand-declare a parallel renderer API in a `.d.ts` — derive it via `InvokeMethodsFor<"namespace">` so renames are compile errors.

### React / renderer

- **No `useState` + `useEffect` to fetch and hydrate.** That's `useQuery` re-implemented. If you need a synchronous seed from localStorage, use `placeholderData`. Canonical shapes live in `skills/marshal-code-review/agents/react-query.md`.
- **Writes go through `useMutation`, not fire-and-forget.** `await api.save(); void queryClient.invalidateQueries()` loses `isPending` / `isError`. Wrap in `useMutation` with `onSettled` invalidation.
- **IPC event subscriptions that just `invalidateQueries` belong at boot, not in `useEffect`.** Wire them once in a top-level `wireSomeApi(qc)` call, not coupled to a component's mount lifecycle.
- **Prefer `useEffectEvent` over `useRef` / `useState` dances for "subscribe once, read latest props per call."** React 19 stable; examples in `src/services/telemetry/TelemetryEventBridge.tsx` and `src/features/heartbeat/HeartbeatPanel.tsx`.
- **Use shadcn/ui components for interactive controls** — `Button`, `Dialog`, `Select`, `Tooltip` from `src/components/ui/`. Raw `<button>` slips past styling and a11y conventions.

### Logging & telemetry

- **No bare `console.*` in production code.** Use `createLogger("Tag")` from `common/marshal-logger.ts`. `no-console` is on repo-wide; per-file exemptions in `.oxlintrc.json` track the migration — remove an exemption as you migrate the file, don't add new ones. Exempt by design: `common/marshal-logger.ts` itself, `electron/mini-mode-page/**`, tests.
- **Never log customer content.** No body slices, email, UPN, display name, OAuth token, or session content. Metadata only — lengths, counts, request IDs, error codes. Same applies to telemetry events.
- **Don't double-telemeter errors at the IPC boundary.** `ipcHandle()` checks `hasTelemetryMarker(err)` before emitting `HANDLER_UNCAUGHT`. If a deeper layer already telemetered and rethrew, the error must carry the marker; don't both telemeter and rethrow plain.

### Security

- **`JSON.parse()` is lint-blocked in `electron/` unless guarded.** The custom `sf4/no-bare-json-parse` rule (`eslint-plugins/marshal-sf4.js`) requires one of: (a) `// SF-4: <reason>` on the same or preceding line, (b) cast result to `unknown` (single cast — `as unknown as T` is rejected as a double-cast), or (c) immediately follow with `safeParse` / `safeParseJson`. Off in `src/` (renderer) and tests. The rule exists because bad data in `~/.marshal/*` JSON files would otherwise crash the main process (OWASP SF-4 / unsafe deserialization).
- **`shell.openExternal` requires scheme + domain validation.** Use `openExternalSafe()` / `openLocalFileSafe()` from `electron/open-external.ts`. Never call `shell.openExternal` directly on user-supplied or AI-supplied URLs. Canonical examples: URL format validation for custom MCP servers; overriding the `react-markdown` `img` renderer to block external URLs.
- **Externally-derived data and prompt-loaded memories must be wrapped before entering model context.** Use `wrapUntrusted()` from `electron/untrusted-wrap.ts` for MCP and relay tool returns; use `renderMemoryEntriesForPrompt()` / `wrapUntrustedMemoryFact()` from `electron/marshal-runtime/memory/prompt-provenance.ts` for memory. Shared closing-tag escape logic lives in `electron/foundation/prompt/prompt-boundary.ts`. Never inject external content or prior-session memories as raw trusted text.
- **Persisted-state schema reads need a `KNOWN_FIELDS` allowlist.** When you add a field to a persisted type, update the allowlist for that file so old on-disk JSON doesn't silently drop the new field (or vice versa).
- **MCP tools are blocked, not disconnected, when a user toggles a server off.** `permissions.servers[key].enabled = false` and `PermissionPolicy.checkUserDisabledTool()` deny pre-hook before the SDK invokes the tool. Don't add code paths that tear down the server connection.

### Process hygiene

- **Partial-conversion sweep.** When you change one site of a pattern (one IPC handler, one `useQuery` shape), grep for siblings and convert them in the same PR — or open a tracking issue. "I'll just change this one" leaves a half-converted codebase.
- **No `safeStorage` before `app.whenReady()`.** On macOS the first `safeStorage` access locks the keychain item name to the default "Chromium Safe Storage" if it runs pre-ready (Electron #45328), ignoring `app.setName()`. A new store/helper that reads encrypted state in its constructor silently reintroduces this — defer the read to a post-`whenReady` `reload()`, and route encrypt/decrypt through `safe-storage-file.ts` / `mcp-crypto.ts` so the `assertSafeStorageReady` guard catches it (it logs, doesn't throw, in packaged builds).

## Testing

Four vitest projects picked up by file-naming convention (`*.test.ts` → `node`/`unit`, `*.browser.test.tsx` → `browser`, `tools/**/test/**/*.test.ts` → `tools`). `pnpm test` runs `unit + node + browser`. Tests collocated with source; mocks from `src/test-utils.tsx`. `MARSHAL_E2E=1` is set by E2E fixtures and bypasses auth + SDK init, replaying scenarios from `common/marshal-mock-scenarios.ts` via `electron/e2e-stubs.ts`. Use `sharedTest` (default) over `test` unless the test mutates persistent state. Real-account suite is `e2e-real/` driven by CDP against `pnpm electron:debug`.

## On-disk state, MCP, Permissions, Skills, Packaged build

- **On-disk state** — The Copilot SDK and Marshal persist independently; Marshal's `~/.marshal/marshal-sessions/sessions-index.json` is authoritative for UI render (metadata only). Session content is stored locally alongside it (`LocalSessionStore` in `electron/session-store.ts`), and `marshal-window-state.json` is per-machine (intentionally **not** cloud-synced). When the two persist layers diverge, Marshal rebuilds the SDK side from its own store.
- **MCP** — built-in stdio `playwright` plus user-configured stdio and remote HTTP/SSE custom MCPs. **File System Access**, **Shell**, and **Search Web** are SDK-native capabilities, not MCP servers; File System Access is served by Marshal self-tools (`electron/marshal-fs/tools.ts`) gated through the permission policy. Tools are blocked, not disconnected, when a user toggles a server off — `PermissionPolicy.checkUserDisabledTool()` denies pre-hook.
- **Permissions** — 3-tier shell-command approval (auto-approve read-only / prompt for writes & network / block dangerous) in `electron/permission-policy.ts` + `permission-card-manager.ts`. Pipes and `>`/`>>` redirects checked segment-by-segment. Audit log via `electron/audit-log.ts`.
- **Skills** — `SKILL.md` + frontmatter; three tiers: bundled (`bundled-skills/` merged with `first-party-skills/` overrides at build), workspace-scoped (`~/.marshal/marshal-skills/{name}/`), global user (`~/.marshal/skills/{name}/`). Repo review skills under `skills/` are symlinked into `.claude/skills/` and `.github/skills/` by `pnpm install:skills`.
- **Packaged build** — `app.getAppPath()` returns a path inside `app.asar` (not real FS); use `process.resourcesPath`. Preload outside asar at `resources/preload.cjs`. MCP `node_modules` at `resources/app.asar.unpacked/node_modules/`. `isPackaged` check: `!process.env.VITE_DEV_SERVER_URL && !!process.resourcesPath`.

## Styling

- **Tailwind CSS v4 + shadcn/ui.** Single CSS entry: `src/index.css` (theme tokens, dark mode, globals).
- **Dark mode:** `[data-theme="dark"]` selector. Tailwind `dark:` variant via `@custom-variant dark (&:is([data-theme="dark"] *))`.
- For CSS variables not registered in `@theme inline`, use Tailwind's `bg-(--var-name)` syntax.
- Use shadcn components (`Button`, `Dialog`, `Select`, `Tooltip`) for any interactive control. Raw HTML elements break the conventions.

## Convention summary

- **Minimal, surgical changes.** Don't rewrite working code while you're in the neighborhood; don't bundle unrelated cleanups.
- **One issue, one PR.** Drive-by fixes are fine when they're small and adjacent.
- **Run the app before requesting review.** Typecheck passing ≠ feature working.
- **Think cross-platform when writing code**, even if you only run it on one OS. See the cross-platform section above for what counts as "risky surface" needing the other side tested.
- **Run `/marshal-code-review` locally before pushing.**
