# Architecture

Agentic Browser uses a **layered architecture with a browser abstraction interface**. Each layer has a single responsibility, and dependencies flow downward only.

See [ADR-005](../.agent-memory/runs/20260212-1643-agentic-browser-e2e-a7x3/adrs/ADR-005-extension-architecture-layered.md) for the full decision rationale.

## Layers

```
┌──────────────────────────────────────────────────┐
│                 Transport Layer                   │
│   NativeMessagingTransport │ ContentScriptBridge  │
├──────────────────────────────────────────────────┤
│                 Command Router                    │
│   Deserialize → Validate (Zod) → Route           │
├──────────────────────────────────────────────────┤
│                 Tool Handlers                     │
│  NavigateTool │ ClickTool │ ScreenshotTool │ …   │
├──────────────────────────────────────────────────┤
│            Browser Abstraction Layer              │
│              IBrowserAdapter                      │
│   ChromeAdapter │ EdgeAdapter │ RemoteAdapter     │
├──────────────────────────────────────────────────┤
│              Infrastructure Layer                 │
│  StateManager │ Lifecycle │ TabTracker │ CDPMgr   │
└──────────────────────────────────────────────────┘
```

### 1. Transport Layer

Handles Native Messaging (MCP server ↔ extension) and content script message routing (service worker ↔ page). Located in `packages/extension/src/background/native-messaging.ts` and `packages/extension/src/content/message-bridge.ts`.

### 2. Command Router

Deserializes incoming messages, validates parameters with Zod schemas from `@agentic-browser/shared`, and routes commands to the appropriate tool handler. Located in `packages/extension/src/background/command-router.ts`.

### 3. Tool Handler Layer

One handler per MCP tool (navigate, click, screenshot, etc.). Each handler receives an `IBrowserAdapter` instance and validated parameters — no direct `chrome.*` API calls. Located in `packages/extension/src/tools/`.

### 4. Browser Abstraction Layer

The `IBrowserAdapter` interface defines all browser operations. Concrete implementations exist for Chrome, Edge, and remote/headless browsers. Adding a new browser backend means implementing this interface — no tool handler changes required. Located in `packages/extension/src/adapters/`.

### 5. Infrastructure Layer

Cross-cutting concerns: state persistence across service worker restarts (`chrome.storage.session` / `chrome.storage.local`), tab tracking, CDP attachment management, and structured logging. Located in `packages/extension/src/infrastructure/`.

## Communication Flow

```
AI Agent → MCP Server (stdio) → Native Messaging → Extension Service Worker
  → Command Router → Tool Handler → IBrowserAdapter → Chrome/Edge APIs
  → Response back through the chain
```

## Module Boundaries

| Module               | Responsibility                         | Key Dependency Rule                                                                  |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| `shared`             | Types, schemas, constants              | Zero internal dependencies (leaf package)                                            |
| `extension/tools`    | Tool handler logic                     | Depends on `adapters` via `IBrowserAdapter`, never on chrome APIs directly           |
| `extension/adapters` | Browser abstraction implementations    | Depends on `infrastructure` for state and CDP                                        |
| `extension/content`  | DOM operations per tab                 | Independent; communicates only via `chrome.runtime.sendMessage`                      |
| `mcp-server`         | MCP protocol + Native Messaging bridge | Depends on `shared` for types; communicates with extension via Native Messaging only |

No circular dependencies between modules.

## Key Design Decisions

| Decision                                  | ADR                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Layered architecture with IBrowserAdapter | [ADR-005](../.agent-memory/runs/20260212-1643-agentic-browser-e2e-a7x3/adrs/ADR-005-extension-architecture-layered.md) |
| Webpack for MV3 bundling                  | [ADR-001](../.agent-memory/runs/20260212-1643-agentic-browser-e2e-a7x3/adrs/ADR-001-build-tool-webpack.md)             |
| Vitest for testing                        | [ADR-002](../.agent-memory/runs/20260212-1643-agentic-browser-e2e-a7x3/adrs/ADR-002-testing-framework-vitest.md)       |
| npm workspaces monorepo                   | [ADR-003](../.agent-memory/runs/20260212-1643-agentic-browser-e2e-a7x3/adrs/ADR-003-monorepo-npm-workspaces.md)        |
| stdio MCP transport                       | [ADR-004](../.agent-memory/runs/20260212-1643-agentic-browser-e2e-a7x3/adrs/ADR-004-mcp-transport-stdio.md)            |
