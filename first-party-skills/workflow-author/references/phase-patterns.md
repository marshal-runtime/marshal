# Phase patterns library

Eleven named compositions, each with a 10-ish-line code sketch against the
locked V1 SDK surface. Copy-and-adapt, don't re-derive.

> **Note:** All examples use `agentName: "general-purpose"` as the safe default.
> Substitute a repo-local `.github/agents/<name>.md` identity when you have one.

---

## 5.1 `sequential` — default when nothing else fits

Plain serial steps.

```ts
const a = await ctx.step("fetch", () =>
  ctx.run({ agentName: "general-purpose" }, "Fetch sales data for Q4", { schema: SalesSchema }),
);

const b = await ctx.step("transform", () =>
  ctx.run({ agentName: "general-purpose" }, `Summarize ${JSON.stringify(a)}`, {
    schema: SummarySchema,
  }),
);

return b;
```

When: "do A then B then C", small N (≤5 steps), no parallelism opportunity.

---

## 5.2 `static-parallel` — known-N independent branches

Use awaited `Promise.all` over wrapped steps.

```ts
const [cost, minutes, tokens] = await Promise.all([
  ctx.step("cloud-cost", () =>
    ctx.run({ agentName: "cloud-cost-fetcher" }, "...", { schema: CostS }),
  ),
  ctx.step("gh-minutes", () =>
    ctx.run({ agentName: "gh-actions-fetcher" }, "...", { schema: MinS }),
  ),
  ctx.step("openai-spend", () =>
    ctx.run({ agentName: "openai-billing-fetcher" }, "...", { schema: TokS }),
  ),
]);
```

When: 2–6 independent fetches with shared join. Always wrap each branch in
its own `ctx.step` so memoization works branch-by-branch on replay.

---

## 5.3 `dynamic-fanOut` — item count known only at run time

```ts
const items = await ctx.step("list", () =>
  ctx.run({ agentName: "general-purpose" }, "List all open PRs on octocat/foo", {
    schema: z.array(PrSchema),
  }),
);

const results = await ctx.fanOut(
  items,
  (item, _idx) =>
    ctx.run({ agentName: "code-review" }, `Review PR ${item.number}`, { schema: ReviewSchema }),
  { maxConcurrency: 10, keyFor: (p) => String(p.number), onUnitFailure: { kind: "continue" } },
);
```

When: "for each PR / bug / file / customer / row".

---

## 5.4 `review-rework-loop` — driven retry until pass

The fix for WSR §9.8 ("reviewer just sits there"). Reviewer's PASS/FAIL
gates a rework loop.

```ts
async function retryUntilPass(
  ctx: WorkflowContext,
  build: () => Promise<Finding>,
  attempt = 0,
  max = 3,
): Promise<Finding> {
  const candidate = await build();
  const verdict = await ctx.run(
    { agentName: "reviewer" },
    `Review: ${JSON.stringify(candidate)}. Reply JSON.`,
    { schema: VerdictSchema },
  );
  if (verdict.status === "PASS" || attempt + 1 >= max) return candidate;
  ctx.log.warn(`Attempt ${attempt + 1} failed: ${verdict.feedback}`);
  return retryUntilPass(ctx, build, attempt + 1, max);
}
```

When: "do X, then have someone check X, then redo if bad".

---

## 5.5 `multi-source-join` — fan-out from N artifacts, not 1

Fixes r-icm-wsr §9.3 (Phase 3 only read refresh-buckets).

```ts
const [a, b, c, d] = await Promise.all([
  ctx.step("refresh",  () => /* … */),
  ctx.step("publish",  () => /* … */),
  ctx.step("create",   () => /* … */),
  ctx.step("delete",   () => /* … */),
]);
const allItems = [...a, ...b, ...c, ...d];
const investigations = await ctx.fanOut(allItems, /* … */, { maxConcurrency: 10 });
```

---

## 5.6 `pipeline-with-quality-gate` — abort if a gate fails

```ts
const draft = await ctx.step("draft", () => /* … */);
const verdict = await ctx.step("validate", () =>
  ctx.run({ agentName: "validator" },
    `Validate: ${JSON.stringify(draft)}`,
    { schema: VerdictSchema }));
if (verdict.status === "FAIL") {
  ctx.log.error("Quality gate failed", { issues: verdict.issues });
  throw new Error(`Validation failed: ${verdict.issues.join("; ")}`);
}
return ctx.step("publish", () => /* … */);
```

---

## 5.7 `idempotent-checkpoint` — external side-effects keyed by runFamilyId

For long-running steps with idempotency. Use `runFamilyId` (not `runId`) so
retries dedupe.

```ts
const bugId = await ctx.step(`file-bug:${b.name}`, async () => {
  const tag = `runFamily:${ctx.runFamilyId}:item:${b.name}`;
  const existing = await findBugByTag(tag);
  return existing ?? fileBug({ tags: [tag], title: b.summary });
});
```

When: any external write that might be retried after a crash or
`workflowRetryFromStep`.

---

## 5.8 `partitioned-cartesian-product` — explicit cross-product

The pattern WSR Phase 1 wanted but didn't get. Items are computed inside a
`ctx.step` so replay sees a stable list (closes A7 FanOutItemDriftError).

```ts
const cells = await ctx.step("cells", () =>
  Promise.resolve(
    ["refresh", "publish", "create", "delete"].flatMap((op) =>
      ["all", "production", "canaries", "tips"].map((filter) => ({
        op,
        filter,
        key: `${op}-${filter}`,
      })),
    ),
  ),
);
const results = await ctx.fanOut(
  cells,
  (c) =>
    ctx.run({ agentName: "general-purpose" }, `Investigate ${c.op}/${c.filter}`, {
      schema: CellSchema,
    }),
  { maxConcurrency: 16, keyFor: (c) => c.key },
);
```

---

## 5.9 `streaming-aggregation` — emit results as they arrive

Per-unit results stream into the renderer via `ctx.emit` and saved artifacts.
The renderer subscribes to events and updates the UI live.

```ts
await ctx.fanOut(
  items,
  async (it, _i) => {
    const r = await ctx.run({ agentName: "investigator" }, `Investigate ${it.id}`, {
      schema: ResultSchema,
    });
    await ctx.saveArtifact(`unit-result-${it.id}.json`, JSON.stringify(r));
    ctx.emit("unit-done", { id: it.id, status: "ok" });
    return r;
  },
  { maxConcurrency: 10, keyFor: (i) => String(i.id) },
);
```

When: the operator wants live progress (grid filling in, board updating).

---

## 5.10 `subagent-message-pingpong` — keep one subagent alive across turns

When one phase's subagent should remain alive across multiple `ctx.step` calls
(e.g. a long-lived investigator that benefits from accumulating context).

```ts
const inv = await ctx.step("spawn-investigator", () =>
  ctx.spawn({ agentName: "deep-researcher", displayName: "Investigator" }),
);

await ctx.step("turn-1", async () => {
  await ctx.send(inv, "Start with X");
  return ctx.waitForReply(inv);
});

await ctx.step("turn-2", async () => {
  await ctx.send(inv, "Given that, do Y");
  return ctx.waitForReply(inv);
});
```

When: multi-turn dialogue is cheaper than spawning fresh subagents each time.

---

## 5.11 `try-and-fallback` — best-effort enrichment

Use `ctx.try` to capture failure without aborting the workflow. Returns a
discriminated union; branch explicitly.

```ts
const r = await ctx.try("fetch-optional-source", () =>
  ctx.run({ agentName: "general-purpose" }, "Try fetching the optional sidecar dataset", {
    schema: SidecarSchema,
  }),
);

const enrichment = r.ok ? r.value : null;
if (!r.ok) ctx.log.warn("sidecar unavailable", { error: r.error.message });
```

When: a step's failure should soft-degrade the workflow, not abort it.
