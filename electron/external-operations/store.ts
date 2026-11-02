import * as fs from "node:fs";
import * as path from "node:path";

import { getAppDataDir } from "../app-paths";
import { loadOrCreateKey, readEncryptedFile, writeEncryptedFile } from "../safe-storage-file";
import type {
  ExternalOperationCancellation,
  ExternalOperationContractEnvelope,
  ExternalOperationDispatchClaim,
  ExternalOperationRecord as CanonicalExternalOperationRecord,
  ExternalOperationExactProcessIdentity,
  ExternalOperationJson,
  ExternalOperationMetadata,
  ExternalOperationNotificationState,
  ExternalOperationProviderIdentity,
  StoredExternalOperationRecord as ExternalOperationRecord,
  ExternalOperationRetention,
  ExternalOperationTerminalEvent,
  ExternalOperationTerminalNotification,
  ExternalOperationWatcher,
  ExternalOperationWatcherLease,
  GoalFence,
  StoredExternalOperationRuntimeIdentity,
} from "./types";
import {
  isExternalOperationFollowThroughComplete,
  isExternalOperationTerminalState,
} from "./types";

const STORE_VERSION = 1;
const STORE_FILE_NAME = "marshal-external-operations.enc";
const ENCRYPTED_FILE_MAGIC = Buffer.from([0x4d, 0x53, 0x45, 0x01]);
export const MAX_EXTERNAL_OPERATION_STORE_BYTES = 4 * 1024 * 1024;
export const MAX_EXTERNAL_OPERATION_RECORDS = 1_000;
export const MAX_EXTERNAL_OPERATION_JSON_DEPTH = 8;
export const MAX_EXTERNAL_OPERATION_STRING_LENGTH = 4_000;
const MAX_EXTERNAL_OPERATION_JSON_ENTRIES = 100;
const SENSITIVE_FIELD_RE =
  /(?:token|secret|password|authorization|cookie|body|content|command|stdout|stderr|log)/i;

const ROOT_FIELDS = ["version", "records"] as const;
const RECORD_FIELDS = [
  "operationId",
  "publicRecord",
  "idempotencyKey",
  "goalFence",
  "metadata",
  "contract",
  "provider",
  "identity",
  "exactProcess",
  "cancellationScope",
  "actionSemantics",
  "detached",
  "state",
  "receipt",
  "watcher",
  "watcherLease",
  "dispatchClaim",
  "retention",
  "terminalNotification",
  "notification",
  "cancellation",
  "terminalEvent",
  "lastHeartbeatAt",
  "lastObservedAt",
  "lastError",
  "adoptedBy",
  "createdAt",
  "updatedAt",
  "revision",
  "journal",
] as const;
const GOAL_FENCE_FIELDS = [
  "goalId",
  "epoch",
  "contractRevision",
  "lifecycleEpoch",
  "specificationRevision",
  "specificationDigest",
] as const;
const METADATA_FIELDS = [
  "sessionId",
  "launcherSessionId",
  "runId",
  "provider",
  "capturedAt",
  "values",
] as const;
const CONTRACT_FIELDS = [
  "request",
  "record",
  "lastUpdate",
  "snapshot",
  "goalOperation",
  "goalRuntime",
] as const;
const PROVIDER_FIELDS = ["kind", "provider", "adapterId"] as const;
const IDENTITY_FIELDS = [
  "toolName",
  "toolCallId",
  "processId",
  "processGroupId",
  "sessionId",
  "subagentSessionId",
  "workflowRunId",
  "providerOperationId",
] as const;
const EXACT_PROCESS_FIELDS = [
  "ownerSessionId",
  "rootPid",
  "spawnedAtMs",
  "startIdentity",
  "processGroupId",
] as const;
const WATCHER_FIELDS = [
  "strategy",
  "intervalMs",
  "leaseDurationMs",
  "lastCheckedAt",
  "nextCheckAt",
] as const;
const WATCHER_LEASE_FIELDS = ["leaseId", "ownerId", "acquiredAt", "expiresAt"] as const;
const RETENTION_FIELDS = ["retentionMs", "retainUntil"] as const;
const TERMINAL_NOTIFICATION_FIELDS = [
  "target",
  "content",
  "kind",
  "deliveryMode",
  "priority",
  "idempotencyKey",
] as const;
const NOTIFICATION_FIELDS = [
  "state",
  "idempotencyKey",
  "messageId",
  "acceptedAt",
  "lastAttemptAt",
  "lastError",
] as const;
const CANCELLATION_FIELDS = [
  "requestId",
  "requestedAt",
  "requestedBy",
  "scope",
  "reason",
  "state",
  "deliveryAttempts",
  "retryAt",
  "accepted",
  "acknowledgedAt",
  "lastError",
] as const;
const DISPATCH_CLAIM_FIELDS = ["claimToken", "claimedBy", "claimedAt", "leaseExpiresAt"] as const;
const CANONICAL_RECORD_FIELDS = [
  "operationId",
  "fence",
  "idempotencyKey",
  "assignmentId",
  "kind",
  "effect",
  "requestedAt",
  "criterionIds",
  "inputFingerprint",
  "status",
  "attempt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "externalReference",
  "durableReceiptId",
  "resultSummary",
  "errorDigest",
  "supersededBy",
] as const;
const TERMINAL_EVENT_FIELDS = [
  "eventId",
  "idempotencyKey",
  "state",
  "occurredAt",
  "result",
  "error",
] as const;
const PROVIDER_KINDS = new Set([
  "host-tool",
  "sdk-turn",
  "child-process",
  "subagent",
  "workflow",
  "provider",
]);
const CANCELLATION_SCOPES = new Set([
  "none",
  "operation",
  "tool",
  "turn",
  "process",
  "process-group",
  "tree",
  "process-tree",
  "subagent",
  "workflow",
  "provider",
]);
const OPERATION_STATES = new Set([
  "registered",
  "running",
  "reconciled",
  "unknown",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "surrendered",
  "superseded",
]);
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "surrendered", "superseded"]);
const WATCHER_STRATEGIES = new Set(["poll", "push", "host"]);
const NOTIFICATION_STATES = new Set(["not-required", "pending", "accepted"]);
const MESSAGE_KINDS = new Set(["subagent", "parent", "review-comment", "goal-terminal"]);
const DELIVERY_MODES = new Set(["queue", "interrupt"]);
export interface ExternalOperationPersistence {
  load(): Promise<string | null>;
  save(content: string): Promise<void>;
}

export class EncryptedExternalOperationPersistence implements ExternalOperationPersistence {
  constructor(private readonly filePath = path.join(getAppDataDir(), STORE_FILE_NAME)) {}

  async load(): Promise<string | null> {
    if (!loadOrCreateKey()) {
      throw new Error("Encrypted external-operation persistence is unavailable");
    }
    try {
      const content = await readEncryptedFile(this.filePath);
      await assertEncryptedStoreFile(this.filePath);
      return content;
    } catch (error) {
      const backupPath = `${this.filePath}.bak`;
      try {
        const recovered = await readEncryptedFile(backupPath);
        await assertEncryptedStoreFile(backupPath);
        await fs.promises.unlink(this.filePath).catch((unlinkError) => {
          if (!isMissingFileError(unlinkError)) throw unlinkError;
        });
        await writeEncryptedFile(this.filePath, recovered);
        await assertEncryptedStoreFile(this.filePath);
        return recovered;
      } catch (backupError) {
        if (isMissingFileError(error) && isMissingFileError(backupError)) return null;
        if (isMissingFileError(backupError)) throw error;
        throw backupError;
      }
    }
  }

  async save(content: string): Promise<void> {
    if (!loadOrCreateKey()) {
      throw new Error("Encrypted external-operation persistence is unavailable");
    }
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await writeEncryptedFile(this.filePath, content);
  }
}

async function assertEncryptedStoreFile(filePath: string): Promise<void> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const prefix = Buffer.alloc(ENCRYPTED_FILE_MAGIC.length);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    if (bytesRead !== prefix.length || !prefix.equals(ENCRYPTED_FILE_MAGIC)) {
      throw new Error("External-operation store is not encrypted");
    }
  } finally {
    await handle.close();
  }
}

export class ExternalOperationStore {
  private lastRecords: ExternalOperationRecord[] = [];
  private initialized = false;

  constructor(private readonly persistence: ExternalOperationPersistence) {}

  async initialize(): Promise<void> {
    await this.load();
  }

  async load(): Promise<ExternalOperationRecord[]> {
    const raw = await this.persistence.load();
    const parsed = raw ? parseStore(raw) : [];
    const compacted = prepareStore(parsed);
    if (raw && raw !== compacted.content) {
      await this.persistence.save(compacted.content);
    }
    this.lastRecords = compacted.records;
    this.initialized = true;
    return structuredClone(this.lastRecords);
  }

  async save(records: readonly ExternalOperationRecord[]): Promise<void> {
    const compacted = prepareStore(records);
    for (const record of compacted.records) {
      assertBoundedValue(record, `external operation ${record.operationId}`, 0);
      assertSensitiveFieldsRedacted(record.metadata, `metadata ${record.operationId}`);
      assertSensitiveFieldsRedacted(record.contract, `contract ${record.operationId}`);
      assertSensitiveFieldsRedacted(record.receipt, `receipt ${record.operationId}`);
      assertSensitiveFieldsRedacted(record.terminalEvent?.result, `result ${record.operationId}`);
      assertSafeText(record.publicRecord.resultSummary, `result summary ${record.operationId}`);
      assertSafeText(record.publicRecord.errorDigest, `public error digest ${record.operationId}`);
      assertSafeText(
        record.publicRecord.externalReference,
        `external reference ${record.operationId}`,
      );
      assertSafeText(record.publicRecord.supersededBy, `supersededBy ${record.operationId}`);
      assertSafeText(record.lastError, `internal error ${record.operationId}`);
      assertSafeText(
        record.terminalNotification?.content,
        `terminal notification ${record.operationId}`,
      );
    }
    await this.persistence.save(compacted.content);
    this.lastRecords = structuredClone(compacted.records);
    this.initialized = true;
  }

  async checkpoint(records: readonly ExternalOperationRecord[] = this.lastRecords): Promise<void> {
    if (!this.initialized) return;
    await this.save(records);
  }

  async close(): Promise<void> {
    await this.checkpoint();
  }
}

function parseStore(raw: string): ExternalOperationRecord[] {
  const value = JSON.parse(raw) as unknown;
  const root = requireRecord(value, "external-operation store");
  assertKnownFields(root, ROOT_FIELDS, "external-operation store");
  if (root.version !== STORE_VERSION) {
    throw new Error(`Unsupported external-operation store version: ${String(root.version)}`);
  }
  if (!Array.isArray(root.records)) {
    throw new Error("External-operation store records must be an array");
  }
  const records = root.records.map((record, index) => parseOperation(record, index));
  const operationIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const record of records) {
    if (operationIds.has(record.operationId)) {
      throw new Error(`Duplicate external-operation id: ${record.operationId}`);
    }
    if (idempotencyKeys.has(record.idempotencyKey)) {
      throw new Error(`Duplicate external-operation idempotency key: ${record.idempotencyKey}`);
    }
    operationIds.add(record.operationId);
    idempotencyKeys.add(record.idempotencyKey);
  }
  return records;
}

function parseOperation(value: unknown, index: number): ExternalOperationRecord {
  const label = `external-operation record ${index}`;
  const record = requireRecord(value, label);
  assertKnownFields(record, RECORD_FIELDS, label);

  const state = requireEnum<ExternalOperationRecord["state"]>(
    record.state,
    OPERATION_STATES,
    `${label}.state`,
  );
  const terminalEvent = optional(record.terminalEvent, (item) => parseTerminalEvent(item, label));
  if (TERMINAL_STATES.has(state) !== Boolean(terminalEvent)) {
    throw new Error(`${label} terminal state and terminalEvent disagree`);
  }
  const terminalNotification = optional(record.terminalNotification, (item) =>
    parseTerminalNotification(item, label),
  );
  const exactProcess = optional(record.exactProcess, (item) => parseExactProcess(item, label));
  const notification = parseNotification(record.notification, label);
  const cancellation = optional(record.cancellation, (item) => parseCancellation(item, label));
  if (record.journal !== undefined && !Array.isArray(record.journal)) {
    throw new Error(`${label}.journal must be an array`);
  }
  const publicRecord = parseCanonicalRecord(record.publicRecord, label);
  const operationId = requireString(record.operationId, `${label}.operationId`);
  const idempotencyKey = requireString(record.idempotencyKey, `${label}.idempotencyKey`);
  const goalFence = parseGoalFence(record.goalFence, label);
  if (
    publicRecord.operationId !== operationId ||
    publicRecord.idempotencyKey !== idempotencyKey ||
    publicRecord.fence.goalId !== goalFence.goalId ||
    publicRecord.fence.epoch !== goalFence.epoch
  ) {
    throw new Error(`${label} public record identity does not match stored identity`);
  }
  const expectedPublicStatus =
    state === "registered"
      ? "planned"
      : state === "running" || state === "cancelling"
        ? "running"
        : state;
  if (publicRecord.status !== expectedPublicStatus) {
    throw new Error(`${label} public record status does not match stored state`);
  }
  if (!terminalEvent && notification.state !== "not-required") {
    throw new Error(`${label} has notification follow-through before terminal state`);
  }
  if (!terminalNotification && notification.state !== "not-required") {
    throw new Error(`${label} has notification state without terminalNotification`);
  }
  if (state === "cancelling" && !cancellation) {
    throw new Error(`${label} is cancelling without cancellation responsibility`);
  }
  return {
    publicRecord,
    operationId,
    idempotencyKey,
    goalFence,
    metadata: parseMetadata(record.metadata, label),
    contract: parseContractEnvelope(record.contract, label),
    provider: parseProvider(record.provider, label),
    identity: parseIdentity(record.identity, label),
    exactProcess,
    cancellationScope: requireEnum(
      record.cancellationScope,
      CANCELLATION_SCOPES,
      `${label}.cancellationScope`,
    ),
    actionSemantics: requireEnum(
      record.actionSemantics,
      new Set(["idempotent", "non-idempotent"]),
      `${label}.actionSemantics`,
    ),
    detached: requireBoolean(record.detached, `${label}.detached`),
    state,
    receipt: optional(record.receipt, (item) => parseJsonObject(item, `${label}.receipt`)),
    watcher: parseWatcher(record.watcher, label),
    watcherLease: optional(record.watcherLease, (item) => parseWatcherLease(item, label)),
    dispatchClaim: optional(record.dispatchClaim, (item) => parseDispatchClaim(item, label)),
    retention: parseRetention(record.retention, label),
    terminalNotification,
    notification,
    cancellation,
    terminalEvent,
    lastHeartbeatAt: optionalString(record.lastHeartbeatAt, `${label}.lastHeartbeatAt`),
    lastObservedAt: optionalString(record.lastObservedAt, `${label}.lastObservedAt`),
    lastError: safeOptionalString(record.lastError, `${label}.lastError`),
    adoptedBy: optionalString(record.adoptedBy, `${label}.adoptedBy`),
    createdAt: requireString(record.createdAt, `${label}.createdAt`),
    updatedAt: requireString(record.updatedAt, `${label}.updatedAt`),
  };
}

function parseGoalFence(value: unknown, parent: string): GoalFence {
  const label = `${parent}.goalFence`;
  const record = requireRecord(value, label);
  assertKnownFields(record, GOAL_FENCE_FIELDS, label);
  const epoch = record.epoch ?? record.lifecycleEpoch;
  return {
    goalId: requireString(record.goalId, `${label}.goalId`),
    epoch: requireNonNegativeInteger(epoch, `${label}.epoch`),
  };
}

function parseCanonicalRecord(value: unknown, parent: string): CanonicalExternalOperationRecord {
  const label = `${parent}.publicRecord`;
  const record = requireRecord(value, label);
  assertKnownFields(record, CANONICAL_RECORD_FIELDS, label);
  return {
    operationId: requireString(record.operationId, `${label}.operationId`),
    fence: parseGoalFence(record.fence, label),
    idempotencyKey: requireString(record.idempotencyKey, `${label}.idempotencyKey`),
    assignmentId: optionalString(record.assignmentId, `${label}.assignmentId`),
    kind: requireString(record.kind, `${label}.kind`),
    effect: requireEnum(
      record.effect,
      new Set(["read", "write", "side-effect"]),
      `${label}.effect`,
    ),
    requestedAt: requireString(record.requestedAt, `${label}.requestedAt`),
    criterionIds: optionalStringArray(record.criterionIds, `${label}.criterionIds`),
    inputFingerprint: optionalString(record.inputFingerprint, `${label}.inputFingerprint`),
    status: requireEnum(
      record.status,
      new Set([
        "planned",
        "running",
        "succeeded",
        "reconciled",
        "failed",
        "cancelled",
        "surrendered",
        "superseded",
        "unknown",
      ]),
      `${label}.status`,
    ),
    attempt: requireNonNegativeInteger(record.attempt, `${label}.attempt`),
    updatedAt: requireString(record.updatedAt, `${label}.updatedAt`),
    startedAt: optionalString(record.startedAt, `${label}.startedAt`),
    completedAt: optionalString(record.completedAt, `${label}.completedAt`),
    externalReference: optionalString(record.externalReference, `${label}.externalReference`),
    durableReceiptId: optionalString(record.durableReceiptId, `${label}.durableReceiptId`),
    resultSummary: safeOptionalString(record.resultSummary, `${label}.resultSummary`),
    errorDigest: optionalString(record.errorDigest, `${label}.errorDigest`),
    supersededBy: optionalString(record.supersededBy, `${label}.supersededBy`),
  };
}

function parseDispatchClaim(value: unknown, parent: string): ExternalOperationDispatchClaim {
  const label = `${parent}.dispatchClaim`;
  const record = requireRecord(value, label);
  assertKnownFields(record, DISPATCH_CLAIM_FIELDS, label);
  return {
    claimToken: requireString(record.claimToken, `${label}.claimToken`),
    claimedBy: requireString(record.claimedBy, `${label}.claimedBy`),
    claimedAt: requireString(record.claimedAt, `${label}.claimedAt`),
    leaseExpiresAt: requireString(record.leaseExpiresAt, `${label}.leaseExpiresAt`),
  };
}

function parseMetadata(value: unknown, parent: string): ExternalOperationMetadata {
  const label = `${parent}.metadata`;
  const record = requireRecord(value, label);
  assertKnownFields(record, METADATA_FIELDS, label);
  return {
    sessionId: optionalString(record.sessionId, `${label}.sessionId`),
    launcherSessionId: optionalString(record.launcherSessionId, `${label}.launcherSessionId`),
    runId: optionalString(record.runId, `${label}.runId`),
    provider: optional(record.provider, (item) => parseJsonObject(item, `${label}.provider`)),
    capturedAt: optionalString(record.capturedAt, `${label}.capturedAt`),
    values: optional(record.values, (item) => parseJsonObject(item, `${label}.values`)),
  };
}

function parseContractEnvelope(value: unknown, parent: string): ExternalOperationContractEnvelope {
  const label = `${parent}.contract`;
  const record = requireRecord(value, label);
  assertKnownFields(record, CONTRACT_FIELDS, label);
  return {
    request: optional(record.request, (item) => parseContractValue(item, `${label}.request`)),
    record: optional(record.record, (item) => parseContractValue(item, `${label}.record`)),
    lastUpdate: optional(record.lastUpdate, (item) =>
      parseContractValue(item, `${label}.lastUpdate`),
    ),
    snapshot: optional(record.snapshot, (item) => parseContractValue(item, `${label}.snapshot`)),
    goalOperation: optional(record.goalOperation, (item) =>
      parseContractValue(item, `${label}.goalOperation`),
    ),
    goalRuntime: optional(record.goalRuntime, (item) =>
      parseContractValue(item, `${label}.goalRuntime`),
    ),
  };
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- callers infer the persisted contract field type from their destination property
function parseContractValue<T>(value: unknown, label: string): T {
  const parsed = parseJsonObject(value, label);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Slice 1 owns the contract shape; persistence only accepts JSON objects
  return parsed as T;
}

function parseProvider(value: unknown, parent: string): ExternalOperationProviderIdentity {
  const label = `${parent}.provider`;
  const record = requireRecord(value, label);
  assertKnownFields(record, PROVIDER_FIELDS, label);
  return {
    kind: requireEnum(record.kind, PROVIDER_KINDS, `${label}.kind`),
    provider: requireString(record.provider, `${label}.provider`),
    adapterId: requireString(record.adapterId, `${label}.adapterId`),
  };
}

function parseIdentity(value: unknown, parent: string): StoredExternalOperationRuntimeIdentity {
  const label = `${parent}.identity`;
  const record = requireRecord(value, label);
  assertKnownFields(record, IDENTITY_FIELDS, label);
  return {
    toolName: optionalString(record.toolName, `${label}.toolName`),
    toolCallId: optionalString(record.toolCallId, `${label}.toolCallId`),
    processId: optionalNumber(record.processId, `${label}.processId`),
    processGroupId: optionalString(record.processGroupId, `${label}.processGroupId`),
    sessionId: optionalString(record.sessionId, `${label}.sessionId`),
    subagentSessionId: optionalString(record.subagentSessionId, `${label}.subagentSessionId`),
    workflowRunId: optionalString(record.workflowRunId, `${label}.workflowRunId`),
    providerOperationId: optionalString(record.providerOperationId, `${label}.providerOperationId`),
  };
}

function parseExactProcess(value: unknown, parent: string): ExternalOperationExactProcessIdentity {
  const label = `${parent}.exactProcess`;
  const record = requireRecord(value, label);
  assertKnownFields(record, EXACT_PROCESS_FIELDS, label);
  return {
    ownerSessionId: requireString(record.ownerSessionId, `${label}.ownerSessionId`),
    rootPid: requirePositiveInteger(record.rootPid, `${label}.rootPid`),
    spawnedAtMs: requireNonNegativeNumber(record.spawnedAtMs, `${label}.spawnedAtMs`),
    startIdentity: optionalString(record.startIdentity, `${label}.startIdentity`),
    processGroupId: optionalString(record.processGroupId, `${label}.processGroupId`),
  };
}

function parseWatcher(value: unknown, parent: string): ExternalOperationWatcher {
  const label = `${parent}.watcher`;
  const record = requireRecord(value, label);
  assertKnownFields(record, WATCHER_FIELDS, label);
  return {
    strategy: requireEnum(record.strategy, WATCHER_STRATEGIES, `${label}.strategy`),
    intervalMs: requireNonNegativeInteger(record.intervalMs, `${label}.intervalMs`),
    leaseDurationMs: requireNonNegativeInteger(record.leaseDurationMs, `${label}.leaseDurationMs`),
    lastCheckedAt: optionalString(record.lastCheckedAt, `${label}.lastCheckedAt`),
    nextCheckAt: optionalString(record.nextCheckAt, `${label}.nextCheckAt`),
  };
}

function parseWatcherLease(value: unknown, parent: string): ExternalOperationWatcherLease {
  const label = `${parent}.watcherLease`;
  const record = requireRecord(value, label);
  assertKnownFields(record, WATCHER_LEASE_FIELDS, label);
  return {
    leaseId: requireString(record.leaseId, `${label}.leaseId`),
    ownerId: requireString(record.ownerId, `${label}.ownerId`),
    acquiredAt: requireString(record.acquiredAt, `${label}.acquiredAt`),
    expiresAt: requireString(record.expiresAt, `${label}.expiresAt`),
  };
}

function parseRetention(value: unknown, parent: string): ExternalOperationRetention {
  const label = `${parent}.retention`;
  const record = requireRecord(value, label);
  assertKnownFields(record, RETENTION_FIELDS, label);
  return {
    retentionMs: optionalNonNegativeInteger(record.retentionMs, `${label}.retentionMs`),
    retainUntil: optionalString(record.retainUntil, `${label}.retainUntil`),
  };
}

function parseTerminalNotification(
  value: unknown,
  parent: string,
): ExternalOperationTerminalNotification {
  const label = `${parent}.terminalNotification`;
  const record = requireRecord(value, label);
  assertKnownFields(record, TERMINAL_NOTIFICATION_FIELDS, label);
  return {
    target: requireString(record.target, `${label}.target`),
    content: requireString(record.content, `${label}.content`),
    kind: optionalEnum(record.kind, MESSAGE_KINDS, `${label}.kind`),
    deliveryMode: optionalEnum(record.deliveryMode, DELIVERY_MODES, `${label}.deliveryMode`),
    priority: optionalNumber(record.priority, `${label}.priority`),
    idempotencyKey: optionalString(record.idempotencyKey, `${label}.idempotencyKey`),
  };
}

function parseNotification(value: unknown, parent: string): ExternalOperationNotificationState {
  const label = `${parent}.notification`;
  const record = requireRecord(value, label);
  assertKnownFields(record, NOTIFICATION_FIELDS, label);
  return {
    state: requireEnum(record.state, NOTIFICATION_STATES, `${label}.state`),
    idempotencyKey: optionalString(record.idempotencyKey, `${label}.idempotencyKey`),
    messageId: optionalString(record.messageId, `${label}.messageId`),
    acceptedAt: optionalString(record.acceptedAt, `${label}.acceptedAt`),
    lastAttemptAt: optionalString(record.lastAttemptAt, `${label}.lastAttemptAt`),
    lastError: safeOptionalString(record.lastError, `${label}.lastError`),
  };
}

function parseCancellation(value: unknown, parent: string): ExternalOperationCancellation {
  const label = `${parent}.cancellation`;
  const record = requireRecord(value, label);
  assertKnownFields(record, CANCELLATION_FIELDS, label);
  return {
    requestId: requireString(record.requestId, `${label}.requestId`),
    requestedAt: requireString(record.requestedAt, `${label}.requestedAt`),
    requestedBy: optionalString(record.requestedBy, `${label}.requestedBy`),
    scope: requireEnum(record.scope, CANCELLATION_SCOPES, `${label}.scope`),
    reason: safeOptionalString(record.reason, `${label}.reason`),
    state: requireEnum(
      record.state,
      new Set(["requested", "accepted", "rejected"]),
      `${label}.state`,
    ),
    deliveryAttempts: requireNonNegativeInteger(
      record.deliveryAttempts,
      `${label}.deliveryAttempts`,
    ),
    retryAt: optionalString(record.retryAt, `${label}.retryAt`),
    accepted: optionalBoolean(record.accepted, `${label}.accepted`),
    acknowledgedAt: optionalString(record.acknowledgedAt, `${label}.acknowledgedAt`),
    lastError: safeOptionalString(record.lastError, `${label}.lastError`),
  };
}

function parseTerminalEvent(value: unknown, parent: string): ExternalOperationTerminalEvent {
  const label = `${parent}.terminalEvent`;
  const record = requireRecord(value, label);
  assertKnownFields(record, TERMINAL_EVENT_FIELDS, label);
  return {
    eventId: requireString(record.eventId, `${label}.eventId`),
    idempotencyKey: requireString(record.idempotencyKey, `${label}.idempotencyKey`),
    state: requireEnum(record.state, TERMINAL_STATES, `${label}.state`),
    occurredAt: requireString(record.occurredAt, `${label}.occurredAt`),
    result: optional(record.result, (item) => parseJson(item, `${label}.result`)),
    error: safeOptionalString(record.error, `${label}.error`),
  };
}

function parseJsonObject(
  value: unknown,
  label: string,
  depth = 0,
): Record<string, ExternalOperationJson> {
  if (depth > MAX_EXTERNAL_OPERATION_JSON_DEPTH) {
    throw new Error(`${label} exceeds maximum JSON depth`);
  }
  const record = requireRecord(value, label);
  if (Object.keys(record).length > MAX_EXTERNAL_OPERATION_JSON_ENTRIES) {
    throw new Error(`${label} has too many fields`);
  }
  const parsed: Record<string, ExternalOperationJson> = {};
  for (const [key, item] of Object.entries(record)) {
    requireString(key, `${label} key`);
    parsed[key] = SENSITIVE_FIELD_RE.test(key)
      ? "[redacted]"
      : parseJson(item, `${label}.${key}`, depth + 1);
  }
  return parsed;
}

function parseJson(value: unknown, label: string, depth = 0): ExternalOperationJson {
  if (depth > MAX_EXTERNAL_OPERATION_JSON_DEPTH) {
    throw new Error(`${label} exceeds maximum JSON depth`);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_EXTERNAL_OPERATION_JSON_ENTRIES) {
      throw new Error(`${label} has too many entries`);
    }
    return value.map((item, index) => parseJson(item, `${label}[${index}]`, depth + 1));
  }
  if (isRecord(value)) return parseJsonObject(value, label, depth + 1);
  throw new Error(`${label} must contain JSON-compatible data`);
}

function assertKnownFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const known = new Set(fields);
  const unknown = Object.keys(record).find((key) => !known.has(key));
  if (unknown) throw new Error(`${label} contains unknown field: ${unknown}`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.length > MAX_EXTERNAL_OPERATION_STRING_LENGTH) {
    throw new Error(`${label} exceeds the maximum string length`);
  }
  return value;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > MAX_EXTERNAL_OPERATION_JSON_ENTRIES) {
    throw new Error(`${label} has too many entries`);
  }
  return value.map((item, index) => requireString(item, `${label}[${index}]`));
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}

function safeOptionalString(value: unknown, label: string): string | undefined {
  const parsed = optionalString(value, label);
  if (parsed === undefined) return undefined;
  return parsed
    .replace(/bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:token|secret|password)=\S+/gi, "[redacted]");
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  return requireBoolean(value, label);
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return requireNonNegativeInteger(value, label);
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the generic preserves each destination contract's string-literal union
function requireEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): T {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`${label} has an unsupported value`);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- set membership validates the generic string union
  return value as T;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the generic preserves each optional destination contract's string-literal union
function optionalEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): T | undefined {
  if (value === undefined) return undefined;
  return requireEnum<T>(value, allowed, label);
}

function optional<T>(value: unknown, parser: (value: unknown) => T): T | undefined {
  return value === undefined ? undefined : parser(value);
}

function assertBoundedValue(value: unknown, label: string, depth: number): void {
  if (depth > MAX_EXTERNAL_OPERATION_JSON_DEPTH) {
    throw new Error(`${label} exceeds maximum JSON depth`);
  }
  if (typeof value === "string") {
    if (value.length > MAX_EXTERNAL_OPERATION_STRING_LENGTH) {
      throw new Error(`${label} exceeds the maximum string length`);
    }
    return;
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_EXTERNAL_OPERATION_JSON_ENTRIES) {
      throw new Error(`${label} has too many entries`);
    }
    value.forEach((item, index) => assertBoundedValue(item, `${label}[${index}]`, depth + 1));
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > MAX_EXTERNAL_OPERATION_JSON_ENTRIES) {
      throw new Error(`${label} has too many fields`);
    }
    for (const [key, item] of entries) {
      assertBoundedValue(key, `${label} key`, depth + 1);
      assertBoundedValue(item, `${label}.${key}`, depth + 1);
    }
    return;
  }
  throw new Error(`${label} contains unsupported persisted data`);
}

function assertSensitiveFieldsRedacted(value: unknown, label: string): void {
  if (value === null || value === undefined || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => assertSensitiveFieldsRedacted(item, label));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_FIELD_RE.test(key) && item !== "[redacted]") {
      throw new Error(`${label} contains an unredacted sensitive field`);
    }
    assertSensitiveFieldsRedacted(item, `${label}.${key}`);
  }
}

function assertSafeText(value: string | undefined, label: string): void {
  if (!value) return;
  if (/bearer\s+\S+/i.test(value) || /(?:token|secret|password)=\S+/i.test(value)) {
    throw new Error(`${label} contains unredacted sensitive text`);
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function prepareStore(records: readonly ExternalOperationRecord[]): {
  records: ExternalOperationRecord[];
  content: string;
} {
  const removable = records
    .filter(
      (record) =>
        isExternalOperationTerminalState(record.state) &&
        isExternalOperationFollowThroughComplete(record),
    )
    .sort((left, right) => {
      const effectPriority =
        Number(left.publicRecord.effect !== "read") - Number(right.publicRecord.effect !== "read");
      return (
        effectPriority ||
        Date.parse(left.terminalEvent?.occurredAt ?? left.updatedAt) -
          Date.parse(right.terminalEvent?.occurredAt ?? right.updatedAt)
      );
    });
  const retained = [...records];
  const protectedCount = records.length - removable.length;
  const removableIds = new Set(removable.map((record) => record.operationId));

  while (
    protectedCount + removableIds.size > MAX_EXTERNAL_OPERATION_RECORDS &&
    removable.length > 0
  ) {
    removableIds.delete(removable.shift()!.operationId);
  }
  let compacted = retained.filter(
    (record) => !isRemovableTerminal(record) || removableIds.has(record.operationId),
  );
  let content = JSON.stringify({ version: STORE_VERSION, records: compacted });
  while (
    Buffer.byteLength(content, "utf8") > MAX_EXTERNAL_OPERATION_STORE_BYTES &&
    removable.length > 0
  ) {
    removableIds.delete(removable.shift()!.operationId);
    compacted = retained.filter(
      (record) => !isRemovableTerminal(record) || removableIds.has(record.operationId),
    );
    content = JSON.stringify({ version: STORE_VERSION, records: compacted });
  }
  if (compacted.length > MAX_EXTERNAL_OPERATION_RECORDS) {
    throw new Error("External-operation current/replay state exceeds the maximum record count");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_EXTERNAL_OPERATION_STORE_BYTES) {
    throw new Error("External-operation current/replay state exceeds the maximum serialized size");
  }
  return { records: structuredClone(compacted), content };
}

function isRemovableTerminal(record: ExternalOperationRecord): boolean {
  return (
    isExternalOperationTerminalState(record.state) &&
    isExternalOperationFollowThroughComplete(record)
  );
}
