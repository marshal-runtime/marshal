/**
 * wsr-mini — compressed Weekly Status Review pipeline (~90 LOC).
 * Per c-sdk.md §11.e. Does NOT need real incident tools — every prompt is
 * inline and the agent identities are placeholders.
 *
 * Demonstrates: static-parallel fanout, dynamic fanout over derived items,
 * review-rework-loop per unit, idempotent bug-filing keyed by runFamilyId,
 * final report assembly.
 */
import { defineWorkflow } from "@marshal/workflow-sdk";
import type { WorkflowContext } from "@marshal/workflow-sdk";
import { z } from "zod";

const Params = z.object({
  shiftStart: z.string().describe("ISO 8601"),
  shiftEnd: z.string().describe("ISO 8601"),
  teamId: z.string(),
});

const ReliabilityCell = z.object({
  op: z.string(),
  filter: z.string(),
  buckets: z.array(z.object({ name: z.string(), count: z.number() })),
});

const AlertGroup = z.object({ incidentId: z.string(), severity: z.string() });

const Bucket = z.object({
  operation: z.string(),
  name: z.string(),
  count: z.number(),
});

const BucketInvestigation = z.object({
  name: z.string(),
  classification: z.enum(["KNOWN", "NEEDS_FILING", "FIXED"]),
  rootCause: z.string(),
  filedBugId: z.string().optional(),
});

const AlertInvestigation = z.object({
  incidentId: z.string(),
  classification: z.string(),
  filedBugId: z.string().optional(),
});

const Verdict = z.object({
  status: z.enum(["PASS", "FAIL"]),
  issues: z.array(z.string()),
});

const FiledBug = z.object({ bugId: z.string() });

type ParamsT = z.infer<typeof Params>;
type ReliabilityCellT = z.infer<typeof ReliabilityCell>;
type AlertGroupT = z.infer<typeof AlertGroup>;
type BucketT = z.infer<typeof Bucket>;
type BucketInvestigationT = z.infer<typeof BucketInvestigation>;
type AlertInvestigationT = z.infer<typeof AlertInvestigation>;
type VerdictT = z.infer<typeof Verdict>;
type FiledBugT = z.infer<typeof FiledBug>;

async function retryUntilPass(
  ctx: WorkflowContext<ParamsT>,
  bucketName: string,
  initial: BucketInvestigationT,
  initialVerdict: VerdictT,
  maxAttempts: number,
): Promise<BucketInvestigationT> {
  let candidate = initial;
  let verdict = initialVerdict;
  for (let attempt = 1; attempt < maxAttempts && verdict.status === "FAIL"; attempt++) {
    candidate = await ctx.run<BucketInvestigationT>(
      { agentName: "oncall-investigator", displayName: `rework-${bucketName}-${attempt}` },
      `Rework bucket ${bucketName} per reviewer feedback: ${verdict.issues.join("; ")}\n` +
        `Reply ONLY with JSON matching BucketInvestigation.`,
      { schema: BucketInvestigation },
    );
    verdict = await ctx.run<VerdictT>(
      { agentName: "oncall-reviewer", displayName: `review-${bucketName}-${attempt}` },
      `Re-review:\n${JSON.stringify(candidate)}\n` +
        `Reply ONLY with JSON: {"status":"PASS"|"FAIL","issues":[...]}.`,
      { schema: Verdict },
    );
  }
  return candidate;
}

export default defineWorkflow<ParamsT, { reportLength: number }>({
  id: "wsr-pipeline",
  displayName: "Weekly Status Review (mini)",
  description:
    "Compressed multi-phase ops investigation with fan-out, review, and idempotent bug-filing.",
  schemaVersion: 1,
  params: Params,
  defaultBudget: 16,

  run: async (ctx) => {
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

    const [reliability, alertGroups] = await Promise.all([
      ctx.step("reliability", () =>
        ctx.fanOut<{ op: string; filter: string; key: string }, ReliabilityCellT>(
          cells,
          (cell) =>
            ctx.run<ReliabilityCellT>(
              { agentName: "oncall-investigator", displayName: `rel-${cell.key}` },
              `Investigate reliability for op=${cell.op}, filter=${cell.filter}. ` +
                `Shift: ${ctx.input.shiftStart}→${ctx.input.shiftEnd}, team=${ctx.input.teamId}. ` +
                `Reply ONLY with ReliabilityCell JSON.`,
              { schema: ReliabilityCell },
            ),
          { maxConcurrency: 16, keyFor: (c) => c.key, onUnitFailure: { kind: "continue" } },
        ),
      ),
      ctx.step("alert-grouping", () =>
        ctx.run<AlertGroupT[]>(
          { agentName: "oncall-orchestrator", displayName: "Alert grouping" },
          `Pull active incident alerts for team=${ctx.input.teamId} in shift window. ` +
            `Reply ONLY with JSON array of {incidentId,severity}.`,
          { schema: z.array(AlertGroup) },
        ),
      ),
    ]);

    const buckets = await ctx.step("buckets", () => {
      const list: BucketT[] = [];
      for (const cell of reliability) {
        // Engine widens FanOutResult to a union when onUnitFailure:"continue".
        // Narrow to the success value (skip ok:false entries).
        const value: ReliabilityCellT | null =
          cell && typeof cell === "object" && "ok" in cell
            ? cell.ok
              ? cell.value
              : null
            : (cell as ReliabilityCellT);
        if (!value) continue;
        for (const b of value.buckets) {
          list.push({ operation: value.op, name: b.name, count: b.count });
        }
      }
      return Promise.resolve(list);
    });

    const bucketInvestigations = await ctx.step("bucket-investigation", () =>
      ctx.fanOut<BucketT, BucketInvestigationT>(
        buckets,
        async (b) => {
          const finding = await ctx.run<BucketInvestigationT>(
            { agentName: "oncall-investigator", displayName: `bucket-${b.name}` },
            `Investigate bucket ${b.name} (${b.operation}), count=${b.count}. ` +
              `Reply ONLY with BucketInvestigation JSON.`,
            { schema: BucketInvestigation },
          );
          const verdict = await ctx.run<VerdictT>(
            { agentName: "oncall-reviewer", displayName: `verdict-${b.name}` },
            `Review:\n${JSON.stringify(finding)}\n` +
              `Reply ONLY with JSON: {"status":"PASS"|"FAIL","issues":[...]}.`,
            { schema: Verdict },
          );
          const final =
            verdict.status === "PASS"
              ? finding
              : await retryUntilPass(ctx, b.name, finding, verdict, 3);

          if (final.classification === "NEEDS_FILING") {
            const filed = await ctx.step(`file-bug:${b.name}`, () =>
              ctx.run<FiledBugT>(
                { agentName: "general-purpose", displayName: `file-bug-${b.name}` },
                `File a bug. Idempotency tag: runFamily:${ctx.runFamilyId}:item:${b.name}. ` +
                  `Before filing, search for existing bug with that tag and return its id if found. ` +
                  `Reply ONLY with JSON: {"bugId":"<id>"}.`,
                { schema: FiledBug },
              ),
            );
            return { ...final, filedBugId: filed.bugId };
          }
          return final;
        },
        { maxConcurrency: 10, keyFor: (b) => b.name, onUnitFailure: { kind: "continue" } },
      ),
    );

    const alertInvestigations = await ctx.step("alert-investigation", () =>
      ctx.fanOut<AlertGroupT, AlertInvestigationT>(
        alertGroups,
        (a) =>
          ctx.run<AlertInvestigationT>(
            { agentName: "oncall-investigator", displayName: `alert-${a.incidentId}` },
            `Investigate incident alert ${a.incidentId} (severity=${a.severity}). ` +
              `Cross-reference these bucket findings:\n${JSON.stringify(bucketInvestigations)}\n` +
              `Reply ONLY with AlertInvestigation JSON.`,
            { schema: AlertInvestigation },
          ),
        { maxConcurrency: 10, keyFor: (a) => a.incidentId, onUnitFailure: { kind: "continue" } },
      ),
    );

    const reportMarkdown = await ctx.step("assemble-report", () =>
      ctx.run<string>(
        { agentName: "oncall-reporter", displayName: "Report" },
        `Assemble WSR markdown report from:\n` +
          `reliability=${JSON.stringify(reliability)}\n` +
          `bucketInvestigations=${JSON.stringify(bucketInvestigations)}\n` +
          `alertInvestigations=${JSON.stringify(alertInvestigations)}\n` +
          `Reply with raw markdown (no JSON wrapper).`,
      ),
    );

    await ctx.saveArtifact("wsr-report.md", reportMarkdown, { mime: "text/markdown" });
    return { reportLength: reportMarkdown.length };
  },
});
