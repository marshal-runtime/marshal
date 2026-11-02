import { z } from "zod";

export const PrStatusSchema = z.enum([
  "queued",
  "running",
  "pending-confirmation",
  "confirmed",
  "dismissed",
  "superseded",
  "failed",
  "crashed",
]);
export type PrStatus = z.infer<typeof PrStatusSchema>;

export const IterationStatusSchema = z.enum([
  "running",
  "pending-confirmation",
  "superseded",
  "confirmed",
  "dismissed",
  "failed",
  "crashed",
]);
export type IterationStatus = z.infer<typeof IterationStatusSchema>;

// AgentRuntime lives in tools/marshal-acp/src/types.ts (it's an marshal-acp concern;
// review-queue is one of many consumers). Re-exported here so existing
// callers don't need to know the layout, and imported in-scope so it can
// be embedded in IterationSchema / PrRowSchema below.
import { AgentRuntimeSchema, type AgentRuntime } from "../../marshal-acp/src/types.ts";

export { AgentRuntimeSchema };
export type { AgentRuntime };

export const TierSchema = z.enum(["maintainer", "trusted", "other"]);
export const SizeBucketSchema = z.enum(["XS", "S", "M", "L", "XL"]);

export const IterationSchema = z.object({
  sha: z.string(),
  sessionId: z.string(),
  agentRuntime: AgentRuntimeSchema,
  startedAt: z.string(),
  completedAt: z.string().optional(),
  status: IterationStatusSchema,
  failureReason: z.string().optional(),
  // Captured from the agent's session/prompt response — answers "why did the
  // turn end?". `end_turn` is voluntary; `max_tokens` etc. surface the cutoff
  // cause when a review ends mid-flow.
  stopReason: z.string().optional(),
  // Output tokens used by the orchestrator's turn. Lets us see whether a
  // truncated review hit the per-turn output budget vs voluntarily ended.
  usageOutputTokens: z.number().int().nonnegative().optional(),
  // Original cwd the ACP session was created in. Resume + keep-context use
  // it because Claude stores sessions at `~/.claude/projects/<encoded-cwd>/`;
  // legacy rows without it fall back to the current config cwd.
  cwd: z.string().optional(),
});
export type Iteration = z.infer<typeof IterationSchema>;

export const PrRowSchema = z.object({
  url: z.string(),
  title: z.string(),
  author: z.string(),
  tier: TierSchema,
  sizeBucket: SizeBucketSchema,
  currentHeadSha: z.string(),
  latestReviewedSha: z.string().nullable(),
  runtimeOverride: AgentRuntimeSchema.optional(),
  status: PrStatusSchema,
  iterations: z.array(IterationSchema),
  // Refreshed by tick() to "now" whenever the dashboard returns this PR.
  // Used by the retention sweep to reap terminal-state rows whose underlying
  // PR has been gone from the dashboard (merged / closed) for more than
  // `config.reviewRetentionHours`. Optional for backward compat with state
  // files written before the field existed — first tick after upgrade stamps
  // them so the clock starts from now.
  lastSeenAt: z.string().optional(),
  // When true, the next automated iteration resumes the previous ACP session
  // (via `session/load`) instead of starting fresh. Set explicitly by
  // `marshal-review-queue keep-context <pr>` after a meaningful chat in the resumed
  // session. Consumed and cleared by the next tick that spawns a slot for
  // this PR — one-shot, no sticky resume.
  keepContextNextIteration: z.boolean().optional(),
});
export type PrRow = z.infer<typeof PrRowSchema>;

export const RepoConfigSchema = z.object({
  cwd: z.string(),
  dashboardCmd: z.array(z.string()).min(1),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export const RunningEntrySchema = z.object({
  prNumber: z.number().int().positive(),
  sessionId: z.string(),
  // childPid is nonnegative because the orchestrator pushes a placeholder row
  // with childPid=0 before the ACP child is spawned (atomic state update +
  // queue update). Replaced with the real pid once the child is alive.
  childPid: z.number().int().nonnegative(),
  startedAt: z.string(),
});
export type RunningEntry = z.infer<typeof RunningEntrySchema>;

export const StateSchema = z.object({
  version: z.literal(1),
  daemon: z.object({
    pid: z.number().int(),
    startedAt: z.string(),
    socketPath: z.string(),
  }),
  config: z.object({
    maxConcurrent: z.number().int().positive(),
    cooldownMinutes: z.number().int().nonnegative(),
    defaultRuntime: AgentRuntimeSchema,
    // When a session/prompt ends with `stopReason: end_turn` but the body
    // lacks a synthesis section AND shows mid-narration markers ("waiting on"
    // / "N of M"), the slot fires one follow-up session/prompt asking the
    // agent to synthesize. Recovers reviews that cut off when the orchestrator
    // loses track of pending sub-agent dispatches.
    followUpOnTruncation: z.boolean().default(true),
    // Terminal-state rows (confirmed / dismissed / failed / crashed) and their
    // review markdown files are deleted once the PR has been absent from the
    // dashboard for this many hours. `pending-confirmation` is never auto-reaped
    // — the user must explicitly confirm or dismiss first. Set to 0 to disable.
    reviewRetentionHours: z.number().nonnegative().default(24),
    repos: z.record(z.string(), RepoConfigSchema),
  }),
  prs: z.record(z.string(), PrRowSchema),
  queue: z.array(z.number().int().positive()),
  running: z.array(RunningEntrySchema),
});
export type State = z.infer<typeof StateSchema>;

export function defaultState(): State {
  return {
    version: 1,
    daemon: { pid: 0, startedAt: new Date(0).toISOString(), socketPath: "" },
    config: {
      maxConcurrent: 5,
      cooldownMinutes: 60,
      defaultRuntime: "claude",
      followUpOnTruncation: true,
      reviewRetentionHours: 24,
      repos: {},
    },
    prs: {},
    queue: [],
    running: [],
  };
}

// Dashboard JSON shape — duplicated from skills/marshal-review-dashboard/scripts/list-prs.py.
// Loose: unknown fields pass through.
export const DashboardPrSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    author: z.string().nullable(),
    url: z.string(),
    head_sha: z.string().nullable(),
    last_push_at: z.string().nullable().optional(),
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
    changed_files: z.number().int().nonnegative().nullable(),
    size_bucket: SizeBucketSchema,
    tier: TierSchema.optional(),
    blocking_failures: z.array(z.string()).default([]),
    zellij_command: z.string().optional(),
  })
  .passthrough();
export type DashboardPr = z.infer<typeof DashboardPrSchema>;

export const DashboardOutputSchema = z
  .object({
    generated_at: z.string(),
    me: z.string(),
    window_days: z.number().int().nonnegative(),
    buckets: z
      .object({
        needs_review: z.array(DashboardPrSchema),
        stale_my_review: z.array(DashboardPrSchema),
        my_prs_with_feedback: z.array(DashboardPrSchema),
        hidden_failing_ci: z.array(DashboardPrSchema).default([]),
      })
      .passthrough(),
  })
  .passthrough();
export type DashboardOutput = z.infer<typeof DashboardOutputSchema>;
