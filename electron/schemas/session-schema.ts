/**
 * Zod schemas for on-disk session data (SF-4 safe deserialization).
 *
 * Convention: session-owned object schemas use `.strip()` to drop unknown keys.
 * Portable goal authority is validated by its stricter nested schema. Message
 * content uses `.passthrough()` to preserve future SDK-added fields.
 */

import { z } from "zod";

import { parseLegacySubagentReadinessDelivery } from "../../common/agent-readiness";
import { PERMISSION_KIND_TUPLE } from "../../common/marshal-ipc-contract";
import type {
  GoalTimelineEvent,
  MessageQuestion,
  QuestionAnswer,
  SessionAgentMessageMetadata,
  SessionInternalControlMetadata,
  SessionMessage,
} from "../../common/marshal-ipc-contract";
import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayProviderId,
} from "../../common/relay-contract";
import { GoalDocumentSchema, GoalRecoverySchema } from "./goal-schema";

const ReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const ContextTierSchema = z.enum(["default", "long_context"]);
/** Sources written by retired features; old rows load as ordinary chats. */
export const LEGACY_SESSION_SOURCE_ALIASES: Readonly<Record<string, "user">> = {
  teams: "user",
  "teams-archived": "user",
};

export function normalizeLegacySessionSource(value: unknown): unknown {
  return typeof value === "string" && Object.hasOwn(LEGACY_SESSION_SOURCE_ALIASES, value)
    ? LEGACY_SESSION_SOURCE_ALIASES[value]
    : value;
}

const SessionSourceEnumSchema = z.enum([
  "user",
  "automation",
  "subagent",
  "workflow-agent",
  "workflow-run",
  "workspace",
  "heartbeat",
  "feedback",
]);
const SessionSourceSchema = z.preprocess(normalizeLegacySessionSource, SessionSourceEnumSchema);
const WorkspaceInstanceIdentitySchema = z
  .object({
    version: z.literal(1),
    device: z.string(),
    inode: z.string(),
    birthtimeNs: z.string(),
  })
  .strip();
const RepositoryAgentIdentitySchema = z
  .object({
    version: z.literal(1),
    normalizedPath: z.string(),
    declaredName: z.string(),
    contentDigest: z.string(),
  })
  .strip();
const SessionRepositoryAgentSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    description: z.string().optional(),
    identity: RepositoryAgentIdentitySchema.optional(),
  })
  .strip();

/** Per-tier default model + reasoning effort (subagent / workflow tiers). */
const TierModelDefaultsSchema = z
  .object({
    model: z.string().optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
    contextTier: ContextTierSchema.optional(),
  })
  .strip();

type AssertAssignable<T extends U, U> = T;

function validateRecommendedIndex(
  data: { answers: Array<unknown>; recommendedIndex?: number },
  ctx: z.RefinementCtx,
): void {
  if (data.recommendedIndex !== undefined && data.recommendedIndex >= data.answers.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recommendedIndex"],
      message: "recommendedIndex must point to an answer",
    });
  }
}

const QuestionAnswerSchema = z
  .object({
    title: z.string(),
    description: z.string().optional(),
  })
  .passthrough();

// Compile-time drift guard: if QuestionAnswerSchema's output and the shared
// QuestionAnswer interface in ipc-contract stop lining up, this fails to compile.
// Intentionally exported so fallow doesn't flag it as unused — see .fallowrc.json.
export type _QuestionAnswerSchemaMatchesShared = AssertAssignable<
  z.output<typeof QuestionAnswerSchema>,
  QuestionAnswer
>;

const MessageQuestionSchema = z
  .object({
    question: z.string(),
    answers: z.array(QuestionAnswerSchema).min(2).max(5),
    recommendedIndex: z.number().int().min(0).optional(),
    selectedAnswer: z.string().optional(),
  })
  .passthrough()
  .superRefine(validateRecommendedIndex);

// Compile-time drift guard — see _QuestionAnswerSchemaMatchesShared above.
export type _MessageQuestionSchemaMatchesShared = AssertAssignable<
  z.output<typeof MessageQuestionSchema>,
  MessageQuestion
>;

export const AskUserToolResultSchema = z
  .object({
    success: z.literal(true),
    question: z.string(),
    answers: z.array(QuestionAnswerSchema).min(2).max(5),
    recommendedIndex: z.number().int().min(0).optional(),
  })
  .strip()
  .superRefine(validateRecommendedIndex);

const GoalTimelineResumeTriggerSchema = z
  .object({
    kind: z.enum([
      "initial-pursuit",
      "continuation-completed",
      "explicit-resume-takeover",
      "completion-claim-rejected",
      "milestone-available",
      "restart-recovery",
      "busy-yield-cleared",
    ]),
    reason: z.string(),
    milestoneSummary: z.string().optional(),
    occurredAt: z.string(),
  })
  .strip();

const SessionMessageGoalFenceSchema = z
  .object({
    goalId: z.string(),
    epoch: z.number().int().positive().optional(),
    contractRevision: z.number().int().positive().optional(),
    lifecycleEpoch: z.number().int().nonnegative().optional(),
    specificationRevision: z.number().int().nonnegative().optional(),
    specificationDigest: z.string().optional(),
  })
  .passthrough()
  .superRefine((fence, ctx) => {
    if (fence.epoch === undefined && fence.lifecycleEpoch === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["epoch"],
        message: "epoch is required",
      });
    }
  })
  .transform((fence) => ({
    goalId: fence.goalId,
    epoch: fence.epoch ?? fence.lifecycleEpoch!,
  }));

const GoalTimelineStatusSchema = z
  .enum(["pursuing", "paused", "blocked", "completed", "stopped", "surrendered", "superseded"])
  .transform((status) =>
    status === "surrendered" || status === "superseded" ? ("stopped" as const) : status,
  );

const GoalTimelineDurableMilestoneSchema = z
  .object({
    latestProgress: z.string().optional(),
    handoffSummary: z.string().optional(),
    latestDecision: z.string().optional(),
    openQuestion: z.string().optional(),
  })
  .strip();

const GoalTimelineAgentSourceSchema = z.enum([
  "assistant",
  "subagent",
  "workflow-agent",
  "reviewer",
]);

const GoalTimelineAgentAttributionInputSchema = z
  .object({
    sessionId: z.string(),
    source: GoalTimelineAgentSourceSchema.optional(),
    sourceLabel: z.string().optional(),
    label: z.string().optional(),
  })
  .strip();

const GoalTimelineAgentAttributionSchema = GoalTimelineAgentAttributionInputSchema.transform(
  ({ label, ...agent }) => ({
    ...agent,
    source: agent.source ?? ("assistant" as const),
    ...((agent.sourceLabel ?? label) ? { sourceLabel: agent.sourceLabel ?? label } : {}),
  }),
);

const GoalTimelineReviewerAttributionSchema = z
  .object({
    sessionId: z.string().optional(),
    source: GoalTimelineAgentSourceSchema.optional(),
    sourceLabel: z.string().optional(),
    label: z.string().optional(),
    requestedCompaction: z.boolean(),
  })
  .strip()
  .transform(({ label, ...reviewer }) => ({
    ...reviewer,
    sessionId: reviewer.sessionId ?? "goal:continuation-reviewer",
    source: reviewer.source ?? ("reviewer" as const),
    ...((reviewer.sourceLabel ?? label) ? { sourceLabel: reviewer.sourceLabel ?? label } : {}),
  }));

const GoalTimelineEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("goal.declared"),
      fence: SessionMessageGoalFenceSchema,
      objective: z.string(),
    })
    .strip(),
  z
    .object({
      type: z.literal("goal.continuation"),
      fence: SessionMessageGoalFenceSchema,
      sequence: z.number().int().positive(),
      verification: z.boolean(),
      resumeTrigger: GoalTimelineResumeTriggerSchema,
      durableMilestone: GoalTimelineDurableMilestoneSchema,
      agent: GoalTimelineAgentAttributionSchema,
      reviewer: GoalTimelineReviewerAttributionSchema.optional(),
    })
    .strip(),
  z
    .object({
      type: z.literal("goal.completion-requested"),
      fence: SessionMessageGoalFenceSchema,
      attempt: z.number().int().positive(),
    })
    .strip(),
  z
    .object({
      type: z.literal("goal.completion-rejected"),
      fence: SessionMessageGoalFenceSchema,
      reason: z.string(),
      outcome: z.enum(["continuing", "blocked"]),
    })
    .strip(),
  z
    .object({
      type: z.literal("goal.lifecycle-changed"),
      fence: SessionMessageGoalFenceSchema,
      from: GoalTimelineStatusSchema,
      to: GoalTimelineStatusSchema,
      reason: z.string().optional(),
    })
    .strip(),
]);

const SessionAgentMessageMetadataSchema = z
  .object({
    source: z.string(),
    sourceLabel: z.string().optional(),
    sourceSessionName: z.string().optional(),
    kind: z.enum([
      "subagent",
      "parent",
      "readiness",
      "review-comment",
      "review-feedback",
      "selected-session",
      "goal-terminal",
      "relay",
      "app-restart",
    ]),
    deliveryMode: z.enum(["queue", "interrupt"]),
    sequence: z.number().int().nonnegative(),
    messageId: z.string().optional(),
    idempotencyKey: z.string().optional(),
    target: z.string().optional(),
    priority: z.number().optional(),
    coalescedMessageCount: z.number().int().positive().optional(),
    deadline: z.string().optional(),
    attempts: z.number().int().nonnegative().optional(),
    state: z
      .enum([
        "accepted",
        "pending",
        "leased",
        "backend-accepted",
        "processed",
        "dead-letter",
        "delivery-unknown",
        "cancelled",
      ])
      .optional(),
    acceptedAt: z.string().optional(),
    updatedAt: z.string().optional(),
    retryAt: z.string().optional(),
    leaseId: z.string().optional(),
    leaseExpiresAt: z.string().optional(),
    backendAcceptedAt: z.string().optional(),
    backendDeliveredAt: z.string().optional(),
    goalFence: SessionMessageGoalFenceSchema.optional(),
    goalId: z.string().optional(),
    goalDeliveryKind: z.enum(["child", "reviewer", "terminal"]).optional(),
    goalTerminalKind: z.enum(["blocked", "completed"]).optional(),
    goalDeliverySequence: z.number().int().nonnegative().optional(),
    processedAt: z.string().optional(),
    sourceSessionSource: SessionSourceSchema.optional(),
    relayOrigin: z
      .object({
        providerId: z.string().min(1),
        accountId: z.string().min(1),
        conversationId: z.string().min(1),
      })
      .strip()
      .transform((origin) => ({
        providerId: parseRelayProviderId(origin.providerId),
        accountId: parseRelayAccountId(origin.accountId),
        conversationId: parseRelayConversationId(origin.conversationId),
      }))
      .optional(),
    readinessGeneration: z.string().optional(),
    readinessWakeVersion: z.literal(1).optional(),
    readinessDispatchExchangeId: z.string().min(1).max(512).optional(),
  })
  .strip()
  .transform(({ sourceSessionName, ...metadata }) => ({
    ...metadata,
    ...((metadata.sourceLabel ?? sourceSessionName)
      ? { sourceLabel: metadata.sourceLabel ?? sourceSessionName }
      : {}),
  }));

const SessionInternalControlMetadataSchema = z
  .object({
    kind: z.enum([
      "goal-continuation",
      "goal-continuation-composer",
      "goal-transition-review",
      "relay-progress",
      "subagent-readiness",
      "background-task",
    ]),
    exchangeId: z.string().min(1).max(512),
    side: z.enum(["request", "response"]),
  })
  .strip();

export type _GoalTimelineEventSchemaMatchesShared = AssertAssignable<
  z.output<typeof GoalTimelineEventSchema>,
  GoalTimelineEvent
>;

export type _SessionAgentMessageMetadataSchemaMatchesShared = AssertAssignable<
  z.output<typeof SessionAgentMessageMetadataSchema>,
  SessionAgentMessageMetadata
>;

export type _SessionInternalControlMetadataSchemaMatchesShared = AssertAssignable<
  z.output<typeof SessionInternalControlMetadataSchema>,
  SessionInternalControlMetadata
>;

// ── SessionMessage ───────────────────────────────────────────────────────────
// Use .passthrough() so future SDK fields stored in messages are preserved on
// round-trip rather than silently stripped.
const LegacyGoalContinuationMetadataSchema = z
  .object({
    goalFence: SessionMessageGoalFenceSchema,
    continuationCount: z.number().int().nonnegative(),
    isVerification: z.boolean(),
    actor: z
      .object({
        sessionId: z.string(),
        name: z.string(),
        source: z.enum(["assistant", "subagent", "workflow-agent"]),
      })
      .passthrough(),
  })
  .passthrough();

const RawMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant", "system"]),
    content: z.string(),
    timestamp: z.string().default(""),
    background: z.boolean().optional(),
    error: z.boolean().optional(),
    goalContinuation: z.boolean().optional(),
    internalControl: SessionInternalControlMetadataSchema.optional(),
    goalTimelineEvent: GoalTimelineEventSchema.optional(),
    goalContinuationMetadata: LegacyGoalContinuationMetadataSchema.optional(),
    reasoning: z
      .object({ text: z.string(), durationSeconds: z.number().nullable() })
      .passthrough()
      .optional(),
    toolCalls: z
      .array(
        z
          .object({
            id: z.string().optional(),
            name: z.string(),
            description: z.string(),
            input: z.string().optional(),
            output: z.string().optional(),
            success: z.boolean().optional(),
            error: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    toolProvenance: z.array(z.record(z.string(), z.unknown())).optional(),
    question: MessageQuestionSchema.optional(),
    agentMessage: SessionAgentMessageMetadataSchema.optional(),
    suppressedAgentStatusResponse: z.boolean().optional(),
  })
  .passthrough();

function normalizeMessageMetadata(message: z.output<typeof RawMessageSchema>): SessionMessage {
  const { goalContinuationMetadata, ...normalized } = message;
  if (normalized.goalTimelineEvent || !goalContinuationMetadata) return normalized;

  const { actor } = goalContinuationMetadata;
  return {
    ...normalized,
    goalTimelineEvent: {
      type: "goal.continuation",
      fence: goalContinuationMetadata.goalFence,
      sequence: goalContinuationMetadata.continuationCount + 1,
      verification: goalContinuationMetadata.isVerification,
      resumeTrigger: {
        kind:
          goalContinuationMetadata.continuationCount === 0
            ? "initial-pursuit"
            : "continuation-completed",
        reason: "Legacy goal continuation.",
        occurredAt: normalized.timestamp,
      },
      durableMilestone: {},
      agent: {
        sessionId: actor.sessionId,
        source: actor.source,
        sourceLabel: actor.name,
      },
    },
  };
}

export const MessageSchema = RawMessageSchema.transform(normalizeMessageMetadata);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Read-only migration: retired generated prompts must not reappear in restored history.
function removeLegacyToolPinMessages(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw
    .filter((message) => !isObjectRecord(message) || message.toolPinNudge !== true)
    .map((message) => {
      if (!isObjectRecord(message)) return message;
      const { toolPinNudge: _removed, ...rest } = message;
      return rest;
    });
}

export function normalizeLegacyReadinessMessages(messages: SessionMessage[]): SessionMessage[] {
  let suppressAssistantResponse = false;
  return messages.map((message) => {
    const metadata = message.agentMessage;
    const readiness =
      message.role === "user" && metadata?.kind === "parent"
        ? parseLegacySubagentReadinessDelivery({
            content: message.content,
            idempotencyKey: metadata.idempotencyKey,
            sourceSessionId: metadata.source,
          })
        : null;
    if (readiness && metadata) {
      suppressAssistantResponse = true;
      return {
        ...message,
        role: "system",
        agentMessage: {
          ...metadata,
          source: readiness.sourceSessionId,
          sourceLabel: metadata.sourceLabel ?? readiness.sourceLabel,
          sourceSessionSource: metadata.sourceSessionSource ?? "subagent",
          kind: "readiness",
          deliveryMode: metadata.deliveryMode,
          sequence: metadata.sequence,
          messageId: metadata.messageId ?? message.id,
          idempotencyKey: metadata.idempotencyKey ?? message.id,
          target: metadata.target,
          state: "processed",
          acceptedAt: metadata.acceptedAt ?? message.timestamp,
          updatedAt: metadata.updatedAt ?? message.timestamp,
          processedAt: metadata.processedAt ?? message.timestamp,
          readinessGeneration:
            metadata.readinessGeneration ??
            `legacy:${metadata.idempotencyKey ?? metadata.messageId ?? message.id}`,
        },
      };
    }
    if (message.role === "user") {
      suppressAssistantResponse = false;
      return message;
    }
    if (suppressAssistantResponse && message.role === "assistant") {
      return { ...message, suppressedAgentStatusResponse: true };
    }
    return message;
  });
}

export function normalizeInternalControlMessages(messages: SessionMessage[]): SessionMessage[] {
  let activeExchange: Pick<SessionInternalControlMetadata, "kind" | "exchangeId"> | null = null;
  let changed = false;
  const normalized = messages.map((message) => {
    if (message.internalControl?.side === "request") {
      activeExchange = message.internalControl;
      return message;
    }
    if (message.role === "user") {
      if (!message.goalContinuation) {
        activeExchange = null;
        return message;
      }
      activeExchange = {
        kind: "goal-continuation",
        exchangeId: message.id,
      };
      if (message.internalControl) return message;
      changed = true;
      return {
        ...message,
        internalControl: {
          ...activeExchange,
          side: "request" as const,
        },
      };
    }
    if (message.role !== "assistant" || !activeExchange || message.internalControl) {
      return message;
    }
    changed = true;
    return {
      ...message,
      internalControl: {
        ...activeExchange,
        side: "response" as const,
      },
    };
  });
  return changed ? normalized : messages;
}

export type _MessageSchemaMatchesShared = AssertAssignable<
  z.output<typeof MessageSchema>,
  SessionMessage
>;

// ── PermissionCardData ───────────────────────────────────────────────────────
const PermissionCardDataSchema = z
  .object({
    id: z.string(),
    toolCallId: z.string().optional(),
    sessionId: z.string().optional(),
    kind: z.enum(PERMISSION_KIND_TUPLE),
    title: z.string(),
    message: z.string(),
    detail: z.string(),
    buttons: z.array(z.string()),
    output: z.string().optional(),
    resolved: z.enum(["allowed", "denied", "failed", "timed-out"]).optional(),
    createdAt: z.number().optional(),
    // Restored pending cards no longer have the original PermissionRequest to recompute this.
    browserUseDisclosure: z.boolean().optional(),
  })
  .strip();

// ── Legacy persona key migration ─────────────────────────────────────────────
// Rows written before Souls persist the persona under `personality`. Both
// session schemas would otherwise lose it — `.strip()` drops it outright, and
// `.passthrough()` would keep a stale duplicate alongside `soul` forever. Lift
// it once, at parse time; the *value* is mapped to a Marshal-owned soul id by
// `coerceToKnownSoul()` in electron/souls.ts when it's read.
function liftLegacyKey(from: string, to: string) {
  return (raw: unknown): unknown => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
    if (!(from in raw)) return raw;
    const legacy: unknown = Reflect.get(raw, from);
    const current: unknown = Reflect.get(raw, to);
    const rest = { ...raw };
    Reflect.deleteProperty(rest, from);
    return current === undefined && typeof legacy === "string" ? { ...rest, [to]: legacy } : rest;
  };
}

const liftLegacySessionSoul = liftLegacyKey("personality", "soul");

// ── SessionMetadata ──────────────────────────────────────────────────────────
// `runtimeId` is the durable visibility partition. Legacy rows derive it from
// `backendOrigin`; rows missing both fields belong to the Copilot runtime.
const SessionMetadataObjectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string().default(""),
    updatedAt: z.string().default(""),
    hasUnread: z.boolean().default(false),
    isActive: z.boolean().default(false),
    // No `.default(false)`: absent must stay absent so a session written before
    // pinning existed round-trips byte-identically instead of gaining a field.
    isPinned: z.boolean().optional(),
    isBusy: z.boolean().optional(),
    model: z.string().optional(),
    runtimeAccountSelection: z.enum(["default", "explicit"]).optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
    contextTier: ContextTierSchema.optional(),
    soul: z.string().optional(),
    source: SessionSourceSchema.optional(),
    automationId: z.string().optional(),
    parentSessionId: z.string().optional(),
    runtimeDelegationId: z.string().optional(),
    runtimeTaskController: z.string().optional(),
    runtimeAgentRole: z
      .enum(["brain", "planner", "swarm", "worker", "reviewer", "validator", "reconciler"])
      .optional(),
    permissionMode: z.enum(["default", "allow-all", "read-only-reviewer"]).optional(),
    workspaceName: z.string().optional(),
    // Display-only origin workspace for worktree sessions. Must be declared
    // here or `.strip()` silently drops it from every index row.
    originWorkspaceName: z.string().optional(),
    workspaceIdentity: WorkspaceInstanceIdentitySchema.optional(),
    workspaceBindingInvalid: z.boolean().optional(),
    repositoryAgent: SessionRepositoryAgentSchema.optional(),
    // Absolute repo root for repoPath-scoped subagents without a workspaceName.
    repoPath: z.string().optional(),
    runtimeId: z.string().optional(),
    backendOrigin: z.enum(["copilot", "gateway"]).optional(),
    backendId: z.string().optional(),
  })
  .strip();

export const SessionMetadataSchema = z.preprocess(
  liftLegacySessionSoul,
  SessionMetadataObjectSchema,
);

// ── StoredSession ────────────────────────────────────────────────────────────
// The on-disk format written by sessions.ts. Includes `aiGeneratedTitle` which
// is a sessions.ts-internal field not exposed in the ipc-contract export.
// `.default([])` on messages ensures a corrupt messages field falls back to an
// empty array rather than losing the entire session.
// Uses `.passthrough()` (not `.strip()`) because ~20 load-modify-save call sites
// round-trip through this schema — stripping unknown fields would silently erase
// any field added to StoredSession before the schema is updated to match.
const StoredSessionObjectSchema = SessionMetadataObjectSchema.extend({
  suppressParentReadinessWake: z.boolean().optional(),
  liveTurnCheckpoint: z
    .object({
      version: z.literal(1),
      ownerId: z.string().optional(),
      message: MessageSchema,
      updatedAt: z.string(),
    })
    .strip()
    .optional(),
  messages: z.preprocess(
    removeLegacyToolPinMessages,
    z
      .array(MessageSchema)
      .default([])
      .transform((messages) =>
        normalizeLegacyReadinessMessages(normalizeInternalControlMessages(messages)),
      ),
  ),
  permissionCards: z.array(PermissionCardDataSchema).optional(),
  contextSummary: z.string().optional(),
  runtimeConversationState: z
    .object({
      version: z.literal(1),
      sourceRuntimeId: z.string(),
      summary: z.string().optional(),
      messages: z.array(
        z.object({ role: z.enum(["user", "assistant", "tool"]), content: z.string() }),
      ),
    })
    .optional(),
  pendingRuntimeHandoff: z.boolean().optional(),
  pendingModelSwitch: z
    .object({
      model: z.string(),
      reasoningEffort: ReasoningEffortSchema.optional(),
      accountSelection: z.enum(["default", "explicit"]).optional(),
      liveSwitch: z.boolean().optional(),
      requestedAt: z.string(),
    })
    .strip()
    .optional(),
  summaryUpToMessageId: z.string().optional(),
  aiGeneratedTitle: z.string().optional(),
  needsAiTitle: z.boolean().optional(),
  playwrightHeadless: z.boolean().optional(),
  sandbox: z
    .object({
      mode: z.enum(["read-only", "workspace-write"]),
      writableRoots: z.array(z.string()).optional(),
    })
    .strip()
    .optional(),
  // Per-session skills allowlist (skill names). Undefined = inherit global
  // skill set; `[]` = no skills allowed. See R1-FIXES A13.
  runtimeActiveExecutionId: z.string().optional(),
  runtimeExecutions: z
    .array(
      z.object({
        executionId: z.string(),
        sessionId: z.string(),
        transcriptRef: z.string(),
        model: z.string().optional(),
        reasoningEffort: ReasoningEffortSchema.optional(),
        usage: z
          .object({
            inputTokens: z.number().nonnegative().optional(),
            outputTokens: z.number().nonnegative().optional(),
            cachedInputTokens: z.number().nonnegative().optional(),
            costUsd: z.number().nonnegative().optional(),
          })
          .optional(),
        usageByModel: z
          .array(
            z.object({
              model: z.string().optional(),
              usage: z.object({
                inputTokens: z.number().nonnegative().optional(),
                outputTokens: z.number().nonnegative().optional(),
                cachedInputTokens: z.number().nonnegative().optional(),
                costUsd: z.number().nonnegative().optional(),
              }),
            }),
          )
          .optional(),
        callIds: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  scopedSkills: z.array(z.string()).optional(),
  // Per-session MCP allowlist (config keys). Undefined = inherit global;
  // `[]` = no MCP servers allowed. See R1-FIXES A13.
  scopedMcp: z.array(z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
  systemPromptOverride: z.string().optional(),
  leanPrompt: z.boolean().optional(),
  leanRepoRules: z.boolean().optional(),
  leanCore: z.boolean().optional(),
  launchAttachments: z.array(z.string()).optional(),
  goal: GoalDocumentSchema.optional(),
  // Quarantined unreadable goal (raw bytes preserved). See migrateStoredSessionGoal.
  goalRecovery: GoalRecoverySchema.optional(),
}).passthrough();

export const StoredSessionSchema = z.preprocess(liftLegacySessionSoul, StoredSessionObjectSchema);

// ── Chunked session storage (chunked-v1) ─────────────────────────────────────
// To avoid loading an entire multi-MB session blob to read any of it, sessions
// are persisted as a small header file plus N message-chunk files. The header
// carries everything except `messages`; the messages live in numbered chunks.
// See LocalSessionStore in electron/session-store.ts.

/** Discriminator value stored in a chunked header's `storageFormat` field. */
export const SESSION_CHUNK_FORMAT = "chunked-v1";

/** Default number of messages per chunk file. */
export const MESSAGES_PER_CHUNK = 50;

/** Header file schema: a stored session with `messages` replaced by chunk metadata. */
export const StoredSessionHeaderSchema = z.preprocess(
  liftLegacySessionSoul,
  StoredSessionObjectSchema.omit({ messages: true })
    .extend({
      storageFormat: z.literal(SESSION_CHUNK_FORMAT),
      /** Generation subdirectory holding this header's chunk files. Optional for
       *  forward-compat with any pre-generation chunked headers. */
      chunkGen: z.string().optional(),
      chunkCount: z.number().int().nonnegative(),
      messageCount: z.number().int().nonnegative(),
      lastMessagePreview: z.string().optional(),
      persistenceProofVersion: z.literal(1).optional(),
      persistenceGenerationToken: z.string().optional(),
      persistenceCanonicalDigest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .passthrough(),
);

/** A single chunk file is a JSON array of messages. */
export const MessageChunkSchema = z.preprocess(
  removeLegacyToolPinMessages,
  z.array(MessageSchema).transform(normalizeInternalControlMessages),
);

// ── SessionsIndex ────────────────────────────────────────────────────────────
// `sessions` accepts `z.unknown()` elements so the array-level parse never fails
// atomically.  Individual entries are validated per-item in `loadIndex()` via
// `SessionMetadataSchema.safeParse()` — invalid entries are dropped with a
// warning instead of losing the entire index.
export const SessionsIndexSchema = z.preprocess(
  liftLegacyKey("defaultPersonality", "defaultSoul"),
  z
    .object({
      sessions: z.array(z.unknown()).default([]),
      activeSessionId: z.string().nullable().default(null),
      defaultModel: z.string().optional(),
      defaultReasoningEfforts: z.record(z.string(), ReasoningEffortSchema).optional(),
      defaultContextTiers: z.record(z.string(), ContextTierSchema).optional(),
      defaultSoul: z.string().optional(),
      subagentDefaults: TierModelDefaultsSchema.optional(),
      workflowDefaults: TierModelDefaultsSchema.optional(),
    })
    .strip(),
);
