import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  parseLegacySubagentReadinessDelivery,
  parseLegacySubagentReadinessEnvelope,
} from "../common/agent-readiness";
import { authorityEpoch, type GoalFence } from "../common/goal-contract";
import type {
  AgentMessageState,
  SessionInternalControlMetadata,
  SessionSource,
} from "../common/marshal-ipc-contract";
import { createLogger } from "../common/marshal-logger";
import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayProviderId,
  type RelayAddress,
} from "../common/relay-contract";
import { getAppDataDir } from "./app-paths";
import { RUNTIME_CONTINUATION_PREFIX } from "./runtime-continuations";
import { loadOrCreateKey, readEncryptedFile, writeEncryptedFile } from "./safe-storage-file";
import { normalizeLegacySessionSource } from "./schemas/session-schema";
import { subagentLaunchMessageId } from "./session-launch-override";

const log = createLogger("AgentMessageOutbox");
const OUTBOX_VERSION = 1;
const DEFAULT_MAX_CONCURRENT_TARGETS = 8;
const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_LEASE_DURATION_MS = 10 * 60_000;
const DEFAULT_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_TERMINAL_MESSAGES = 1000;
const OUTBOX_FILE_NAME = "marshal-agent-message-outbox.enc";
const ENCRYPTED_FILE_MAGIC = Buffer.from([0x4d, 0x53, 0x45, 0x01]);
const MAX_GOAL_ID_LENGTH = 256;
const MAX_GOAL_FENCE_REASON_LENGTH = 300;
// Backend acceptance is presumed side-effect-free (the message never reached the backend),
// so a bounded number of retries is safe here; backend delivery is not retried for the same reason.
const ACCEPTANCE_TIMEOUT_RETRY_DELAYS_MS = [10_000, 30_000, 60_000];
const MAX_COALESCED_MESSAGES = 50;
const MAX_COALESCED_CONTENT_CHARS = 200_000;

export type AgentMessageKind =
  | "subagent"
  | "parent"
  | "review-comment"
  | "review-feedback"
  | "selected-session"
  | "goal-terminal"
  | "relay"
  | "app-restart";

export type AgentMessageDeliveryMode = "queue" | "interrupt";

export type GoalMessageDeliveryKind = "child" | "reviewer" | "terminal";

export type GoalMessageTerminalKind = "blocked" | "completed";

export const LEGACY_UNFENCED_GOAL_MESSAGE_POLICY = {
  state: "cancelled",
  reason: "Legacy or incomplete goal message has no trusted goal fence",
} as const;

export interface GoalMessageIdentity {
  goalFence: GoalFence;
  goalId: string;
  goalDeliveryKind: GoalMessageDeliveryKind;
  goalTerminalKind?: GoalMessageTerminalKind;
  goalDeliverySequence: number;
}

export interface AgentMessageRecord {
  messageId: string;
  idempotencyKey: string;
  source: string;
  sourceLabel?: string;
  sourceSessionSource?: SessionSource;
  relayOrigin?: RelayAddress;
  target: string;
  kind: AgentMessageKind;
  deliveryMode: AgentMessageDeliveryMode;
  priority: number;
  sequence: number;
  deadline?: string;
  content: string;
  internalControl?: SessionInternalControlMetadata;
  attempts: number;
  state: AgentMessageState;
  acceptedAt: string;
  updatedAt: string;
  retryAt?: string;
  leaseId?: string;
  leaseExpiresAt?: string;
  backendAcceptedAt?: string;
  backendDeliveredAt?: string;
  goalFence?: GoalFence;
  goalId?: string;
  goalDeliveryKind?: GoalMessageDeliveryKind;
  goalTerminalKind?: GoalMessageTerminalKind;
  goalDeliverySequence?: number;
  processedAt?: string;
  response?: string;
  lastError?: string;
  /** Set on the record that carries a batch: the other queued records delivered in its turn. */
  coalescedMessageIds?: string[];
  /** Set on a record delivered inside another record's turn; its state mirrors that record. */
  coalescedInto?: string;
}

export interface EnqueueAgentMessageInput {
  messageId?: string;
  idempotencyKey?: string;
  source: string;
  sourceLabel?: string;
  sourceSessionSource?: SessionSource;
  relayOrigin?: RelayAddress;
  target: string;
  kind: AgentMessageKind;
  deliveryMode?: AgentMessageDeliveryMode;
  priority?: number;
  deadline?: string;
  content: string;
  internalControl?: SessionInternalControlMetadata;
  goalFence?: GoalFence;
  goalId?: string;
  goalDeliveryKind?: GoalMessageDeliveryKind;
  goalTerminalKind?: GoalMessageTerminalKind;
  goalDeliverySequence?: number;
  /** Atomically cancel this source's messages still queued for the target. */
  replaceQueuedFromSource?: boolean;
}

export interface AgentMessageAcceptance {
  accepted: true;
  messageId: string;
  state: AgentMessageState;
  goalFenceStatus?: "current" | "stale" | "revoked" | "unknown" | "untrusted";
  replacedMessageIds?: string[];
}

export interface QueuedAgentMessageCancellation {
  cancelledMessageIds: string[];
  notCancelledMessageIds: string[];
}

export interface AgentMessageWaitResult {
  message: AgentMessageRecord;
  timedOut: boolean;
}

export interface AgentMessageBackendAcceptance {
  messageId: string;
  backendAcceptedAt: string;
}

export interface AgentMessageBackendDelivery {
  messageId: string;
  backendDeliveredAt: string;
}

export type AgentMessageDeliveryResult =
  | { state: "processed"; response?: string }
  | {
      state: "pending";
      retryAfterMs?: number;
      error?: string;
      attemptConsumed?: boolean;
    }
  | { state: "dead-letter" | "delivery-unknown" | "cancelled"; error?: string };

export interface AgentMessageDeliveryContext {
  markBackendAccepted: () => Promise<void>;
  markBackendDelivered: () => Promise<void>;
}

export type AgentMessageDeliveryControlStage = "backend-acceptance" | "backend-delivery";

export class AgentMessageDeliveryControlError extends Error {
  constructor(
    readonly messageId: string,
    readonly stage: AgentMessageDeliveryControlStage,
    message: string,
  ) {
    super(message);
    this.name = "AgentMessageDeliveryControlError";
  }
}

export function isAgentMessageDeliveryControlError(
  error: unknown,
): error is AgentMessageDeliveryControlError {
  return error instanceof AgentMessageDeliveryControlError;
}

/** Well-known error name/field so callers can distinguish infra timeouts from product-level failures. */
export class AgentMessageInfraTimeoutError extends Error {
  readonly errorClass = "infra" as const;

  constructor(
    readonly messageId: string,
    readonly stage: AgentMessageDeliveryControlStage,
    message: string,
  ) {
    super(message);
    this.name = "AgentMessageInfraTimeoutError";
  }
}

export function isAgentMessageInfraTimeoutError(
  error: unknown,
): error is AgentMessageInfraTimeoutError {
  return error instanceof AgentMessageInfraTimeoutError;
}

export type AgentMessageDeliver = (
  message: Readonly<AgentMessageRecord>,
  context: AgentMessageDeliveryContext,
) => Promise<AgentMessageDeliveryResult>;

export interface AgentMessageOutboxPersistence {
  load(): Promise<string | null>;
  save(content: string): Promise<void>;
}

export type GoalMessageFenceValidation =
  | { status: "current" }
  | { status: "stale"; reason?: string }
  | { status: "revoked"; reason?: string }
  | { status: "unknown"; reason?: string };

export interface GoalMessageFenceValidator {
  validate(
    fence: Readonly<GoalFence>,
  ): GoalMessageFenceValidation | Promise<GoalMessageFenceValidation>;
}

export interface AgentMessageQuery {
  target?: string;
  goalFence?: GoalFence;
  goalDeliveryKind?: GoalMessageDeliveryKind;
  goalTerminalKind?: GoalMessageTerminalKind;
  unfinishedOnly?: boolean;
}

export type CurrentAgentMessageQuery = AgentMessageQuery & { goalFence: GoalFence };

export interface AgentMessageOutboxOptions {
  persistence: AgentMessageOutboxPersistence;
  deliver: AgentMessageDeliver;
  goalFenceValidator?: GoalMessageFenceValidator;
  canDeliver?: (message: Readonly<AgentMessageRecord>) => boolean;
  maxConcurrentTargets?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  leaseDurationMs?: number;
  terminalRetentionMs?: number;
  maxTerminalMessages?: number;
  now?: () => number;
  createId?: () => string;
}

interface PersistedOutbox {
  version: number;
  nextSequence: number;
  messages: AgentMessageRecord[];
}

const OUTBOX_FIELDS = ["version", "nextSequence", "messages"] as const;
const MESSAGE_FIELDS = [
  "messageId",
  "idempotencyKey",
  "source",
  "sourceLabel",
  "sourceSessionSource",
  "relayOrigin",
  "target",
  "kind",
  "resourceOpportunityTicketId",
  "deliveryMode",
  "priority",
  "sequence",
  "deadline",
  "content",
  "internalControl",
  "attempts",
  "state",
  "acceptedAt",
  "updatedAt",
  "retryAt",
  "leaseId",
  "leaseExpiresAt",
  "backendAcceptedAt",
  "backendDeliveredAt",
  "goalFence",
  "goalId",
  "goalDeliveryKind",
  "goalTerminalKind",
  "goalDeliverySequence",
  "processedAt",
  "response",
  "lastError",
  "coalescedMessageIds",
  "coalescedInto",
] as const;
const MESSAGE_KINDS: ReadonlySet<string> = new Set([
  "subagent",
  "parent",
  "review-comment",
  "review-feedback",
  "selected-session",
  "goal-terminal",
  "relay",
  "app-restart",
]);
const MESSAGE_STATES: ReadonlySet<string> = new Set([
  "accepted",
  "pending",
  "leased",
  "backend-accepted",
  "processed",
  "dead-letter",
  "delivery-unknown",
  "cancelled",
]);
const DELIVERY_MODES: ReadonlySet<string> = new Set(["queue", "interrupt"]);
const SESSION_SOURCES: ReadonlySet<string> = new Set([
  "user",
  "automation",
  "subagent",
  "workflow-agent",
  "workflow-run",
  "workspace",
  "heartbeat",
  "feedback",
]);
const GOAL_DELIVERY_KINDS: ReadonlySet<string> = new Set(["child", "reviewer", "terminal"]);
const GOAL_TERMINAL_KINDS: ReadonlySet<string> = new Set(["blocked", "completed"]);
const GOAL_FENCE_FIELDS = ["goalId", "epoch"] as const;
const LEGACY_GOAL_FENCE_FIELDS = [
  "goalId",
  "contractRevision",
  "lifecycleEpoch",
  "specificationRevision",
  "specificationDigest",
] as const;
const TERMINAL_STATES = new Set<AgentMessageState>([
  "processed",
  "dead-letter",
  "delivery-unknown",
  "cancelled",
]);
type GoalMessageFenceCheck = GoalMessageFenceValidation | { status: "untrusted"; reason: string };
interface ActiveTargetDispatch {
  readonly leaseId: string;
  /**
   * Set once the prompt is durably backend-delivered. The target stays leased (per-target
   * exclusion) while its turn runs, but it no longer occupies a global dispatch slot: otherwise
   * a few long child turns hold every slot and all other agent messages wait for them to end.
   */
  deliveryCapacityReleased?: boolean;
  /** Set once the turn crossed the backend barrier, the point an interrupt may cancel it. */
  backendAccepted?: boolean;
}

export class EncryptedAgentMessageOutboxPersistence implements AgentMessageOutboxPersistence {
  private readonly filePath: string;

  constructor(filePath = path.join(getAppDataDir(), OUTBOX_FILE_NAME)) {
    this.filePath = filePath;
  }

  async load(): Promise<string | null> {
    if (!loadOrCreateKey()) {
      throw new Error("Encrypted agent-message persistence is unavailable");
    }
    try {
      const handle = await fs.promises.open(this.filePath, "r");
      try {
        const prefix = Buffer.alloc(ENCRYPTED_FILE_MAGIC.length);
        const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
        if (bytesRead !== prefix.length || !prefix.equals(ENCRYPTED_FILE_MAGIC)) {
          throw new Error("Agent-message outbox is not encrypted");
        }
      } finally {
        await handle.close();
      }
      try {
        return await readEncryptedFile(this.filePath);
      } catch (error) {
        if (!isUnreadableEncryptedOutboxError(error)) throw error;
        const quarantinedPath = `${this.filePath}.unreadable-${Date.now()}`;
        await fs.promises.rename(this.filePath, quarantinedPath);
        const backupPath = `${this.filePath}.bak`;
        await fs.promises
          .rename(backupPath, `${quarantinedPath}.bak`)
          .catch((backupError: unknown) => {
            if (!isMissingFileError(backupError)) throw backupError;
          });
        log.warn("Archived unreadable encrypted outbox and started a fresh queue");
        return null;
      }
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  async save(content: string): Promise<void> {
    if (!loadOrCreateKey()) {
      throw new Error("Encrypted agent-message persistence is unavailable");
    }
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await writeEncryptedFile(this.filePath, content);
  }
}

export function isUnreadableEncryptedOutboxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Unsupported state or unable to authenticate data") ||
    message.includes("Encrypted file appears truncated or corrupt")
  );
}

export class AgentMessageOutbox {
  private readonly persistence: AgentMessageOutboxPersistence;
  private readonly deliver: AgentMessageDeliver;
  private readonly goalFenceValidator: GoalMessageFenceValidator | undefined;
  private readonly canDeliver: (message: Readonly<AgentMessageRecord>) => boolean;
  private readonly maxConcurrentTargets: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly leaseDurationMs: number;
  private readonly terminalRetentionMs: number;
  private readonly maxTerminalMessages: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly messages = new Map<string, AgentMessageRecord>();
  private readonly activeTargets = new Map<string, ActiveTargetDispatch>();
  private readonly deferredGoalMessageIds = new Map<string, Set<string>>();
  private readonly listeners = new Map<string, Set<(message: AgentMessageRecord) => void>>();
  private readonly terminalListeners = new Set<(message: AgentMessageRecord) => void>();
  private nextSequence = 1;
  private started = false;
  private stopped = false;
  private dispatchPaused = false;
  private runtimeResetDepth = 0;
  private dispatchPausedBeforeRuntimeReset = false;
  private mutationTail: Promise<void> = Promise.resolve();
  private dispatchTimer: ReturnType<typeof setTimeout> | undefined;
  private dispatchScheduledAt = 0;
  private readonly goalRevalidationRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly goalRevalidationRetryAttempts = new Map<string, number>();

  constructor(options: AgentMessageOutboxOptions) {
    this.persistence = options.persistence;
    this.deliver = options.deliver;
    this.goalFenceValidator = options.goalFenceValidator;
    this.canDeliver = options.canDeliver ?? (() => true);
    this.maxConcurrentTargets = Math.max(
      1,
      Math.floor(options.maxConcurrentTargets ?? DEFAULT_MAX_CONCURRENT_TARGETS),
    );
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.leaseDurationMs = Math.max(
      1,
      Math.floor(options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS),
    );
    this.terminalRetentionMs = Math.max(
      0,
      options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS,
    );
    this.maxTerminalMessages = Math.max(
      0,
      Math.floor(options.maxTerminalMessages ?? DEFAULT_MAX_TERMINAL_MESSAGES),
    );
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  async start(options?: { pauseDispatch?: boolean }): Promise<void> {
    try {
      await this.runExclusive(async () => {
        if (this.started && !this.stopped) return;
        const raw = await this.persistence.load();
        const persisted = raw ? parsePersistedOutbox(raw) : emptyOutbox();
        this.messages.clear();
        this.activeTargets.clear();
        this.deferredGoalMessageIds.clear();
        for (const message of persisted.messages) this.messages.set(message.messageId, message);
        this.nextSequence = persisted.nextSequence;
        this.stopped = false;
        this.dispatchPaused = options?.pauseDispatch === true;
        this.runtimeResetDepth = 0;
        this.dispatchPausedBeforeRuntimeReset = false;
        this.started = true;

        const cancelledLegacyReadiness = this.cancelLegacyReadinessNoticesLocked();
        const reconciledGoalMessages =
          await this.reconcileGoalMessagesLocked("application restart");
        const recovered = await this.recoverInterruptedLocked("application restart");
        if (
          recovered ||
          cancelledLegacyReadiness ||
          reconciledGoalMessages ||
          this.hasPrunableTerminalMessagesLocked()
        ) {
          await this.persistLocked();
        }
      });
    } catch (error) {
      this.started = false;
      this.stopped = true;
      throw error;
    }
    this.scheduleDispatch();
  }

  stop(): void {
    this.stopped = true;
    if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
    this.dispatchTimer = undefined;
    for (const timer of this.goalRevalidationRetryTimers.values()) clearTimeout(timer);
    this.goalRevalidationRetryTimers.clear();
    this.goalRevalidationRetryAttempts.clear();
  }

  private cancelLegacyReadinessNoticesLocked(): boolean {
    let changed = false;
    const updatedAt = new Date(this.now()).toISOString();
    for (const message of this.messages.values()) {
      if (
        TERMINAL_STATES.has(message.state) ||
        message.kind !== "parent" ||
        !parseLegacySubagentReadinessDelivery({
          content: message.content,
          idempotencyKey: message.idempotencyKey,
          sourceSessionId: message.source,
        })
      ) {
        continue;
      }
      message.state = "cancelled";
      message.updatedAt = updatedAt;
      message.lastError = "Legacy conversational subagent-readiness delivery was disabled";
      delete message.retryAt;
      delete message.leaseId;
      delete message.leaseExpiresAt;
      changed = true;
    }
    return changed;
  }

  async shutdown(): Promise<void> {
    this.stop();
    await this.mutationTail;
  }

  async recoverAfterRuntimeReset(): Promise<void> {
    await this.runExclusive(async () => {
      this.assertStarted();
      const previousMessages = new Map(
        [...this.messages.entries()].map(([messageId, message]) => [
          messageId,
          cloneMessage(message),
        ]),
      );
      const previousActiveTargets = new Map(this.activeTargets);
      const previousDeferredGoalMessages = this.cloneDeferredGoalMessageIds();
      if (this.runtimeResetDepth === 0) {
        this.dispatchPausedBeforeRuntimeReset = this.dispatchPaused;
      }
      this.runtimeResetDepth += 1;
      this.dispatchPaused = true;
      if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
      this.dispatchTimer = undefined;
      this.activeTargets.clear();
      try {
        const reconciledGoalMessages =
          await this.reconcileGoalMessagesLocked("backend runtime reset");
        const recovered = await this.recoverInterruptedLocked("backend runtime reset");
        if (reconciledGoalMessages || recovered) {
          await this.persistLocked();
        }
      } catch (error) {
        this.messages.clear();
        for (const [messageId, message] of previousMessages) {
          this.messages.set(messageId, message);
        }
        this.activeTargets.clear();
        for (const [target, dispatch] of previousActiveTargets) {
          this.activeTargets.set(target, dispatch);
        }
        this.deferredGoalMessageIds.clear();
        for (const [goalId, messageIds] of previousDeferredGoalMessages) {
          this.deferredGoalMessageIds.set(goalId, messageIds);
        }
        this.runtimeResetDepth = Math.max(0, this.runtimeResetDepth - 1);
        if (this.runtimeResetDepth === 0) {
          this.dispatchPaused = this.dispatchPausedBeforeRuntimeReset;
          this.dispatchPausedBeforeRuntimeReset = false;
        }
        this.scheduleDispatch(this.retryDelayMs);
        throw error;
      }
    });
  }

  resumeAfterRuntimeReset(): void {
    if (!this.started || this.stopped) return;
    if (this.runtimeResetDepth > 0) {
      this.runtimeResetDepth -= 1;
      if (this.runtimeResetDepth > 0) return;
      this.dispatchPaused = this.dispatchPausedBeforeRuntimeReset;
      this.dispatchPausedBeforeRuntimeReset = false;
    } else {
      this.dispatchPaused = false;
    }
    if (this.dispatchPaused) return;
    this.scheduleDispatch();
  }

  async revalidateDeferredGoalMessages(goalId: string): Promise<void> {
    let changed: AgentMessageRecord[];
    try {
      changed = await this.runExclusive(async () => {
        if (!this.started || this.stopped) return [] as AgentMessageRecord[];
        const deferredIds = this.deferredGoalMessageIds.get(goalId);
        if (!deferredIds || deferredIds.size === 0) return [] as AgentMessageRecord[];
        const previous = new Map<string, AgentMessageRecord>();
        const previousDeferredGoalMessages = this.cloneDeferredGoalMessageIds();
        const updated: AgentMessageRecord[] = [];
        for (const messageId of [...deferredIds]) {
          const message = this.messages.get(messageId);
          if (!message || message.state !== "pending") {
            this.clearDeferredGoalMessage(messageId, goalId);
            continue;
          }
          // eslint-disable-next-line no-await-in-loop -- durable goal proofs are revalidated serially
          const validation = await this.validateGoalMessageFence(message);
          if (validation.status === "unknown") continue;
          previous.set(message.messageId, cloneMessage(message));
          if (validation.status === "current") {
            this.clearDeferredGoalMessage(message.messageId, goalId);
            delete message.retryAt;
            delete message.lastError;
            message.updatedAt = new Date(this.now()).toISOString();
          } else {
            this.transitionForNonCurrentGoalFence(
              message,
              validation,
              "goal state hydration",
              false,
            );
          }
          updated.push(message);
        }
        if (updated.length === 0) return updated;
        try {
          await this.persistLocked();
        } catch (error) {
          for (const [messageId, prior] of previous) this.messages.set(messageId, prior);
          this.deferredGoalMessageIds.clear();
          for (const [deferredGoalId, messageIds] of previousDeferredGoalMessages) {
            this.deferredGoalMessageIds.set(deferredGoalId, messageIds);
          }
          throw error;
        }
        return updated.map(cloneMessage);
      });
    } catch (error) {
      this.scheduleGoalRevalidationRetry(goalId);
      throw error;
    }
    this.clearGoalRevalidationRetry(goalId);
    if (changed.length === 0) return;
    for (const message of changed) this.notify(message);
    if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
    this.dispatchTimer = undefined;
    this.scheduleDispatch();
  }

  private scheduleGoalRevalidationRetry(goalId: string): void {
    if (!this.started || this.stopped || this.goalRevalidationRetryTimers.has(goalId)) return;
    const attempt = (this.goalRevalidationRetryAttempts.get(goalId) ?? 0) + 1;
    this.goalRevalidationRetryAttempts.set(goalId, attempt);
    const baseDelayMs = Math.max(1, this.retryDelayMs);
    const delayMs = Math.min(30_000, baseDelayMs * 2 ** Math.min(attempt - 1, 8));
    const timer = setTimeout(() => {
      this.goalRevalidationRetryTimers.delete(goalId);
      void this.revalidateDeferredGoalMessages(goalId).catch((error) => {
        log.with({ goalId }).warn("Deferred goal-message revalidation retry failed", error);
      });
    }, delayMs);
    timer.unref?.();
    this.goalRevalidationRetryTimers.set(goalId, timer);
  }

  private clearGoalRevalidationRetry(goalId: string): void {
    const timer = this.goalRevalidationRetryTimers.get(goalId);
    if (timer) clearTimeout(timer);
    this.goalRevalidationRetryTimers.delete(goalId);
    this.goalRevalidationRetryAttempts.delete(goalId);
  }

  async enqueue(input: EnqueueAgentMessageInput): Promise<AgentMessageAcceptance> {
    const acceptance = await this.runExclusive(async () => {
      this.assertStarted();
      const messageId = input.messageId ?? this.createId();
      const goalIdentity = normalizeGoalMessageIdentity(input);
      const goalIdempotencyKey = goalIdentity
        ? buildGoalMessageIdempotencyKey(goalIdentity)
        : undefined;
      if (
        goalIdempotencyKey &&
        input.idempotencyKey !== undefined &&
        input.idempotencyKey !== goalIdempotencyKey
      ) {
        throw new Error("Goal-message idempotency key does not match its fenced identity");
      }
      const idempotencyKey = goalIdempotencyKey ?? input.idempotencyKey ?? messageId;
      const duplicateById = this.messages.get(messageId);
      const duplicateByKey = [...this.messages.values()].find(
        (message) => message.idempotencyKey === idempotencyKey,
      );
      if (duplicateById && duplicateByKey && duplicateById.messageId !== duplicateByKey.messageId) {
        throw new Error("Agent-message ID and idempotency key identify different records");
      }
      const duplicate = duplicateById ?? duplicateByKey;
      if (duplicate) {
        if (goalIdentity && !hasGoalMessageIdentity(duplicate, goalIdentity)) {
          throw new Error("Agent-message identity cannot be reused for a different goal fence");
        }
        const fenceValidation = await this.validateGoalMessageFence(duplicate);
        if (isRejectedGoalFence(fenceValidation) && duplicate.state !== "cancelled") {
          const previous = cloneMessage(duplicate);
          this.transitionForNonCurrentGoalFence(
            duplicate,
            fenceValidation,
            "idempotent retry",
            hasPossibleExternalEffect(duplicate),
          );
          try {
            await this.persistLocked();
          } catch (error) {
            this.messages.set(duplicate.messageId, previous);
            throw error;
          }
          this.notify(duplicate);
        }
        return {
          accepted: true,
          messageId: duplicate.messageId,
          state: duplicate.state,
          ...(isGoalRelatedMessage(duplicate) ? { goalFenceStatus: fenceValidation.status } : {}),
        } satisfies AgentMessageAcceptance;
      }

      const now = new Date(this.now()).toISOString();
      const sequence = this.allocateSequenceLocked();
      const message: AgentMessageRecord = {
        messageId,
        idempotencyKey,
        source: input.source,
        ...(input.sourceLabel ? { sourceLabel: input.sourceLabel } : {}),
        ...(input.sourceSessionSource ? { sourceSessionSource: input.sourceSessionSource } : {}),
        ...(input.relayOrigin ? { relayOrigin: { ...input.relayOrigin } } : {}),
        target: input.target,
        kind: input.kind,
        deliveryMode: input.deliveryMode ?? "queue",
        priority: normalizePriority(input.priority),
        sequence,
        deadline: normalizeDeadline(input.deadline),
        content: input.content,
        ...(input.internalControl ? { internalControl: { ...input.internalControl } } : {}),
        ...(goalIdentity
          ? {
              goalFence: cloneGoalFence(goalIdentity.goalFence),
              goalId: goalIdentity.goalId,
              goalDeliveryKind: goalIdentity.goalDeliveryKind,
              ...(goalIdentity.goalTerminalKind
                ? { goalTerminalKind: goalIdentity.goalTerminalKind }
                : {}),
              goalDeliverySequence: goalIdentity.goalDeliverySequence,
            }
          : {}),
        attempts: 0,
        state: "accepted",
        acceptedAt: now,
        updatedAt: now,
      };
      let fenceValidation = await this.validateGoalMessageFence(message);
      if (isRejectedGoalFence(fenceValidation)) {
        this.cancelForInvalidGoalFence(
          message,
          formatGoalFenceRejection(fenceValidation, "enqueue"),
          now,
        );
      }
      const replacedPrevious = input.replaceQueuedFromSource
        ? this.listCancellableQueuedLocked(input.target, input.source).map(cloneMessage)
        : [];
      for (const previous of replacedPrevious) {
        const replaced = this.messages.get(previous.messageId);
        if (!replaced) continue;
        replaced.state = "cancelled";
        replaced.updatedAt = now;
        replaced.lastError = `Replaced by newer message ${messageId} from the same sender`;
        delete replaced.retryAt;
      }
      this.messages.set(messageId, message);
      try {
        await this.persistLocked();
      } catch (error) {
        this.messages.delete(messageId);
        for (const previous of replacedPrevious) this.messages.set(previous.messageId, previous);
        this.nextSequence = sequence;
        throw error;
      }
      for (const previous of replacedPrevious) {
        const replaced = this.messages.get(previous.messageId);
        if (replaced) this.notify(replaced);
      }
      if (isGoalRelatedMessage(message)) {
        fenceValidation = await this.revalidatePersistedGoalFenceLocked(
          message,
          "durable acceptance",
          false,
        );
      }
      const acceptedMessage = this.messages.get(messageId) ?? message;
      this.notify(acceptedMessage);
      return {
        accepted: true,
        messageId,
        state: acceptedMessage.state,
        ...(isGoalRelatedMessage(acceptedMessage)
          ? { goalFenceStatus: fenceValidation.status }
          : {}),
        ...(replacedPrevious.length > 0
          ? { replacedMessageIds: replacedPrevious.map((previous) => previous.messageId) }
          : {}),
      } satisfies AgentMessageAcceptance;
    });

    void this.promoteAccepted(acceptance.messageId);
    return acceptance;
  }

  getDiagnostic(messageId: string): AgentMessageRecord | undefined {
    const message = this.messages.get(messageId);
    return message ? cloneMessage(message) : undefined;
  }

  get(messageId: string): AgentMessageRecord | undefined {
    return this.getDiagnostic(messageId);
  }

  subscribe(messageId: string, listener: (message: AgentMessageRecord) => void): () => void {
    const listeners = this.listeners.get(messageId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(messageId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(messageId);
    };
  }

  /** Fires for every record reaching a terminal state, including batched records. */
  addTerminalListener(listener: (message: AgentMessageRecord) => void): () => void {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  /**
   * Counts work that will start a new turn on the target. Goal-fenced records are excluded: an
   * unknown fence can wait indefinitely for its owner to hydrate and never reach dispatch.
   */
  countQueuedForTarget(target: string): number {
    let count = 0;
    for (const message of this.messages.values()) {
      if (
        message.target === target &&
        (message.state === "accepted" || message.state === "pending") &&
        !isGoalRelatedMessage(message)
      ) {
        count += 1;
      }
    }
    return count;
  }

  listDiagnostic(query?: AgentMessageQuery): AgentMessageRecord[] {
    return [...this.messages.values()]
      .filter((message) => matchesAgentMessageQuery(message, query))
      .map(cloneMessage)
      .sort(compareMessages);
  }

  list(query?: AgentMessageQuery): AgentMessageRecord[] {
    return this.listDiagnostic(query);
  }

  hasUnfinishedDiagnosticForTarget(
    target: string,
    query?: Omit<AgentMessageQuery, "target">,
  ): boolean {
    for (const message of this.messages.values()) {
      if (
        message.target === target &&
        !TERMINAL_STATES.has(message.state) &&
        matchesAgentMessageQuery(message, query)
      ) {
        return true;
      }
    }
    return false;
  }

  hasUnfinishedForTarget(target: string, query?: Omit<AgentMessageQuery, "target">): boolean {
    return this.hasUnfinishedDiagnosticForTarget(target, query);
  }

  async listCurrent(query: CurrentAgentMessageQuery): Promise<AgentMessageRecord[]> {
    const current: AgentMessageRecord[] = [];
    for (const message of this.listDiagnostic(query)) {
      // eslint-disable-next-line no-await-in-loop -- every candidate needs an authoritative fence check
      if ((await this.validateGoalMessageFence(message)).status === "current") {
        current.push(message);
      }
    }
    return current;
  }

  async getCurrent(
    messageId: string,
    goalFence: GoalFence,
  ): Promise<AgentMessageRecord | undefined> {
    const message = this.getDiagnostic(messageId);
    if (!message?.goalFence || !goalFencesEqual(message.goalFence, goalFence)) return undefined;
    return (await this.validateGoalMessageFence(message)).status === "current"
      ? message
      : undefined;
  }

  async hasCurrentUnfinishedForTarget(
    target: string,
    query: Omit<CurrentAgentMessageQuery, "target">,
  ): Promise<boolean> {
    return (
      (
        await this.listCurrent({
          ...query,
          target,
          unfinishedOnly: true,
        })
      ).length > 0
    );
  }

  async waitForTerminal(messageId: string, timeoutMs: number): Promise<AgentMessageWaitResult> {
    await this.mutationTail;
    const current = this.messages.get(messageId);
    if (!current) throw new Error(`Unknown agent message: ${messageId}`);
    if (TERMINAL_STATES.has(current.state)) {
      if (current.state === "processed") {
        await this.assertCurrentGoalProof(current, "terminal waiter");
      }
      return { message: cloneMessage(current), timedOut: false };
    }

    return new Promise((resolve) => {
      const listener = (message: AgentMessageRecord): void => {
        if (!TERMINAL_STATES.has(message.state)) return;
        cleanup();
        resolve({ message, timedOut: false });
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        const listeners = this.listeners.get(messageId);
        listeners?.delete(listener);
        if (listeners?.size === 0) this.listeners.delete(messageId);
      };
      const timer = setTimeout(
        () => {
          cleanup();
          const latest = this.messages.get(messageId);
          if (!latest) throw new Error(`Unknown agent message: ${messageId}`);
          resolve({ message: cloneMessage(latest), timedOut: true });
        },
        Math.max(0, timeoutMs),
      );
      const listeners = this.listeners.get(messageId) ?? new Set();
      listeners.add(listener);
      this.listeners.set(messageId, listeners);
    });
  }

  async waitForBackendAccepted(
    messageId: string,
    timeoutMs: number,
  ): Promise<AgentMessageBackendAcceptance> {
    await this.mutationTail;
    const current = this.messages.get(messageId);
    if (!current) throw new Error(`Unknown agent message: ${messageId}`);
    if (current.backendAcceptedAt) {
      await this.assertCurrentGoalProof(current, "backend acceptance waiter");
      return { messageId, backendAcceptedAt: current.backendAcceptedAt };
    }
    if (TERMINAL_STATES.has(current.state)) {
      throw backendAcceptanceFailure(current);
    }

    return await new Promise((resolve, reject) => {
      const listener = (message: AgentMessageRecord): void => {
        if (message.backendAcceptedAt) {
          cleanup();
          resolve({ messageId, backendAcceptedAt: message.backendAcceptedAt });
          return;
        }
        if (!TERMINAL_STATES.has(message.state)) return;
        cleanup();
        reject(backendAcceptanceFailure(message));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        const listeners = this.listeners.get(messageId);
        listeners?.delete(listener);
        if (listeners?.size === 0) this.listeners.delete(messageId);
      };
      const timer = setTimeout(
        () => {
          cleanup();
          reject(
            new AgentMessageInfraTimeoutError(
              messageId,
              "backend-acceptance",
              `Timed out waiting for agent message backend acceptance: ${messageId}`,
            ),
          );
        },
        Math.max(0, timeoutMs),
      );
      const listeners = this.listeners.get(messageId) ?? new Set();
      listeners.add(listener);
      this.listeners.set(messageId, listeners);
    });
  }

  /**
   * Retries {@link waitForBackendAccepted} on infra timeouts with backoff before surfacing failure.
   * Acceptance-only: the message has not reached the backend yet, so re-waiting is side-effect-free.
   * Non-timeout failures (e.g. dead-letter) are not retried and reject immediately.
   */
  async waitForBackendAcceptedWithRetry(
    messageId: string,
    timeoutMs: number,
    retryDelaysMs: readonly number[] = ACCEPTANCE_TIMEOUT_RETRY_DELAYS_MS,
  ): Promise<AgentMessageBackendAcceptance> {
    for (let attempt = 0; ; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop -- each retry must observe the previous attempt's outcome before backing off
        return await this.waitForBackendAccepted(messageId, timeoutMs);
      } catch (error) {
        if (!isAgentMessageInfraTimeoutError(error) || attempt >= retryDelaysMs.length) throw error;
        log
          .with({
            messageId,
            attempt: String(attempt + 1),
            retryInMs: String(retryDelaysMs[attempt]),
          })
          .warn("Backend acceptance timed out; retrying before surfacing failure");
        // eslint-disable-next-line no-await-in-loop -- backoff must elapse before the next sequential retry
        await delay(retryDelaysMs[attempt]);
      }
    }
  }

  async waitForBackendDelivered(
    messageId: string,
    timeoutMs: number,
  ): Promise<AgentMessageBackendDelivery> {
    await this.mutationTail;
    const current = this.messages.get(messageId);
    if (!current) throw new Error(`Unknown agent message: ${messageId}`);
    if (current.backendDeliveredAt) {
      await this.assertCurrentGoalProof(current, "backend delivery waiter");
      return { messageId, backendDeliveredAt: current.backendDeliveredAt };
    }
    if (TERMINAL_STATES.has(current.state)) {
      throw backendDeliveryFailure(current);
    }

    return await new Promise((resolve, reject) => {
      const listener = (message: AgentMessageRecord): void => {
        if (message.backendDeliveredAt) {
          cleanup();
          resolve({ messageId, backendDeliveredAt: message.backendDeliveredAt });
          return;
        }
        if (!TERMINAL_STATES.has(message.state)) return;
        cleanup();
        reject(backendDeliveryFailure(message));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        const listeners = this.listeners.get(messageId);
        listeners?.delete(listener);
        if (listeners?.size === 0) this.listeners.delete(messageId);
      };
      const timer = setTimeout(
        () => {
          cleanup();
          reject(
            new AgentMessageInfraTimeoutError(
              messageId,
              "backend-delivery",
              `Timed out waiting for agent message backend delivery: ${messageId}`,
            ),
          );
        },
        Math.max(0, timeoutMs),
      );
      const listeners = this.listeners.get(messageId) ?? new Set();
      listeners.add(listener);
      this.listeners.set(messageId, listeners);
    });
  }

  /** Internal controller fence: leased work is safe to cancel until the durable
   * backend-acceptance callback authorizes native dispatch. */
  async cancelBeforeBackendAcceptance(
    messageId: string,
    source: string,
    target: string,
  ): Promise<void> {
    await this.runExclusive(async () => {
      const message = this.messages.get(messageId);
      if (
        !message ||
        message.source !== source ||
        message.target !== target ||
        message.coalescedInto ||
        (message.state !== "accepted" && message.state !== "pending" && message.state !== "leased")
      )
        return;
      const previous = cloneMessage(message);
      message.state = "cancelled";
      delete message.leaseId;
      delete message.leaseExpiresAt;
      message.updatedAt = new Date(this.now()).toISOString();
      try {
        await this.persistLocked();
      } catch (error) {
        this.messages.set(messageId, previous);
        throw error;
      }
      if (previous.leaseId) this.releaseActiveTarget(target, previous.leaseId);
      this.notify(message);
    });
    this.scheduleDispatch();
  }

  async cancel(messageId: string): Promise<AgentMessageRecord> {
    return this.runExclusive(async () => {
      const message = this.messages.get(messageId);
      if (!message) throw new Error(`Unknown agent message: ${messageId}`);
      if (
        message.state === "leased" ||
        message.state === "backend-accepted" ||
        message.coalescedInto
      ) {
        throw new Error(`Cannot cancel agent message after delivery started: ${messageId}`);
      }
      if (!TERMINAL_STATES.has(message.state)) {
        const previous = cloneMessage(message);
        message.state = "cancelled";
        message.updatedAt = new Date(this.now()).toISOString();
        try {
          await this.persistLocked();
        } catch (error) {
          this.messages.set(messageId, previous);
          throw error;
        }
        this.notify(message);
      }
      return cloneMessage(message);
    });
  }

  /**
   * Cancels a sender's own messages that have not started delivery. Without `messageIds` it
   * cancels everything the sender still has queued for the target.
   */
  async cancelQueuedFromSource(
    target: string,
    source: string,
    messageIds?: readonly string[],
  ): Promise<QueuedAgentMessageCancellation> {
    const result = await this.runExclusive(async () => {
      const cancellable = this.listCancellableQueuedLocked(target, source);
      const requested = messageIds ? new Set(messageIds) : undefined;
      const selected = requested
        ? cancellable.filter((message) => requested.has(message.messageId))
        : cancellable;
      const previous = selected.map(cloneMessage);
      const updatedAt = new Date(this.now()).toISOString();
      for (const message of selected) {
        message.state = "cancelled";
        message.updatedAt = updatedAt;
        message.lastError = "Cancelled by its sender before delivery";
        delete message.retryAt;
      }
      if (selected.length > 0) {
        try {
          await this.persistLocked();
        } catch (error) {
          for (const prior of previous) this.messages.set(prior.messageId, prior);
          throw error;
        }
        for (const message of selected) this.notify(message);
      }
      const cancelledMessageIds = selected.map((message) => message.messageId);
      const cancelled = new Set(cancelledMessageIds);
      return {
        cancelledMessageIds,
        notCancelledMessageIds: (messageIds ?? []).filter((id) => !cancelled.has(id)),
      };
    });
    this.scheduleDispatch();
    return result;
  }

  private listCancellableQueuedLocked(target: string, source: string): AgentMessageRecord[] {
    return [...this.messages.values()]
      .filter(
        (message) =>
          message.target === target &&
          message.source === source &&
          (message.state === "accepted" || message.state === "pending") &&
          !message.coalescedInto &&
          !message.coalescedMessageIds?.length &&
          isCoalescableAgentMessage(message),
      )
      .sort(compareMessages);
  }

  private async promoteAccepted(messageId: string): Promise<void> {
    try {
      const shouldDispatchNow = await this.runExclusive(async () => {
        if (this.stopped) return false;
        const message = this.messages.get(messageId);
        if (!message || message.state !== "accepted") return false;
        const previous = cloneMessage(message);
        message.state = "pending";
        message.updatedAt = new Date(this.now()).toISOString();
        try {
          await this.persistLocked();
        } catch (error) {
          this.messages.set(messageId, previous);
          throw error;
        }
        const validation = await this.revalidatePersistedGoalFenceLocked(
          message,
          "accepted-message promotion",
          false,
        );
        if (validation.status === "unknown") return false;
        this.notify(message);
        return true;
      });
      if (shouldDispatchNow) this.scheduleDispatch();
      else this.scheduleNextRetry();
    } catch (error) {
      log.with({ messageId }).error("Failed to promote accepted agent message", error);
      setTimeout(() => void this.promoteAccepted(messageId), this.retryDelayMs);
    }
  }

  private scheduleDispatch(delayMs = 0): void {
    if (!this.started || this.stopped || this.dispatchPaused) return;
    const scheduledAt = this.now() + Math.max(0, delayMs);
    if (this.dispatchTimer && this.dispatchScheduledAt <= scheduledAt) return;
    // A lease-expiry wake must not hold newly accepted work on another idle target.
    if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
    this.dispatchScheduledAt = scheduledAt;
    this.dispatchTimer = setTimeout(
      () => {
        this.dispatchTimer = undefined;
        void this.dispatchReady().catch((error) => {
          log.error("Agent-message dispatch failed", error);
          this.scheduleDispatch(this.retryDelayMs);
        });
      },
      Math.max(0, delayMs),
    );
  }

  private async dispatchReady(): Promise<void> {
    let terminalizedExpiredMessage = false;
    let blockedTarget = false;
    const leased = await this.runExclusive(async () => {
      if (this.stopped || this.dispatchPaused) return [];
      const now = this.now();
      const changed = new Map<string, AgentMessageRecord>();
      const previousActiveTargets = new Map(this.activeTargets);
      await this.recoverExpiredDispatchesLocked(now, changed);
      let availableTargets = this.maxConcurrentTargets - this.countCapacityHoldingTargets();
      const candidates = availableTargets > 0 ? this.listDispatchCandidates(now) : [];
      let selected: AgentMessageRecord[] = [];
      const selectedTargets = new Set<string>();
      for (const message of candidates) {
        if (selectedTargets.has(message.target)) continue;
        const activeDispatch = this.activeTargets.get(message.target);
        if (activeDispatch && !canPreemptActiveDispatch(message, activeDispatch)) continue;
        if (availableTargets <= 0) break;
        // eslint-disable-next-line no-await-in-loop -- goal fences are validated in queue order
        const fenceValidation = await this.validateGoalMessageFence(message);
        if (isRejectedGoalFence(fenceValidation)) {
          changed.set(message.messageId, cloneMessage(message));
          this.cancelForInvalidGoalFence(
            message,
            formatGoalFenceRejection(fenceValidation, "lease"),
            new Date(now).toISOString(),
          );
          terminalizedExpiredMessage = true;
          continue;
        }
        if (fenceValidation.status === "unknown") {
          changed.set(message.messageId, cloneMessage(message));
          this.transitionForNonCurrentGoalFence(message, fenceValidation, "lease", false);
          continue;
        }
        if (isDeadlineExpired(message, now)) {
          changed.set(message.messageId, cloneMessage(message));
          message.state = "dead-letter";
          message.lastError = "Message deadline expired before delivery began";
          message.updatedAt = new Date(now).toISOString();
          terminalizedExpiredMessage = true;
          continue;
        }
        if (!this.canDeliver(message)) {
          blockedTarget = true;
          continue;
        }
        if (!changed.has(message.messageId)) {
          changed.set(message.messageId, cloneMessage(message));
        }
        message.state = "leased";
        message.attempts += 1;
        message.leaseId = this.createId();
        message.leaseExpiresAt = new Date(now + this.leaseDurationMs).toISOString();
        message.updatedAt = new Date(now).toISOString();
        this.coalesceQueuedIntoLocked(message, changed);
        this.activeTargets.set(message.target, { leaseId: message.leaseId });
        availableTargets -= 1;
        selectedTargets.add(message.target);
        selected.push(cloneMessage(message));
      }
      if (changed.size > 0) {
        try {
          await this.persistLocked();
        } catch (error) {
          for (const [messageId, previous] of changed) {
            this.messages.set(messageId, previous);
          }
          this.activeTargets.clear();
          for (const [target, dispatch] of previousActiveTargets) {
            this.activeTargets.set(target, dispatch);
          }
          throw error;
        }
        const dispatchable: AgentMessageRecord[] = [];
        for (const selectedMessage of selected) {
          const current = this.messages.get(selectedMessage.messageId);
          if (!current || current.leaseId !== selectedMessage.leaseId) continue;
          // eslint-disable-next-line no-await-in-loop -- no delivery starts before each durable lease is revalidated
          const validation = await this.revalidatePersistedGoalFenceLocked(
            current,
            "durable lease",
            false,
          );
          if (validation.status === "current") {
            this.clearDeferredGoalMessage(current.messageId, current.goalId);
            dispatchable.push(this.toDeliverableLocked(current, now));
          } else if (validation.status === "unknown") {
            this.deferGoalMessage(current);
          } else {
            terminalizedExpiredMessage = true;
          }
        }
        selected = dispatchable;
        for (const messageId of changed.keys()) {
          const current = this.messages.get(messageId);
          if (current) this.notify(current);
        }
      }
      return selected;
    });

    for (const message of leased) void this.deliverLeased(message);
    if (terminalizedExpiredMessage) this.scheduleDispatch();
    else if (blockedTarget) this.scheduleDispatch(this.retryDelayMs);
    else this.scheduleNextRetry();
  }

  private async deliverLeased(leased: AgentMessageRecord): Promise<void> {
    let backendAccepted = false;
    let result: AgentMessageDeliveryResult;
    try {
      result = await this.deliver(leased, {
        markBackendAccepted: async () => {
          await this.runExclusive(async () => {
            if (this.stopped) throw new Error("Agent-message outbox stopped before dispatch");
            const current = this.messages.get(leased.messageId);
            if (!current || current.leaseId !== leased.leaseId || current.state !== "leased") {
              throw new Error("Agent-message lease was invalidated before dispatch");
            }
            const beforeAcceptance = await this.revalidatePersistedGoalFenceLocked(
              current,
              "backend acceptance",
              false,
            );
            if (beforeAcceptance.status !== "current") {
              this.notify(current);
              throw new Error(formatGoalFenceRejection(beforeAcceptance, "backend acceptance"));
            }
            const previous = cloneMessage(current);
            current.state = "backend-accepted";
            current.backendAcceptedAt = new Date(this.now()).toISOString();
            current.updatedAt = current.backendAcceptedAt;
            current.leaseExpiresAt = new Date(this.now() + this.leaseDurationMs).toISOString();
            try {
              await this.persistLocked();
            } catch (error) {
              this.messages.set(leased.messageId, previous);
              throw error;
            }
            const afterAcceptance = await this.revalidatePersistedGoalFenceLocked(
              current,
              "durable backend acceptance",
              false,
            );
            this.notify(current);
            if (afterAcceptance.status !== "current") {
              throw new Error(
                formatGoalFenceRejection(afterAcceptance, "durable backend acceptance"),
              );
            }
            const dispatch = this.activeTargets.get(leased.target);
            if (dispatch && dispatch.leaseId === leased.leaseId) dispatch.backendAccepted = true;
          }).catch((error: unknown) => {
            throw toDeliveryControlError(leased.messageId, "backend-acceptance", error);
          });
          backendAccepted = true;
          this.scheduleDispatch();
        },
        markBackendDelivered: async () => {
          await this.runExclusive(async () => {
            if (this.stopped) throw new Error("Agent-message outbox stopped before delivery");
            const current = this.messages.get(leased.messageId);
            if (
              !current ||
              current.leaseId !== leased.leaseId ||
              current.state !== "backend-accepted"
            ) {
              throw new Error("Agent-message lease was invalidated before backend delivery");
            }
            const beforeDelivery = await this.revalidatePersistedGoalFenceLocked(
              current,
              "backend delivery",
              true,
            );
            if (beforeDelivery.status !== "current") {
              this.notify(current);
              throw new Error(formatGoalFenceRejection(beforeDelivery, "backend delivery"));
            }
            if (current.backendDeliveredAt) return;
            const previous = cloneMessage(current);
            current.backendDeliveredAt = new Date(this.now()).toISOString();
            current.updatedAt = current.backendDeliveredAt;
            current.leaseExpiresAt = new Date(this.now() + this.leaseDurationMs).toISOString();
            try {
              await this.persistLocked();
            } catch (error) {
              this.messages.set(leased.messageId, previous);
              throw error;
            }
            const afterDelivery = await this.revalidatePersistedGoalFenceLocked(
              current,
              "durable backend delivery",
              true,
            );
            this.notify(current);
            if (afterDelivery.status !== "current") {
              throw new Error(formatGoalFenceRejection(afterDelivery, "durable backend delivery"));
            }
            const dispatch = this.activeTargets.get(leased.target);
            if (dispatch && dispatch.leaseId === leased.leaseId) {
              dispatch.deliveryCapacityReleased = true;
            }
          }).catch((error: unknown) => {
            throw toDeliveryControlError(leased.messageId, "backend-delivery", error);
          });
          this.scheduleDispatch();
        },
      });
    } catch (error) {
      result = backendAccepted
        ? { state: "delivery-unknown", error: formatError(error) }
        : { state: "pending", error: formatError(error) };
    }

    let resultCommit: "retry" | "persisted" | "lease-lost" = "retry";
    while (!this.stopped && resultCommit === "retry") {
      try {
        // eslint-disable-next-line no-await-in-loop -- each retry must observe the previous durable write result
        resultCommit = await this.runExclusive(async () => {
          if (this.stopped) return "lease-lost";
          const current = this.messages.get(leased.messageId);
          if (!current || current.leaseId !== leased.leaseId) return "lease-lost";
          const previous = cloneMessage(current);
          const now = this.now();
          const updatedAt = new Date(now).toISOString();
          const fenceValidation = await this.validateGoalMessageFence(current);
          const externalMayHaveOccurred =
            backendAccepted ||
            current.state === "backend-accepted" ||
            current.backendDeliveredAt !== undefined ||
            result.state === "processed";
          if (fenceValidation.status !== "current") {
            this.transitionForNonCurrentGoalFence(
              current,
              fenceValidation,
              "delivery result",
              externalMayHaveOccurred,
            );
          } else if (result.state === "pending") {
            if (result.attemptConsumed === false)
              current.attempts = Math.max(0, current.attempts - 1);
            if (backendAccepted || current.state === "backend-accepted") {
              current.state = "delivery-unknown";
              current.lastError =
                result.error ?? "Delivery outcome was ambiguous after backend acceptance";
            } else if (current.attempts >= this.maxAttempts || isDeadlineExpired(current, now)) {
              current.state = "dead-letter";
              current.lastError = result.error ?? "Agent-message delivery attempts exhausted";
            } else {
              current.state = "pending";
              const retryDelay =
                result.retryAfterMs ??
                Math.min(
                  this.retryDelayMs * 2 ** Math.max(0, current.attempts - 1),
                  MAX_RETRY_DELAY_MS,
                );
              current.retryAt = new Date(now + Math.max(0, retryDelay)).toISOString();
              current.lastError = result.error;
            }
          } else {
            current.state = result.state;
            current.lastError = result.state === "processed" ? undefined : result.error;
            if (result.state === "processed") {
              current.processedAt = updatedAt;
              current.response = result.response;
            }
          }
          current.updatedAt = updatedAt;
          delete current.leaseId;
          delete current.leaseExpiresAt;
          try {
            await this.persistLocked();
          } catch (error) {
            this.messages.set(leased.messageId, previous);
            throw error;
          }
          await this.revalidatePersistedGoalFenceLocked(
            current,
            "durable delivery result",
            externalMayHaveOccurred,
          );
          this.notify(current);
          return "persisted";
        });
      } catch (error) {
        log.with({ messageId: leased.messageId }).error("Failed to persist delivery result", error);
        // eslint-disable-next-line no-await-in-loop -- failed durable writes are retried serially without replaying delivery
        await delay(Math.max(1, this.retryDelayMs));
      }
    }

    if (leased.leaseId) this.releaseActiveTarget(leased.target, leased.leaseId);
    if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
    this.dispatchTimer = undefined;
    this.scheduleDispatch();
  }

  private countCapacityHoldingTargets(): number {
    let count = 0;
    for (const dispatch of this.activeTargets.values()) {
      if (!dispatch.deliveryCapacityReleased) count += 1;
    }
    return count;
  }

  private listDispatchCandidates(now: number): AgentMessageRecord[] {
    const heads = new Map<string, AgentMessageRecord>();
    for (const message of [...this.messages.values()].sort(compareMessages)) {
      if (
        TERMINAL_STATES.has(message.state) ||
        // A turn past the backend barrier no longer holds the head: it can only be interrupted,
        // and the active-target check keeps everything else behind it.
        message.state === "backend-accepted" ||
        message.coalescedInto ||
        heads.has(message.target)
      ) {
        continue;
      }
      heads.set(message.target, message);
    }
    return [...heads.values()].filter((message) => {
      if (message.state !== "pending") return false;
      if (this.isDeferredGoalMessage(message.messageId, message.goalId)) return false;
      if (isDeadlineExpired(message, now)) return true;
      if (!message.retryAt) return true;
      return Date.parse(message.retryAt) <= now;
    });
  }

  private scheduleNextRetry(): void {
    if (this.dispatchTimer || this.stopped || this.dispatchPaused) return;
    const now = this.now();
    let delayMs: number | undefined;
    for (const message of this.messages.values()) {
      if (this.isDeferredGoalMessage(message.messageId, message.goalId)) continue;
      const wakeAt =
        message.state === "pending"
          ? message.retryAt
          : message.state === "leased" || message.state === "backend-accepted"
            ? message.leaseExpiresAt
            : undefined;
      if (!wakeAt) continue;
      const candidate = Math.max(0, Date.parse(wakeAt) - now);
      delayMs = delayMs === undefined ? candidate : Math.min(delayMs, candidate);
    }
    if (delayMs !== undefined) this.scheduleDispatch(delayMs);
  }

  private async recoverExpiredDispatchesLocked(
    now: number,
    changed: Map<string, AgentMessageRecord>,
  ): Promise<void> {
    const updatedAt = new Date(now).toISOString();
    for (const message of this.messages.values()) {
      if (
        (message.state !== "leased" && message.state !== "backend-accepted") ||
        message.coalescedInto ||
        !message.leaseExpiresAt ||
        Date.parse(message.leaseExpiresAt) > now
      ) {
        continue;
      }
      changed.set(message.messageId, cloneMessage(message));
      for (const member of this.listCoalescedMembers(message)) {
        changed.set(member.messageId, cloneMessage(member));
      }
      const leaseId = message.leaseId;
      // eslint-disable-next-line no-await-in-loop -- recovery preserves durable message order
      const fenceValidation = await this.validateGoalMessageFence(message);
      if (fenceValidation.status !== "current") {
        this.transitionForNonCurrentGoalFence(
          message,
          fenceValidation,
          "expired lease recovery",
          hasPossibleExternalEffect(message),
        );
      } else if (message.state === "leased") {
        message.state = "pending";
        message.attempts = Math.max(0, message.attempts - 1);
        message.lastError = "Pre-dispatch lease expired before backend acceptance";
      } else {
        message.state = "delivery-unknown";
        message.lastError = "Delivery outcome remained unknown after the backend lease expired";
      }
      message.updatedAt = updatedAt;
      if (leaseId) this.releaseActiveTarget(message.target, leaseId);
      delete message.leaseId;
      delete message.leaseExpiresAt;
    }
  }

  private async reconcileGoalMessagesLocked(reason: string): Promise<boolean> {
    let changed = false;
    const updatedAt = new Date(this.now()).toISOString();
    for (const message of this.messages.values()) {
      // eslint-disable-next-line no-await-in-loop -- reconciliation preserves durable message order
      const validation = await this.validateGoalMessageFence(message);
      if (validation.status === "current") {
        this.clearDeferredGoalMessage(message.messageId, message.goalId);
        continue;
      }
      if (validation.status === "unknown" && TERMINAL_STATES.has(message.state)) continue;
      this.transitionForNonCurrentGoalFence(
        message,
        validation,
        reason,
        hasPossibleExternalEffect(message),
      );
      message.updatedAt = updatedAt;
      changed = true;
    }
    return changed;
  }

  private async revalidatePersistedGoalFenceLocked(
    message: AgentMessageRecord,
    stage: string,
    externalMayHaveOccurred: boolean,
  ): Promise<GoalMessageFenceCheck> {
    const validation = await this.validateGoalMessageFence(message);
    if (validation.status === "current") {
      this.clearDeferredGoalMessage(message.messageId, message.goalId);
      return validation;
    }
    this.transitionForNonCurrentGoalFence(message, validation, stage, externalMayHaveOccurred);
    await this.persistGoalFenceTransitionLocked(message.messageId);
    return validation;
  }

  private transitionForNonCurrentGoalFence(
    message: AgentMessageRecord,
    validation: Exclude<GoalMessageFenceCheck, { status: "current" }>,
    stage: string,
    externalMayHaveOccurred: boolean,
  ): void {
    const leaseId = message.leaseId;
    const updatedAt = new Date(this.now()).toISOString();
    if (externalMayHaveOccurred) {
      this.markDeliveryUnknownForGoalFence(message, validation, stage, updatedAt);
    } else if (isRejectedGoalFence(validation)) {
      this.cancelForInvalidGoalFence(
        message,
        formatGoalFenceRejection(validation, stage),
        updatedAt,
      );
    } else {
      message.state = "pending";
      message.attempts = Math.max(0, message.attempts - 1);
      delete message.retryAt;
      message.lastError = boundedGoalFenceReason(
        validation.reason ?? `Goal fence validation was unavailable during ${stage}`,
      );
      message.updatedAt = updatedAt;
      delete message.leaseId;
      delete message.leaseExpiresAt;
      delete message.backendAcceptedAt;
      delete message.backendDeliveredAt;
      delete message.processedAt;
      delete message.response;
      this.deferGoalMessage(message);
    }
    if (leaseId) this.releaseActiveTarget(message.target, leaseId);
  }

  private markDeliveryUnknownForGoalFence(
    message: AgentMessageRecord,
    validation: Exclude<GoalMessageFenceCheck, { status: "current" }>,
    stage: string,
    updatedAt: string,
  ): void {
    this.clearDeferredGoalMessage(message.messageId, message.goalId);
    message.state = "delivery-unknown";
    message.lastError =
      validation.status === "unknown"
        ? boundedGoalFenceReason(
            validation.reason ?? `Goal fence validation was unavailable during ${stage}`,
          )
        : formatGoalFenceRejection(validation, stage);
    message.updatedAt = updatedAt;
    delete message.retryAt;
    delete message.leaseId;
    delete message.leaseExpiresAt;
    delete message.backendAcceptedAt;
    delete message.backendDeliveredAt;
    delete message.processedAt;
    delete message.response;
  }

  private async persistGoalFenceTransitionLocked(messageId: string): Promise<void> {
    while (!this.stopped) {
      try {
        // eslint-disable-next-line no-await-in-loop -- stale proof must be durable before exposure
        await this.persistLocked();
        return;
      } catch (error) {
        log
          .with({ messageId, errorType: formatErrorType(error) })
          .error("Failed to persist goal-fence transition");
        // eslint-disable-next-line no-await-in-loop -- retry without exposing the stale durable state
        await delay(Math.max(1, this.retryDelayMs));
      }
    }
    throw new Error("Agent-message outbox stopped before persisting goal-fence transition");
  }

  private async assertCurrentGoalProof(
    message: Readonly<AgentMessageRecord>,
    stage: string,
  ): Promise<void> {
    const validation = await this.validateGoalMessageFence(message);
    if (validation.status === "current") return;
    throw new Error(
      `Agent message ${message.messageId} is not current goal proof during ${stage}: ${validation.status}`,
    );
  }

  private async validateGoalMessageFence(
    message: Readonly<AgentMessageRecord>,
  ): Promise<GoalMessageFenceCheck> {
    if (!isGoalRelatedMessage(message)) return { status: "current" };
    if (!hasCompleteGoalMessageIdentity(message)) {
      return {
        status: "untrusted",
        reason: LEGACY_UNFENCED_GOAL_MESSAGE_POLICY.reason,
      };
    }
    if (!this.goalFenceValidator) {
      return { status: "unknown", reason: "Goal fence validator is unavailable" };
    }
    try {
      const validation = await this.goalFenceValidator.validate(cloneGoalFence(message.goalFence));
      if (
        validation.status !== "current" &&
        validation.status !== "stale" &&
        validation.status !== "revoked" &&
        validation.status !== "unknown"
      ) {
        return {
          status: "unknown",
          reason: "Goal fence validator returned an invalid status",
        };
      }
      if (validation.status === "current") return { status: "current" };
      const reason = "reason" in validation ? boundedValidatorReason(validation.reason) : undefined;
      return reason ? { status: validation.status, reason } : { status: validation.status };
    } catch (error) {
      log
        .with({
          goalId: message.goalId,
          messageId: message.messageId,
          errorType: formatErrorType(error),
        })
        .warn("Goal fence validation was unavailable");
      return { status: "unknown", reason: "Goal fence validation was unavailable" };
    }
  }

  private cancelForInvalidGoalFence(
    message: AgentMessageRecord,
    reason: string,
    updatedAt: string,
  ): void {
    this.clearDeferredGoalMessage(message.messageId, message.goalId);
    message.state = "cancelled";
    message.lastError = boundedGoalFenceReason(reason);
    message.updatedAt = updatedAt;
    delete message.retryAt;
    delete message.leaseId;
    delete message.leaseExpiresAt;
    delete message.backendAcceptedAt;
    delete message.backendDeliveredAt;
    delete message.processedAt;
    delete message.response;
  }

  private deferGoalMessage(message: Readonly<AgentMessageRecord>): void {
    if (!message.goalId) return;
    const messageIds = this.deferredGoalMessageIds.get(message.goalId) ?? new Set<string>();
    messageIds.add(message.messageId);
    this.deferredGoalMessageIds.set(message.goalId, messageIds);
  }

  private clearDeferredGoalMessage(messageId: string, goalId: string | undefined): void {
    if (!goalId) return;
    const messageIds = this.deferredGoalMessageIds.get(goalId);
    if (!messageIds) return;
    messageIds.delete(messageId);
    if (messageIds.size === 0) this.deferredGoalMessageIds.delete(goalId);
  }

  private isDeferredGoalMessage(messageId: string, goalId: string | undefined): boolean {
    return !!goalId && (this.deferredGoalMessageIds.get(goalId)?.has(messageId) ?? false);
  }

  private cloneDeferredGoalMessageIds(): Map<string, Set<string>> {
    return new Map(
      [...this.deferredGoalMessageIds].map(([goalId, messageIds]) => [goalId, new Set(messageIds)]),
    );
  }

  private releaseActiveTarget(target: string, leaseId: string): void {
    if (this.activeTargets.get(target)?.leaseId === leaseId) {
      this.activeTargets.delete(target);
    }
  }

  /** Adds the queued records behind a freshly leased head to its turn, in queue order. */
  private coalesceQueuedIntoLocked(
    head: AgentMessageRecord,
    changed: Map<string, AgentMessageRecord>,
  ): void {
    if (head.coalescedMessageIds?.length || !isCoalescableAgentMessage(head)) return;
    const members: AgentMessageRecord[] = [];
    let contentChars = head.content.length;
    const queued = [...this.messages.values()]
      .filter(
        (message) =>
          message.target === head.target &&
          message.messageId !== head.messageId &&
          !TERMINAL_STATES.has(message.state) &&
          message.state !== "backend-accepted",
      )
      .sort(compareMessages);
    for (const message of queued) {
      contentChars += message.content.length;
      if (
        message.state !== "pending" ||
        message.deadline !== undefined ||
        !isCoalescableAgentMessage(message) ||
        members.length + 1 >= MAX_COALESCED_MESSAGES ||
        contentChars > MAX_COALESCED_CONTENT_CHARS
      ) {
        break;
      }
      members.push(message);
    }
    if (members.length === 0) return;
    for (const member of members) {
      changed.set(member.messageId, cloneMessage(member));
      member.coalescedInto = head.messageId;
    }
    head.coalescedMessageIds = members.map((member) => member.messageId);
  }

  private listCoalescedMembers(head: Readonly<AgentMessageRecord>): AgentMessageRecord[] {
    const members: AgentMessageRecord[] = [];
    for (const messageId of head.coalescedMessageIds ?? []) {
      const member = this.messages.get(messageId);
      if (member) members.push(member);
    }
    return members;
  }

  private toDeliverableLocked(head: AgentMessageRecord, now: number): AgentMessageRecord {
    const deliverable = cloneMessage(head);
    const members = this.listCoalescedMembers(head);
    if (members.length === 0) return deliverable;
    const batch = [head, ...members].sort((left, right) => left.sequence - right.sequence);
    deliverable.content = renderCoalescedAgentMessages(batch, now);
    deliverable.acceptedAt = batch.reduce(
      (oldest, message) => (message.acceptedAt < oldest ? message.acceptedAt : oldest),
      head.acceptedAt,
    );
    return deliverable;
  }

  /** A batch has one delivery outcome, so every durable write copies it onto the members. */
  private syncCoalescedMembersLocked(): void {
    for (const head of this.messages.values()) {
      for (const member of this.listCoalescedMembers(head)) {
        member.state = head.state;
        member.updatedAt = head.updatedAt;
        assignMirroredField(member, "retryAt", head.retryAt);
        assignMirroredField(member, "backendAcceptedAt", head.backendAcceptedAt);
        assignMirroredField(member, "backendDeliveredAt", head.backendDeliveredAt);
        assignMirroredField(member, "processedAt", head.processedAt);
        assignMirroredField(member, "response", head.response);
        assignMirroredField(member, "lastError", head.lastError);
      }
    }
  }

  private async persistLocked(): Promise<void> {
    this.syncCoalescedMembersLocked();
    const pruned = this.pruneTerminalMessagesLocked();
    const persisted: PersistedOutbox = {
      version: OUTBOX_VERSION,
      nextSequence: this.nextSequence,
      messages: [...this.messages.values()].sort((left, right) => left.sequence - right.sequence),
    };
    try {
      await this.persistence.save(JSON.stringify(persisted));
    } catch (error) {
      for (const message of pruned) this.messages.set(message.messageId, message);
      throw error;
    }
  }

  private allocateSequenceLocked(): number {
    if (!isSafePositiveInteger(this.nextSequence)) {
      throw new Error("Agent-message sequence space is exhausted");
    }
    const sequence = this.nextSequence;
    if ([...this.messages.values()].some((message) => message.sequence === sequence)) {
      throw new Error("Agent-message sequence space is exhausted");
    }
    if (sequence < Number.MAX_SAFE_INTEGER) {
      this.nextSequence = sequence + 1;
    }
    return sequence;
  }

  private hasPrunableTerminalMessagesLocked(): boolean {
    const terminal = [...this.messages.values()]
      .filter((message) => TERMINAL_STATES.has(message.state))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    const cutoff = this.now() - this.terminalRetentionMs;
    return terminal.some(
      (message, index) =>
        index >= this.maxTerminalMessages || Date.parse(message.updatedAt) < cutoff,
    );
  }

  private pruneTerminalMessagesLocked(): AgentMessageRecord[] {
    const terminal = [...this.messages.values()]
      .filter((message) => TERMINAL_STATES.has(message.state))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    const cutoff = this.now() - this.terminalRetentionMs;
    const pruned: AgentMessageRecord[] = [];
    for (let index = 0; index < terminal.length; index++) {
      const message = terminal[index];
      if (index >= this.maxTerminalMessages || Date.parse(message.updatedAt) < cutoff) {
        this.messages.delete(message.messageId);
        pruned.push(message);
      }
    }
    return pruned;
  }

  private async recoverInterruptedLocked(reason: string): Promise<boolean> {
    let recovered = false;
    const updatedAt = new Date(this.now()).toISOString();
    for (const message of this.messages.values()) {
      if (
        reason === "application restart" &&
        message.messageId.startsWith(RUNTIME_CONTINUATION_PREFIX) &&
        (message.state === "accepted" ||
          message.state === "pending" ||
          message.state === "leased") &&
        !message.backendAcceptedAt &&
        !message.backendDeliveredAt
      ) {
        message.state = "cancelled";
        message.updatedAt = updatedAt;
        message.lastError =
          "Unaccepted controller continuation requires fresh controller evaluation after restart.";
        delete message.leaseId;
        delete message.leaseExpiresAt;
        recovered = true;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- shutdown fencing preserves durable message order
      const fenceValidation = await this.validateGoalMessageFence(message);
      if (isRejectedGoalFence(fenceValidation)) {
        this.transitionForNonCurrentGoalFence(
          message,
          fenceValidation,
          reason,
          hasPossibleExternalEffect(message),
        );
        message.updatedAt = updatedAt;
        recovered = true;
      } else if (message.state === "accepted") {
        message.state = "pending";
        message.updatedAt = updatedAt;
        recovered = true;
      } else if (message.state === "leased") {
        message.state = "pending";
        message.attempts = Math.max(0, message.attempts - 1);
        message.updatedAt = updatedAt;
        message.lastError = `Pre-dispatch lease recovered after ${reason}`;
        delete message.leaseId;
        delete message.leaseExpiresAt;
        recovered = true;
      } else if (message.state === "backend-accepted") {
        message.state = "delivery-unknown";
        message.updatedAt = updatedAt;
        message.lastError = `Delivery was interrupted by ${reason}`;
        delete message.leaseId;
        delete message.leaseExpiresAt;
        recovered = true;
      }
    }
    return recovered;
  }

  private notify(message: AgentMessageRecord): void {
    for (const listener of this.listeners.get(message.messageId) ?? []) {
      listener(cloneMessage(message));
    }
    for (const member of this.listCoalescedMembers(message)) this.notify(member);
    if (!TERMINAL_STATES.has(message.state)) return;
    for (const listener of this.terminalListeners) listener(cloneMessage(message));
  }

  private assertStarted(): void {
    if (!this.started || this.stopped) {
      throw new Error("Agent-message outbox has not been started");
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function isLegacyAutomaticIdleNotice(content: string): boolean {
  return parseLegacySubagentReadinessEnvelope(content) !== null;
}

function emptyOutbox(): PersistedOutbox {
  return { version: OUTBOX_VERSION, nextSequence: 1, messages: [] };
}

function parsePersistedOutbox(raw: string): PersistedOutbox {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("Invalid agent-message outbox payload");
  rejectUnknownFields(parsed, OUTBOX_FIELDS, "agent-message outbox");
  if (parsed.version !== OUTBOX_VERSION) {
    throw new Error(`Unsupported agent-message outbox version: ${String(parsed.version)}`);
  }
  if (!isSafeNonNegativeInteger(parsed.nextSequence) || !Array.isArray(parsed.messages)) {
    throw new Error("Invalid agent-message outbox header");
  }
  const messages = parsed.messages
    .filter((value) => !(isRecord(value) && value.kind === "resource-notice"))
    .map(parseMessage);
  assertUniqueMessages(messages);
  const highestSequence = messages.reduce(
    (highest, message) => Math.max(highest, message.sequence),
    0,
  );
  const recoveredNextSequence =
    highestSequence === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : highestSequence + 1;
  return {
    version: OUTBOX_VERSION,
    nextSequence: Math.max(parsed.nextSequence, recoveredNextSequence, 1),
    messages,
  };
}

function parseMessage(value: unknown): AgentMessageRecord {
  if (!isRecord(value)) throw new Error("Invalid persisted agent message");
  rejectUnknownFields(value, MESSAGE_FIELDS, "persisted agent message");
  if (
    !isString(value.messageId) ||
    !isString(value.idempotencyKey) ||
    !isString(value.source) ||
    !isString(value.target) ||
    !isAgentMessageKind(value.kind) ||
    !isAgentMessageDeliveryMode(value.deliveryMode) ||
    typeof value.priority !== "number" ||
    !Number.isFinite(value.priority) ||
    !isSafePositiveInteger(value.sequence) ||
    !isString(value.content) ||
    !isNonNegativeInteger(value.attempts) ||
    !isAgentMessageState(value.state) ||
    !isString(value.acceptedAt) ||
    !isString(value.updatedAt)
  ) {
    throw new Error("Invalid persisted agent-message fields");
  }
  const message: AgentMessageRecord = {
    messageId: value.messageId,
    idempotencyKey: value.idempotencyKey,
    source: value.source,
    target: value.target,
    kind: value.kind,
    deliveryMode: value.deliveryMode,
    priority: value.priority,
    sequence: value.sequence,
    content: value.content,
    attempts: value.attempts,
    state: value.state,
    acceptedAt: value.acceptedAt,
    updatedAt: value.updatedAt,
  };
  copyOptionalStringFields(value, message, [
    "sourceLabel",
    "deadline",
    "retryAt",
    "leaseId",
    "leaseExpiresAt",
    "backendAcceptedAt",
    "backendDeliveredAt",
    "processedAt",
    "response",
    "lastError",
  ]);
  if (value.sourceSessionSource !== undefined) {
    const sourceSessionSource = normalizeLegacySessionSource(value.sourceSessionSource);
    if (!isSessionSource(sourceSessionSource)) {
      throw new Error("Invalid persisted agent-message source session type");
    }
    message.sourceSessionSource = sourceSessionSource;
  }
  if (value.relayOrigin !== undefined) {
    message.relayOrigin = parseRelayOrigin(value.relayOrigin);
  }
  if (value.internalControl !== undefined) {
    message.internalControl = parseInternalControl(value.internalControl);
  }
  parsePersistedGoalMessageIdentity(value, message);
  copyOptionalStringFields(value, message, ["coalescedInto"]);
  if (value.coalescedMessageIds !== undefined) {
    if (
      !Array.isArray(value.coalescedMessageIds) ||
      !value.coalescedMessageIds.every((messageId) => isString(messageId))
    ) {
      throw new Error("Invalid persisted coalesced agent-message IDs");
    }
    message.coalescedMessageIds = [...value.coalescedMessageIds];
  }
  assertValidTimestamp(message.acceptedAt, "acceptedAt");
  assertValidTimestamp(message.updatedAt, "updatedAt");
  for (const field of [
    "deadline",
    "retryAt",
    "leaseExpiresAt",
    "backendAcceptedAt",
    "backendDeliveredAt",
    "processedAt",
  ] as const) {
    const timestamp = message[field];
    if (timestamp !== undefined) assertValidTimestamp(timestamp, field);
  }
  return message;
}

function assertUniqueMessages(messages: AgentMessageRecord[]): void {
  const messageIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  const sequences = new Set<number>();
  for (const message of messages) {
    if (messageIds.has(message.messageId)) {
      throw new Error(`Duplicate agent-message ID: ${message.messageId}`);
    }
    if (idempotencyKeys.has(message.idempotencyKey)) {
      throw new Error(`Duplicate agent-message idempotency key: ${message.idempotencyKey}`);
    }
    if (sequences.has(message.sequence)) {
      throw new Error(`Duplicate agent-message sequence: ${message.sequence}`);
    }
    messageIds.add(message.messageId);
    idempotencyKeys.add(message.idempotencyKey);
    sequences.add(message.sequence);
  }
}

function assertValidTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid persisted agent-message timestamp: ${field}`);
  }
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  knownFields: readonly string[],
  label: string,
): void {
  const known = new Set(knownFields);
  const unknown = Object.keys(value).filter((field) => !known.has(field));
  if (unknown.length > 0) throw new Error(`Unknown ${label} fields: ${unknown.join(", ")}`);
}

function copyOptionalStringFields(
  source: Record<string, unknown>,
  target: AgentMessageRecord,
  fields: readonly (keyof AgentMessageRecord)[],
): void {
  for (const field of fields) {
    const value = source[field];
    if (value === undefined) continue;
    if (!isString(value)) throw new Error(`Invalid persisted agent-message field: ${field}`);
    Object.assign(target, { [field]: value });
  }
}

function normalizePriority(priority: number | undefined): number {
  return Number.isFinite(priority) ? Math.trunc(priority ?? 0) : 0;
}

function normalizeDeadline(deadline: string | undefined): string | undefined {
  if (!deadline) return undefined;
  const timestamp = Date.parse(deadline);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid agent-message deadline: ${deadline}`);
  return new Date(timestamp).toISOString();
}

/** Only plain steering can share a turn; the others have their own per-message delivery proof. */
function isCoalescableAgentMessage(message: Readonly<AgentMessageRecord>): boolean {
  return (
    message.kind === "subagent" &&
    !isGoalRelatedMessage(message) &&
    !message.internalControl &&
    !message.relayOrigin &&
    !message.messageId.startsWith(RUNTIME_CONTINUATION_PREFIX) &&
    message.messageId !== subagentLaunchMessageId(message.target)
  );
}

/**
 * Parent reports stay out on purpose: every subagent finishing would otherwise cancel the turn the
 * parent is using to process the previous report.
 */
function canPreemptActiveDispatch(
  message: Readonly<AgentMessageRecord>,
  dispatch: Readonly<ActiveTargetDispatch>,
): boolean {
  return (
    message.kind === "subagent" &&
    message.deliveryMode === "interrupt" &&
    dispatch.backendAccepted === true
  );
}

function assignMirroredField(
  message: AgentMessageRecord,
  field:
    | "retryAt"
    | "backendAcceptedAt"
    | "backendDeliveredAt"
    | "processedAt"
    | "response"
    | "lastError",
  value: string | undefined,
): void {
  if (value === undefined) delete message[field];
  else message[field] = value;
}

/** Describes when a message was sent, for the agent reading it after it sat in the queue. */
export function describeAgentMessageSendTime(acceptedAt: string, now: number): string {
  const sentAt = new Date(acceptedAt);
  const sameDay = sentAt.toDateString() === new Date(now).toDateString();
  const clock = sentAt.toLocaleString("en-GB", {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const waitedMinutes = Math.floor((now - sentAt.getTime()) / 60_000);
  if (waitedMinutes < 1) return `${clock}, just now`;
  const hours = Math.floor(waitedMinutes / 60);
  const minutes = waitedMinutes % 60;
  return `${clock}, ${hours > 0 ? `${hours}h ` : ""}${minutes}m ago`;
}

function renderCoalescedAgentMessages(
  batch: readonly Readonly<AgentMessageRecord>[],
  now: number,
): string {
  const sections = batch.map((message, index) => {
    const sender = message.sourceLabel ?? message.source;
    const sentAt = describeAgentMessageSendTime(message.acceptedAt, now);
    return `--- Message ${index + 1} of ${batch.length} · from ${sender} · sent ${sentAt} ---\n${message.content}`;
  });
  return [
    `${batch.length} messages were queued for you and arrive together, oldest first. Where two messages from the same sender conflict, the later one wins.`,
    ...sections,
  ].join("\n\n");
}

function compareMessages(left: AgentMessageRecord, right: AgentMessageRecord): number {
  return right.priority - left.priority || left.sequence - right.sequence;
}

function isDeadlineExpired(message: AgentMessageRecord, now: number): boolean {
  return message.deadline !== undefined && Date.parse(message.deadline) <= now;
}

function cloneMessage(message: AgentMessageRecord): AgentMessageRecord {
  return {
    ...message,
    ...(message.internalControl ? { internalControl: { ...message.internalControl } } : {}),
    ...(message.relayOrigin ? { relayOrigin: { ...message.relayOrigin } } : {}),
    ...(message.goalFence ? { goalFence: cloneGoalFence(message.goalFence) } : {}),
  };
}

function parseRelayOrigin(value: unknown): RelayAddress {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["providerId", "accountId", "conversationId"].includes(key),
    ) ||
    !isString(value.providerId) ||
    !isString(value.accountId) ||
    !isString(value.conversationId)
  ) {
    throw new Error("Invalid persisted agent-message relay origin");
  }
  return {
    providerId: parseRelayProviderId(value.providerId),
    accountId: parseRelayAccountId(value.accountId),
    conversationId: parseRelayConversationId(value.conversationId),
  };
}

function parseInternalControl(value: unknown): SessionInternalControlMetadata {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["exchangeId", "kind", "side"].includes(key)) ||
    !isString(value.exchangeId) ||
    (value.kind !== "goal-continuation" &&
      value.kind !== "goal-continuation-composer" &&
      value.kind !== "relay-progress" &&
      value.kind !== "subagent-readiness") ||
    (value.side !== "request" && value.side !== "response")
  ) {
    throw new Error("Invalid persisted agent-message internal control");
  }
  return {
    exchangeId: value.exchangeId,
    kind: value.kind,
    side: value.side,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isAgentMessageKind(value: unknown): value is AgentMessageKind {
  return typeof value === "string" && MESSAGE_KINDS.has(value);
}

function isAgentMessageDeliveryMode(value: unknown): value is AgentMessageDeliveryMode {
  return typeof value === "string" && DELIVERY_MODES.has(value);
}

function isSessionSource(value: unknown): value is SessionSource {
  return typeof value === "string" && SESSION_SOURCES.has(value);
}

function isGoalMessageDeliveryKind(value: unknown): value is GoalMessageDeliveryKind {
  return typeof value === "string" && GOAL_DELIVERY_KINDS.has(value);
}

function isGoalMessageTerminalKind(value: unknown): value is GoalMessageTerminalKind {
  return typeof value === "string" && GOAL_TERMINAL_KINDS.has(value);
}

function isAgentMessageState(value: unknown): value is AgentMessageState {
  return typeof value === "string" && MESSAGE_STATES.has(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatErrorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function toDeliveryControlError(
  messageId: string,
  stage: AgentMessageDeliveryControlStage,
  error: unknown,
): AgentMessageDeliveryControlError {
  if (isAgentMessageDeliveryControlError(error)) return error;
  return new AgentMessageDeliveryControlError(messageId, stage, formatError(error));
}

export function buildGoalMessageIdempotencyKey(identity: GoalMessageIdentity): string {
  const normalized = normalizeGoalMessageIdentity(identity);
  if (!normalized) throw new Error("Goal-message identity is required");
  return [
    "goal-message",
    "v2",
    encodeURIComponent(normalized.goalId),
    `epoch-${normalized.goalFence.epoch}`,
    normalized.goalDeliveryKind,
    normalized.goalTerminalKind ?? "none",
    `sequence-${normalized.goalDeliverySequence}`,
  ].join(":");
}

export function goalFencesEqual(left: Readonly<GoalFence>, right: Readonly<GoalFence>): boolean {
  return left.goalId === right.goalId && authorityEpoch(left) === authorityEpoch(right);
}

function normalizeGoalMessageIdentity(input: {
  kind?: unknown;
  goalFence?: unknown;
  goalId?: unknown;
  goalDeliveryKind?: unknown;
  goalTerminalKind?: unknown;
  goalDeliverySequence?: unknown;
}): GoalMessageIdentity | undefined {
  const hasGoalMetadata =
    input.goalFence !== undefined ||
    input.goalId !== undefined ||
    input.goalDeliveryKind !== undefined ||
    input.goalTerminalKind !== undefined ||
    input.goalDeliverySequence !== undefined;
  if (!hasGoalMetadata) {
    if (input.kind === "goal-terminal" || input.kind === "review-comment") {
      throw new Error(LEGACY_UNFENCED_GOAL_MESSAGE_POLICY.reason);
    }
    return undefined;
  }
  if (
    input.goalFence === undefined ||
    input.goalId === undefined ||
    input.goalDeliveryKind === undefined ||
    input.goalDeliverySequence === undefined
  ) {
    throw new Error("Goal-related agent messages require complete fenced delivery metadata");
  }
  const goalFence = normalizeGoalFence(input.goalFence);
  const goalId = normalizeGoalIdentifier(input.goalId, "goalId");
  if (goalId !== goalFence.goalId) {
    throw new Error("Goal-message goalId must match goalFence.goalId");
  }
  if (!isGoalMessageDeliveryKind(input.goalDeliveryKind)) {
    throw new Error("Invalid goal-message delivery kind");
  }
  if (!isSafeNonNegativeInteger(input.goalDeliverySequence)) {
    throw new Error("Invalid goal-message delivery sequence");
  }
  const terminalKind = input.goalTerminalKind;
  if (input.goalDeliveryKind === "terminal") {
    if (!isGoalMessageTerminalKind(terminalKind)) {
      throw new Error("Terminal goal messages require a blocked or completed terminal kind");
    }
    if (input.kind !== undefined && input.kind !== "goal-terminal") {
      throw new Error("Terminal goal delivery metadata requires the goal-terminal message kind");
    }
  } else {
    if (terminalKind !== undefined) {
      throw new Error("Non-terminal goal messages cannot carry a terminal kind");
    }
    if (
      input.goalDeliveryKind === "reviewer" &&
      input.kind !== undefined &&
      input.kind !== "review-comment"
    ) {
      throw new Error("Reviewer goal delivery metadata requires the review-comment message kind");
    }
    if (
      input.goalDeliveryKind === "child" &&
      input.kind !== undefined &&
      input.kind !== "parent" &&
      input.kind !== "subagent"
    ) {
      throw new Error("Child goal delivery metadata requires a parent or subagent message kind");
    }
  }
  return {
    goalFence,
    goalId,
    goalDeliveryKind: input.goalDeliveryKind,
    ...(terminalKind ? { goalTerminalKind: terminalKind } : {}),
    goalDeliverySequence: input.goalDeliverySequence,
  };
}

function normalizeGoalFence(value: unknown): GoalFence {
  if (!isRecord(value)) throw new Error("Invalid goal-message fence");
  const legacy = "lifecycleEpoch" in value && !("epoch" in value);
  rejectUnknownFields(
    value,
    legacy ? LEGACY_GOAL_FENCE_FIELDS : GOAL_FENCE_FIELDS,
    "goal-message fence",
  );
  const goalId = normalizeGoalIdentifier(value.goalId, "goalFence.goalId");
  const epoch = legacy ? value.lifecycleEpoch : value.epoch;
  if (!isSafePositiveInteger(epoch)) throw new Error("Invalid goal-message fence epoch");
  return { goalId, epoch };
}

function normalizeGoalIdentifier(value: unknown, field: string): string {
  if (
    !isString(value) ||
    value.length === 0 ||
    value.length > MAX_GOAL_ID_LENGTH ||
    !/^[A-Za-z0-9._:@/-]+$/.test(value)
  ) {
    throw new Error(`Invalid goal-message ${field}`);
  }
  return value;
}

function parsePersistedGoalMessageIdentity(
  source: Record<string, unknown>,
  message: AgentMessageRecord,
): void {
  const hasGoalMetadata =
    source.goalFence !== undefined ||
    source.goalId !== undefined ||
    source.goalDeliveryKind !== undefined ||
    source.goalTerminalKind !== undefined ||
    source.goalDeliverySequence !== undefined;
  if (!hasGoalMetadata) return;
  const identity = normalizeGoalMessageIdentity({
    kind: message.kind,
    goalFence: source.goalFence,
    goalId: source.goalId,
    goalDeliveryKind: source.goalDeliveryKind,
    goalTerminalKind: source.goalTerminalKind,
    goalDeliverySequence: source.goalDeliverySequence,
  });
  if (!identity) throw new Error("Invalid persisted goal-message identity");
  if (
    message.idempotencyKey !== buildGoalMessageIdempotencyKey(identity) &&
    message.idempotencyKey !== buildLegacyGoalMessageIdempotencyKey(source)
  ) {
    throw new Error("Persisted goal-message idempotency key does not match its fenced identity");
  }
  Object.assign(message, identity);
}

function isGoalRelatedMessage(message: Readonly<AgentMessageRecord>): boolean {
  return (
    message.kind === "goal-terminal" ||
    message.kind === "review-comment" ||
    message.goalFence !== undefined ||
    message.goalId !== undefined ||
    message.goalDeliveryKind !== undefined ||
    message.goalTerminalKind !== undefined ||
    message.goalDeliverySequence !== undefined
  );
}

function hasPossibleExternalEffect(message: Readonly<AgentMessageRecord>): boolean {
  return (
    message.state === "backend-accepted" ||
    message.state === "processed" ||
    message.state === "delivery-unknown" ||
    message.backendAcceptedAt !== undefined ||
    message.backendDeliveredAt !== undefined ||
    message.processedAt !== undefined
  );
}

function hasCompleteGoalMessageIdentity(
  message: Readonly<AgentMessageRecord>,
): message is Readonly<AgentMessageRecord & GoalMessageIdentity> {
  return (
    message.goalFence !== undefined &&
    message.goalId !== undefined &&
    message.goalDeliveryKind !== undefined &&
    message.goalDeliverySequence !== undefined &&
    message.goalId === message.goalFence.goalId &&
    (message.goalDeliveryKind !== "terminal" || message.goalTerminalKind !== undefined)
  );
}

function hasGoalMessageIdentity(
  message: Readonly<AgentMessageRecord>,
  identity: Readonly<GoalMessageIdentity>,
): boolean {
  return (
    hasCompleteGoalMessageIdentity(message) &&
    message.goalId === identity.goalId &&
    message.goalDeliveryKind === identity.goalDeliveryKind &&
    message.goalTerminalKind === identity.goalTerminalKind &&
    message.goalDeliverySequence === identity.goalDeliverySequence &&
    goalFencesEqual(message.goalFence, identity.goalFence)
  );
}

function matchesAgentMessageQuery(
  message: Readonly<AgentMessageRecord>,
  query: AgentMessageQuery | undefined,
): boolean {
  if (!query) return true;
  if (query.target !== undefined && message.target !== query.target) return false;
  if (
    query.goalFence &&
    (!message.goalFence || !goalFencesEqual(message.goalFence, query.goalFence))
  ) {
    return false;
  }
  if (query.goalDeliveryKind !== undefined && message.goalDeliveryKind !== query.goalDeliveryKind) {
    return false;
  }
  if (query.goalTerminalKind !== undefined && message.goalTerminalKind !== query.goalTerminalKind) {
    return false;
  }
  if (query.unfinishedOnly && TERMINAL_STATES.has(message.state)) return false;
  return true;
}

function isRejectedGoalFence(
  validation: GoalMessageFenceCheck,
): validation is Extract<GoalMessageFenceCheck, { status: "stale" | "revoked" | "untrusted" }> {
  return (
    validation.status === "stale" ||
    validation.status === "revoked" ||
    validation.status === "untrusted"
  );
}

function formatGoalFenceRejection(validation: GoalMessageFenceCheck, stage: string): string {
  const status = validation.status === "untrusted" ? "untrusted" : validation.status;
  const reason = "reason" in validation ? boundedValidatorReason(validation.reason) : undefined;
  return boundedGoalFenceReason(
    `Goal fence was ${status} during ${stage}${reason ? ` (${reason})` : ""}`,
  );
}

function boundedValidatorReason(reason: string | undefined): string | undefined {
  if (!reason || !/^[A-Za-z0-9._:-]+$/.test(reason)) return undefined;
  return reason.slice(0, 80);
}

function boundedGoalFenceReason(reason: string): string {
  let bounded = "";
  for (
    let index = 0;
    index < reason.length && bounded.length < MAX_GOAL_FENCE_REASON_LENGTH;
    index++
  ) {
    const character = reason[index];
    const code = reason.charCodeAt(index);
    bounded += code <= 31 || code === 127 ? " " : character;
  }
  return bounded;
}

function cloneGoalFence(fence: Readonly<GoalFence>): GoalFence {
  return { goalId: fence.goalId, epoch: authorityEpoch(fence) };
}

function buildLegacyGoalMessageIdempotencyKey(source: Record<string, unknown>): string | null {
  if (!isRecord(source.goalFence)) return null;
  const fence = source.goalFence;
  if (
    typeof source.goalId !== "string" ||
    typeof fence.contractRevision !== "number" ||
    typeof fence.lifecycleEpoch !== "number" ||
    typeof fence.specificationRevision !== "number" ||
    typeof fence.specificationDigest !== "string" ||
    typeof source.goalDeliveryKind !== "string" ||
    typeof source.goalDeliverySequence !== "number"
  ) {
    return null;
  }
  return [
    "goal-message",
    "v1",
    encodeURIComponent(source.goalId),
    `contract-${fence.contractRevision}`,
    `lifecycle-${fence.lifecycleEpoch}`,
    `spec-${fence.specificationRevision}`,
    `digest-${encodeURIComponent(fence.specificationDigest)}`,
    source.goalDeliveryKind,
    typeof source.goalTerminalKind === "string" ? source.goalTerminalKind : "none",
    `sequence-${source.goalDeliverySequence}`,
  ].join(":");
}

function backendAcceptanceFailure(message: AgentMessageRecord): Error {
  const detail = message.lastError ? `: ${message.lastError}` : "";
  return new Error(
    `Agent message ${message.messageId} reached ${message.state} before backend acceptance${detail}`,
  );
}

function backendDeliveryFailure(message: AgentMessageRecord): Error {
  const detail = message.lastError ? `: ${message.lastError}` : "";
  return new Error(
    `Agent message ${message.messageId} reached ${message.state} before backend delivery${detail}`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
