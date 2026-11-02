import {
  RelayDatabase,
  type RelayDatabaseRow,
  relayIntegerColumn,
  relayNullableTextColumn,
  relayTextColumn,
  requireRelayInteger,
  requireRelayRow,
  requireRelayText,
} from "./relay-database";

export type RelayMessageDirection = "inbound" | "outbound";

export interface RelayMessageCorrelation {
  correlationId: string;
  direction: RelayMessageDirection;
  provider: string;
  accountId: string;
  conversationId: string;
  providerMessageId: string;
  localMessageId: string;
  inboundId?: string;
  publicationId?: string;
  createdAtMs: number;
}

interface RelayMessageCorrelationBaseInput {
  correlationId: string;
  provider: string;
  accountId: string;
  conversationId: string;
  providerMessageId: string;
  localMessageId: string;
  createdAtMs?: number;
}

export type RecordRelayMessageCorrelationInput =
  | (RelayMessageCorrelationBaseInput & {
      direction: "inbound";
      inboundId: string;
      publicationId?: never;
    })
  | (RelayMessageCorrelationBaseInput & {
      direction: "outbound";
      inboundId?: never;
      publicationId: string;
    });

export interface RelayMessageCorrelationStoreOptions {
  now?: () => number;
}

export class RelayMessageCorrelationStore {
  private readonly now: () => number;

  constructor(
    private readonly database: RelayDatabase,
    options: RelayMessageCorrelationStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  record(input: RecordRelayMessageCorrelationInput): RelayMessageCorrelation {
    const correlationId = requireRelayText("correlationId", input.correlationId);
    const provider = requireRelayText("provider", input.provider);
    const accountId = requireRelayText("accountId", input.accountId);
    const conversationId = requireRelayText("conversationId", input.conversationId);
    const providerMessageId = requireRelayText("providerMessageId", input.providerMessageId);
    const localMessageId = requireRelayText("localMessageId", input.localMessageId);
    const inboundId =
      input.direction === "inbound" ? requireRelayText("inboundId", input.inboundId) : undefined;
    const publicationId =
      input.direction === "outbound"
        ? requireRelayText("publicationId", input.publicationId)
        : undefined;
    const createdAtMs = requireRelayInteger("createdAtMs", input.createdAtMs ?? this.now());

    return this.database.transaction(() => {
      const existing = this.getByCorrelationId(correlationId);
      if (existing) {
        const expected: RelayMessageCorrelation = {
          correlationId,
          direction: input.direction,
          provider,
          accountId,
          conversationId,
          providerMessageId,
          localMessageId,
          ...(inboundId === undefined ? {} : { inboundId }),
          ...(publicationId === undefined ? {} : { publicationId }),
          createdAtMs: existing.createdAtMs,
        };
        if (!correlationsEqual(existing, expected)) {
          throw new Error(`Correlation ${correlationId} is already mapped to another message`);
        }
        return existing;
      }

      const providerMapping = this.getByProviderMessage(
        input.direction,
        provider,
        accountId,
        conversationId,
        providerMessageId,
      );
      if (providerMapping) {
        throw new Error(
          `Provider message is already mapped by correlation ${providerMapping.correlationId}`,
        );
      }

      this.database
        .prepare(
          `INSERT INTO relay_message_correlations (
             correlation_id,
             direction,
             provider,
             account_id,
             conversation_id,
             provider_message_id,
             local_message_id,
             inbound_id,
             publication_id,
             created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          correlationId,
          input.direction,
          provider,
          accountId,
          conversationId,
          providerMessageId,
          localMessageId,
          inboundId ?? null,
          publicationId ?? null,
          createdAtMs,
        );
      return this.requireByCorrelationId(correlationId);
    });
  }

  getByCorrelationId(correlationId: string): RelayMessageCorrelation | undefined {
    requireRelayText("correlationId", correlationId);
    const row = this.database
      .prepare(
        `SELECT
           correlation_id,
           direction,
           provider,
           account_id,
           conversation_id,
           provider_message_id,
           local_message_id,
           inbound_id,
           publication_id,
           created_at_ms
         FROM relay_message_correlations
         WHERE correlation_id = ?`,
      )
      .get(correlationId);
    return row === undefined
      ? undefined
      : correlationFromRow(requireRelayRow(row, "relay correlation by id"));
  }

  getByProviderMessage(
    direction: RelayMessageDirection,
    provider: string,
    accountId: string,
    conversationId: string,
    providerMessageId: string,
  ): RelayMessageCorrelation | undefined {
    requireDirection(direction);
    requireRelayText("provider", provider);
    requireRelayText("accountId", accountId);
    requireRelayText("conversationId", conversationId);
    requireRelayText("providerMessageId", providerMessageId);
    const row = this.database
      .prepare(
        `SELECT
           correlation_id,
           direction,
           provider,
           account_id,
           conversation_id,
           provider_message_id,
           local_message_id,
           inbound_id,
           publication_id,
           created_at_ms
         FROM relay_message_correlations
         WHERE
           direction = ?
           AND provider = ?
           AND account_id = ?
           AND conversation_id = ?
           AND provider_message_id = ?`,
      )
      .get(direction, provider, accountId, conversationId, providerMessageId);
    return row === undefined
      ? undefined
      : correlationFromRow(requireRelayRow(row, "relay correlation by provider message"));
  }

  listByLocalMessage(localMessageId: string): RelayMessageCorrelation[] {
    requireRelayText("localMessageId", localMessageId);
    const rows = this.database
      .prepare(
        `SELECT
           correlation_id,
           direction,
           provider,
           account_id,
           conversation_id,
           provider_message_id,
           local_message_id,
           inbound_id,
           publication_id,
           created_at_ms
         FROM relay_message_correlations
         WHERE local_message_id = ?
         ORDER BY created_at_ms ASC, correlation_id ASC`,
      )
      .all(localMessageId);
    return rows.map((row) =>
      correlationFromRow(requireRelayRow(row, "relay correlation by local message")),
    );
  }

  private requireByCorrelationId(correlationId: string): RelayMessageCorrelation {
    const correlation = this.getByCorrelationId(correlationId);
    if (!correlation) {
      throw new Error(`Relay correlation disappeared during write: ${correlationId}`);
    }
    return correlation;
  }
}

function correlationFromRow(row: RelayDatabaseRow): RelayMessageCorrelation {
  const inboundId = relayNullableTextColumn(row, "inbound_id");
  const publicationId = relayNullableTextColumn(row, "publication_id");
  return {
    correlationId: relayTextColumn(row, "correlation_id"),
    direction: relayDirectionColumn(row),
    provider: relayTextColumn(row, "provider"),
    accountId: relayTextColumn(row, "account_id"),
    conversationId: relayTextColumn(row, "conversation_id"),
    providerMessageId: relayTextColumn(row, "provider_message_id"),
    localMessageId: relayTextColumn(row, "local_message_id"),
    ...(inboundId === undefined ? {} : { inboundId }),
    ...(publicationId === undefined ? {} : { publicationId }),
    createdAtMs: relayIntegerColumn(row, "created_at_ms"),
  };
}

function correlationsEqual(left: RelayMessageCorrelation, right: RelayMessageCorrelation): boolean {
  return (
    left.correlationId === right.correlationId &&
    left.direction === right.direction &&
    left.provider === right.provider &&
    left.accountId === right.accountId &&
    left.conversationId === right.conversationId &&
    left.providerMessageId === right.providerMessageId &&
    left.localMessageId === right.localMessageId &&
    left.inboundId === right.inboundId &&
    left.publicationId === right.publicationId
  );
}

function requireDirection(direction: RelayMessageDirection): void {
  if (direction !== "inbound" && direction !== "outbound") {
    throw new Error(`Unsupported relay message direction: ${String(direction)}`);
  }
}

function relayDirectionColumn(row: RelayDatabaseRow): RelayMessageDirection {
  const direction = relayTextColumn(row, "direction");
  if (direction !== "inbound" && direction !== "outbound") {
    throw new Error(`Invalid relay message direction in SQLite: ${direction}`);
  }
  return direction;
}
