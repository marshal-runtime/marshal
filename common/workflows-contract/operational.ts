import { z } from "zod";

export const WorkflowScheduleCursorSchema = z
  .object({
    shiftId: z.string().optional(),
    shiftStartAt: z.number().int().nonnegative().optional(),
    coveredThrough: z.number().int().nonnegative().optional(),
    active: z.boolean().optional(),
    lastRunId: z.string().optional(),
    updatedAt: z.number().int().nonnegative().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strip();
export type WorkflowScheduleCursor = z.infer<typeof WorkflowScheduleCursorSchema>;

export const WorkflowScheduleIncrementalWindowSchema = z
  .object({
    previous: WorkflowScheduleCursorSchema.optional(),
    windowStartAt: z.number().int().nonnegative(),
    windowEndAt: z.number().int().nonnegative(),
  })
  .strip();
export type WorkflowScheduleIncrementalWindow = z.infer<
  typeof WorkflowScheduleIncrementalWindowSchema
>;

export const WorkflowArtifactFolderRefSchema = z
  .object({
    runId: z.string(),
    prefix: z.string(),
    artifactCount: z.number().int().nonnegative().optional(),
  })
  .strip();
export type WorkflowArtifactFolderRef = z.infer<typeof WorkflowArtifactFolderRefSchema>;

export const WorkflowFileRefSchema = z
  .object({
    path: z.string(),
    label: z.string().optional(),
    reason: z.string().optional(),
  })
  .strip();
export type WorkflowFileRef = z.infer<typeof WorkflowFileRefSchema>;

export const WorkflowArtifactLinkSchema = z
  .object({
    runId: z.string(),
    key: z.string(),
    storageKey: z.string().optional(),
    label: z.string().optional(),
  })
  .strip();
export type WorkflowArtifactLink = z.infer<typeof WorkflowArtifactLinkSchema>;

export const WorkflowChatLinkSchema = z
  .object({
    sessionId: z.string(),
    runId: z.string().optional(),
    handleId: z.string().optional(),
    label: z.string().optional(),
    reason: z.string().optional(),
  })
  .strip();
export type WorkflowChatLink = z.infer<typeof WorkflowChatLinkSchema>;

export const WorkflowStageContextSchema = z
  .object({
    stageId: z.string(),
    label: z.string().optional(),
    summary: z.string().optional(),
    artifactFolders: z.array(WorkflowArtifactFolderRefSchema).default([]),
    artifacts: z.array(WorkflowArtifactLinkSchema).default([]),
    files: z.array(WorkflowFileRefSchema).default([]),
    agentContext: z.record(z.string(), z.unknown()).optional(),
  })
  .strip();
export type WorkflowStageContext = z.infer<typeof WorkflowStageContextSchema>;

export const WorkflowInvestigationCompletionStateSchema = z.enum([
  "pending_agent",
  "agent_finished",
  "approved",
  "rejected",
  "intervened",
  "expired",
  "cancelled",
  "error",
]);
export type WorkflowInvestigationCompletionState = z.infer<
  typeof WorkflowInvestigationCompletionStateSchema
>;

export const WORKFLOW_INVESTIGATION_COMPLETION_TRANSITIONS: Readonly<
  Record<WorkflowInvestigationCompletionState, readonly WorkflowInvestigationCompletionState[]>
> = {
  pending_agent: ["agent_finished", "intervened", "expired", "cancelled", "error"],
  agent_finished: ["approved", "rejected", "intervened", "expired", "cancelled", "error"],
  approved: ["intervened"],
  rejected: ["intervened"],
  intervened: [],
  expired: ["intervened"],
  cancelled: ["intervened"],
  error: ["intervened"],
};

export function isValidInvestigationCompletionTransition(
  from: WorkflowInvestigationCompletionState | undefined,
  to: WorkflowInvestigationCompletionState,
): boolean {
  if (from === undefined)
    return to === "pending_agent" || to === "agent_finished" || to === "error";
  return WORKFLOW_INVESTIGATION_COMPLETION_TRANSITIONS[from].includes(to);
}

export const WorkflowInvestigationCompletionSchema = z
  .object({
    incidentId: z.string(),
    state: WorkflowInvestigationCompletionStateSchema,
    previousState: WorkflowInvestigationCompletionStateSchema.optional(),
    reason: z.string().optional(),
    actor: z.string().optional(),
    markdownArtifactKey: z.string().optional(),
    jsonArtifactKey: z.string().optional(),
    chatLinks: z.array(WorkflowChatLinkSchema).default([]),
    updatedAt: z.number().int().nonnegative(),
  })
  .strip();
export type WorkflowInvestigationCompletion = z.infer<typeof WorkflowInvestigationCompletionSchema>;

export interface WorkflowInvestigationCompletionUpdate {
  readonly incidentId: string;
  readonly state: WorkflowInvestigationCompletionState;
  readonly reason?: string;
  readonly actor?: string;
  readonly markdownArtifactKey?: string;
  readonly jsonArtifactKey?: string;
  readonly chatLinks?: ReadonlyArray<WorkflowChatLink>;
}

export const WorkflowActionCenterEvidenceSchema = z
  .object({
    label: z.string(),
    detail: z.string().optional(),
    artifacts: z.array(WorkflowArtifactLinkSchema).default([]),
    chats: z.array(WorkflowChatLinkSchema).default([]),
    files: z.array(WorkflowFileRefSchema).default([]),
  })
  .strip();
export type WorkflowActionCenterEvidence = z.infer<typeof WorkflowActionCenterEvidenceSchema>;

export const WorkflowActionCenterItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.string().optional(),
    why: z.string().optional(),
    evidence: z.array(WorkflowActionCenterEvidenceSchema).default([]),
    supportingDetails: z.array(z.string()).default([]),
    artifacts: z.array(WorkflowArtifactLinkSchema).default([]),
    chats: z.array(WorkflowChatLinkSchema).default([]),
    safeToSend: z.boolean().optional(),
    ownerAlias: z.string().optional(),
  })
  .strip();
export type WorkflowActionCenterSnapshotItem = z.infer<typeof WorkflowActionCenterItemSchema>;
