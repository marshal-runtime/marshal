# Marshal

Marshal is a desktop app for working with AI coding and computer-use agents on your own machine. You pick an agent runtime, point it at a workspace, and it works through your files, shell, browser, and installed extensions, with every sensitive action going through a permission policy you control.

It is an Electron app (React 19, TypeScript, Vite) for macOS and Windows.

## What it does

- **Several agent runtimes behind one interface.** Sessions run on the Claude Agent SDK, OpenAI Codex, or the Cursor SDK. The chat, permissions, tools, and session history work the same whichever runtime you choose.
- **Workspaces and subagents.** Sessions are scoped to a project folder. An agent can spawn user-visible subagent sessions, optionally in their own git worktrees, and steer them.
- **Permission-gated tools.** File access, shell commands, and browser control are gated by a policy: read-only shell commands run automatically, writes and network access ask first, and dangerous commands are blocked. Decisions are written to a local audit log.
- **Browser automation** through a bundled Playwright MCP server, plus any stdio or HTTP/SSE MCP servers you add.
- **Marshal Runtime extensions.** Extensions add capabilities, resources, and UI panels that agents can discover and call at runtime. The runtime itself comes from the `@marshal/runtime` packages, pinned as archives in `.marshal-runtime-packs/`.
- **Long-running work.** Durable goals that survive restarts, scheduled and condition-triggered automations, a heartbeat, and a progress panel per session.
- **Skills.** `SKILL.md` instruction packages, bundled with the app or added per user and per workspace.
- **iPhone access.** A phone view of your chats served from your Mac over Tailscale. See [`iphone-setup/README.md`](iphone-setup/README.md).

## Requirements

- Node.js 22.18 or newer
- pnpm 10.32.1 (pinned through `packageManager`; `corepack enable` picks it up)
- Credentials for at least one runtime: a Claude account or API key, a ChatGPT/OpenAI account for Codex, or a Cursor account. Marshal signs in to each from Settings.

## Getting started

```bash
pnpm install          # dependencies, runtime packs, and Playwright browsers
pnpm electron:dev     # build and launch the desktop app
```

`pnpm dev` runs the Vite dev server alone, with hot reload for renderer work.

## Development

```bash
pnpm test             # unit, node, and browser test projects (Vitest)
pnpm test:e2e         # Playwright end-to-end suite against a mocked runtime
pnpm lint             # oxlint, type-aware, zero warnings
pnpm format           # oxfmt
pnpm typecheck        # tsc --noEmit
pnpm build:vite       # fastest "does it compile" check
pnpm build            # full release build with electron-builder
```

Release builds are written to `release/<version>/`.

## Project layout

| Path                  | Contents                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `electron/`           | Main process: windows, IPC handlers, sessions, runtime backends, permissions, MCP, Marshal Runtime host |
| `electron/backend/`   | One directory per agent runtime, behind a shared backend contract                                       |
| `src/`                | Renderer: the React UI                                                                                  |
| `common/`             | Code shared by both processes, including the typed IPC contract in `marshal-ipc-contract.ts`            |
| `first-party-skills/` | Skills bundled with the app                                                                             |
| `skills/`             | Repository skills for working on Marshal itself, such as code review                                    |
| `e2e/`, `e2e-real/`   | Playwright suites (mocked runtime, and real accounts over CDP)                                          |
| `scripts/`            | Build, packaging, and verification scripts                                                              |

Contributor conventions (the backend abstraction rules, the IPC handler stack, logging, and security rules) are in [`CLAUDE.md`](CLAUDE.md).
