# Harness verification scripts

CDP-driven verification + profiling for the running Marshal / Marshal app.
Self-contained: `cdp-helpers.mjs` resolves `chrome-remote-interface` from this repo's
`node_modules`. (See the `goal-pursuit-verify` skill for the full playbook.)

## Build + launch

```powershell
# Isolated goal/workspace mock harness:
$env:MARSHAL_E2E_WORKER="goal-workspace-smoke"
node scripts\harness-verify\seed-isolated.mjs
$env:MARSHAL_E2E="1"
$env:MARSHAL_GOAL_HARNESS="1"
$env:MARSHAL_E2E_WORKSPACE_FIXTURES="1"
pnpm build:vite
node_modules\electron\dist\electron.exe . --no-sandbox --remote-debugging-port=9337 --user-data-dir="$env:TEMP\marshal-e2e-data-goal-workspace-smoke\electron-user-data"

# In another PowerShell from the repo root:
$env:PORT="9337"
$env:RESULTS_DIR="$env:TEMP\marshal-e2e-data-goal-workspace-smoke\results"
$env:OUT="$env:RESULTS_DIR\goal-verify.json"
node scripts\harness-verify\goal-verify.mjs

# REAL dev mode (real Copilot backend, uses the CLI-owned auth profile, loads dist/):
node_modules\electron\dist\electron.exe . --remote-debugging-port=9401
```

## Goal-feature drivers

- `seed-isolated.mjs` — resets only the selected worker's `%TEMP%\marshal-e2e-data-<worker>` root and
  seeds a local session, managed workspace, contained external workspace, and repository agents.
- `goal-verify.mjs` — isolated smoke through the real preload IPC. It creates a scoped session,
  exercises `set`, `get`, definition/context updates, pause/resume/steer/stop, rejects a stale
  two-field fence, compacts without changing session or goal authority, observes `goal:changed`,
  and verifies the final snapshot is durable. Relaunch the same isolated app root and set
  `VERIFY_SESSION_ID` to the first run's session ID to verify process-restart persistence.
  Set `QUIT_AFTER=1` on both runs so Electron flushes and releases its encrypted profile cleanly.
- `goal-real-run.mjs` — strict real-backend probe that creates a fresh session and requires a
  persisted continuation request/response, successful `goalUpdateContext` work, a successful
  `goalProposeTransition`, reviewer-approved completion, and terminal outbox delivery. It stops a
  still-pursuing goal during cleanup. Environment: `PORT`, `RESULTS_DIR`, `MAX_MIN`.

## Leak / perf

`soak.mjs` (renderer heap/nodes/listeners slope), `verify.ps1` (build→launch→soak), `dev-soak.mjs`
(real-streaming leak), `startup.mjs` (cold-start TTI), and `multi-session.mjs`.

Run scripts from the repo root so relative build and Electron paths stay stable.
Always kill the launched instance by PID (`Stop-Process -Id <pid> -Force`).
