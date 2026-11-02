// electron/workflows/__tests__/sdk-types.test.ts
//
// Type-inference smoke test for `@marshal/workflow-sdk`. Locks in the
// authoring contract the bundled `workflow-author` skill relies on:
// `defineWorkflow`, `ctx.run<TOut>`, and `ctx.fanOut` must auto-infer
// from the supplied Zod schemas / arrays — no explicit generics
// required.
//
// Lives under `electron/workflows/__tests__/` so the existing vitest
// `node` project picks it up. Assertions all run at typecheck time; the
// runtime test only sanity-checks defineWorkflow returns a frozen
// object. Build green = inference contract preserved.

import {
  defineWorkflow,
  type UnitFailurePolicy,
  type WorkflowContext,
} from "@marshal/workflow-sdk";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

describe("@marshal/workflow-sdk type inference", () => {
  it("infers ctx.input from params schema (no explicit generics)", () => {
    const Params = z.object({ name: z.string(), age: z.number().optional() });
    defineWorkflow({
      id: "infer-input",
      displayName: "Infer Input",
      params: Params,
      run: async (ctx) => {
        expectTypeOf(ctx.input).toEqualTypeOf<{ name: string; age?: number | undefined }>();
        return { ok: true };
      },
    });
  });

  it("infers TOutput from ctx.run({ schema })", () => {
    const Greeting = z.object({ greeting: z.string() });
    defineWorkflow({
      id: "infer-run-output",
      displayName: "Infer ctx.run output",
      run: async (ctx) => {
        const result = await ctx.run({ agentName: "general-purpose" }, "say hello", {
          schema: Greeting,
        });
        expectTypeOf(result).toEqualTypeOf<{ greeting: string }>();
      },
    });
  });

  it("infers fanOut item + result types", () => {
    defineWorkflow({
      id: "infer-fanout",
      displayName: "Infer fanOut",
      run: async (ctx) => {
        const buckets = [{ name: "a" }, { name: "b" }];
        const out = await ctx.fanOut(buckets, async (b, idx): Promise<number> => {
          expectTypeOf(b).toEqualTypeOf<{ name: string }>();
          expectTypeOf(idx).toEqualTypeOf<number>();
          return b.name.length;
        });
        expectTypeOf(out).toMatchTypeOf<
          ReadonlyArray<number | { ok: true; value: number } | { ok: false; error: Error }>
        >();
      },
    });
  });

  it("accepts both canonical and legacy UnitFailurePolicy shapes", () => {
    const policies: UnitFailurePolicy[] = [
      "abort",
      "continue",
      { failCount: 3 },
      { failFraction: 0.25 },
      // Legacy { kind } shape from foundations shell — still supported.
      { kind: "fail-fast" },
      { kind: "continue" },
      { kind: "budget", maxFailures: 3 },
    ];
    expect(policies).toHaveLength(7);
  });

  it("accepts number or WorkflowBudget for defaultBudget", () => {
    const a = defineWorkflow({
      id: "budget-number",
      displayName: "Budget number",
      defaultBudget: 1,
      run: async () => undefined,
    });
    const b = defineWorkflow({
      id: "budget-struct",
      displayName: "Budget struct",
      defaultBudget: { maxConcurrentSubagents: 8, maxTotalSubagents: 200 },
      run: async () => undefined,
    });
    expect(a.id).toBe("budget-number");
    expect(b.id).toBe("budget-struct");
  });

  it("explicit generics still compile (existing IMPL-SKILL example shape)", () => {
    const Params = z.object({ name: z.string().default("world") });
    const Out = z.object({ greeting: z.string() });
    defineWorkflow<z.infer<typeof Params>, z.infer<typeof Out>>({
      id: "explicit-generics",
      displayName: "Explicit generics",
      params: Params,
      run: async (ctx) => {
        expectTypeOf(ctx).toMatchTypeOf<WorkflowContext<{ name: string }>>();
        return { greeting: `hi ${ctx.input.name}` };
      },
    });
  });

  it("exposes schedule and durable store helper contracts", () => {
    defineWorkflow({
      id: "runtime-foundations",
      displayName: "Runtime foundations",
      run: async (ctx) => {
        expectTypeOf(ctx.schedule?.occurrenceAt).toEqualTypeOf<number | undefined>();
        const entry = await ctx.store.getEntry("shards/2026-06/a", z.object({ shift: z.string() }));
        expectTypeOf(entry?.value).toEqualTypeOf<{ shift: string } | undefined>();
        const entries = await ctx.store.listEntries("shards/");
        expectTypeOf(entries[0]?.expiresAt).toEqualTypeOf<number | undefined>();
        const compacted = await ctx.store.compact({ prefix: "shards/", olderThanMs: 86_400_000 });
        expectTypeOf(compacted.deletedKeys).toEqualTypeOf<ReadonlyArray<string>>();
      },
    });
  });

  it("freezes the returned definition object", () => {
    const def = defineWorkflow({
      id: "frozen",
      displayName: "Frozen",
      run: async () => undefined,
    });
    expect(Object.isFrozen(def)).toBe(true);
  });
});
