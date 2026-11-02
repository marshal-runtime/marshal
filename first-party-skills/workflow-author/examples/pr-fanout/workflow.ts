/**
 * pr-fanout — review all open PRs in a repo with bounded concurrency,
 * then aggregate to a postable digest. Per c-sdk.md §11.b.
 */
import { defineWorkflow } from "@marshal/workflow-sdk";
import { z } from "zod";

const Params = z.object({
  repo: z.string().describe("GitHub repo as owner/name"),
  filterText: z.string().optional().describe("Optional substring filter on PR titles"),
});

const Pr = z.object({ number: z.number(), title: z.string() });
const PrSummary = z.object({
  number: z.number(),
  risk: z.enum(["low", "med", "high"]),
  notes: z.string(),
});
const Digest = z.object({ markdown: z.string() });

type ParamsT = z.infer<typeof Params>;
type PrT = z.infer<typeof Pr>;
type PrSummaryT = z.infer<typeof PrSummary>;
type DigestT = z.infer<typeof Digest>;

export default defineWorkflow<ParamsT, DigestT>({
  id: "pr-review-fanout",
  displayName: "Review open PRs",
  description: "Fan-out PR review across a repo, then aggregate to a markdown digest.",
  schemaVersion: 1,
  params: Params,
  defaultBudget: 10,

  run: async (ctx) => {
    const prs = await ctx.step("list-prs", () =>
      ctx.run<PrT[]>(
        { agentName: "general-purpose", displayName: "List PRs" },
        `Run: gh pr list --repo ${ctx.input.repo} --state open --json number,title` +
          (ctx.input.filterText ? ` and filter to titles matching "${ctx.input.filterText}"` : "") +
          `. Reply ONLY with a JSON array of {number,title}.`,
        { schema: z.array(Pr) },
      ),
    );

    const reviews = await ctx.fanOut<PrT, PrSummaryT>(
      prs,
      (pr, _idx) =>
        ctx.run<PrSummaryT>(
          { agentName: "code-review", displayName: `pr-${pr.number}` },
          `Review ${ctx.input.repo}#${pr.number} ("${pr.title}"). ` +
            `Reply ONLY with JSON: {"number":${pr.number},"risk":"low|med|high","notes":"<text>"}`,
          { schema: PrSummary },
        ),
      {
        maxConcurrency: 10,
        keyFor: (p) => String(p.number),
        onUnitFailure: { kind: "continue" },
      },
    );

    const ok = reviews.filter((r): r is PrSummaryT => Boolean(r));

    const digest = await ctx.step("aggregate", () =>
      ctx.run<DigestT>(
        { agentName: "general-purpose", displayName: "Aggregate" },
        `Aggregate these PR reviews into a markdown digest grouped by risk:\n${JSON.stringify(ok, null, 2)}\n` +
          `Reply ONLY with JSON: {"markdown":"<digest>"}`,
        { schema: Digest },
      ),
    );

    await ctx.saveArtifact("digest.md", digest.markdown, { mime: "text/markdown" });
    return digest;
  },
});
