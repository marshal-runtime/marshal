# copilot/

Copilot runtime adapter over the shared local backend composition.

## Files

- `provider.ts` — compatibility `CopilotBackend` facade that composes `LocalBackend`.
- `strategy.ts` — Copilot runtime identity, capabilities, model defaults, process tools, and bundled workspace files.
- `auth.ts` — GitHub device-flow login, credential cleanup, and Copilot-plan probing.
- `session.ts`, `tools.ts`, `automation.ts`, `permissions.ts`, `internal.ts`, and the loop-guard files are compatibility exports for the shared implementations in `../local/`.
- `client-factory.ts` — production factory that spawns the bundled CLI subprocess.
- `sdk-adapter.ts` — the host↔SDK mapper for neutral runtime client/session, event, tool, invocation, MCP, and permission contracts.
- `mock-client.ts` — E2E runtime client implementing the same neutral client/session contract.
  Runtime-neutral changes belong in `../local/`; this directory should contain only
  Copilot-specific strategy, auth, SDK mapping, client creation, and compatibility
  exports.

## System message is append-mode

Marshal passes its system prompt as `systemMessage: { content }` with **no `mode`**, which the SDK treats as **append mode** (`SystemMessageConfig`): the SDK's own foundation/coder persona (identity, safety, `code_change_rules`, tool instructions…) stays in place and Marshal's prompt is appended after it. `mode: "replace"` would drop the SDK guardrails — don't use it; `toCopilotSessionConfig()` sends a launch's replacement prompt in append mode too, and maps `projectContext: false` to `skipCustomInstructions`, `enableSkills: false`, and disabled memory. Plain `spawnSubagent` subagents (no repo agent, no scoped MCP, non-workflow parent) run on the SDK default subagent prompt path: `sessions.ts` resolves and passes a concrete tier-default model, while appending only `SUBAGENT_DELEGATION_GUIDANCE` instead of the full Marshal prompt, so they keep the SDK coder persona but still learn the `task` vs `spawnSubagent` distinction. Repo-agent, workflow, and scoped-MCP subagents get the full Marshal message (which already contains that guidance).

## Why no `ws-client.ts` / `auth/controller.ts` / `session-sync.ts`?

The Copilot SDK _is_ the transport. Auth, session lifecycle, and event delivery all happen inside the SDK's CLI subprocess; this directory only adapts the SDK to the `IBackendProvider` contract. The gateway side, which speaks JSON-RPC over WebSocket to marshal, has those files because it owns the transport itself, with auth split into `auth/controller.ts`.
