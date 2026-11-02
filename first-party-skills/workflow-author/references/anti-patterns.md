# Anti-patterns — the 14 do-nots

Lifted from the WSR pipeline post-mortem (`r-icm-wsr.md §9`) and the V1 SDK
lock (`r1-fixes.md`). Each entry: **DO NOT** + the right form + the citation.

---

### a. DO NOT put prompts in a separate `.md` file from the workflow

**DO** inline them in `workflow.ts`. Helper functions returning template
literals are fine. Editing a sidecar prompt file to tune workflow behavior
breaks "the workflow is its source" promise.

_r-icm-wsr §9.4 — the single most-cited authoring failure._

---

### b. DO NOT perform side-effects outside `ctx.step`

**DO** wrap every observable effect in
`await ctx.step("descriptive-id", async () => …)`.

Plain top-level `await` of a side-effect breaks replay because the engine
re-invokes the workflow body from scratch on resume; only `ctx.step`-wrapped
results are memoized.

_r1-fixes A1 + foundation `WorkflowContext` contract._

---

### c. DO NOT rely on artifact filename munging to encode data

**DO** use `ctx.saveArtifact(stableKey, content, { mime })` with a key
chosen for readability. If the content is structured, JSON-stringify on
write and parse-with-Zod on read.

WSR's `Dictionary<string, string>` trap (where the key string smuggled the
shape) is the cautionary tale.

_r-icm-wsr §9.10._

---

### d. DO NOT compute the partition list inside the workflow at decision time when the operator should see it

**DO** pass partition inputs via the `params` schema so the operator's form
surfaces them. The operator should not have to run the workflow to discover
what items it iterated over.

_r-icm-wsr §9.2._

---

### e. DO NOT silently swallow `ctx.fanOut` unit failures

**DO** declare `onUnitFailure: { kind: "continue" }` only if you also
explicitly handle the failed units downstream (count, surface, retry, or
file). The default `{ kind: "fail-fast" }` is correct for most workflows.

`{ kind: "continue" }` returns `undefined` for failed units; if you `.map()`
the result, undefined propagates silently into reports.

_r-icm-wsr §9.5 + foundation `UnitFailurePolicy` shape._

---

### f. DO NOT hard-code agent identity strings the operator might want to swap

**DO** accept the identity (or a "profile" enum) via `params`. WSR's
hard-coded `oncall-investigator` made every tweak require a workflow edit.

_r-icm-wsr §9.4._

---

### g. DO NOT downgrade `StaticParallel(N)` to `Sequential(1)` "for now" because plumbing is hard

**DO** ask the user if you can't ship the parallelism today; ship a marked
TODO step rather than silent serialization. Hidden serialization is worse
than visible scope cut.

_r-icm-wsr §9.2._

---

### h. DO NOT fan out from a single source artifact when the data lives in N artifacts

**DO** read all N first (one `ctx.step` per source, then concat), then
`ctx.fanOut` over the merged list. The classic WSR Phase-3 bug was reading
only the "refresh" bucket file when alerts came from refresh+publish+create+delete.

_r-icm-wsr §9.3._

---

### i. DO NOT treat validation as a yes/no that "just sits there"

**DO** wire it as a `review-rework-loop` (pattern 5.4) that drives a retry.
A reviewer step that returns PASS/FAIL but doesn't gate or rework anything
is reviewer-as-decoration.

_r-icm-wsr §9.8._

---

### j. DO NOT spawn unbounded subagents

**DO** always set `maxConcurrency` on `ctx.fanOut`. The per-run cap
(`defaultBudget`) is a backstop, not a design. WSR's "spawn 200 in parallel"
hit infra rate limits 60 seconds in.

_r1-fixes "renderer / fanout cap" lock._

---

### k. DO NOT skip the `runFamilyId` + `itemKey` in idempotent side-effect keys

**DO** tag every external write with
`[runFamily:${ctx.runFamilyId}, item:${itemKey}]` and read-before-write.

`ctx.runId` changes across replays / retries; `ctx.runFamilyId` is stable
across the whole logical execution (R1-FIXES A6). Using `runId` here means
every retry re-files the bug.

_r1-fixes A6._

---

### l. DO NOT declare a step id derived from a non-deterministic value

**DO** use stable string literals. Inside a `fanOut`, the engine
auto-prefixes by `keyFor(item, idx)` so two units running the same inner
step id don't collide.

```ts
// BAD
await ctx.step(`compute-${Date.now()}`, …);
// GOOD
await ctx.step("compute", …);
// GOOD inside fanOut — engine adds the item key to the callsite path
ctx.fanOut(items, async (item) => {
  return ctx.step("compute", () => /* … */);
}, { keyFor: (i) => i.name });
```

_r1-fixes A8 (callsite-key memoization wins)._

---

### m. DO NOT import `fs`, `child_process`, `electron`, `process`, or any host tool from a renderer

**DO** read state from the renderer props (`props.run`, `props.artifacts`)
and call the actions the SDK passes you. The renderer sandbox is enforced
by the loader.

_r1-fixes "renderer state path" lock._

---

### n. DO NOT make a workflow that depends on another workflow's runtime state

**DO** compose via subagents in V1. Sub-workflows are V2. If you find
yourself wanting `workflowGetRun` from inside a workflow body, factor
the shared work into a subagent prompt instead.

_01-spec §6.7._
