import {
  RelayDatabase,
  relayNullableTextColumn,
  relayTextColumn,
  requireRelayRow,
} from "../../relay-database";

export interface StoredWhatsAppRelaySession {
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly kind: "fixed-agent" | "conversation";
  readonly role?: "new-chats" | "progress" | "information-control";
  readonly groupId: string;
  readonly title: string;
  readonly priority: "foreground" | "control" | "background";
  readonly agentId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredWhatsAppRelayBinding {
  readonly bindingId: string;
  readonly groupId: string;
  readonly role: "new-chats" | "progress" | "information-control" | "session";
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredWhatsAppRelayCorrelation {
  readonly correlationId: string;
  readonly groupId: string;
  readonly providerMessageId: string;
  readonly publicationId: string;
  readonly sourceSessionId?: string;
  readonly sourceTurnId?: string;
  readonly createdAt: string;
}

export interface StoredWhatsAppMessageSessionRoute {
  readonly groupId: string;
  readonly providerMessageId: string;
  readonly sessionId: string;
  readonly direction: "inbound" | "outbound";
  readonly createdAt: string;
}

export class WhatsAppFixedAgentStore {
  private readonly database: RelayDatabase;

  constructor(databasePath: string) {
    this.database = new RelayDatabase(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS whatsapp_fixed_agent_sessions (
        idempotency_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('fixed-agent', 'conversation')),
        role TEXT CHECK (role IN ('new-chats', 'progress', 'information-control')),
        group_id TEXT NOT NULL,
        title TEXT NOT NULL,
        priority TEXT NOT NULL CHECK (priority IN ('foreground', 'control', 'background')),
        agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS whatsapp_fixed_agent_sessions_group_idx
        ON whatsapp_fixed_agent_sessions (group_id, kind);

      CREATE TABLE IF NOT EXISTS whatsapp_fixed_agent_bindings (
        binding_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (
          role IN ('new-chats', 'progress', 'information-control', 'session')
        ),
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS whatsapp_fixed_agent_bindings_session_idx
        ON whatsapp_fixed_agent_bindings (session_id);

      CREATE TABLE IF NOT EXISTS whatsapp_fixed_agent_processed_messages (
        provider_message_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        processed_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS whatsapp_fixed_agent_message_claims (
        provider_message_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
        claimed_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS whatsapp_fixed_agent_correlations (
        correlation_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        provider_message_id TEXT NOT NULL,
        publication_id TEXT NOT NULL UNIQUE,
        source_session_id TEXT,
        source_turn_id TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS whatsapp_message_session_routes (
        group_id TEXT NOT NULL,
        provider_message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (group_id, provider_message_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS whatsapp_message_session_routes_session_idx
        ON whatsapp_message_session_routes (session_id, created_at);
    `);
  }

  close(): void {
    this.database.close();
  }

  beginMessageProcessing(
    providerMessageId: string,
    groupId: string,
    claimedAt: string,
  ): "claimed" | "completed" {
    return this.database.transaction(() => {
      const legacy = this.database
        .prepare(
          `SELECT provider_message_id
           FROM whatsapp_fixed_agent_processed_messages
           WHERE provider_message_id = ?`,
        )
        .get(providerMessageId);
      if (legacy !== undefined) return "completed";
      const existing = this.database
        .prepare(
          `SELECT state
           FROM whatsapp_fixed_agent_message_claims
           WHERE provider_message_id = ?`,
        )
        .get(providerMessageId);
      if (existing !== undefined) {
        const row = requireRelayRow(existing, "WhatsApp fixed-agent message claim");
        if (relayTextColumn(row, "state") === "completed") return "completed";
        this.database
          .prepare(
            `UPDATE whatsapp_fixed_agent_message_claims
             SET group_id = ?, claimed_at = ?
             WHERE provider_message_id = ? AND state = 'pending'`,
          )
          .run(groupId, claimedAt, providerMessageId);
        return "claimed";
      }
      this.database
        .prepare(
          `INSERT INTO whatsapp_fixed_agent_message_claims (
             provider_message_id, group_id, state, claimed_at, completed_at
           ) VALUES (?, ?, 'pending', ?, NULL)`,
        )
        .run(providerMessageId, groupId, claimedAt);
      return "claimed";
    });
  }

  completeMessageProcessing(providerMessageId: string, completedAt: string): void {
    const result = this.database
      .prepare(
        `UPDATE whatsapp_fixed_agent_message_claims
         SET state = 'completed', completed_at = ?
         WHERE provider_message_id = ? AND state = 'pending'`,
      )
      .run(completedAt, providerMessageId);
    if (result.changes !== 1) {
      throw new Error(`WhatsApp fixed-agent message claim is not pending: ${providerMessageId}`);
    }
  }

  getSessionByIdempotencyKey(idempotencyKey: string): StoredWhatsAppRelaySession | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM whatsapp_fixed_agent_sessions
         WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey);
    return row === undefined ? undefined : parseSession(row);
  }

  getSessionById(sessionId: string): StoredWhatsAppRelaySession | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM whatsapp_fixed_agent_sessions
         WHERE session_id = ?`,
      )
      .get(sessionId);
    return row === undefined ? undefined : parseSession(row);
  }

  listSessions(): StoredWhatsAppRelaySession[] {
    return this.database
      .prepare(
        `SELECT * FROM whatsapp_fixed_agent_sessions
         ORDER BY updated_at DESC, session_id ASC`,
      )
      .all()
      .map(parseSession);
  }

  upsertSession(session: StoredWhatsAppRelaySession): void {
    this.database
      .prepare(
        `INSERT INTO whatsapp_fixed_agent_sessions (
          idempotency_key, session_id, kind, role, group_id, title, priority,
          agent_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET
          session_id = excluded.session_id,
          kind = excluded.kind,
          role = excluded.role,
          group_id = excluded.group_id,
          title = excluded.title,
          priority = excluded.priority,
          agent_id = excluded.agent_id,
          updated_at = excluded.updated_at`,
      )
      .run(
        session.idempotencyKey,
        session.sessionId,
        session.kind,
        session.role ?? null,
        session.groupId,
        session.title,
        session.priority,
        session.agentId ?? null,
        session.createdAt,
        session.updatedAt,
      );
  }

  replaceSessionById(session: StoredWhatsAppRelaySession): boolean {
    const result = this.database
      .prepare(
        `UPDATE whatsapp_fixed_agent_sessions
         SET
           idempotency_key = ?,
           kind = ?,
           role = ?,
           group_id = ?,
           title = ?,
           priority = ?,
           agent_id = ?,
           created_at = ?,
           updated_at = ?
         WHERE session_id = ?`,
      )
      .run(
        session.idempotencyKey,
        session.kind,
        session.role ?? null,
        session.groupId,
        session.title,
        session.priority,
        session.agentId ?? null,
        session.createdAt,
        session.updatedAt,
        session.sessionId,
      );
    return result.changes > 0;
  }

  getBindingByGroup(groupId: string): StoredWhatsAppRelayBinding | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM whatsapp_fixed_agent_bindings
         WHERE group_id = ?`,
      )
      .get(groupId);
    return row === undefined ? undefined : parseBinding(row);
  }

  getBindingById(bindingId: string): StoredWhatsAppRelayBinding | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM whatsapp_fixed_agent_bindings
         WHERE binding_id = ?`,
      )
      .get(bindingId);
    return row === undefined ? undefined : parseBinding(row);
  }

  listBindingsBySession(sessionId: string): StoredWhatsAppRelayBinding[] {
    return this.database
      .prepare(
        `SELECT * FROM whatsapp_fixed_agent_bindings
         WHERE session_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(sessionId)
      .map(parseBinding);
  }

  upsertBinding(binding: StoredWhatsAppRelayBinding): void {
    this.database
      .prepare(
        `INSERT INTO whatsapp_fixed_agent_bindings (
          binding_id, group_id, role, session_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(group_id) DO UPDATE SET
          binding_id = excluded.binding_id,
          role = excluded.role,
          session_id = excluded.session_id,
          updated_at = excluded.updated_at`,
      )
      .run(
        binding.bindingId,
        binding.groupId,
        binding.role,
        binding.sessionId,
        binding.createdAt,
        binding.updatedAt,
      );
  }

  deleteBinding(bindingId: string): void {
    this.database
      .prepare("DELETE FROM whatsapp_fixed_agent_bindings WHERE binding_id = ?")
      .run(bindingId);
  }

  deleteOtherBindingsForSession(sessionId: string, groupId: string): void {
    this.database
      .prepare(
        `DELETE FROM whatsapp_fixed_agent_bindings
         WHERE session_id = ? AND group_id <> ? AND role = 'session'`,
      )
      .run(sessionId, groupId);
  }

  deleteSessionAccessPoint(sessionId: string): void {
    this.database.transaction(() => {
      const groups = this.listBindingsBySession(sessionId)
        .filter((binding) => binding.role === "session")
        .map((binding) => binding.groupId);
      for (const groupId of groups) {
        this.database
          .prepare("DELETE FROM whatsapp_message_session_routes WHERE group_id = ?")
          .run(groupId);
        this.database
          .prepare("DELETE FROM whatsapp_fixed_agent_correlations WHERE group_id = ?")
          .run(groupId);
        this.database
          .prepare("DELETE FROM whatsapp_fixed_agent_processed_messages WHERE group_id = ?")
          .run(groupId);
        this.database
          .prepare("DELETE FROM whatsapp_fixed_agent_message_claims WHERE group_id = ?")
          .run(groupId);
      }
      this.database
        .prepare(
          `DELETE FROM whatsapp_fixed_agent_bindings
           WHERE session_id = ? AND role = 'session'`,
        )
        .run(sessionId);
      this.database
        .prepare(
          `DELETE FROM whatsapp_fixed_agent_sessions
           WHERE
             session_id = ?
             AND kind = 'conversation'
             AND NOT EXISTS (
               SELECT 1
               FROM whatsapp_fixed_agent_bindings
               WHERE session_id = ? AND role <> 'session'
             )`,
        )
        .run(sessionId, sessionId);
    });
  }

  getCorrelation(correlationId: string): StoredWhatsAppRelayCorrelation | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM whatsapp_fixed_agent_correlations
         WHERE correlation_id = ?`,
      )
      .get(correlationId);
    return row === undefined ? undefined : parseCorrelation(row);
  }

  getCorrelationByProviderMessageId(
    providerMessageId: string,
    groupId: string,
  ): StoredWhatsAppRelayCorrelation | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM whatsapp_fixed_agent_correlations
         WHERE provider_message_id = ? AND group_id = ?`,
      )
      .get(providerMessageId, groupId);
    return row === undefined ? undefined : parseCorrelation(row);
  }

  getCorrelationByPublicationId(publicationId: string): StoredWhatsAppRelayCorrelation | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM whatsapp_fixed_agent_correlations
         WHERE publication_id = ?`,
      )
      .get(publicationId);
    return row === undefined ? undefined : parseCorrelation(row);
  }

  upsertCorrelation(correlation: StoredWhatsAppRelayCorrelation): void {
    this.database
      .prepare(
        `INSERT INTO whatsapp_fixed_agent_correlations (
          correlation_id, group_id, provider_message_id, publication_id,
          source_session_id, source_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(correlation_id) DO UPDATE SET
          group_id = excluded.group_id,
          provider_message_id = excluded.provider_message_id,
          publication_id = excluded.publication_id,
          source_session_id = excluded.source_session_id,
          source_turn_id = excluded.source_turn_id`,
      )
      .run(
        correlation.correlationId,
        correlation.groupId,
        correlation.providerMessageId,
        correlation.publicationId,
        correlation.sourceSessionId ?? null,
        correlation.sourceTurnId ?? null,
        correlation.createdAt,
      );
  }

  getMessageSessionRoute(
    groupId: string,
    providerMessageId: string,
  ): StoredWhatsAppMessageSessionRoute | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM whatsapp_message_session_routes
         WHERE group_id = ? AND provider_message_id = ?`,
      )
      .get(groupId, providerMessageId);
    return row === undefined ? undefined : parseMessageSessionRoute(row);
  }

  upsertMessageSessionRoute(route: StoredWhatsAppMessageSessionRoute): void {
    this.database
      .prepare(
        `INSERT INTO whatsapp_message_session_routes (
          group_id, provider_message_id, session_id, direction, created_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(group_id, provider_message_id) DO UPDATE SET
          session_id = excluded.session_id,
          direction = excluded.direction`,
      )
      .run(
        route.groupId,
        route.providerMessageId,
        route.sessionId,
        route.direction,
        route.createdAt,
      );
  }
}

function parseSession(value: unknown): StoredWhatsAppRelaySession {
  const row = requireRelayRow(value, "WhatsApp fixed-agent session");
  const kind = relayTextColumn(row, "kind");
  const role = relayNullableTextColumn(row, "role");
  const priority = relayTextColumn(row, "priority");
  if (kind !== "fixed-agent" && kind !== "conversation") {
    throw new Error("Stored WhatsApp relay session kind is invalid");
  }
  if (
    role !== undefined &&
    role !== "new-chats" &&
    role !== "progress" &&
    role !== "information-control"
  ) {
    throw new Error("Stored WhatsApp relay session role is invalid");
  }
  if (priority !== "foreground" && priority !== "control" && priority !== "background") {
    throw new Error("Stored WhatsApp relay session priority is invalid");
  }
  const agentId = relayNullableTextColumn(row, "agent_id");
  return {
    idempotencyKey: relayTextColumn(row, "idempotency_key"),
    sessionId: relayTextColumn(row, "session_id"),
    kind,
    ...(role ? { role } : {}),
    groupId: relayTextColumn(row, "group_id"),
    title: relayTextColumn(row, "title"),
    priority,
    ...(agentId ? { agentId } : {}),
    createdAt: relayTextColumn(row, "created_at"),
    updatedAt: relayTextColumn(row, "updated_at"),
  };
}

function parseBinding(value: unknown): StoredWhatsAppRelayBinding {
  const row = requireRelayRow(value, "WhatsApp fixed-agent binding");
  const role = relayTextColumn(row, "role");
  if (
    role !== "new-chats" &&
    role !== "progress" &&
    role !== "information-control" &&
    role !== "session"
  ) {
    throw new Error("Stored WhatsApp relay binding role is invalid");
  }
  return {
    bindingId: relayTextColumn(row, "binding_id"),
    groupId: relayTextColumn(row, "group_id"),
    role,
    sessionId: relayTextColumn(row, "session_id"),
    createdAt: relayTextColumn(row, "created_at"),
    updatedAt: relayTextColumn(row, "updated_at"),
  };
}

function parseCorrelation(value: unknown): StoredWhatsAppRelayCorrelation {
  const row = requireRelayRow(value, "WhatsApp relay correlation");
  const sourceSessionId = relayNullableTextColumn(row, "source_session_id");
  const sourceTurnId = relayNullableTextColumn(row, "source_turn_id");
  return {
    correlationId: relayTextColumn(row, "correlation_id"),
    groupId: relayTextColumn(row, "group_id"),
    providerMessageId: relayTextColumn(row, "provider_message_id"),
    publicationId: relayTextColumn(row, "publication_id"),
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(sourceTurnId ? { sourceTurnId } : {}),
    createdAt: relayTextColumn(row, "created_at"),
  };
}

function parseMessageSessionRoute(value: unknown): StoredWhatsAppMessageSessionRoute {
  const row = requireRelayRow(value, "WhatsApp message session route");
  const direction = relayTextColumn(row, "direction");
  if (direction !== "inbound" && direction !== "outbound") {
    throw new Error("Stored WhatsApp message session route direction is invalid");
  }
  return {
    groupId: relayTextColumn(row, "group_id"),
    providerMessageId: relayTextColumn(row, "provider_message_id"),
    sessionId: relayTextColumn(row, "session_id"),
    direction,
    createdAt: relayTextColumn(row, "created_at"),
  };
}
