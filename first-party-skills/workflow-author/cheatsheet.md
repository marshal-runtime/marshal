# Workflow Author Cheatsheet

One-page reference for the locked V1 SDK surface. Paste into context when authoring.

## Imports

```ts
import { defineWorkflow, defineRenderer } from "@marshal/workflow-sdk";
import { z } from "zod";
```

## `defineWorkflow`

```ts
export default defineWorkflow({
  id: "kebab-case-stable-id", // never changes; bound to runs forever
  displayName: "Human Name",
  description: "Optional one-liner",
  schemaVersion: 1,
  params: z.object({
    /* … */
  }), // optional but recommended
  defaultBudget: 8, // max concurrent subagents per run
  defaultModel: "gpt-5.5", // optional: model for host + all spawns (per-spawn `model` overrides)
  defaultReasoningEffort: "high", // optional: "low"|"medium"|"high"|"xhigh" (per-spawn `reasoningEffort` overrides)
  notifyOnComplete: "none", // "system" | "none" (default)
  run: async (ctx) => {
    /* … */
  },
});
```

## `ctx.*` one-liners (locked surface — R1-FIXES A1)

| Call                                                            | What it does                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `ctx.input`                                                     | Typed params from the operator's form (parsed by `params` schema)         |
| `ctx.runId`                                                     | Unique id for this run; changes across replays                            |
| `ctx.runFamilyId`                                               | Stable id across replays/retries — **use this in idempotency keys**       |
| `ctx.workflowId`                                                | The id from `defineWorkflow`                                              |
| `ctx.cancelled: AbortSignal`                                    | Fires when cancel requested; pass to fetch, etc.                          |
| `ctx.log.{debug,info,warn,error}(msg, payload?)`                | Structured log → event log                                                |
| `await ctx.step("id", async () => T)`                           | Memoized waypoint — replay returns the recorded result without re-running |
| `await ctx.try("id", async () => T)`                            | Soft-fail variant; returns `{ok:true,value} \| {ok:false,error}`          |
| `ctx.now()`                                                     | Replay-safe wall time (memoized per call site)                            |
| `await ctx.sleep(ms)`                                           | Replay-safe sleep                                                         |
| `await ctx.spawn(opts) → AgentHandle`                           | Create a subagent session (no message dispatched)                         |
| `await ctx.send(handle, "text", { deliveryMode? })`             | Send a message to a live subagent                                         |
| `await ctx.waitForReply(handle, { timeoutMs? }) → AgentMessage` | Suspend until that subagent emits idle                                    |
| `await ctx.run(opts, prompt, { schema?, timeoutMs? }) → T`      | Shorthand: spawn + send + waitForReply (+ Zod parse if `schema`)          |
| `await ctx.fanOut(items, fn, opts) → readonly T[]`              | Concurrency-capped map                                                    |
| `await ctx.saveArtifact(key, content, { mime? }) → ArtifactRef` | Persist bytes/string for this run; auto-namespaced inside fanOut          |
| `await ctx.readArtifact(key) → Uint8Array`                      | Read back                                                                 |
| `await ctx.listArtifacts(prefix?) → ArtifactRef[]`              | List run-scoped artifacts                                                 |
| `await ctx.shell(cmd, { cwd?, timeoutMs? }) → string`           | Run a shell command in a one-shot subagent; returns stdout                |
| `ctx.emit(eventName, payload?)`                                 | Push a custom event into the renderer's event stream                      |

## `SpawnOptions` (also accepted by `RunOptions`)

```ts
{
  task?: string,                  // subagent display task line
  displayName?: string,
  agentName?: string,             // .github/agents/<name>.md identity
  model?: string,                 // overrides defaultModel / workflow tier default
  reasoningEffort?: "low" | "medium" | "high" | "xhigh", // overrides defaultReasoningEffort
  personality?: string,
  permissionMode?: "default" | "allow-all",  // overridden by manifest.permissions.mode
  workspaceName?: string,         // Co-create workspace
  repoPath?: string,              // absolute git repo path
  createWorktree?: boolean,
  worktreeName?: string,
  branchName?: string,
  baseRef?: string,
  skills?: readonly string[],     // REPLACES (not merges) inherited skills
  mcp?: readonly string[],        // REPLACES (not merges) inherited MCP servers
}
```

## `ctx.fanOut` opts

```ts
ctx.fanOut(
  items,
  async (item, idx) => {
    /* unit body */
  },
  {
    maxConcurrency: 10, // ALWAYS set
    keyFor: (item, idx) => String(item.id ?? idx), // domain key — recommended
    onUnitFailure:
      { kind: "fail-fast" } | // default — any failure rejects
      { kind: "continue" } | // failures recorded; fanOut resolves
      { kind: "budget", maxFailures: 3 }, // abort after N failures
  },
);
```

## `manifest.json` shape

```json
{
  "id": "kebab-case-stable-id",
  "version": "1.0.0",
  "title": "Human Title",
  "description": "One-liner shown in Library",
  "permissions": { "mode": "ask" },
  "cloudSync": "inherit-host"
}
```

`permissions.mode`:

- `"allow-all"` — every spawned subagent auto-approves tool calls. Requires
  user consent at install.
- `"ask"` — permission cards route to the Workflows tab and the initiator's
  chat session.

`cloudSync` (default `"inherit-host"`):

- `"off"` — host session and ALL subagents skip cloud sync.
- `"on"` — force-enable (respects global sensitivity threshold).
- `"inherit-host"` — host session inherits user's global setting; subagents
  follow host.

## Decision tree: `ctx.run` vs `ctx.spawn`+`ctx.send`+`ctx.waitForReply`

- **Single prompt, single reply** → `ctx.run(opts, prompt, { schema })`
- **Multi-turn dialogue with same subagent** → `ctx.spawn` + repeated
  `ctx.send` + `ctx.waitForReply`
- **Spawn now, prompt later (composed from upstream step results)** →
  `ctx.spawn` + `ctx.send` (no `ctx.run` shorthand because the prompt isn't
  ready at spawn time)
- **Fire-and-forget** → `ctx.spawn` + `ctx.send` without `ctx.waitForReply`

## Common gotchas

- **Step ids are labels, not unique keys.** The engine adds a callsite index
  automatically (see R1-FIXES A8). Repeated literal ids are fine. What breaks
  replay is a **dynamic** id (template literal interpolating `Date.now()`,
  `Math.random()`, `ctx.runId`).
- **Side-effects outside `ctx.step` break replay.** Wrap them.
- **`ctx.fanOut` artifact paths auto-namespace by `keyFor(item, idx)`.** Two
  units writing `"summary.md"` go to different paths. Sanitization is
  automatic.
- **`runId` vs `runFamilyId`.** A retry produces a new `runId` but the
  `runFamilyId` is preserved. Use `runFamilyId` for idempotency tags;
  `runId` only for things scoped to the current execution attempt.
- **Schemas via `params`** — the schema gets converted to a JSON-Schema by the
  engine and drives the Library form. Use Zod default values to fill the form.
- **The foundation `defineWorkflow` shim THROWS** if called without the engine
  bound. That's expected in unit tests — mock it.
