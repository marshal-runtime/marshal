// common/workflows-contract/events.ts
//
// Typed-at-rest event log for Dynamic Workflows. Per r1-fixes.md A9 the
// engine, persistence layer, and renderer all consume the same
// discriminated union — schema drift is caught at parse time, not at
// runtime narrowing.
//
// The shape mirrors c-runtime.md §10 but the payloads are tighter than
// the loose `Record<string, unknown>` in the engine doc, because the
// reducer (`common/workflows-reducer.ts`) needs to consume them without
// `as` casts.
//
// Adding a new event: extend the discriminated union below, add a
// reducer arm in `workflows-reducer.ts`, and ensure the engine writes
// the new shape through `EventLog.append()`. The reducer's exhaustive
// switch will fail typechecks until every consumer is updated.

import { z } from "zod";

import {
  WorkflowActionCenterItemSchema,
  WorkflowInvestigationCompletionSchema,
  WorkflowScheduleCursorSchema,
  WorkflowStageContextSchema,
} from "./operational";
import { WorkflowRunScheduleContextSchema } from "./run-record";

// ── Common building blocks ─────────────────────────────────────────────

/** Errors crossing the IPC / on-disk boundary are serialised to plain JSON. */
export const SerializedErrorSchema: z.ZodType<SerializedError> = z.lazy(() =>
  z.object({
    message: z.string(),
    name: z.string().optional(),
    stack: z.string().optional(),
    cause: SerializedErrorSchema.optional(),
  }),
);
export interface SerializedError {
  message: string;
  name?: string;
  stack?: string;
  cause?: SerializedError;
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return {
      message: err.message,
      name: err.name,
      stack: err.stack,
      cause: err.cause !== undefined ? serializeError(err.cause) : undefined,
    };
  }
  return { message: String(err) };
}

// ── Per-event payload schemas ─────────────────────────────────────────

export const RunStartedPayloadSchema = z.object({
  workflowId: z.string(),
  workflowVersion: z.string(),
  workflowDistHash: z.string(),
  runFamilyId: z.string(),
  parentRunId: z.string().optional(),
  input: z.unknown(),
  schedule: WorkflowRunScheduleContextSchema.optional(),
  startedAt: z.number().int().nonnegative(),
  resumeFromCrash: z.boolean().optional(),
  /** When non-empty, the engine is replaying from a specific step (retry-from-step). */
  replayFromStepKey: z.string().optional(),
});

export const RunCompletedPayloadSchema = z.object({
  result: z.unknown(),
  durationMs: z.number().int().nonnegative(),
});

export const RunFailedPayloadSchema = z.object({
  error: SerializedErrorSchema,
  failedStepKey: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
});

export const RunCancelledPayloadSchema = z.object({
  reason: z.string(),
  durationMs: z.number().int().nonnegative(),
});

export const RunCrashedPayloadSchema = z.object({
  error: SerializedErrorSchema,
  code: z.string().optional(),
});

export const StepStartedPayloadSchema = z.object({
  stepKey: z.string(),
  label: z.string(),
  parentStepKey: z.string(),
  startedAt: z.number().int().nonnegative(),
});

export const StepCompletedPayloadSchema = z.object({
  stepKey: z.string(),
  label: z.string(),
  result: z.unknown(),
  durationMs: z.number().int().nonnegative(),
});

export const StepFailedPayloadSchema = z.object({
  stepKey: z.string(),
  label: z.string(),
  error: SerializedErrorSchema,
  durationMs: z.number().int().nonnegative(),
});

export const StepSkippedReplayPayloadSchema = z.object({
  stepKey: z.string(),
  label: z.string(),
  result: z.unknown(),
});

export const FanOutStartedPayloadSchema = z.object({
  stepKey: z.string(),
  count: z.number().int().nonnegative(),
  itemKeys: z.array(z.string()),
  maxConcurrency: z.number().int().positive(),
});

export const FanOutUnitCompletedPayloadSchema = z.object({
  stepKey: z.string(),
  itemKey: z.string(),
});

export const FanOutUnitFailedPayloadSchema = z.object({
  stepKey: z.string(),
  itemKey: z.string(),
  error: SerializedErrorSchema,
});

export const FanOutCompletedPayloadSchema = z.object({
  stepKey: z.string(),
  successCount: z.number().int().nonnegative(),
  failCount: z.number().int().nonnegative(),
  aborted: z.boolean(),
});

export const SpawnRequestedPayloadSchema = z.object({
  handleId: z.string(),
  stepKey: z.string(),
  agentName: z.string().optional(),
  displayName: z.string().optional(),
  /** Slot id when the spawn was resolved through a binding slot. */
  slot: z.string().optional(),
  /** When spawned inside a fanOut unit: the `__fanOut` parent step key. */
  fanOutStepKey: z.string().optional(),
  /** When spawned inside a fanOut unit: the unit's item key. */
  fanOutUnitKey: z.string().optional(),
});

export const SpawnedPayloadSchema = z.object({
  handleId: z.string(),
  sessionId: z.string(),
  agentName: z.string().optional(),
  /** Step that owns this agent (mirrors the matching spawn-requested). */
  stepKey: z.string().optional(),
  /** When spawned inside a fanOut unit: the `__fanOut` parent step key. */
  fanOutStepKey: z.string().optional(),
  /** When spawned inside a fanOut unit: the unit's item key. */
  fanOutUnitKey: z.string().optional(),
});

export const SubagentQueuedPayloadSchema = z.object({
  handleId: z.string(),
  waitingOn: z.enum(["global", "run", "fanOut"]),
});

export const AgentMessagePayloadSchema = z.object({
  handleId: z.string(),
  role: z.enum(["assistant", "user"]),
  content: z.string(),
});

export const AgentRepliedPayloadSchema = z.object({
  handleId: z.string(),
  reply: z.string(),
  durationMs: z.number().int().nonnegative(),
});

export const AgentSpawnCompletePayloadSchema = z.object({
  handleId: z.string(),
  durationMs: z.number().int().nonnegative(),
});

export const AgentSpawnFailedPayloadSchema = z.object({
  handleId: z.string(),
  error: SerializedErrorSchema,
});

export const ArtifactSavedPayloadSchema = z.object({
  key: z.string(),
  storageKey: z.string(),
  namespace: z.enum(["run", "fanout"]),
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  stepKey: z.string().optional(),
});

export const ArtifactCredentialRedactedPayloadSchema = z.object({
  key: z.string(),
  patternHits: z.record(z.string(), z.number().int().positive()),
});

export const StateReadPayloadSchema = z.object({
  key: z.string(),
  found: z.boolean(),
  stepKey: z.string().optional(),
});

export const StateWrittenPayloadSchema = z.object({
  key: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  hash: z.string(),
  stepKey: z.string().optional(),
});

export const StateDeletedPayloadSchema = z.object({
  key: z.string(),
  stepKey: z.string().optional(),
});

export const StateCredentialRedactedPayloadSchema = z.object({
  key: z.string(),
  patternHits: z.record(z.string(), z.number().int().positive()),
});

export const ScheduleCursorAdvancedPayloadSchema = z.object({
  key: z.string(),
  previous: WorkflowScheduleCursorSchema.optional(),
  next: WorkflowScheduleCursorSchema,
  runId: z.string(),
});

export const StageContextExposedPayloadSchema = WorkflowStageContextSchema;

export const InvestigationCompletionPayloadSchema = WorkflowInvestigationCompletionSchema;

export const ActionCenterItemsSetPayloadSchema = z.object({
  items: z.array(WorkflowActionCenterItemSchema),
  replace: z.boolean().default(true),
});

export const CtxEmitPayloadSchema = z.object({
  name: z.string(),
  data: z.unknown(),
});

// ── Discriminated union ───────────────────────────────────────────────

export const WorkflowEventSchema = z.discriminatedUnion("type", [
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("run.started"),
    payload: RunStartedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("run.completed"),
    payload: RunCompletedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("run.failed"),
    payload: RunFailedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("run.cancelled"),
    payload: RunCancelledPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("run.crashed"),
    payload: RunCrashedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("step.started"),
    payload: StepStartedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("step.completed"),
    payload: StepCompletedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("step.failed"),
    payload: StepFailedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("step.skipped-replay"),
    payload: StepSkippedReplayPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("fanOut.started"),
    payload: FanOutStartedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("fanOut.unit-completed"),
    payload: FanOutUnitCompletedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("fanOut.unit-failed"),
    payload: FanOutUnitFailedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("fanOut.completed"),
    payload: FanOutCompletedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("agent.spawn-requested"),
    payload: SpawnRequestedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("agent.spawned"),
    payload: SpawnedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("agent.message"),
    payload: AgentMessagePayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("agent.replied"),
    payload: AgentRepliedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("agent.spawn-complete"),
    payload: AgentSpawnCompletePayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("agent.spawn-failed"),
    payload: AgentSpawnFailedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("subagent.queued"),
    payload: SubagentQueuedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("artifact.saved"),
    payload: ArtifactSavedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("artifact.credential-redacted"),
    payload: ArtifactCredentialRedactedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("state.read"),
    payload: StateReadPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("state.written"),
    payload: StateWrittenPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("state.deleted"),
    payload: StateDeletedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("state.credential-redacted"),
    payload: StateCredentialRedactedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("schedule.cursor-advanced"),
    payload: ScheduleCursorAdvancedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("stage.context-exposed"),
    payload: StageContextExposedPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("investigation.completion-transitioned"),
    payload: InvestigationCompletionPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("action-center.items-set"),
    payload: ActionCenterItemsSetPayloadSchema,
  }),
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
    type: z.literal("ctx.emit"),
    payload: CtxEmitPayloadSchema,
  }),
]);

export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;
export type WorkflowEventType = WorkflowEvent["type"];

/** Convenience: extract a specific event variant by `type`. */
export type WorkflowEventOf<T extends WorkflowEventType> = Extract<WorkflowEvent, { type: T }>;
