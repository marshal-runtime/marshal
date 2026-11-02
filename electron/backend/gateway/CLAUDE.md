# Gateway backend module

This folder contains all gateway-mode (marshal runtime) machinery for m's backend abstraction. New gateway-related files go here:

- **Top level (`gateway/`):** core gateway plumbing — `provider.ts` (`GatewayBackend`, the `IBackendProvider` impl), `session.ts` (`GatewaySessionBackend`), `tools.ts` (`GatewayToolBackend`), `ws-client.ts` (RPC transport), `session-sync.ts` (sidebar/session-list state), `row.ts`, `device-identity.ts`, `normalize-event.ts` (server→client message normalizer).
- **`automation/`:** multi-step automation machinery (Phase 2b-1) — `backend.ts` (`GatewayAutomationBackend`), `map.ts` (mapper helpers between m's `AutomationData` and marshal's `CronJob`), `cron-decoders.ts` (pure decoders for marshal `cron.*` RPC payloads), `orchestrator.ts` (the step-as-cron chain advancer), `history-aggregator.ts` (per-step run-log → `AutomationRunData` synthesizer).
- **E2E mocking:** `mock-ws-client.ts` + `testing/scenario-script.ts` provide a scripted `IGatewayWsClient` impl. `createBackend` is the only module outside `gateway/` that imports `MockGatewayWsClient`, and the class is only instantiated when `MARSHAL_E2E=1 + MARSHAL_GATEWAY_E2E=1` are both set (see `electron/backend/create-backend.ts`). The Playwright fixture is `gatewaySharedTest` in `e2e/marshal-fixtures.ts`.

When the gateway server lands `agentTurnChain`, the entire `automation/` orchestrator + dedup machinery deletes; only `backend.ts` and `map.ts` remain.

## Naming convention

Files inside `gateway/` drop the redundant `gateway-` prefix. Inside `gateway/automation/`, drop the redundant `automation-` prefix. The folder path provides the namespace.

## Boundary rules (parent CLAUDE.md, recap)

- Shared code (`electron/sessions.ts`, IPC handlers, renderer hooks) MUST NOT import from `electron/backend/gateway/**`. Per-backend machinery stays here.
- No `backend.origin === "gateway"` behavioral forks in shared code. Polymorphic methods on `ISessionBackend`/`IAutomationBackend`/`IToolBackend` instead.

## Execution routing

`GatewaySessionBackend` implements both `ISessionBackend` and
`IExecutionBackend`. Do not reintroduce provider-wide `activeRunId` or
`activeSessionId` fields. Foreground events route through the two per-run maps
(`backendRunId` and `localRunId`); `sessionKey` fallback is only for untracked
cron/background traffic.

Gateway concurrency is negotiated from the successful connect-response
`capabilities.execution` v1 object. Missing or incomplete guarantees mean
legacy mode and a hard cap of one active run. `chat.abort` must always carry an
explicit `runId`; omitting it aborts every run in the session on legacy
servers. The canonical protocol and remaining server requirements are in
`docs/architecture/14-marshal-backend-abstraction.md` under "Execution capability
negotiation". The 100-run interleaving regression test is
`execution-routing.test.ts`.
