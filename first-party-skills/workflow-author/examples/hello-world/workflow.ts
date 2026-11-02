/**
 * hello-world workflow — smoke test for IMPL-ENGINE and first worked example.
 *
 * One phase, one subagent, one artifact. ~15 LOC of real workflow body.
 */
import { defineWorkflow } from "@marshal/workflow-sdk";
import { z } from "zod";

const Params = z.object({
  name: z.string().min(1).default("world"),
});

const Greeting = z.object({
  greeting: z.string(),
});

export default defineWorkflow<z.infer<typeof Params>, z.infer<typeof Greeting>>({
  id: "hello-world",
  displayName: "Hello world",
  description: "Smoke-test workflow: spawn one subagent, save one artifact.",
  schemaVersion: 1,
  params: Params,
  defaultBudget: 1,

  run: async (ctx) => {
    const greeting = await ctx.step("greet", () =>
      ctx.run<z.infer<typeof Greeting>>(
        { agentName: "general-purpose", displayName: "Greeter" },
        `Say hello to ${ctx.input.name}. Reply ONLY with a JSON object: {"greeting":"<text>"}`,
        { schema: Greeting },
      ),
    );

    await ctx.saveArtifact("greeting.json", JSON.stringify(greeting), {
      mime: "application/json",
    });

    ctx.log.info("greeting saved", { runFamilyId: ctx.runFamilyId });
    return greeting;
  },
});
