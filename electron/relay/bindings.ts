import { randomUUID } from "node:crypto";

import type { RelayManagedGroupRole } from "../../common/relay-experience-contract";
import {
  RelayDatabase,
  type RelayDatabaseRow,
  boundedRelayLimit,
  relayIntegerColumn,
  relayNullableIntegerColumn,
  relayNullableTextColumn,
  relayTextColumn,
  requireRelayInteger,
  requireRelayRow,
  requireRelayText,
} from "./relay-database";

export interface RelayBinding {
  bindingId: string;
  provider: string;
  accountId: string;
  externalConversationId: string;
  localConversationId: string;
  role: RelayManagedGroupRole;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface UpsertRelayBindingInput {
  bindingId?: string;
  provider: string;
  accountId: string;
  externalConversationId: string;
  localConversationId: string;
  role?: RelayManagedGroupRole;
  updatedAtMs?: number;
}

export type RelayBindingActivityKind = "inbound" | "publication" | "session" | "progress";

export interface RelayBindingActivity {
  bindingId: string;
  lastInboundAtMs?: number;
  lastPublicationAtMs?: number;
  lastSessionActivityAtMs?: number;
  lastProgressPromptAtMs?: number;
  updatedAtMs: number;
}

export interface RelayBindingWithActivity {
  binding: RelayBinding;
  activity?: RelayBindingActivity;
}

export interface RelayBindingRetirement extends RelayBinding {
  requestedAtMs: number;
  retirementUpdatedAtMs: number;
  lastError?: string;
}

export interface RelayBindingStoreOptions {
  now?: () => number;
  createId?: () => string;
}

export class RelayBindingStore {
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(
    private readonly database: RelayDatabase,
    options: RelayBindingStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  upsert(input: UpsertRelayBindingInput): RelayBinding {
    const provider = requireRelayText("provider", input.provider);
    const accountId = requireRelayText("accountId", input.accountId);
    const externalConversationId = requireRelayText(
      "externalConversationId",
      input.externalConversationId,
    );
    const localConversationId = requireRelayText("localConversationId", input.localConversationId);
    const role = requireRelayBindingRole(input.role ?? "session");
    const updatedAtMs = requireRelayInteger("updatedAtMs", input.updatedAtMs ?? this.now());

    return this.database.transaction(() => {
      const requestedBindingId =
        input.bindingId === undefined ? undefined : requireRelayText("bindingId", input.bindingId);
      const existingById =
        requestedBindingId === undefined ? undefined : this.getAnyById(requestedBindingId);
      const existingRoute = this.getAnyByExternalConversation(
        provider,
        accountId,
        externalConversationId,
      );
      if (existingById && this.isRetiring(existingById.bindingId)) {
        throw new Error(`Relay binding ${existingById.bindingId} is retiring`);
      }
      if (existingRoute && this.isRetiring(existingRoute.bindingId)) {
        throw new Error(`Relay route is retiring: ${existingRoute.bindingId}`);
      }
      if (existingById) {
        if (existingById.provider !== provider) {
          throw new Error(`Relay binding ${existingById.bindingId} belongs to another provider`);
        }
        if (existingRoute && existingRoute.bindingId !== existingById.bindingId) {
          throw new Error(
            `Relay route is already owned by binding ${existingRoute.bindingId}, not ${existingById.bindingId}`,
          );
        }
        this.database
          .prepare(
            `UPDATE relay_bindings
             SET
               account_id = ?,
               external_conversation_id = ?,
               local_conversation_id = ?,
               role = ?,
               updated_at_ms = ?
             WHERE binding_id = ?`,
          )
          .run(
            accountId,
            externalConversationId,
            localConversationId,
            role,
            updatedAtMs,
            existingById.bindingId,
          );
        return this.requireById(existingById.bindingId);
      }
      if (existingRoute) {
        if (requestedBindingId !== undefined && requestedBindingId !== existingRoute.bindingId) {
          throw new Error(
            `Relay route is already owned by binding ${existingRoute.bindingId}, not ${requestedBindingId}`,
          );
        }
        this.database
          .prepare(
            `UPDATE relay_bindings
             SET local_conversation_id = ?, role = ?, updated_at_ms = ?
             WHERE binding_id = ?`,
          )
          .run(localConversationId, role, updatedAtMs, existingRoute.bindingId);
        return this.requireById(existingRoute.bindingId);
      }

      const bindingId = requestedBindingId ?? requireRelayText("bindingId", this.createId());
      this.database
        .prepare(
          `INSERT INTO relay_bindings (
             binding_id,
             provider,
             account_id,
             external_conversation_id,
             local_conversation_id,
             role,
             created_at_ms,
             updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          bindingId,
          provider,
          accountId,
          externalConversationId,
          localConversationId,
          role,
          updatedAtMs,
          updatedAtMs,
        );
      return this.requireById(bindingId);
    });
  }

  getById(bindingId: string): RelayBinding | undefined {
    requireRelayText("bindingId", bindingId);
    const row = this.database
      .prepare(
        `SELECT
           binding_id,
           provider,
           account_id,
           external_conversation_id,
           local_conversation_id,
           role,
           created_at_ms,
           updated_at_ms
         FROM relay_bindings
         WHERE
           binding_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM relay_binding_retirements r
             WHERE r.binding_id = relay_bindings.binding_id
           )`,
      )
      .get(bindingId);
    return row === undefined
      ? undefined
      : bindingFromRow(requireRelayRow(row, "relay binding by id"));
  }

  getByExternalConversation(
    provider: string,
    accountId: string,
    externalConversationId: string,
  ): RelayBinding | undefined {
    requireRelayText("provider", provider);
    requireRelayText("accountId", accountId);
    requireRelayText("externalConversationId", externalConversationId);
    const row = this.database
      .prepare(
        `SELECT
           binding_id,
           provider,
           account_id,
           external_conversation_id,
           local_conversation_id,
           role,
           created_at_ms,
           updated_at_ms
         FROM relay_bindings
         WHERE
           provider = ?
           AND account_id = ?
           AND external_conversation_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM relay_binding_retirements r
             WHERE r.binding_id = relay_bindings.binding_id
           )`,
      )
      .get(provider, accountId, externalConversationId);
    return row === undefined
      ? undefined
      : bindingFromRow(requireRelayRow(row, "relay binding by external conversation"));
  }

  listByLocalConversation(localConversationId: string): RelayBinding[] {
    requireRelayText("localConversationId", localConversationId);
    const rows = this.database
      .prepare(
        `SELECT
           binding_id,
           provider,
           account_id,
           external_conversation_id,
           local_conversation_id,
           role,
           created_at_ms,
           updated_at_ms
         FROM relay_bindings
         WHERE
           local_conversation_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM relay_binding_retirements r
             WHERE r.binding_id = relay_bindings.binding_id
           )
         ORDER BY created_at_ms ASC, binding_id ASC`,
      )
      .all(localConversationId);
    return rows.map((row) =>
      bindingFromRow(requireRelayRow(row, "relay binding by local conversation")),
    );
  }

  listByProviderExceptAccount(provider: string, accountId: string): RelayBinding[] {
    requireRelayText("provider", provider);
    requireRelayText("accountId", accountId);
    const rows = this.database
      .prepare(
        `SELECT
           binding_id,
           provider,
           account_id,
           external_conversation_id,
           local_conversation_id,
           role,
           created_at_ms,
           updated_at_ms
         FROM relay_bindings
         WHERE
           provider = ?
           AND account_id <> ?
           AND NOT EXISTS (
             SELECT 1 FROM relay_binding_retirements r
             WHERE r.binding_id = relay_bindings.binding_id
           )
         ORDER BY created_at_ms ASC, binding_id ASC`,
      )
      .all(provider, accountId);
    return rows.map((row) =>
      bindingFromRow(requireRelayRow(row, "relay bindings outside account")),
    );
  }

  listSessionAccessPoints(localConversationId: string): RelayBindingWithActivity[] {
    requireRelayText("localConversationId", localConversationId);
    const rows = this.database
      .prepare(
        `${BINDING_WITH_ACTIVITY_SELECT}
         WHERE
           b.local_conversation_id = ?
           AND b.role = 'session'
           AND NOT EXISTS (
             SELECT 1 FROM relay_binding_retirements r
             WHERE r.binding_id = b.binding_id
           )
         ORDER BY b.created_at_ms ASC, b.binding_id ASC`,
      )
      .all(localConversationId);
    return rows.map(bindingWithActivityFromRow);
  }

  listAllSessionAccessPoints(): RelayBindingWithActivity[] {
    const rows = this.database
      .prepare(
        `${BINDING_WITH_ACTIVITY_SELECT}
         WHERE
           b.role = 'session'
           AND NOT EXISTS (
             SELECT 1 FROM relay_binding_retirements r
             WHERE r.binding_id = b.binding_id
           )
         ORDER BY b.local_conversation_id ASC, b.created_at_ms ASC, b.binding_id ASC`,
      )
      .all();
    return rows.map(bindingWithActivityFromRow);
  }

  getPreferredSessionAccessPoint(localConversationId: string): RelayBinding | undefined {
    requireRelayText("localConversationId", localConversationId);
    const row = this.database
      .prepare(
        `${BINDING_WITH_ACTIVITY_SELECT}
         WHERE
           b.local_conversation_id = ?
           AND b.role = 'session'
           AND NOT EXISTS (
             SELECT 1 FROM relay_binding_retirements r
             WHERE r.binding_id = b.binding_id
           )
         ORDER BY
           MAX(
             b.updated_at_ms,
             COALESCE(a.last_inbound_at_ms, 0),
             COALESCE(a.last_publication_at_ms, 0),
             COALESCE(a.last_session_activity_at_ms, 0)
           ) DESC,
           b.updated_at_ms DESC,
           b.binding_id ASC
         LIMIT 1`,
      )
      .get(localConversationId);
    return row === undefined ? undefined : bindingWithActivityFromRow(row).binding;
  }

  getActivity(bindingId: string): RelayBindingActivity | undefined {
    requireRelayText("bindingId", bindingId);
    const row = this.database
      .prepare(
        `SELECT
           binding_id,
           last_inbound_at_ms,
           last_publication_at_ms,
           last_session_activity_at_ms,
           last_progress_prompt_at_ms,
           updated_at_ms
         FROM relay_binding_activity
         WHERE binding_id = ?`,
      )
      .get(bindingId);
    return row === undefined
      ? undefined
      : bindingActivityFromRow(requireRelayRow(row, "relay binding activity"));
  }

  recordActivity(
    bindingId: string,
    kind: RelayBindingActivityKind,
    occurredAtMs = this.now(),
  ): RelayBindingActivity {
    requireRelayText("bindingId", bindingId);
    const timestamp = requireRelayInteger("occurredAtMs", occurredAtMs);
    return this.database.transaction(() => {
      if (!this.getById(bindingId)) throw new Error(`Unknown relay binding: ${bindingId}`);
      const current = this.getActivity(bindingId);
      const activity: RelayBindingActivity = {
        bindingId,
        ...(current?.lastInboundAtMs === undefined
          ? {}
          : { lastInboundAtMs: current.lastInboundAtMs }),
        ...(current?.lastPublicationAtMs === undefined
          ? {}
          : { lastPublicationAtMs: current.lastPublicationAtMs }),
        ...(current?.lastSessionActivityAtMs === undefined
          ? {}
          : { lastSessionActivityAtMs: current.lastSessionActivityAtMs }),
        ...(current?.lastProgressPromptAtMs === undefined
          ? {}
          : { lastProgressPromptAtMs: current.lastProgressPromptAtMs }),
        updatedAtMs: Math.max(current?.updatedAtMs ?? 0, timestamp),
      };
      switch (kind) {
        case "inbound":
          activity.lastInboundAtMs = Math.max(activity.lastInboundAtMs ?? 0, timestamp);
          break;
        case "publication":
          activity.lastPublicationAtMs = Math.max(activity.lastPublicationAtMs ?? 0, timestamp);
          break;
        case "session":
          activity.lastSessionActivityAtMs = Math.max(
            activity.lastSessionActivityAtMs ?? 0,
            timestamp,
          );
          break;
        case "progress":
          activity.lastProgressPromptAtMs = Math.max(
            activity.lastProgressPromptAtMs ?? 0,
            timestamp,
          );
          break;
      }
      this.database
        .prepare(
          `INSERT INTO relay_binding_activity (
             binding_id,
             last_inbound_at_ms,
             last_publication_at_ms,
             last_session_activity_at_ms,
             last_progress_prompt_at_ms,
             updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(binding_id) DO UPDATE SET
             last_inbound_at_ms = excluded.last_inbound_at_ms,
             last_publication_at_ms = excluded.last_publication_at_ms,
             last_session_activity_at_ms = excluded.last_session_activity_at_ms,
             last_progress_prompt_at_ms = excluded.last_progress_prompt_at_ms,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(
          bindingId,
          activity.lastInboundAtMs ?? null,
          activity.lastPublicationAtMs ?? null,
          activity.lastSessionActivityAtMs ?? null,
          activity.lastProgressPromptAtMs ?? null,
          activity.updatedAtMs,
        );
      return this.getActivity(bindingId)!;
    });
  }

  recordSessionActivity(
    localConversationId: string,
    kind: Extract<RelayBindingActivityKind, "session" | "progress">,
    occurredAtMs = this.now(),
  ): RelayBindingActivity[] {
    return this.listSessionAccessPoints(localConversationId).map(({ binding }) =>
      this.recordActivity(binding.bindingId, kind, occurredAtMs),
    );
  }

  listStaleSessionAccessPoints(inactiveBeforeMs: number, limit = 100): RelayBindingWithActivity[] {
    requireRelayInteger("inactiveBeforeMs", inactiveBeforeMs);
    requireRelayInteger("limit", limit, 1);
    const rows = this.database
      .prepare(
        `${BINDING_WITH_ACTIVITY_SELECT}
         WHERE
           b.role = 'session'
           AND NOT EXISTS (
             SELECT 1 FROM relay_binding_retirements r
             WHERE r.binding_id = b.binding_id
           )
           AND MAX(
             b.updated_at_ms,
             COALESCE(a.last_inbound_at_ms, 0),
             COALESCE(a.last_publication_at_ms, 0),
             COALESCE(a.last_session_activity_at_ms, 0)
           ) < ?
         ORDER BY b.updated_at_ms ASC, b.binding_id ASC
         LIMIT ?`,
      )
      .all(inactiveBeforeMs, limit);
    return rows.map(bindingWithActivityFromRow);
  }

  prepareRetirement(bindingId: string, requestedAtMs = this.now()): RelayBindingRetirement {
    requireRelayText("bindingId", bindingId);
    const requestedAt = requireRelayInteger("requestedAtMs", requestedAtMs);
    return this.database.transaction(() => {
      const binding = this.getAnyById(bindingId);
      if (!binding) throw new Error(`Unknown relay binding: ${bindingId}`);
      const existing = this.getRetirement(bindingId);
      if (existing) return existing;
      this.database
        .prepare(
          `INSERT INTO relay_binding_retirements (
             binding_id,
             provider,
             account_id,
             external_conversation_id,
             local_conversation_id,
             role,
             binding_created_at_ms,
             binding_updated_at_ms,
             requested_at_ms,
             updated_at_ms,
             last_error
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          binding.bindingId,
          binding.provider,
          binding.accountId,
          binding.externalConversationId,
          binding.localConversationId,
          binding.role,
          binding.createdAtMs,
          binding.updatedAtMs,
          requestedAt,
          requestedAt,
        );
      return this.requireRetirement(bindingId);
    });
  }

  getRetirement(bindingId: string): RelayBindingRetirement | undefined {
    requireRelayText("bindingId", bindingId);
    const row = this.database
      .prepare(
        `SELECT
           binding_id,
           provider,
           account_id,
           external_conversation_id,
           local_conversation_id,
           role,
           binding_created_at_ms,
           binding_updated_at_ms,
           requested_at_ms,
           updated_at_ms,
           last_error
         FROM relay_binding_retirements
         WHERE binding_id = ?`,
      )
      .get(bindingId);
    return row === undefined
      ? undefined
      : retirementFromRow(requireRelayRow(row, "relay binding retirement"));
  }

  listRetirements(options?: {
    provider?: string;
    accountId?: string;
    localConversationId?: string;
    limit?: number;
  }): RelayBindingRetirement[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options?.provider !== undefined) {
      clauses.push("provider = ?");
      params.push(requireRelayText("provider", options.provider));
    }
    if (options?.accountId !== undefined) {
      clauses.push("account_id = ?");
      params.push(requireRelayText("accountId", options.accountId));
    }
    if (options?.localConversationId !== undefined) {
      clauses.push("local_conversation_id = ?");
      params.push(requireRelayText("localConversationId", options.localConversationId));
    }
    const limit = boundedRelayLimit(options?.limit ?? 1_000);
    params.push(limit);
    const rows = this.database
      .prepare(
        `SELECT
           binding_id,
           provider,
           account_id,
           external_conversation_id,
           local_conversation_id,
           role,
           binding_created_at_ms,
           binding_updated_at_ms,
           requested_at_ms,
           updated_at_ms,
           last_error
         FROM relay_binding_retirements
         ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
         ORDER BY requested_at_ms ASC, binding_id ASC
         LIMIT ?`,
      )
      .all(...params);
    return rows.map((row) =>
      retirementFromRow(requireRelayRow(row, "relay binding retirement listing")),
    );
  }

  recordRetirementError(bindingId: string, error: string, updatedAtMs = this.now()): void {
    requireRelayText("bindingId", bindingId);
    const lastError = requireRelayText("error", error).slice(0, 2_000);
    const updatedAt = requireRelayInteger("updatedAtMs", updatedAtMs);
    this.database
      .prepare(
        `UPDATE relay_binding_retirements
         SET last_error = ?, updated_at_ms = ?
         WHERE binding_id = ?`,
      )
      .run(lastError, updatedAt, bindingId);
  }

  completeRetirement(bindingId: string): boolean {
    requireRelayText("bindingId", bindingId);
    return this.database.transaction(() => {
      if (!this.getRetirement(bindingId)) return false;
      const result = this.database
        .prepare("DELETE FROM relay_bindings WHERE binding_id = ?")
        .run(bindingId);
      return Number(result.changes) === 1;
    });
  }

  cancelRetirement(bindingId: string): boolean {
    requireRelayText("bindingId", bindingId);
    const result = this.database
      .prepare("DELETE FROM relay_binding_retirements WHERE binding_id = ?")
      .run(bindingId);
    return Number(result.changes) === 1;
  }

  reactivateRetirement(input: UpsertRelayBindingInput & { bindingId: string }): RelayBinding {
    requireRelayText("bindingId", input.bindingId);
    return this.database.transaction(() => {
      if (!this.getRetirement(input.bindingId)) {
        throw new Error(`Relay binding is not retiring: ${input.bindingId}`);
      }
      this.cancelRetirement(input.bindingId);
      return this.upsert(input);
    });
  }

  remove(bindingId: string): boolean {
    requireRelayText("bindingId", bindingId);
    const result = this.database
      .prepare("DELETE FROM relay_bindings WHERE binding_id = ?")
      .run(bindingId);
    return Number(result.changes) === 1;
  }

  private requireById(bindingId: string): RelayBinding {
    const binding = this.getById(bindingId);
    if (!binding) throw new Error(`Relay binding disappeared during write: ${bindingId}`);
    return binding;
  }

  private getAnyById(bindingId: string): RelayBinding | undefined {
    const row = this.database
      .prepare(
        `SELECT
           binding_id,
           provider,
           account_id,
           external_conversation_id,
           local_conversation_id,
           role,
           created_at_ms,
           updated_at_ms
         FROM relay_bindings
         WHERE binding_id = ?`,
      )
      .get(bindingId);
    return row === undefined
      ? undefined
      : bindingFromRow(requireRelayRow(row, "relay binding by id including retirement"));
  }

  private getAnyByExternalConversation(
    provider: string,
    accountId: string,
    externalConversationId: string,
  ): RelayBinding | undefined {
    const row = this.database
      .prepare(
        `SELECT
           binding_id,
           provider,
           account_id,
           external_conversation_id,
           local_conversation_id,
           role,
           created_at_ms,
           updated_at_ms
         FROM relay_bindings
         WHERE provider = ? AND account_id = ? AND external_conversation_id = ?`,
      )
      .get(provider, accountId, externalConversationId);
    return row === undefined
      ? undefined
      : bindingFromRow(requireRelayRow(row, "relay binding route including retirement"));
  }

  private isRetiring(bindingId: string): boolean {
    return this.getRetirement(bindingId) !== undefined;
  }

  private requireRetirement(bindingId: string): RelayBindingRetirement {
    const retirement = this.getRetirement(bindingId);
    if (!retirement) throw new Error(`Relay binding retirement disappeared: ${bindingId}`);
    return retirement;
  }
}

function bindingFromRow(row: RelayDatabaseRow): RelayBinding {
  return {
    bindingId: relayTextColumn(row, "binding_id"),
    provider: relayTextColumn(row, "provider"),
    accountId: relayTextColumn(row, "account_id"),
    externalConversationId: relayTextColumn(row, "external_conversation_id"),
    localConversationId: relayTextColumn(row, "local_conversation_id"),
    role: requireRelayBindingRole(relayTextColumn(row, "role")),
    createdAtMs: relayIntegerColumn(row, "created_at_ms"),
    updatedAtMs: relayIntegerColumn(row, "updated_at_ms"),
  };
}

function retirementFromRow(row: RelayDatabaseRow): RelayBindingRetirement {
  const lastError = relayNullableTextColumn(row, "last_error");
  return {
    bindingId: relayTextColumn(row, "binding_id"),
    provider: relayTextColumn(row, "provider"),
    accountId: relayTextColumn(row, "account_id"),
    externalConversationId: relayTextColumn(row, "external_conversation_id"),
    localConversationId: relayTextColumn(row, "local_conversation_id"),
    role: requireRelayBindingRole(relayTextColumn(row, "role")),
    createdAtMs: relayIntegerColumn(row, "binding_created_at_ms"),
    updatedAtMs: relayIntegerColumn(row, "binding_updated_at_ms"),
    requestedAtMs: relayIntegerColumn(row, "requested_at_ms"),
    retirementUpdatedAtMs: relayIntegerColumn(row, "updated_at_ms"),
    ...(lastError === undefined ? {} : { lastError }),
  };
}

const BINDING_WITH_ACTIVITY_SELECT = `SELECT
  b.binding_id,
  b.provider,
  b.account_id,
  b.external_conversation_id,
  b.local_conversation_id,
  b.role,
  b.created_at_ms,
  b.updated_at_ms,
  a.last_inbound_at_ms,
  a.last_publication_at_ms,
  a.last_session_activity_at_ms,
  a.last_progress_prompt_at_ms,
  a.updated_at_ms AS activity_updated_at_ms
FROM relay_bindings b
LEFT JOIN relay_binding_activity a ON a.binding_id = b.binding_id`;

function bindingWithActivityFromRow(value: unknown): RelayBindingWithActivity {
  const row = requireRelayRow(value, "relay binding with activity");
  const activityUpdatedAtMs = relayNullableIntegerColumn(row, "activity_updated_at_ms");
  const lastInboundAtMs = relayNullableIntegerColumn(row, "last_inbound_at_ms");
  const lastPublicationAtMs = relayNullableIntegerColumn(row, "last_publication_at_ms");
  const lastSessionActivityAtMs = relayNullableIntegerColumn(row, "last_session_activity_at_ms");
  const lastProgressPromptAtMs = relayNullableIntegerColumn(row, "last_progress_prompt_at_ms");
  return {
    binding: bindingFromRow(row),
    ...(activityUpdatedAtMs === undefined
      ? {}
      : {
          activity: {
            bindingId: relayTextColumn(row, "binding_id"),
            ...(lastInboundAtMs === undefined ? {} : { lastInboundAtMs }),
            ...(lastPublicationAtMs === undefined ? {} : { lastPublicationAtMs }),
            ...(lastSessionActivityAtMs === undefined ? {} : { lastSessionActivityAtMs }),
            ...(lastProgressPromptAtMs === undefined ? {} : { lastProgressPromptAtMs }),
            updatedAtMs: activityUpdatedAtMs,
          },
        }),
  };
}

function bindingActivityFromRow(row: RelayDatabaseRow): RelayBindingActivity {
  const lastInboundAtMs = relayNullableIntegerColumn(row, "last_inbound_at_ms");
  const lastPublicationAtMs = relayNullableIntegerColumn(row, "last_publication_at_ms");
  const lastSessionActivityAtMs = relayNullableIntegerColumn(row, "last_session_activity_at_ms");
  const lastProgressPromptAtMs = relayNullableIntegerColumn(row, "last_progress_prompt_at_ms");
  return {
    bindingId: relayTextColumn(row, "binding_id"),
    ...(lastInboundAtMs === undefined ? {} : { lastInboundAtMs }),
    ...(lastPublicationAtMs === undefined ? {} : { lastPublicationAtMs }),
    ...(lastSessionActivityAtMs === undefined ? {} : { lastSessionActivityAtMs }),
    ...(lastProgressPromptAtMs === undefined ? {} : { lastProgressPromptAtMs }),
    updatedAtMs: relayIntegerColumn(row, "updated_at_ms"),
  };
}

function requireRelayBindingRole(value: string): RelayManagedGroupRole {
  if (
    value !== "new-chats" &&
    value !== "progress" &&
    value !== "information-control" &&
    value !== "session"
  ) {
    throw new Error(`Invalid relay binding role: ${value}`);
  }
  return value;
}
