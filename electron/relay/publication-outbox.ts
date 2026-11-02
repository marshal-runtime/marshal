import { randomUUID } from "node:crypto";

import { RelayMessageCorrelationStore } from "./message-correlation";
import {
  RelayDatabase,
  type RelayDatabaseRow,
  relayIntegerColumn,
  relayNullableIntegerColumn,
  relayNullableTextColumn,
  relayTextColumn,
  requireRelayInteger,
  requireRelayRow,
  requireRelayText,
} from "./relay-database";

export type RelayPublicationState =
  | "pending"
  | "leased"
  | "sending"
  | "sent"
  | "ambiguous"
  | "failed"
  | "superseded";

export interface RelayPublication {
  sequence: number;
  publicationId: string;
  correlationId: string;
  provider: string;
  accountId: string;
  conversationId: string;
  localMessageId: string;
  payloadJson: string;
  priority: number;
  state: RelayPublicationState;
  attempts: number;
  maxAttempts: number;
  nextAttemptAtMs: number;
  leaseId?: string;
  leaseOwner?: string;
  leaseExpiresAtMs?: number;
  sendingAtMs?: number;
  sentAtMs?: number;
  providerMessageId?: string;
  lastError?: string;
  supersededBy?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface EnqueueRelayPublicationInput {
  publicationId?: string;
  correlationId: string;
  provider: string;
  accountId: string;
  conversationId: string;
  localMessageId: string;
  payloadJson: string;
  priority?: number;
  maxAttempts?: number;
  createdAtMs?: number;
}

export interface RelayPublicationOutboxOptions {
  now?: () => number;
  createId?: () => string;
  defaultMaxAttempts?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

export interface RelayPublicationRecovery {
  requeued: number;
  ambiguous: number;
}

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BASE_RETRY_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

export class RelayPublicationOutbox {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly defaultMaxAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly correlations: RelayMessageCorrelationStore;

  constructor(
    private readonly database: RelayDatabase,
    options: RelayPublicationOutboxOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.defaultMaxAttempts = requireRelayInteger(
      "defaultMaxAttempts",
      options.defaultMaxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      1,
    );
    this.baseRetryDelayMs = requireRelayInteger(
      "baseRetryDelayMs",
      options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS,
      1,
    );
    this.maxRetryDelayMs = requireRelayInteger(
      "maxRetryDelayMs",
      options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
      this.baseRetryDelayMs,
    );
    this.correlations = new RelayMessageCorrelationStore(database, { now: this.now });
  }

  enqueue(input: EnqueueRelayPublicationInput): RelayPublication {
    const correlationId = requireRelayText("correlationId", input.correlationId);
    const provider = requireRelayText("provider", input.provider);
    const accountId = requireRelayText("accountId", input.accountId);
    const conversationId = requireRelayText("conversationId", input.conversationId);
    const localMessageId = requireRelayText("localMessageId", input.localMessageId);
    const payloadJson = requireRelayText("payloadJson", input.payloadJson);
    const priority = requirePriority(input.priority ?? 0);
    const maxAttempts = requireRelayInteger(
      "maxAttempts",
      input.maxAttempts ?? this.defaultMaxAttempts,
      1,
    );
    const createdAtMs = requireRelayInteger("createdAtMs", input.createdAtMs ?? this.now());

    return this.database.transaction(() => {
      const existing = this.getByCorrelationId(correlationId);
      if (existing) {
        if (
          existing.provider !== provider ||
          existing.accountId !== accountId ||
          existing.conversationId !== conversationId ||
          existing.localMessageId !== localMessageId ||
          existing.payloadJson !== payloadJson ||
          existing.priority !== priority ||
          existing.maxAttempts !== maxAttempts
        ) {
          throw new Error(`Publication correlation ${correlationId} was reused with new content`);
        }
        if (input.publicationId !== undefined && input.publicationId !== existing.publicationId) {
          throw new Error(
            `Publication correlation ${correlationId} already belongs to ${existing.publicationId}`,
          );
        }
        return existing;
      }

      const publicationId = requireRelayText(
        "publicationId",
        input.publicationId ?? this.createId(),
      );
      this.database
        .prepare(
          `INSERT INTO relay_publications (
             publication_id,
             correlation_id,
             provider,
             account_id,
             conversation_id,
             local_message_id,
             payload_json,
             priority,
             state,
             attempts,
             max_attempts,
             next_attempt_at_ms,
             created_at_ms,
             updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
        )
        .run(
          publicationId,
          correlationId,
          provider,
          accountId,
          conversationId,
          localMessageId,
          payloadJson,
          priority,
          maxAttempts,
          createdAtMs,
          createdAtMs,
          createdAtMs,
        );
      return this.requireById(publicationId);
    });
  }

  get(publicationId: string): RelayPublication | undefined {
    requireRelayText("publicationId", publicationId);
    const row = this.database
      .prepare("SELECT * FROM relay_publications WHERE publication_id = ?")
      .get(publicationId);
    return row === undefined
      ? undefined
      : publicationFromRow(requireRelayRow(row, "relay publication by id"));
  }

  getByCorrelationId(correlationId: string): RelayPublication | undefined {
    requireRelayText("correlationId", correlationId);
    const row = this.database
      .prepare("SELECT * FROM relay_publications WHERE correlation_id = ?")
      .get(correlationId);
    return row === undefined
      ? undefined
      : publicationFromRow(requireRelayRow(row, "relay publication by correlation"));
  }

  list(): RelayPublication[] {
    const rows = this.database
      .prepare("SELECT * FROM relay_publications ORDER BY sequence ASC")
      .all();
    return rows.map((row) => publicationFromRow(requireRelayRow(row, "relay publication listing")));
  }

  leaseNext(
    leaseOwner: string,
    leaseDurationMs: number,
    nowMs = this.now(),
  ): RelayPublication | undefined {
    requireRelayText("leaseOwner", leaseOwner);
    requireRelayInteger("leaseDurationMs", leaseDurationMs, 1);
    requireRelayInteger("nowMs", nowMs);
    const leaseExpiresAtMs = requireRelayInteger(
      "leaseExpiresAtMs",
      nowMs + leaseDurationMs,
      nowMs + 1,
    );

    return this.database.transaction(() => {
      this.recoverInterruptedLocked(nowMs, true);
      const candidateRow = this.database
        .prepare(
          `SELECT p.*
           FROM relay_publications p
           WHERE
             p.state = 'pending'
             AND p.next_attempt_at_ms <= ?
             AND p.attempts < p.max_attempts
             AND NOT EXISTS (
               SELECT 1
               FROM relay_publications active
               WHERE
                 active.provider = p.provider
                 AND active.account_id = p.account_id
                 AND active.conversation_id = p.conversation_id
                 AND active.state IN ('leased', 'sending')
             )
             AND NOT EXISTS (
               SELECT 1
               FROM relay_publications earlier
               WHERE
                 earlier.provider = p.provider
                 AND earlier.account_id = p.account_id
                 AND earlier.conversation_id = p.conversation_id
                 AND earlier.sequence < p.sequence
                 AND earlier.state IN ('pending', 'leased', 'sending')
             )
           ORDER BY p.priority DESC, p.sequence ASC
           LIMIT 1`,
        )
        .get(nowMs);
      if (candidateRow === undefined) return undefined;
      const candidate = publicationFromRow(
        requireRelayRow(candidateRow, "relay publication lease candidate"),
      );

      const leaseId = requireRelayText("leaseId", this.createId());
      const result = this.database
        .prepare(
          `UPDATE relay_publications
           SET
             state = 'leased',
             attempts = attempts + 1,
             lease_id = ?,
             lease_owner = ?,
             lease_expires_at_ms = ?,
             last_error = NULL,
             updated_at_ms = ?
           WHERE publication_id = ? AND state = 'pending'`,
        )
        .run(leaseId, leaseOwner, leaseExpiresAtMs, nowMs, candidate.publicationId);
      if (Number(result.changes) !== 1) {
        throw new Error(`Publication changed before lease commit: ${candidate.publicationId}`);
      }
      return this.requireById(candidate.publicationId);
    });
  }

  beginSending(publicationId: string, leaseId: string, nowMs = this.now()): RelayPublication {
    requireRelayText("publicationId", publicationId);
    requireRelayText("leaseId", leaseId);
    requireRelayInteger("nowMs", nowMs);

    return this.database.transaction(() => {
      this.recoverInterruptedLocked(nowMs, true);
      this.requireOwned(publicationId, leaseId, "leased");
      this.database
        .prepare(
          `UPDATE relay_publications
           SET state = 'sending', sending_at_ms = ?, updated_at_ms = ?
           WHERE publication_id = ? AND state = 'leased' AND lease_id = ?`,
        )
        .run(nowMs, nowMs, publicationId, leaseId);
      return this.requireById(publicationId);
    });
  }

  markSent(
    publicationId: string,
    leaseId: string,
    providerMessageId: string,
    nowMs = this.now(),
  ): RelayPublication {
    requireRelayText("publicationId", publicationId);
    requireRelayText("leaseId", leaseId);
    requireRelayText("providerMessageId", providerMessageId);
    requireRelayInteger("nowMs", nowMs);

    return this.database.transaction(() => {
      const existing = this.requireById(publicationId);
      if (existing.state === "sent") {
        if (existing.providerMessageId !== providerMessageId) {
          throw new Error(`Publication ${publicationId} was sent with another provider message`);
        }
        return existing;
      }

      this.recoverInterruptedLocked(nowMs, true);
      const sending = this.requireOwned(publicationId, leaseId, "sending");
      this.correlations.record({
        direction: "outbound",
        correlationId: sending.correlationId,
        provider: sending.provider,
        accountId: sending.accountId,
        conversationId: sending.conversationId,
        providerMessageId,
        localMessageId: sending.localMessageId,
        publicationId: sending.publicationId,
        createdAtMs: nowMs,
      });
      const result = this.database
        .prepare(
          `UPDATE relay_publications
           SET
             state = 'sent',
             provider_message_id = ?,
             sent_at_ms = ?,
             lease_id = NULL,
             lease_owner = NULL,
             lease_expires_at_ms = NULL,
             last_error = NULL,
             updated_at_ms = ?
           WHERE publication_id = ? AND state = 'sending' AND lease_id = ?`,
        )
        .run(providerMessageId, nowMs, nowMs, publicationId, leaseId);
      if (Number(result.changes) !== 1) {
        throw new Error(`Publication changed before sent commit: ${publicationId}`);
      }
      return this.requireById(publicationId);
    });
  }

  reschedule(
    publicationId: string,
    leaseId: string,
    error: string,
    nowMs = this.now(),
  ): RelayPublication {
    requireRelayText("publicationId", publicationId);
    requireRelayText("leaseId", leaseId);
    const lastError = boundedError(error);
    requireRelayInteger("nowMs", nowMs);

    return this.database.transaction(() => {
      this.recoverInterruptedLocked(nowMs, true);
      const leased = this.requireOwned(publicationId, leaseId, "leased");
      const exhausted = leased.attempts >= leased.maxAttempts;
      const nextAttemptAtMs = exhausted
        ? leased.nextAttemptAtMs
        : requireRelayInteger(
            "nextAttemptAtMs",
            nowMs + this.retryDelayMs(leased.attempts),
            nowMs + 1,
          );
      const result = this.database
        .prepare(
          `UPDATE relay_publications
           SET
             state = ?,
             next_attempt_at_ms = ?,
             lease_id = NULL,
             lease_owner = NULL,
             lease_expires_at_ms = NULL,
             last_error = ?,
             updated_at_ms = ?
           WHERE publication_id = ? AND state = 'leased' AND lease_id = ?`,
        )
        .run(
          exhausted ? "failed" : "pending",
          nextAttemptAtMs,
          lastError,
          nowMs,
          publicationId,
          leaseId,
        );
      if (Number(result.changes) !== 1) {
        throw new Error(`Publication changed before retry commit: ${publicationId}`);
      }
      return this.requireById(publicationId);
    });
  }

  markAmbiguous(
    publicationId: string,
    leaseId: string,
    error: string,
    nowMs = this.now(),
  ): RelayPublication {
    return this.finishOwned(publicationId, leaseId, "sending", "ambiguous", error, nowMs);
  }

  markFailed(
    publicationId: string,
    leaseId: string,
    error: string,
    nowMs = this.now(),
  ): RelayPublication {
    requireRelayText("publicationId", publicationId);
    requireRelayText("leaseId", leaseId);
    const lastError = boundedError(error);
    requireRelayInteger("nowMs", nowMs);

    return this.database.transaction(() => {
      this.recoverInterruptedLocked(nowMs, true);
      const current = this.requireById(publicationId);
      if (
        current.leaseId !== leaseId ||
        (current.state !== "leased" && current.state !== "sending")
      ) {
        throw new Error(`Publication lease is no longer current: ${publicationId}`);
      }
      const result = this.database
        .prepare(
          `UPDATE relay_publications
           SET
             state = 'failed',
             lease_id = NULL,
             lease_owner = NULL,
             lease_expires_at_ms = NULL,
             last_error = ?,
             updated_at_ms = ?
           WHERE
             publication_id = ?
             AND lease_id = ?
             AND state IN ('leased', 'sending')`,
        )
        .run(lastError, nowMs, publicationId, leaseId);
      if (Number(result.changes) !== 1) {
        throw new Error(`Publication changed before failed commit: ${publicationId}`);
      }
      return this.requireById(publicationId);
    });
  }

  supersede(publicationId: string, supersededBy: string, nowMs = this.now()): RelayPublication {
    requireRelayText("publicationId", publicationId);
    requireRelayText("supersededBy", supersededBy);
    requireRelayInteger("nowMs", nowMs);
    if (publicationId === supersededBy) {
      throw new Error("A publication cannot supersede itself");
    }

    return this.database.transaction(() => {
      const current = this.requireById(publicationId);
      if (current.state === "superseded") {
        if (current.supersededBy !== supersededBy) {
          throw new Error(`Publication ${publicationId} was superseded by another publication`);
        }
        return current;
      }
      if (current.state === "leased" || current.state === "sending" || current.state === "sent") {
        throw new Error(`Publication ${publicationId} cannot be superseded from ${current.state}`);
      }

      const replacement = this.requireById(supersededBy);
      if (
        current.provider !== replacement.provider ||
        current.accountId !== replacement.accountId ||
        current.conversationId !== replacement.conversationId
      ) {
        throw new Error("A publication can only be superseded by another publication on its route");
      }
      if (replacement.sequence <= current.sequence) {
        throw new Error("A publication can only be superseded by a newer publication");
      }
      this.database
        .prepare(
          `UPDATE relay_publications
           SET state = 'superseded', superseded_by = ?, last_error = NULL, updated_at_ms = ?
           WHERE publication_id = ?`,
        )
        .run(supersededBy, nowMs, publicationId);
      return this.requireById(publicationId);
    });
  }

  recoverAfterRestart(nowMs = this.now()): RelayPublicationRecovery {
    requireRelayInteger("nowMs", nowMs);
    return this.database.transaction(() => this.recoverInterruptedLocked(nowMs, false));
  }

  recoverExpiredLeases(nowMs = this.now()): RelayPublicationRecovery {
    requireRelayInteger("nowMs", nowMs);
    return this.database.transaction(() => this.recoverInterruptedLocked(nowMs, true));
  }

  private finishOwned(
    publicationId: string,
    leaseId: string,
    expectedState: "leased" | "sending",
    finalState: "ambiguous" | "failed",
    error: string,
    nowMs: number,
  ): RelayPublication {
    requireRelayText("publicationId", publicationId);
    requireRelayText("leaseId", leaseId);
    const lastError = boundedError(error);
    requireRelayInteger("nowMs", nowMs);

    return this.database.transaction(() => {
      this.recoverInterruptedLocked(nowMs, true);
      this.requireOwned(publicationId, leaseId, expectedState);
      const result = this.database
        .prepare(
          `UPDATE relay_publications
           SET
             state = ?,
             lease_id = NULL,
             lease_owner = NULL,
             lease_expires_at_ms = NULL,
             last_error = ?,
             updated_at_ms = ?
           WHERE publication_id = ? AND state = ? AND lease_id = ?`,
        )
        .run(finalState, lastError, nowMs, publicationId, expectedState, leaseId);
      if (Number(result.changes) !== 1) {
        throw new Error(`Publication changed before ${finalState} commit: ${publicationId}`);
      }
      return this.requireById(publicationId);
    });
  }

  private requireOwned(
    publicationId: string,
    leaseId: string,
    expectedState: "leased" | "sending",
  ): RelayPublication {
    const current = this.requireById(publicationId);
    if (current.state !== expectedState || current.leaseId !== leaseId) {
      throw new Error(`Publication lease is no longer current: ${publicationId}`);
    }
    return current;
  }

  private recoverInterruptedLocked(nowMs: number, expiredOnly: boolean): RelayPublicationRecovery {
    const leased = expiredOnly
      ? this.database
          .prepare(
            `UPDATE relay_publications
             SET
               state = 'pending',
               attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
               next_attempt_at_ms = ?,
               lease_id = NULL,
               lease_owner = NULL,
               lease_expires_at_ms = NULL,
               last_error = 'Lease expired before provider send began',
               updated_at_ms = ?
             WHERE state = 'leased' AND lease_expires_at_ms <= ?`,
          )
          .run(nowMs, nowMs, nowMs)
      : this.database
          .prepare(
            `UPDATE relay_publications
             SET
               state = 'pending',
               attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
               next_attempt_at_ms = ?,
               lease_id = NULL,
               lease_owner = NULL,
               lease_expires_at_ms = NULL,
               last_error = 'Lease recovered after relay restart before provider send began',
               updated_at_ms = ?
             WHERE state = 'leased'`,
          )
          .run(nowMs, nowMs);
    const sending = expiredOnly
      ? this.database
          .prepare(
            `UPDATE relay_publications
             SET
               state = 'ambiguous',
               lease_id = NULL,
               lease_owner = NULL,
               lease_expires_at_ms = NULL,
               last_error = 'Provider send outcome is unknown after lease expiry',
               updated_at_ms = ?
             WHERE state = 'sending' AND lease_expires_at_ms <= ?`,
          )
          .run(nowMs, nowMs)
      : this.database
          .prepare(
            `UPDATE relay_publications
             SET
               state = 'ambiguous',
               lease_id = NULL,
               lease_owner = NULL,
               lease_expires_at_ms = NULL,
               last_error = 'Provider send outcome is unknown after relay restart',
               updated_at_ms = ?
             WHERE state = 'sending'`,
          )
          .run(nowMs);
    return {
      requeued: Number(leased.changes),
      ambiguous: Number(sending.changes),
    };
  }

  private retryDelayMs(attempts: number): number {
    const exponent = Math.min(Math.max(0, attempts - 1), 30);
    return Math.min(this.baseRetryDelayMs * 2 ** exponent, this.maxRetryDelayMs);
  }

  private requireById(publicationId: string): RelayPublication {
    const publication = this.get(publicationId);
    if (!publication) throw new Error(`Unknown relay publication: ${publicationId}`);
    return publication;
  }
}

function publicationFromRow(row: RelayDatabaseRow): RelayPublication {
  const leaseId = relayNullableTextColumn(row, "lease_id");
  const leaseOwner = relayNullableTextColumn(row, "lease_owner");
  const leaseExpiresAtMs = relayNullableIntegerColumn(row, "lease_expires_at_ms");
  const sendingAtMs = relayNullableIntegerColumn(row, "sending_at_ms");
  const sentAtMs = relayNullableIntegerColumn(row, "sent_at_ms");
  const providerMessageId = relayNullableTextColumn(row, "provider_message_id");
  const lastError = relayNullableTextColumn(row, "last_error");
  const supersededBy = relayNullableTextColumn(row, "superseded_by");
  return {
    sequence: relayIntegerColumn(row, "sequence"),
    publicationId: relayTextColumn(row, "publication_id"),
    correlationId: relayTextColumn(row, "correlation_id"),
    provider: relayTextColumn(row, "provider"),
    accountId: relayTextColumn(row, "account_id"),
    conversationId: relayTextColumn(row, "conversation_id"),
    localMessageId: relayTextColumn(row, "local_message_id"),
    payloadJson: relayTextColumn(row, "payload_json"),
    priority: relayIntegerColumn(row, "priority"),
    state: publicationStateColumn(row),
    attempts: relayIntegerColumn(row, "attempts"),
    maxAttempts: relayIntegerColumn(row, "max_attempts"),
    nextAttemptAtMs: relayIntegerColumn(row, "next_attempt_at_ms"),
    ...(leaseId === undefined ? {} : { leaseId }),
    ...(leaseOwner === undefined ? {} : { leaseOwner }),
    ...(leaseExpiresAtMs === undefined ? {} : { leaseExpiresAtMs }),
    ...(sendingAtMs === undefined ? {} : { sendingAtMs }),
    ...(sentAtMs === undefined ? {} : { sentAtMs }),
    ...(providerMessageId === undefined ? {} : { providerMessageId }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(supersededBy === undefined ? {} : { supersededBy }),
    createdAtMs: relayIntegerColumn(row, "created_at_ms"),
    updatedAtMs: relayIntegerColumn(row, "updated_at_ms"),
  };
}

function requirePriority(priority: number): number {
  if (!Number.isSafeInteger(priority)) throw new Error("priority must be a safe integer");
  return priority;
}

function boundedError(error: string): string {
  const value = requireRelayText("error", error);
  return value.length <= 2000 ? value : value.slice(0, 2000);
}

function publicationStateColumn(row: RelayDatabaseRow): RelayPublicationState {
  const state = relayTextColumn(row, "state");
  if (
    state !== "pending" &&
    state !== "leased" &&
    state !== "sending" &&
    state !== "sent" &&
    state !== "ambiguous" &&
    state !== "failed" &&
    state !== "superseded"
  ) {
    throw new Error(`Invalid relay publication state in SQLite: ${state}`);
  }
  return state;
}
