import * as fs from "node:fs";
import * as path from "node:path";

import { COPILOT_RUNTIME_ID } from "../common/runtime-config";
import { getAppDataDir } from "./app-paths";

interface ArchivedTurnRow {
  id: number;
  turn_index: number;
  user_message: string | null;
  assistant_response: string | null;
  timestamp: string | null;
}

interface ArchivedSessionRow {
  id: string;
  cwd: string | null;
  repository: string | null;
  summary: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ArchivedSessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface ArchivedSessionMetadata {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  hasUnread: false;
  isActive: false;
  repoPath?: string;
  runtimeId: "copilot";
  backendOrigin: "copilot";
}

export interface ArchivedSessionMessagesPage {
  messages: ArchivedSessionMessage[];
  total: number;
  hasMore: boolean;
}

export class ReadOnlySessionArchive {
  private database: import("node:sqlite").DatabaseSync | null = null;
  private openPath: string | null = null;

  constructor(private readonly databasePath?: string) {}

  dispose(): void {
    this.close();
  }

  loadMessages(sessionId: string): ArchivedSessionMessage[] {
    const database = this.getDatabase();
    if (!database) return [];
    const rows: unknown = database
      .prepare(
        `SELECT id, turn_index, user_message, assistant_response, timestamp
         FROM turns
         WHERE session_id = ?
         ORDER BY turn_index ASC, id ASC`,
      )
      .all(sessionId);
    if (!Array.isArray(rows)) return [];
    return rows.filter(isArchivedTurnRow).flatMap((row) => messagesForArchivedTurn(sessionId, row));
  }

  loadMessagesTail(sessionId: string, maxMessages: number): ArchivedSessionMessagesPage {
    const messages = this.loadMessages(sessionId);
    const limit = Math.max(0, Math.floor(maxMessages));
    const tail = limit > 0 ? messages.slice(-limit) : [];
    return {
      messages: tail,
      total: messages.length,
      hasMore: messages.length > tail.length,
    };
  }

  countMessages(sessionId: string): number {
    const database = this.getDatabase();
    if (!database) return 0;
    const row: unknown = database
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN LENGTH(TRIM(user_message)) > 0 THEN 1 ELSE 0 END), 0) +
           COALESCE(SUM(CASE WHEN LENGTH(TRIM(assistant_response)) > 0 THEN 1 ELSE 0 END), 0)
           AS message_count
         FROM turns
         WHERE session_id = ?`,
      )
      .get(sessionId);
    if (!isUnknownRecord(row)) return 0;
    const messageCount: unknown = Reflect.get(row, "message_count");
    return typeof messageCount === "number" && Number.isFinite(messageCount) ? messageCount : 0;
  }

  loadMetadata(sessionId: string): ArchivedSessionMetadata | null {
    const database = this.getDatabase();
    if (!database) return null;
    const row: unknown = database
      .prepare(
        `SELECT id, cwd, repository, summary, created_at, updated_at
         FROM sessions
         WHERE id = ?`,
      )
      .get(sessionId);
    if (!isArchivedSessionRow(row)) return null;
    const createdAt = normalizeArchiveTimestamp(row.created_at);
    return {
      id: row.id,
      name: boundedArchiveName(row.summary, row.repository),
      createdAt,
      updatedAt: normalizeArchiveTimestamp(row.updated_at ?? row.created_at),
      hasUnread: false,
      isActive: false,
      ...(row.cwd?.trim() ? { repoPath: row.cwd.trim() } : {}),
      runtimeId: COPILOT_RUNTIME_ID,
      backendOrigin: "copilot",
    };
  }

  private getDatabase(): import("node:sqlite").DatabaseSync | null {
    const databasePath = this.databasePath ?? path.join(getAppDataDir(), "session-store.db");
    if (!fs.existsSync(databasePath)) {
      this.close();
      return null;
    }
    if (this.database && this.openPath === databasePath) return this.database;
    this.close();
    const sqlite = process.getBuiltinModule("node:sqlite") as
      | typeof import("node:sqlite")
      | undefined;
    if (!sqlite) return null;
    const database = new sqlite.DatabaseSync(databasePath, {
      readOnly: true,
      enableForeignKeyConstraints: false,
    });
    database.exec("PRAGMA query_only = ON");
    this.database = database;
    this.openPath = databasePath;
    return database;
  }

  private close(): void {
    this.database?.close();
    this.database = null;
    this.openPath = null;
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isArchivedTurnRow(value: unknown): value is ArchivedTurnRow {
  if (!isUnknownRecord(value)) return false;
  return (
    typeof value.id === "number" &&
    typeof value.turn_index === "number" &&
    isNullableString(value.user_message) &&
    isNullableString(value.assistant_response) &&
    isNullableString(value.timestamp)
  );
}

function isArchivedSessionRow(value: unknown): value is ArchivedSessionRow {
  if (!isUnknownRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    isNullableString(value.cwd) &&
    isNullableString(value.repository) &&
    isNullableString(value.summary) &&
    isNullableString(value.created_at) &&
    isNullableString(value.updated_at)
  );
}

function messagesForArchivedTurn(
  sessionId: string,
  row: ArchivedTurnRow,
): ArchivedSessionMessage[] {
  const timestamp = normalizeArchiveTimestamp(row.timestamp);
  const messages: ArchivedSessionMessage[] = [];
  const user = normalizeArchiveContent(row.user_message);
  if (user) {
    messages.push({
      id: `archive:${sessionId}:${row.turn_index}:${row.id}:user`,
      role: "user",
      content: user,
      timestamp,
    });
  }
  const assistant = normalizeArchiveContent(row.assistant_response);
  if (assistant) {
    messages.push({
      id: `archive:${sessionId}:${row.turn_index}:${row.id}:assistant`,
      role: "assistant",
      content: assistant,
      timestamp,
    });
  }
  return messages;
}

function normalizeArchiveContent(value: string | null): string | null {
  if (typeof value !== "string") return null;
  return value.trim().length > 0 ? value : null;
}

function normalizeArchiveTimestamp(value: string | null): string {
  if (typeof value === "string") {
    const normalized = value.includes("T") ? value : value.replace(" ", "T");
    const timestamp = Date.parse(
      /[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`,
    );
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return new Date(0).toISOString();
}

function boundedArchiveName(summary: string | null, repository: string | null): string {
  const candidate = summary?.trim() || repository?.trim() || "Recovered session";
  return candidate.slice(0, 200);
}
