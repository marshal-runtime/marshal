import * as fs from "node:fs";
import * as path from "node:path";

import { secureMkdirSync } from "../platform-security";

export const RELAY_DATABASE_SCHEMA_VERSION = 3;

type DatabaseSync = import("node:sqlite").DatabaseSync;
type StatementSync = import("node:sqlite").StatementSync;
export type RelayDatabaseRow = Record<string, unknown>;

export class RelayDatabase {
  private readonly database: DatabaseSync;
  private transactionDepth = 0;
  private nextSavepoint = 1;
  private closed = false;

  constructor(readonly databasePath: string) {
    requireRelayText("databasePath", databasePath);
    if (databasePath !== ":memory:") {
      const parentDirectory = path.dirname(path.resolve(databasePath));
      if (!fs.existsSync(parentDirectory)) secureMkdirSync(parentDirectory, 0o700);
    }

    const sqlite = process.getBuiltinModule("node:sqlite") as
      | typeof import("node:sqlite")
      | undefined;
    if (!sqlite) throw new Error("Built-in SQLite is unavailable");

    this.database = new sqlite.DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
    });
    try {
      this.database.exec("PRAGMA busy_timeout = 5000");
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA synchronous = FULL");
      this.database.exec("PRAGMA foreign_keys = ON");
      this.migrate();
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  prepare(sql: string): StatementSync {
    this.assertOpen();
    return this.database.prepare(sql);
  }

  exec(sql: string): void {
    this.assertOpen();
    this.database.exec(sql);
  }

  transaction<T>(work: () => T): T {
    this.assertOpen();
    const outermost = this.transactionDepth === 0;
    const savepoint = outermost ? undefined : `relay_${this.nextSavepoint++}`;
    this.database.exec(outermost ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;

    try {
      const result = work();
      this.database.exec(outermost ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        this.database.exec(
          outermost
            ? "ROLLBACK"
            : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`,
        );
      } catch (rollbackError) {
        const transactionDetail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Relay SQLite transaction failed (${transactionDetail}) and rollback also failed`,
          {
            cause: rollbackError,
          },
        );
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  getSchemaVersion(): number {
    this.assertOpen();
    const row = requireRelayRow(
      this.database.prepare("PRAGMA user_version").get(),
      "relay schema version",
    );
    return relayIntegerColumn(row, "user_version");
  }

  close(): void {
    if (this.closed) return;
    if (this.transactionDepth !== 0) {
      throw new Error("Cannot close the relay database during a transaction");
    }
    this.database.close();
    this.closed = true;
  }

  private migrate(): void {
    const currentVersion = this.getSchemaVersion();
    if (currentVersion > RELAY_DATABASE_SCHEMA_VERSION) {
      throw new Error(
        `Relay database schema ${currentVersion} is newer than supported schema ${RELAY_DATABASE_SCHEMA_VERSION}`,
      );
    }
    if (currentVersion === RELAY_DATABASE_SCHEMA_VERSION) return;

    this.transaction(() => {
      const lockedVersion = this.getSchemaVersion();
      if (lockedVersion > RELAY_DATABASE_SCHEMA_VERSION) {
        throw new Error(
          `Relay database schema ${lockedVersion} is newer than supported schema ${RELAY_DATABASE_SCHEMA_VERSION}`,
        );
      }
      if (lockedVersion < 1) {
        this.database.exec(`
          CREATE TABLE relay_bindings (
            binding_id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            account_id TEXT NOT NULL,
            external_conversation_id TEXT NOT NULL,
            local_conversation_id TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            UNIQUE (provider, account_id, external_conversation_id)
          ) STRICT;

          CREATE INDEX relay_bindings_local_conversation_idx
            ON relay_bindings (local_conversation_id, provider, account_id);

          CREATE TABLE relay_inbound_journal (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            inbound_id TEXT NOT NULL UNIQUE,
            correlation_id TEXT NOT NULL UNIQUE,
            provider TEXT NOT NULL,
            account_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            provider_message_id TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('accepted', 'enqueued')),
            local_message_id TEXT,
            accepted_at_ms INTEGER NOT NULL,
            enqueued_at_ms INTEGER,
            UNIQUE (provider, account_id, conversation_id, provider_message_id),
            CHECK (
              (state = 'accepted' AND local_message_id IS NULL AND enqueued_at_ms IS NULL)
              OR
              (state = 'enqueued' AND local_message_id IS NOT NULL AND enqueued_at_ms IS NOT NULL)
            )
          ) STRICT;

          CREATE INDEX relay_inbound_journal_pending_idx
            ON relay_inbound_journal (state, sequence);

          CREATE TABLE relay_publications (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            publication_id TEXT NOT NULL UNIQUE,
            correlation_id TEXT NOT NULL UNIQUE,
            provider TEXT NOT NULL,
            account_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            local_message_id TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            priority INTEGER NOT NULL,
            state TEXT NOT NULL CHECK (
              state IN (
                'pending',
                'leased',
                'sending',
                'sent',
                'ambiguous',
                'failed',
                'superseded'
              )
            ),
            attempts INTEGER NOT NULL CHECK (attempts >= 0),
            max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
            next_attempt_at_ms INTEGER NOT NULL,
            lease_id TEXT,
            lease_owner TEXT,
            lease_expires_at_ms INTEGER,
            sending_at_ms INTEGER,
            sent_at_ms INTEGER,
            provider_message_id TEXT,
            last_error TEXT,
            superseded_by TEXT,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            CHECK (
              (
                state IN ('leased', 'sending')
                AND lease_id IS NOT NULL
                AND lease_owner IS NOT NULL
                AND lease_expires_at_ms IS NOT NULL
              )
              OR
              (
                state NOT IN ('leased', 'sending')
                AND lease_id IS NULL
                AND lease_owner IS NULL
                AND lease_expires_at_ms IS NULL
              )
            ),
            CHECK (
              (state = 'sent' AND sent_at_ms IS NOT NULL)
              OR (state <> 'sent' AND sent_at_ms IS NULL)
            ),
            CHECK (
              (state = 'superseded' AND superseded_by IS NOT NULL)
              OR (state <> 'superseded' AND superseded_by IS NULL)
            ),
            CHECK (attempts <= max_attempts),
            CHECK (state <> 'sending' OR sending_at_ms IS NOT NULL),
            CHECK (state NOT IN ('ambiguous', 'failed') OR last_error IS NOT NULL)
          ) STRICT;

          CREATE INDEX relay_publications_ready_idx
            ON relay_publications (state, next_attempt_at_ms, priority DESC, sequence ASC);

          CREATE INDEX relay_publications_route_idx
            ON relay_publications (provider, account_id, conversation_id, sequence);

          CREATE TABLE relay_message_correlations (
            correlation_id TEXT PRIMARY KEY,
            direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
            provider TEXT NOT NULL,
            account_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            provider_message_id TEXT NOT NULL,
            local_message_id TEXT NOT NULL,
            inbound_id TEXT,
            publication_id TEXT,
            created_at_ms INTEGER NOT NULL,
            CHECK (
              (
                direction = 'inbound'
                AND inbound_id IS NOT NULL
                AND publication_id IS NULL
              )
              OR
              (
                direction = 'outbound'
                AND inbound_id IS NULL
                AND publication_id IS NOT NULL
              )
            ),
            FOREIGN KEY (inbound_id)
              REFERENCES relay_inbound_journal (inbound_id)
              ON DELETE CASCADE,
            FOREIGN KEY (publication_id)
              REFERENCES relay_publications (publication_id)
              ON DELETE CASCADE
          ) STRICT;

          CREATE UNIQUE INDEX relay_message_correlations_provider_message_idx
            ON relay_message_correlations (
              direction,
              provider,
              account_id,
              conversation_id,
              provider_message_id
            );

          CREATE INDEX relay_message_correlations_local_message_idx
            ON relay_message_correlations (local_message_id, direction, created_at_ms);
        `);
      }
      if (lockedVersion < 2) {
        this.database.exec(`
         ALTER TABLE relay_bindings
           ADD COLUMN role TEXT NOT NULL DEFAULT 'session'
           CHECK (
             role IN (
               'new-chats',
               'progress',
               'information-control',
               'session'
             )
           );

         CREATE TABLE relay_binding_activity (
           binding_id TEXT PRIMARY KEY,
           last_inbound_at_ms INTEGER,
           last_publication_at_ms INTEGER,
           last_session_activity_at_ms INTEGER,
           last_progress_prompt_at_ms INTEGER,
           updated_at_ms INTEGER NOT NULL,
           FOREIGN KEY (binding_id)
             REFERENCES relay_bindings (binding_id)
             ON DELETE CASCADE
         ) STRICT;

         CREATE INDEX relay_binding_activity_updated_idx
           ON relay_binding_activity (updated_at_ms, binding_id);
       `);
      }
      if (lockedVersion < 3) {
        this.database.exec(`
          CREATE TABLE relay_binding_retirements (
            binding_id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            account_id TEXT NOT NULL,
            external_conversation_id TEXT NOT NULL,
            local_conversation_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK (
              role IN (
                'new-chats',
                'progress',
                'information-control',
                'session'
              )
            ),
            binding_created_at_ms INTEGER NOT NULL,
            binding_updated_at_ms INTEGER NOT NULL,
            requested_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            last_error TEXT,
            FOREIGN KEY (binding_id)
              REFERENCES relay_bindings (binding_id)
              ON DELETE CASCADE
          ) STRICT;

          CREATE INDEX relay_binding_retirements_account_idx
            ON relay_binding_retirements (provider, account_id, requested_at_ms, binding_id);

          CREATE INDEX relay_binding_retirements_session_idx
            ON relay_binding_retirements (local_conversation_id, requested_at_ms, binding_id);
        `);
      }
      if (lockedVersion < RELAY_DATABASE_SCHEMA_VERSION) {
        this.database.exec(`PRAGMA user_version = ${RELAY_DATABASE_SCHEMA_VERSION}`);
      }
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Relay database is closed");
  }
}

export function requireRelayText(name: string, value: string): string {
  if (!value.trim()) throw new Error(`${name} is required`);
  if (value.includes("\0")) throw new Error(`${name} cannot contain a null byte`);
  return value;
}

export function requireRelayInteger(name: string, value: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

export function boundedRelayLimit(limit: number, maximum = 1000): number {
  requireRelayInteger("limit", limit, 1);
  return Math.min(limit, maximum);
}

export function requireRelayRow(value: unknown, context: string): RelayDatabaseRow {
  if (!isRelayRow(value)) throw new Error(`Invalid SQLite row for ${context}`);
  return value;
}

export function relayTextColumn(row: RelayDatabaseRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`Invalid SQLite text column: ${column}`);
  }
  return value;
}

export function relayNullableTextColumn(row: RelayDatabaseRow, column: string): string | undefined {
  const value = row[column];
  if (value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid nullable SQLite text column: ${column}`);
  }
  return value;
}

export function relayIntegerColumn(row: RelayDatabaseRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid SQLite integer column: ${column}`);
  }
  return value;
}

export function relayNullableIntegerColumn(
  row: RelayDatabaseRow,
  column: string,
): number | undefined {
  const value = row[column];
  if (value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid nullable SQLite integer column: ${column}`);
  }
  return value;
}

function isRelayRow(value: unknown): value is RelayDatabaseRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
