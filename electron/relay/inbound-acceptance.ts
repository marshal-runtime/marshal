import { randomUUID } from "node:crypto";

import { RelayMessageCorrelationStore, type RelayMessageCorrelation } from "./message-correlation";
import {
  boundedRelayLimit,
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

export type AcceptedInboundState = "accepted" | "enqueued";

export interface AcceptedInboundRecord {
  sequence: number;
  inboundId: string;
  correlationId: string;
  provider: string;
  accountId: string;
  conversationId: string;
  providerMessageId: string;
  payloadJson: string;
  state: AcceptedInboundState;
  localMessageId?: string;
  acceptedAtMs: number;
  enqueuedAtMs?: number;
}

export interface AcceptInboundInput {
  inboundId?: string;
  correlationId?: string;
  provider: string;
  accountId: string;
  conversationId: string;
  providerMessageId: string;
  payloadJson: string;
  acceptedAtMs?: number;
}

export interface AcceptInboundResult {
  inserted: boolean;
  record: AcceptedInboundRecord;
}

export interface InboundAcceptanceJournalOptions {
  now?: () => number;
  createId?: () => string;
}

export interface AcceptedInboundEnqueueRequest {
  correlationId: string;
  idempotencyKey: string;
  inboundId: string;
  provider: string;
  accountId: string;
  conversationId: string;
  providerMessageId: string;
  payloadJson: string;
  acceptedAtMs: number;
}

export interface AcceptedInboundEnqueueResult {
  localMessageId: string;
}

export type AcceptedInboundEnqueuer = (
  request: AcceptedInboundEnqueueRequest,
) => Promise<AcceptedInboundEnqueueResult>;

export interface AcceptedInboundPumpResult {
  scanned: number;
  enqueued: number;
  blocked?: {
    correlationId: string;
    error: unknown;
  };
}

export interface AcceptedInboundPumpOptions {
  now?: () => number;
  limit?: number;
}

export class InboundAcceptanceJournal {
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(
    private readonly database: RelayDatabase,
    options: InboundAcceptanceJournalOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  accept(input: AcceptInboundInput): AcceptInboundResult {
    const provider = requireRelayText("provider", input.provider);
    const accountId = requireRelayText("accountId", input.accountId);
    const conversationId = requireRelayText("conversationId", input.conversationId);
    const providerMessageId = requireRelayText("providerMessageId", input.providerMessageId);
    const payloadJson = requireRelayText("payloadJson", input.payloadJson);
    const acceptedAtMs = requireRelayInteger("acceptedAtMs", input.acceptedAtMs ?? this.now());

    return this.database.transaction(() => {
      const existing = this.getByProviderMessage(
        provider,
        accountId,
        conversationId,
        providerMessageId,
      );
      if (existing) return { inserted: false, record: existing };

      const inboundId = requireRelayText("inboundId", input.inboundId ?? this.createId());
      const correlationId = requireRelayText(
        "correlationId",
        input.correlationId ?? this.createId(),
      );
      this.database
        .prepare(
          `INSERT INTO relay_inbound_journal (
             inbound_id,
             correlation_id,
             provider,
             account_id,
             conversation_id,
             provider_message_id,
             payload_json,
             state,
             accepted_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`,
        )
        .run(
          inboundId,
          correlationId,
          provider,
          accountId,
          conversationId,
          providerMessageId,
          payloadJson,
          acceptedAtMs,
        );
      return { inserted: true, record: this.requireByCorrelationId(correlationId) };
    });
  }

  getByCorrelationId(correlationId: string): AcceptedInboundRecord | undefined {
    requireRelayText("correlationId", correlationId);
    const row = this.database
      .prepare(`${INBOUND_SELECT} WHERE correlation_id = ?`)
      .get(correlationId);
    return row === undefined
      ? undefined
      : inboundFromRow(requireRelayRow(row, "accepted inbound by correlation"));
  }

  getByProviderMessage(
    provider: string,
    accountId: string,
    conversationId: string,
    providerMessageId: string,
  ): AcceptedInboundRecord | undefined {
    requireRelayText("provider", provider);
    requireRelayText("accountId", accountId);
    requireRelayText("conversationId", conversationId);
    requireRelayText("providerMessageId", providerMessageId);
    const row = this.database
      .prepare(
        `${INBOUND_SELECT}
         WHERE
           provider = ?
           AND account_id = ?
           AND conversation_id = ?
           AND provider_message_id = ?`,
      )
      .get(provider, accountId, conversationId, providerMessageId);
    return row === undefined
      ? undefined
      : inboundFromRow(requireRelayRow(row, "accepted inbound by provider message"));
  }

  listAccepted(limit = 100): AcceptedInboundRecord[] {
    const boundedLimit = boundedRelayLimit(limit);
    const rows = this.database
      .prepare(
        `${INBOUND_SELECT}
         WHERE state = 'accepted'
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(boundedLimit);
    return rows.map((row) =>
      inboundFromRow(requireRelayRow(row, "accepted inbound journal listing")),
    );
  }

  listAcceptedForAccount(
    provider: string,
    accountId: string,
    afterSequence = 0,
    limit = 100,
  ): AcceptedInboundRecord[] {
    requireRelayText("provider", provider);
    requireRelayText("accountId", accountId);
    requireRelayInteger("afterSequence", afterSequence);
    const boundedLimit = boundedRelayLimit(limit);
    const rows = this.database
      .prepare(
        `${INBOUND_SELECT}
         WHERE
           state = 'accepted'
           AND provider = ?
           AND account_id = ?
           AND sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(provider, accountId, afterSequence, boundedLimit);
    return rows.map((row) =>
      inboundFromRow(requireRelayRow(row, "accepted inbound account listing")),
    );
  }

  markEnqueued(
    correlationId: string,
    localMessageId: string,
    enqueuedAtMs = this.now(),
  ): AcceptedInboundRecord {
    requireRelayText("correlationId", correlationId);
    requireRelayText("localMessageId", localMessageId);
    requireRelayInteger("enqueuedAtMs", enqueuedAtMs);

    const existing = this.requireByCorrelationId(correlationId);
    if (existing.state === "enqueued") {
      if (existing.localMessageId !== localMessageId) {
        throw new Error(
          `Accepted inbound ${correlationId} is already enqueued as ${existing.localMessageId}`,
        );
      }
      return existing;
    }

    const result = this.database
      .prepare(
        `UPDATE relay_inbound_journal
         SET state = 'enqueued', local_message_id = ?, enqueued_at_ms = ?
         WHERE correlation_id = ? AND state = 'accepted'`,
      )
      .run(localMessageId, enqueuedAtMs, correlationId);
    if (Number(result.changes) !== 1) {
      throw new Error(`Accepted inbound state changed before enqueue commit: ${correlationId}`);
    }
    return this.requireByCorrelationId(correlationId);
  }

  private requireByCorrelationId(correlationId: string): AcceptedInboundRecord {
    const record = this.getByCorrelationId(correlationId);
    if (!record) throw new Error(`Unknown accepted inbound correlation: ${correlationId}`);
    return record;
  }
}

export class AcceptedInboundPump {
  private readonly journal: InboundAcceptanceJournal;
  private readonly correlations: RelayMessageCorrelationStore;
  private readonly now: () => number;
  private readonly limit: number;

  constructor(
    private readonly database: RelayDatabase,
    private readonly enqueue: AcceptedInboundEnqueuer,
    options: AcceptedInboundPumpOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.limit = boundedRelayLimit(options.limit ?? 100);
    this.journal = new InboundAcceptanceJournal(database, { now: this.now });
    this.correlations = new RelayMessageCorrelationStore(database, { now: this.now });
  }

  async pump(): Promise<AcceptedInboundPumpResult> {
    const accepted = this.journal.listAccepted(this.limit);
    let enqueued = 0;

    for (const record of accepted) {
      try {
        // eslint-disable-next-line no-await-in-loop -- journal sequence is the relay acceptance order
        const result = await this.enqueue({
          correlationId: record.correlationId,
          idempotencyKey: record.correlationId,
          inboundId: record.inboundId,
          provider: record.provider,
          accountId: record.accountId,
          conversationId: record.conversationId,
          providerMessageId: record.providerMessageId,
          payloadJson: record.payloadJson,
          acceptedAtMs: record.acceptedAtMs,
        });
        const localMessageId = requireRelayText("localMessageId", result.localMessageId);
        const committedAtMs = requireRelayInteger("enqueuedAtMs", this.now());
        this.database.transaction(() => {
          this.journal.markEnqueued(record.correlationId, localMessageId, committedAtMs);
          this.correlations.record({
            direction: "inbound",
            correlationId: record.correlationId,
            provider: record.provider,
            accountId: record.accountId,
            conversationId: record.conversationId,
            providerMessageId: record.providerMessageId,
            localMessageId,
            inboundId: record.inboundId,
            createdAtMs: committedAtMs,
          });
        });
        enqueued += 1;
      } catch (error) {
        return {
          scanned: accepted.length,
          enqueued,
          blocked: { correlationId: record.correlationId, error },
        };
      }
    }

    return { scanned: accepted.length, enqueued };
  }

  getCorrelation(correlationId: string): RelayMessageCorrelation | undefined {
    return this.correlations.getByCorrelationId(correlationId);
  }
}

const INBOUND_SELECT = `SELECT
  sequence,
  inbound_id,
  correlation_id,
  provider,
  account_id,
  conversation_id,
  provider_message_id,
  payload_json,
  state,
  local_message_id,
  accepted_at_ms,
  enqueued_at_ms
FROM relay_inbound_journal`;

function inboundFromRow(row: RelayDatabaseRow): AcceptedInboundRecord {
  const localMessageId = relayNullableTextColumn(row, "local_message_id");
  const enqueuedAtMs = relayNullableIntegerColumn(row, "enqueued_at_ms");
  return {
    sequence: relayIntegerColumn(row, "sequence"),
    inboundId: relayTextColumn(row, "inbound_id"),
    correlationId: relayTextColumn(row, "correlation_id"),
    provider: relayTextColumn(row, "provider"),
    accountId: relayTextColumn(row, "account_id"),
    conversationId: relayTextColumn(row, "conversation_id"),
    providerMessageId: relayTextColumn(row, "provider_message_id"),
    payloadJson: relayTextColumn(row, "payload_json"),
    state: inboundStateColumn(row),
    ...(localMessageId === undefined ? {} : { localMessageId }),
    acceptedAtMs: relayIntegerColumn(row, "accepted_at_ms"),
    ...(enqueuedAtMs === undefined ? {} : { enqueuedAtMs }),
  };
}

function inboundStateColumn(row: RelayDatabaseRow): AcceptedInboundState {
  const state = relayTextColumn(row, "state");
  if (state !== "accepted" && state !== "enqueued") {
    throw new Error(`Invalid accepted inbound state in SQLite: ${state}`);
  }
  return state;
}
