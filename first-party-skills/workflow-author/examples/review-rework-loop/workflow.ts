/**
 * review-rework-loop — standalone teaching example of pattern 5.4.
 * Per c-sdk.md §11.d.
 *
 * Investigates a topic, has a reviewer vote PASS/FAIL, retries with reworked
 * inputs up to N times.
 */
import { defineWorkflow } from "@marshal/workflow-sdk";
import { z } from "zod";

const Params = z.object({
  topic: z.string().describe("What to investigate"),
  maxAttempts: z.number().int().min(1).max(5).default(3),
});

const Finding = z.object({
  summary: z.string(),
  evidence: z.array(z.string()),
});

const Verdict = z.object({
  status: z.enum(["PASS", "FAIL"]),
  feedback: z.string(),
});

type ParamsT = z.infer<typeof Params>;
type FindingT = z.infer<typeof Finding>;
type VerdictT = z.infer<typeof Verdict>;

export default defineWorkflow<ParamsT, FindingT>({
  id: "review-rework-loop",
  displayName: "Investigate with QA gate",
  description: "Investigate a topic, gate on reviewer PASS/FAIL, rework up to N times.",
  schemaVersion: 1,
  params: Params,
  defaultBudget: 2,

  run: async (ctx) => {
    let finding = await ctx.step("first-pass", () =>
      ctx.run<FindingT>(
        { agentName: "investigator", displayName: "First pass" },
        `Investigate: ${ctx.input.topic}. ` +
          `Reply ONLY with JSON: {"summary":"<text>","evidence":["<bullet>",…]}`,
        { schema: Finding },
      ),
    );

    let attempt = 1;
    for (;;) {
      const verdict = await ctx.step(`review-${attempt}`, () =>
        ctx.run<VerdictT>(
          { agentName: "reviewer", displayName: `Review ${attempt}` },
          `Review this investigation:\n${JSON.stringify(finding)}\n` +
            `Reply ONLY with JSON: {"status":"PASS"|"FAIL","feedback":"<text>"}`,
          { schema: Verdict },
        ),
      );

      if (verdict.status === "PASS") break;

      if (attempt >= ctx.input.maxAttempts) {
        ctx.log.warn("rework cap reached; returning last finding", { attempt });
        break;
      }

      finding = await ctx.step(`rework-${attempt}`, () =>
        ctx.run<FindingT>(
          { agentName: "investigator", displayName: `Rework ${attempt}` },
          `Rework per reviewer feedback: ${verdict.feedback}\n\n` +
            `Prior finding:\n${JSON.stringify(finding)}\n\n` +
            `Reply ONLY with JSON: {"summary":"<text>","evidence":["<bullet>",…]}`,
          { schema: Finding },
        ),
      );
      attempt++;
    }

    await ctx.saveArtifact("final-finding.json", JSON.stringify(finding), {
      mime: "application/json",
    });
    return finding;
  },
});
