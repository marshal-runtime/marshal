// common/workflows-contract/run-record.ts
//
// Per-run metadata header. Persisted as `run.json` in the run directory
// (see c-persist.md §3) and surfaced in the runs index as a summary
// projection (`RunIndexEntry`).

import { z } from "zod";

import { WorkflowScheduleIncrementalWindowSchema } from "./operational";

export const RunStatusSchema = z.enum([
  "pending", // created, not yet started
  "running", // engine actively executing
  "succeeded", // terminal: workflow.run resolved
  "failed", // terminal: workflow.run threw
  "cancelled", // terminal: user/tool/budget cancel
  "crashed", // detected at boot: was "running" with no live engine
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TriggeredBySchema = z.enum([
  "user",
  "self-tool",
  "schedule",
  "automation",
  "subagent",
]);
export type TriggeredBy = z.infer<typeof TriggeredBySchema>;

export const WorkflowRunScheduleContextSchema = z.object({
  key: z.string(),
  naturalLanguage: z.string(),
  parser: z.literal("electron/automations/parseSchedule").optional(),
  normalized: z.string().optional(),
  kind: z.enum(["single", "interval", "multi"]).optional(),
  occurrenceAt: z.number().int().nonnegative(),
  checkedAt: z.number().int().nonnegative(),
  incremental: WorkflowScheduleIncrementalWindowSchema.optional(),
});
export type WorkflowRunScheduleContext = z.infer<typeof WorkflowRunScheduleContextSchema>;

export const RunRecordSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  workflowId: z.string(),
  /** Repo-local workflow source root, when this run came from a repository. */
  workflowRepoPath: z.string().optional(),
  /** Workspace name used to resolve the repo at run start, if any. */
  workflowWorkspaceName: z.string().optional(),
  workflowVersion: z.string(),
  /** SHA-256 of the compiled `dist/workflow.js` pinned at run start. */
  workflowDistHash: z.string(),
  /** Stable across replays — equals runId for fresh runs (r1-fixes A6). */
  runFamilyId: z.string(),
  parentRunId: z.string().optional(),
  /** Snapshot of `input` after the workflow's params schema parsed it. */
  inputSnapshot: z.unknown(),
  status: RunStatusSchema,
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  source: z.literal("workflow-run"),
  triggeredBy: TriggeredBySchema,
  schedule: WorkflowRunScheduleContextSchema.optional(),
  initiatorSessionId: z.string().optional(),
  /** Synthetic host session id for spawned subagents. */
  hostSessionId: z.string(),
  errorSummary: z
    .object({
      message: z.string(),
      stack: z.string().optional(),
      stepKey: z.string().optional(),
      code: z.string().optional(),
    })
    .nullable(),
  totals: z.object({
    steps: z.number().int().nonnegative(),
    subagents: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  }),
  /**
   * Monotonic event-sequence allocator. Engine `EventLog.append` reads
   * this on resume and bumps it on every persisted event.
   */
  nextEventSeq: z.number().int().nonnegative(),
});

export type RunRecord = z.infer<typeof RunRecordSchema>;

/** Projection of `RunRecord` stored in the runs index. */
export const RunIndexEntrySchema = z.object({
  runId: z.string().uuid(),
  workflowId: z.string(),
  workflowRepoPath: z.string().optional(),
  workflowWorkspaceName: z.string().optional(),
  workflowVersion: z.string(),
  runFamilyId: z.string(),
  parentRunId: z.string().optional(),
  title: z.string(),
  status: RunStatusSchema,
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().nullable(),
  source: z.literal("workflow-run"),
  triggeredBy: TriggeredBySchema,
  initiatorSessionId: z.string().optional(),
  /** Synthetic host session id, indexed for persistent sidebar navigation. */
  hostSessionId: z.string().optional(),
  totals: z.object({
    steps: z.number().int().nonnegative(),
    subagents: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  }),
});

export type RunIndexEntry = z.infer<typeof RunIndexEntrySchema>;

export const WorkflowRunsIndexSchema = z.object({
  schemaVersion: z.literal(1),
  runs: z.array(RunIndexEntrySchema),
});

export type WorkflowRunsIndex = z.infer<typeof WorkflowRunsIndexSchema>;
