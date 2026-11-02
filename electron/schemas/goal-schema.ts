import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  GOAL_DOCUMENT_SCHEMA_VERSION,
  GOAL_INITIAL_EPOCH,
  type GoalDocumentV2,
  type GoalJsonValue,
  type GoalRecord,
} from "../../common/goal-contract";

export const GOAL_PORTABLE_LIMITS = {
  idLength: 256,
  timestampLength: 128,
  textLength: 8_000,
  maxCriteria: 50,
  maxContextItems: 100,
  maxStateKeys: 100,
  maxStateDepth: 8,
  maxStateBytes: 64 * 1024,
} as const;

const IdSchema = z.string().trim().min(1).max(GOAL_PORTABLE_LIMITS.idLength);
const TimestampSchema = z.string().trim().min(1).max(GOAL_PORTABLE_LIMITS.timestampLength);
const TextSchema = z.string().trim().min(1).max(GOAL_PORTABLE_LIMITS.textLength);
const TextListSchema = z.array(TextSchema).max(GOAL_PORTABLE_LIMITS.maxContextItems);
const CriteriaSchema = z.array(TextSchema).max(GOAL_PORTABLE_LIMITS.maxCriteria);

const SourceInstructionSchema = z
  .object({
    messageId: IdSchema,
    excerpt: TextSchema,
  })
  .strict();

const JsonValueSchema: z.ZodType<GoalJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const GoalStateBagSchema = z
  .record(z.string().min(1).max(128), JsonValueSchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > GOAL_PORTABLE_LIMITS.maxStateKeys) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Goal state exceeds ${GOAL_PORTABLE_LIMITS.maxStateKeys} keys`,
      });
    }
    if (jsonDepth(value) > GOAL_PORTABLE_LIMITS.maxStateDepth) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Goal state exceeds depth ${GOAL_PORTABLE_LIMITS.maxStateDepth}`,
      });
    }
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > GOAL_PORTABLE_LIMITS.maxStateBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Goal state exceeds ${GOAL_PORTABLE_LIMITS.maxStateBytes} bytes`,
      });
    }
  });

export const GoalDocumentV2Schema = z
  .object({
    schemaVersion: z.literal(GOAL_DOCUMENT_SCHEMA_VERSION),
    id: IdSchema,
    epoch: z.number().int().positive(),
    objective: TextSchema,
    criteria: CriteriaSchema,
    sourceInstruction: SourceInstructionSchema.optional(),
    status: z.enum(["pursuing", "paused", "blocked", "completed", "stopped"]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    startedPursuingAt: TimestampSchema.optional(),
    completedAt: TimestampSchema.optional(),
    blockedReason: TextSchema.optional(),
    progress: TextListSchema,
    openQuestions: TextListSchema,
    assumptions: TextListSchema,
    decisions: TextListSchema,
    state: GoalStateBagSchema,
    continuationCount: z.number().int().nonnegative(),
    activeMs: z.number().finite().nonnegative(),
    tokensUsed: z.number().finite().nonnegative(),
  })
  .strict() satisfies z.ZodType<GoalRecord>;

export const GoalStateSchema = GoalDocumentV2Schema;
export const GoalDocumentSchema = GoalDocumentV2Schema;

/**
 * Quarantine record for a persisted goal that failed validation even after
 * salvage. `raw` is the JSON re-serialization of the parsed goal VALUE —
 * value-faithful, not byte-faithful (the session file was already parsed
 * before migration, so the original serialization is not available here) —
 * preserved so no recovery path ever has to invent intent, and deliberately
 * unbounded so quarantining never truncates data that already fit in the
 * session file. The record is durable: setting a new goal marks it resolved
 * (resolvedAt/resolvedByGoalId) but keeps the retained copy; only a later
 * quarantine replaces it (single retained slot, most recent wins).
 */
export const GoalRecoverySchema = z
  .object({
    reason: z.literal("invalid-document"),
    raw: z.string().min(1),
    quarantinedAt: TimestampSchema,
    resolvedAt: TimestampSchema.optional(),
    resolvedByGoalId: IdSchema.optional(),
  })
  .strict();

export type GoalRecoveryState = z.infer<typeof GoalRecoverySchema>;

export type GoalDocumentMigrationResult =
  | { kind: "current"; document: GoalDocumentV2 }
  | { kind: "migrated"; document: GoalDocumentV2 }
  | { kind: "unsupported-version"; version: number }
  | { kind: "invalid" };

export function createInitialGoalDocument(input: {
  id?: string;
  objective: string;
  criteria?: string[];
  acceptanceCriteria?: string[];
  sourceInstruction?: { messageId: string; excerpt: string };
  now?: string;
}): GoalDocumentV2 {
  const now = input.now ?? new Date().toISOString();
  return GoalDocumentV2Schema.parse({
    schemaVersion: GOAL_DOCUMENT_SCHEMA_VERSION,
    id: input.id ?? randomUUID(),
    epoch: GOAL_INITIAL_EPOCH,
    objective: input.objective,
    criteria: input.criteria ?? input.acceptanceCriteria ?? [],
    ...(input.sourceInstruction ? { sourceInstruction: input.sourceInstruction } : {}),
    status: "pursuing",
    createdAt: now,
    updatedAt: now,
    startedPursuingAt: now,
    progress: [],
    openQuestions: [],
    assumptions: [],
    decisions: [],
    state: {},
    continuationCount: 0,
    activeMs: 0,
    tokensUsed: 0,
  });
}

export function migrateGoalDocumentForPersistence(value: unknown): GoalDocumentMigrationResult {
  if (!isRecord(value)) return { kind: "invalid" };
  const version = value.schemaVersion;
  if (typeof version === "number" && version > GOAL_DOCUMENT_SCHEMA_VERSION) {
    return { kind: "unsupported-version", version };
  }
  if (version === GOAL_DOCUMENT_SCHEMA_VERSION) {
    const parsed = GoalDocumentV2Schema.safeParse(value);
    if (parsed.success) return { kind: "current", document: parsed.data };
    // Salvage before declaring invalid: sourceInstruction is a strict
    // sub-schema, so a future writer adding a field there must not cost the
    // goal (StoredSessionSchema embeds this schema, so an invalid goal fails
    // the entire session load). Preserve the KNOWN intent-pointer fields —
    // never drop the user's original-instruction link when its own fields are
    // valid; only a sourceInstruction whose known fields are themselves
    // unreadable is dropped, and the goal authority itself stays strict.
    if (isRecord(value) && value.sourceInstruction !== undefined) {
      const raw = value.sourceInstruction;
      const picked =
        isRecord(raw) && typeof raw.messageId === "string" && typeof raw.excerpt === "string"
          ? { messageId: raw.messageId, excerpt: raw.excerpt }
          : undefined;
      const { sourceInstruction: _dropped, ...rest } = value;
      const salvaged = GoalDocumentV2Schema.safeParse(
        picked ? { ...rest, sourceInstruction: picked } : rest,
      );
      if (salvaged.success) return { kind: "migrated", document: salvaged.data };
    }
    return { kind: "invalid" };
  }
  if (version !== undefined && version !== 1 && version !== 2) return { kind: "invalid" };

  const objective = readText(value.objective);
  const id = readText(value.id);
  if (!objective || !id) return { kind: "invalid" };

  const oldStatus = readText(value.status);
  const status = migrateStatus(oldStatus);
  const createdAt = readText(value.createdAt) ?? new Date().toISOString();
  const updatedAt = readText(value.updatedAt) ?? createdAt;
  const criteria =
    readTextList(value.criteria, "text") ?? readTextList(value.acceptanceCriteria) ?? [];
  const progressNote = readText(value.progressNote);
  const progress = [
    ...(readTextList(value.progress) ?? []),
    ...(progressNote ? [progressNote] : []),
  ];
  const openQuestions =
    readTextList(value.openQuestions, "question") ?? readTextList(value.handoff, "blockers") ?? [];
  const assumptions = readLegacyAssumptions(value);
  const decisions = readTextList(value.decisions, "decision") ?? [];
  const state = readLegacyState(value);
  const persistedEpoch =
    readPositiveInt(value.epoch) ?? readPositiveInt(value.lifecycleEpoch) ?? GOAL_INITIAL_EPOCH;
  const blockedReason = readText(value.blockedReason);

  const candidate = {
    schemaVersion: GOAL_DOCUMENT_SCHEMA_VERSION,
    id,
    epoch: persistedEpoch,
    objective,
    criteria,
    status,
    createdAt,
    updatedAt,
    ...(status === "pursuing" && readText(value.startedPursuingAt)
      ? { startedPursuingAt: readText(value.startedPursuingAt) }
      : {}),
    ...(status === "completed" && readText(value.completedAt)
      ? { completedAt: readText(value.completedAt) }
      : {}),
    ...(status === "blocked" && blockedReason ? { blockedReason } : {}),
    progress,
    openQuestions,
    assumptions,
    decisions,
    state,
    continuationCount: readNonnegativeNumber(value.continuationCount),
    activeMs: readNonnegativeNumber(value.activeMs),
    tokensUsed: readNonnegativeNumber(value.tokensUsed),
  };
  const parsed = GoalDocumentV2Schema.safeParse(candidate);
  return parsed.success ? { kind: "migrated", document: parsed.data } : { kind: "invalid" };
}

function migrateStatus(value: string | null): GoalRecord["status"] {
  if (value === "paused" || value === "blocked") return value;
  if (value === "pursuing") return "paused";
  if (value === "completed") return "completed";
  if (value === "stopped" || value === "surrendered" || value === "superseded") return "stopped";
  return "paused";
}

function readLegacyState(value: Record<string, unknown>): Record<string, GoalJsonValue> {
  const state = isRecord(value.state)
    ? value.state
    : isRecord(value.scratchpad)
      ? value.scratchpad
      : {};
  const parsed = GoalStateBagSchema.safeParse(state);
  return parsed.success ? parsed.data : {};
}

function readLegacyAssumptions(value: Record<string, unknown>): string[] {
  const direct = readTextList(value.assumptions) ?? [];
  const questions = Array.isArray(value.openQuestions)
    ? value.openQuestions.flatMap((entry) => {
        const assumption = isRecord(entry) ? readText(entry.assumption) : null;
        return assumption ? [assumption] : [];
      })
    : [];
  return [...direct, ...questions].slice(-GOAL_PORTABLE_LIMITS.maxContextItems);
}

function readTextList(value: unknown, objectKey?: string): string[] | null {
  if (objectKey && isRecord(value)) {
    return readTextList(value[objectKey]);
  }
  if (!Array.isArray(value)) return null;
  return value
    .flatMap((entry) => {
      if (typeof entry === "string") return [entry.trim()];
      if (objectKey && isRecord(entry)) {
        const text = readText(entry[objectKey]);
        return text ? [text] : [];
      }
      return [];
    })
    .filter(Boolean)
    .slice(-GOAL_PORTABLE_LIMITS.maxContextItems);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function readNonnegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function jsonDepth(value: GoalJsonValue | Record<string, GoalJsonValue>): number {
  if (value === null || typeof value !== "object") return 0;
  const children = Array.isArray(value) ? value : Object.values(value);
  return 1 + children.reduce<number>((max, child) => Math.max(max, jsonDepth(child)), 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
