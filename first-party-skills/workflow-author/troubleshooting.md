# Troubleshooting

Error → cause → fix. Error class names are locked by IMPL-ENGINE
(see r1-fixes.md and `electron/workflows/errors.ts`).

## `MemoMismatchError: step at <stepKey> returned a value that does not match the recorded one on replay`

**Cause:** A `ctx.step` body produced a non-deterministic value (`Date.now()`,
`Math.random()`, an unkeyed network call) and the run resumed after a crash.
The engine sees the new value doesn't match the recorded one.

**Fix:** Move the non-determinism _inside_ the step body — `ctx.step` records
the result on first run and replays it. Use `ctx.now()` / `ctx.sleep()` instead
of the wall-clock primitives. If the value really must be fresh on every
replay attempt, change the step id (or use `ctx.try` instead).

**See also:** [references/anti-patterns.md](references/anti-patterns.md) §b, §l.

---

## `CapacityExceededError: per-run subagent budget exhausted (used N of M)`

**Cause:** The workflow asked for more concurrent subagents than the per-run
cap allows. The cap is `min(fanOut.maxConcurrency, workflow.defaultBudget,
globalCap)` — the smallest wins.

**Fix:** Lower `maxConcurrency` on `ctx.fanOut`, OR raise the workflow's
`defaultBudget`, OR split the phase. If you're hitting the global cap, the
work will queue (not fail) — this error only fires for a hard per-run cap
breach.

---

## `ArtifactSchemaError: artifact "<key>" failed schema validation`

**Cause:** A `ctx.readArtifact` callsite parsed the bytes with a schema
incompatible with the writer's schema. The SDK does not validate at write
time (it stores raw bytes) — validation happens at the reader.

**Fix:** Share the Zod schema across writer and reader by importing both
from a sibling `schemas.ts`. If you intentionally evolved the schema, add a
version suffix to the artifact key (`reliability.cells.v2`).

---

## `SubagentTimeoutError: handle <handleId> exceeded timeoutMs=<n>`

**Cause:** A subagent didn't reach idle within `timeoutMs` (default 60min).

**Fix:** Either raise the timeout (`ctx.run({ timeoutMs: 3_600_000 }, …)`),
simplify the prompt, or split the work across multiple `ctx.send` turns using
`ctx.spawn` + `ctx.waitForReply` so each turn has its own timeout.

---

## `OutputParseError: subagent reply did not match output schema`

**Cause:** When `ctx.run(opts, prompt, { schema })` is used, the subagent's
reply text is fed into `schema.parse(...)`. If the reply isn't valid JSON
matching the schema, this error fires.

**Fix:** Either (a) loosen the schema, (b) adjust the prompt to demand the
exact JSON shape ("Reply with ONLY a JSON object matching {...}, no prose"),
or (c) wrap in `z.union([SuccessSchema, z.object({ error: z.string() })])`
and branch on the result. **Do not** silently mask parse failures.

---

## `WorkflowCancelledError`

**Cause:** Operator clicked Cancel, `workflowCancel` was called, or a
parent workflow cancelled (rare in V1 — no sub-workflows yet).

**Fix:** Don't catch this — let it propagate so the engine can mark the run
cancelled and reap subagents. If you have cleanup, register a compensator
(the compensator stack runs LIFO on cancel; see r1-fixes "compensator scope").

---

## `CompileError: esbuild failed`

**Cause:** Syntax or type error in `workflow.ts` or `renderer.tsx`. Surfaces
during repo-local compilation or UI/CLI import.

**Fix:** Esbuild prints `file:line:col`. Open that line, fix it, then retry the
repo-local build or UI/CLI import. If you've retried once and the error persists,
hand the raw esbuild message to the user — don't keep iterating blindly.

---

## `MissingDefaultExportError: workflow.ts must \`export default\` a \`defineWorkflow(...)\` call`

**Cause:** `workflow.ts` doesn't have `export default defineWorkflow({...})`,
or the default export isn't a workflow definition.

**Fix:** Make sure the file ends with `export default defineWorkflow({...});`
(or assigns the result of `defineWorkflow(...)` to a variable that's then
default-exported on a separate line). The loader checks the object has the
`id`, `schemaVersion`, and `run` fields.

---

## `RendererSlotConflict: another renderer is already registered for workflowId=<id>`

**Cause:** Two installed workflows registered renderers with the same
`workflowId`, OR a custom renderer collided with the default `SLOT.WORKFLOW_RUN_DETAIL`
fallback.

**Fix:** Workflow ids are unique per install; this should never happen for
user-installed workflows. If you see it for a bundled workflow, file a bug —
two bundled workflows are colliding on the same id.

---

## `PermissionDeniedError: <tool> is blocked by tenant policy`

**Cause:** A subagent tried to use a tool the operator's tenant policy
disables (e.g. workflows disabled at tenant level, or a specific MCP server
toggled off in Settings).

**Fix:** Surface to the user — this is policy, not a bug. Offer an alternative
path that doesn't need the disabled tool (e.g. a different MCP source, or a
prompt that doesn't require the blocked filesystem write).

---

## `FanOutItemDriftError: fanOut at <stepKey> produced different items on replay`

**Cause:** Closes R1-FIXES A7. The `items` array passed to `ctx.fanOut` was
computed by an upstream non-memoized expression that produced a different list
on replay — e.g. `Array.from(someMap.values())` where `someMap` mutated between
runs.

**Fix:** Compute the items list **inside** a `ctx.step` so the result is
memoized:

```ts
const items = await ctx.step("compute-items", async () => /* … */);
await ctx.fanOut(items, fn, { maxConcurrency: 10 });
```

Then on replay the items array is identical (read from the memo) and the fanOut
topology converges.
