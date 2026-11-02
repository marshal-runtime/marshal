import type { GoalDocumentV2 } from "../../common/goal-contract";
import {
  isHiddenInternalControlMessage,
  type SessionMetadata,
} from "../../common/marshal-ipc-contract";
import { GoalDocumentV2Schema, migrateGoalDocumentForPersistence } from "../schemas/goal-schema";
import { redactSecrets } from "../secret-redactor";
import type { PersistedSession, SessionsIndex } from "../session-store";

export interface SanitizedValue<T> {
  value: T;
  redactionCount: number;
}

const STRUCTURAL_GOAL_STRING_FIELDS = new Set([
  "completionRejectionSignature",
  "dependsOn",
  "digest",
  "from",
  "id",
  "idempotencyKey",
  "inputFingerprint",
  "resolvedAgainstRevision",
  "sourceRevision",
  "to",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStructuralGoalStringField(fieldName: string | undefined): boolean {
  return (
    fieldName !== undefined &&
    (STRUCTURAL_GOAL_STRING_FIELDS.has(fieldName) ||
      fieldName.endsWith("Id") ||
      fieldName.endsWith("Ids") ||
      fieldName.endsWith("Digest"))
  );
}

function sanitizePortableGoalValue(
  value: unknown,
  fieldName?: string,
  redactRecordValues = false,
): SanitizedValue<unknown> {
  if (typeof value === "string") {
    if (!redactRecordValues && isStructuralGoalStringField(fieldName)) {
      return { value, redactionCount: 0 };
    }
    const redacted = redactSecrets(value);
    return { value: redacted.result, redactionCount: redacted.count };
  }
  if (Array.isArray(value)) {
    let redactionCount = 0;
    const sanitized = value.map((item) => {
      const result = sanitizePortableGoalValue(item, fieldName, redactRecordValues);
      redactionCount += result.redactionCount;
      return result.value;
    });
    return { value: sanitized, redactionCount };
  }
  if (!isRecord(value)) return { value, redactionCount: 0 };

  let redactionCount = 0;
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const result = sanitizePortableGoalValue(
      item,
      key,
      redactRecordValues || fieldName === "scratchpad",
    );
    sanitized[key] = result.value;
    redactionCount += result.redactionCount;
  }
  return { value: sanitized, redactionCount };
}

function sanitizePortableGoalObject(value: object): number {
  let redactionCount = 0;
  for (const [key, item] of Object.entries(value)) {
    const result = sanitizePortableGoalValue(item, key, key === "scratchpad");
    Reflect.set(value, key, result.value);
    redactionCount += result.redactionCount;
  }
  return redactionCount;
}

export function sanitizePortableGoalTree<T extends object>(value: T): SanitizedValue<T> {
  const cloned = structuredClone(value);
  return {
    value: cloned,
    redactionCount: sanitizePortableGoalObject(cloned),
  };
}

export function prepareGoalForCloudStorage(input: unknown): SanitizedValue<GoalDocumentV2> {
  const migration = migrateGoalDocumentForPersistence(input);
  if (migration.kind === "unsupported-version") {
    throw new Error(`Unsupported goal schema version: ${String(migration.version)}`);
  }
  if (migration.kind === "invalid") {
    throw new Error("Invalid goal document");
  }

  const sanitized = sanitizePortableGoalTree(migration.document);
  const validated = GoalDocumentV2Schema.safeParse(sanitized.value);
  if (!validated.success) {
    throw new Error("Goal redaction produced an invalid portable document");
  }
  return { value: sanitized.value, redactionCount: sanitized.redactionCount };
}

function redactOptional(value: string | undefined): SanitizedValue<string | undefined> {
  if (value === undefined) return { value, redactionCount: 0 };
  const redacted = redactSecrets(value);
  return { value: redacted.result, redactionCount: redacted.count };
}

export function sanitizeSessionMetadataForCloudStorage<T extends SessionMetadata>(
  session: T,
): SanitizedValue<T> {
  let redactionCount = 0;
  const name = redactOptional(session.name);
  const workspaceName = redactOptional(session.workspaceName);
  const repoPath = redactOptional(session.repoPath);
  redactionCount += name.redactionCount + workspaceName.redactionCount + repoPath.redactionCount;

  const repositoryAgent = session.repositoryAgent
    ? {
        name: redactOptional(session.repositoryAgent.name),
        path: redactOptional(session.repositoryAgent.path),
        description: redactOptional(session.repositoryAgent.description),
        identity: session.repositoryAgent.identity,
      }
    : undefined;
  if (repositoryAgent) {
    redactionCount +=
      repositoryAgent.name.redactionCount +
      repositoryAgent.path.redactionCount +
      repositoryAgent.description.redactionCount;
  }

  return {
    value: {
      ...session,
      name: name.value ?? "",
      workspaceName: workspaceName.value,
      repoPath: repoPath.value,
      repositoryAgent: repositoryAgent
        ? {
            name: repositoryAgent.name.value ?? "",
            path: repositoryAgent.path.value ?? "",
            description: repositoryAgent.description.value,
            identity: repositoryAgent.identity,
          }
        : undefined,
    },
    redactionCount,
  };
}

export function sanitizeSessionEnvelopeForCloudStorage(
  session: PersistedSession,
): SanitizedValue<PersistedSession> {
  const metadata = sanitizeSessionMetadataForCloudStorage(session);
  const goal =
    session.goal === undefined
      ? { value: undefined, redactionCount: 0 }
      : prepareGoalForCloudStorage(session.goal);
  return {
    value: {
      ...metadata.value,
      goal: goal.value,
    },
    redactionCount: metadata.redactionCount + goal.redactionCount,
  };
}

type StoredMessage = PersistedSession["messages"][number];

const sanitizedMessageCache = new WeakMap<
  StoredMessage,
  {
    rawContent: string;
    rawReasoning: string | undefined;
    redactControlContent: boolean;
    content: string;
    reasoning: StoredMessage["reasoning"];
  }
>();

function sanitizeNestedStrings<T>(value: T): SanitizedValue<T>;
function sanitizeNestedStrings(value: unknown): SanitizedValue<unknown> {
  if (typeof value === "string") {
    const redacted = redactSecrets(value);
    return { value: redacted.result, redactionCount: redacted.count };
  }
  if (Array.isArray(value)) {
    let redactionCount = 0;
    const sanitized = value.map((item) => {
      const result = sanitizeNestedStrings(item);
      redactionCount += result.redactionCount;
      return result.value;
    });
    return { value: sanitized, redactionCount };
  }
  if (!isRecord(value)) return { value, redactionCount: 0 };

  let redactionCount = 0;
  const sanitized = Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const result = sanitizeNestedStrings(item);
      redactionCount += result.redactionCount;
      return [key, result.value];
    }),
  );
  return { value: sanitized, redactionCount };
}

export function sanitizeSessionForCloudStorage(
  session: PersistedSession,
): SanitizedValue<PersistedSession> {
  const envelope = sanitizeSessionEnvelopeForCloudStorage(session);
  let redactionCount = envelope.redactionCount;

  const messagesWithCheckpoint = session.liveTurnCheckpoint
    ? [...session.messages, session.liveTurnCheckpoint.message]
    : session.messages;
  const sanitizedMessages = messagesWithCheckpoint.map((message) => {
    const cached = sanitizedMessageCache.get(message);
    const redactControlContent =
      isHiddenInternalControlMessage(message) ||
      message.goalContinuation === true ||
      message.suppressedAgentStatusResponse === true;
    let content: string;
    let reasoning: StoredMessage["reasoning"];
    if (
      cached &&
      cached.rawContent === message.content &&
      cached.rawReasoning === message.reasoning?.text &&
      cached.redactControlContent === redactControlContent
    ) {
      content = cached.content;
      reasoning = cached.reasoning;
    } else if (redactControlContent) {
      content = "";
      reasoning = undefined;
      sanitizedMessageCache.set(message, {
        rawContent: message.content,
        rawReasoning: message.reasoning?.text,
        redactControlContent,
        content,
        reasoning,
      });
    } else {
      const sanitizedContent = redactSecrets(message.content);
      content = sanitizedContent.result;
      redactionCount += sanitizedContent.count;
      reasoning = message.reasoning;
      if (message.reasoning !== undefined) {
        const sanitizedReasoning = redactSecrets(message.reasoning.text);
        redactionCount += sanitizedReasoning.count;
        reasoning = { ...message.reasoning, text: sanitizedReasoning.result };
      }
      sanitizedMessageCache.set(message, {
        rawContent: message.content,
        rawReasoning: message.reasoning?.text,
        redactControlContent,
        content,
        reasoning,
      });
    }
    const nested = sanitizeNestedStrings({
      toolCalls: message.toolCalls,
      contentBlocks: redactControlContent ? undefined : message.contentBlocks,
      toolProvenance: message.toolProvenance,
      question: message.question,
      agentMessage: message.agentMessage,
      internalControl: message.internalControl,
      goalTimelineEvent: message.goalTimelineEvent,
    });
    redactionCount += nested.redactionCount;
    return { ...message, content, reasoning, ...nested.value };
  });
  const messages = sanitizedMessages.slice(0, session.messages.length);
  const liveTurnCheckpoint = session.liveTurnCheckpoint
    ? {
        ...session.liveTurnCheckpoint,
        message: sanitizedMessages[session.messages.length],
      }
    : undefined;

  const permissionCards = sanitizeNestedStrings(session.permissionCards);
  redactionCount += permissionCards.redactionCount;
  const contextSummary = redactOptional(session.contextSummary);
  redactionCount += contextSummary.redactionCount;
  const aiGeneratedTitle = redactOptional(session.aiGeneratedTitle);
  redactionCount += aiGeneratedTitle.redactionCount;

  return {
    value: {
      ...envelope.value,
      messages,
      permissionCards: permissionCards.value,
      contextSummary: contextSummary.value,
      aiGeneratedTitle: aiGeneratedTitle.value,
      liveTurnCheckpoint,
    },
    redactionCount,
  };
}

export function sanitizeSessionsIndexForCloudStorage(
  index: SessionsIndex,
): SanitizedValue<SessionsIndex> {
  let redactionCount = 0;
  const sessions = index.sessions.map((session) => {
    const sanitized = sanitizeSessionMetadataForCloudStorage(session);
    redactionCount += sanitized.redactionCount;
    return sanitized.value;
  });
  return {
    value: { ...index, sessions },
    redactionCount,
  };
}
