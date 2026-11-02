/**
 * Workflow scaffold. Fill in the TODOs, then write to
 * <repo>/.github/marshal-workflows/<id>/workflow.ts for direct discovery.
 *
 * Locked SDK surface — see ../cheatsheet.md.
 */
import { defineWorkflow } from "@marshal/workflow-sdk";
import { z } from "zod";

// TODO: define the params shape the operator's form will collect.
const ParamsSchema = z.object({
  // example: target: z.string().describe("Target name"),
});

// TODO: define output schema if your workflow returns structured data.
const OutputSchema = z.object({
  ok: z.boolean(),
});

export default defineWorkflow({
  id: "TODO-kebab-case-id",
  displayName: "TODO Display Name",
  description: "TODO one-line description",
  schemaVersion: 1,
  params: ParamsSchema,
  defaultBudget: 8,
  notifyOnComplete: "none",

  run: async (ctx) => {
    // TODO: replace this scaffold with real steps. Every observable
    // side-effect MUST go inside a ctx.step.
    const greeting = await ctx.step("hello", () =>
      Promise.resolve(`Hello from ${ctx.workflowId} / runFamily=${ctx.runFamilyId}`),
    );
    ctx.log.info(greeting);
    return OutputSchema.parse({ ok: true });
  },
});
