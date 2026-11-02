/**
 * fanout-with-renderer — minimal fan-out workflow co-located with a custom
 * renderer. Renderer reads `props.run.steps` and tiles them in a grid.
 *
 * Only bundled workflows can ship renderers in V1.
 */
import { defineWorkflow } from "@marshal/workflow-sdk";
import { z } from "zod";

const Params = z.object({
  items: z.array(z.string()).min(1).describe("Items to investigate"),
});

const UnitResult = z.object({
  item: z.string(),
  summary: z.string(),
});

type ParamsT = z.infer<typeof Params>;
type UnitResultT = z.infer<typeof UnitResult>;

export default defineWorkflow<ParamsT, { investigated: number; requested: number }>({
  id: "fanout-with-renderer",
  displayName: "Fan-out grid demo",
  description: "Per-unit investigation with a co-located grid renderer.",
  schemaVersion: 1,
  params: Params,
  defaultBudget: 8,

  run: async (ctx) => {
    const results = await ctx.fanOut<string, UnitResultT>(
      ctx.input.items,
      (item, _idx) =>
        ctx.step("investigate", () =>
          ctx.run<UnitResultT>(
            { agentName: "general-purpose", displayName: `unit-${item}` },
            `Investigate "${item}" and reply ONLY with JSON: {"item":"${item}","summary":"<text>"}`,
            { schema: UnitResult },
          ),
        ),
      { maxConcurrency: 4, keyFor: (i) => i, onUnitFailure: { kind: "continue" } },
    );

    const ok = results.filter((r): r is UnitResultT => Boolean(r));
    await ctx.saveArtifact("results.json", JSON.stringify(ok, null, 2), {
      mime: "application/json",
    });
    return { investigated: ok.length, requested: ctx.input.items.length };
  },
});
