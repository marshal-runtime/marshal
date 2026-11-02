import fs from "node:fs";
import path from "node:path";

import type { PermissionAction } from "../common/marshal-constants";
import { createLogger } from "../common/marshal-logger";
import type { ApprovalRequest } from "./backend/types";
import { getCommandText, getServerName, getToolName } from "./permission-policy";
import { secureMkdirSync, secureAppendFile } from "./platform-security";

const log = createLogger("AuditLog");

// --- Types ---

export type AuditDecisionSource =
  | "pre-hook-disabled-server"
  | "pre-hook-tenant-policy"
  | "pre-hook-file-upload-disabled"
  | "pre-hook-blocked-tool"
  | "internal-auto-approve"
  | "policy-auto-approve"
  | "policy-auto-deny"
  | "policy-burst-defuser"
  | "policy-security-gate"
  | "user-interactive"
  | "timeout"
  | "no-window"
  | "no-callback-fallback";

export interface AuditLogEntry {
  /** ISO-8601 UTC timestamp */
  timestamp: string;
  /** Internal session ID */
  sessionId: string;
  /** GitHub username (cached from AuthStatus) */
  userLogin: string;
  /** SDK tool call ID — present for MCP tools only */
  toolCallId?: string;
  /** Permission kind */
  kind: string;
  /** Tool name (MCP tool name or "") */
  toolName: string;
  /** MCP server name or "" */
  serverName: string;
  /** Shell command text or "" */
  commandText: string;
  /** Final outcome */
  decision: "approved" | "denied";
  /** User's button choice (only for interactive decisions) */
  userAction?: PermissionAction;
  /** Where the decision was made */
  source: AuditDecisionSource;
  /** SDK-level result returned to the Copilot SDK */
  sdkResult: string;
  /**
   * Set on `always-allow` rows. `true` if a durable rule was written,
   * `false` if the pattern was unrepresentable (collapsed to `*`) and
   * the persistence layer short-circuited. Absent for other actions.
   */
  persistedRule?: boolean;
}

/** Fields required from callers — timestamp and identity are added by the logger. */
export type AuditLogInput = Omit<AuditLogEntry, "timestamp" | "userLogin">;

export interface AuditQueryFilters {
  sessionId?: string;
  kind?: string;
  decision?: "approved" | "denied";
  source?: AuditDecisionSource;
  fromDate?: string; // YYYY-MM-DD
  toDate?: string; // YYYY-MM-DD
  toolName?: string;
}

/** Build an AuditLogInput from a ApprovalRequest and decision metadata. */
export function buildAuditInput(
  request: ApprovalRequest,
  decision: "approved" | "denied",
  source: AuditDecisionSource,
  sdkResult: string,
  userAction?: PermissionAction,
): AuditLogInput {
  const serverName = getServerName(request);
  return {
    sessionId: request.sessionId,
    toolCallId: request.toolCallId,
    kind: request.kind,
    toolName: getToolName(request),
    serverName,
    commandText: getCommandText(request),
    decision,
    source,
    sdkResult,
    ...(userAction ? { userAction } : {}),
  };
}

/** Build an AuditLogInput for pre-hook / permissionHandler sites that lack a full ApprovalRequest. */
export function buildPreHookAuditInput(opts: {
  sessionId: string;
  toolCallId?: string;
  toolName: string;
  serverName: string;
  kind: string;
  decision: "approved" | "denied";
  source: AuditDecisionSource;
  sdkResult: string;
}): AuditLogInput {
  return {
    sessionId: opts.sessionId,
    toolCallId: opts.toolCallId,
    kind: opts.kind,
    toolName: opts.toolName,
    serverName: opts.serverName,
    commandText: "",
    decision: opts.decision,
    source: opts.source,
    sdkResult: opts.sdkResult,
  };
}

/** Audit entry for MCP OAuth lifecycle events. Separate shape from AuditLogEntry. */
export interface OAuthAuditEntry {
  /** Discriminant tag — distinguishes from AuditLogEntry permission entries. */
  type: "oauth";
  /** ISO-8601 UTC timestamp */
  timestamp: string;
  /** GitHub username (cached from AuthStatus). */
  userLogin: string;
  /**
   * Originating chat session id for OAuth events that flowed through the
   * `mcp:oauth-required` chat-time path (where the SDK emits the prompt on
   * a specific session). Absent for user-initiated sign-in / sign-out from
   * Settings / Extensions panel / startup card. Used by audit-log review
   * to attribute a failed sign-in to the conversation that triggered it.
   */
  sessionId?: string;
  /** Lifecycle event */
  event: "mcp-oauth-initiate" | "mcp-oauth-success" | "mcp-oauth-failure" | "mcp-oauth-signout";
  /** Display name of the MCP server */
  serverName: string;
  alias?: string;
  forceReauth: boolean;
  error?: string;
}

/** Fields required from callers — timestamp and identity are added by the logger. */
export type OAuthAuditLogInput = Omit<OAuthAuditEntry, "type" | "timestamp" | "userLogin">;

/** Matches permission audit log filenames and captures the date. */
const LOG_FILE_RE = /^permissions-(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** Matches OAuth audit log filenames and captures the date. */
const OAUTH_LOG_FILE_RE = /^oauth-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** UTC date string for log filenames (YYYY-MM-DD). */
function utcDateString(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

// --- AuditLogger ---

export class AuditLogger {
  private logDir: string;
  private enabled: boolean;
  private cachedUserLogin = "";
  // Serializes concurrent writes — same pattern as settings-store.ts:223
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(opts: { logDir: string; enabled?: boolean }) {
    this.logDir = opts.logDir;
    this.enabled = opts.enabled ?? true;
    if (this.enabled) {
      try {
        secureMkdirSync(this.logDir, 0o700);
      } catch {
        // Directory creation failure is non-fatal — log() will silently fail
      }
    }
  }

  /** Update cached GitHub username (wired to setAuthStatusCallback). */
  setUserLogin(login: string): void {
    this.cachedUserLogin = login;
  }

  /** Append an audit entry to today's log file. Never throws, never blocks. */
  log(input: AuditLogInput): void {
    if (!this.enabled) return;

    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      userLogin: this.cachedUserLogin,
      ...input,
    };

    let line: string;
    try {
      line = JSON.stringify(entry) + "\n";
    } catch {
      return; // Serialization failure — skip silently
    }

    const filePath = path.join(this.logDir, `permissions-${utcDateString()}.jsonl`);

    // Chain off previous write to avoid interleaved/EBUSY on Windows
    this.pendingWrite = this.pendingWrite
      .then(() => secureAppendFile(filePath, line, { mode: 0o600 }))
      .catch((err) => log.error("Write failed:", err));
  }

  /** Append an OAuth lifecycle entry to today's oauth log file. Never throws, never blocks. */
  logOAuth(input: OAuthAuditLogInput): void {
    if (!this.enabled) return;

    const entry: OAuthAuditEntry = {
      type: "oauth",
      timestamp: new Date().toISOString(),
      userLogin: this.cachedUserLogin,
      ...input,
    };

    let line: string;
    try {
      line = JSON.stringify(entry) + "\n";
    } catch {
      return; // Serialization failure — skip silently
    }

    const filePath = path.join(this.logDir, `oauth-${utcDateString()}.jsonl`);

    this.pendingWrite = this.pendingWrite
      .then(() => secureAppendFile(filePath, line, { mode: 0o600 }))
      .catch((err) => log.error("OAuth audit write failed:", err));
  }

  /** Resolves when all in-flight writes complete. Call from before-quit. */
  flush(): Promise<void> {
    return this.pendingWrite;
  }

  /**
   * Query log entries matching filters. Uses synchronous I/O.
   * @internal Diagnostic/forensic use only — do not call from IPC handlers.
   * Convert to async if this ever needs to serve renderer queries.
   */
  query(filters: AuditQueryFilters): AuditLogEntry[] {
    if (!this.enabled) return [];

    const results: AuditLogEntry[] = [];
    let files: string[];
    try {
      files = fs
        .readdirSync(this.logDir)
        .filter((f) => LOG_FILE_RE.test(f))
        .sort();
    } catch {
      return [];
    }

    // Filter files by date range
    if (filters.fromDate || filters.toDate) {
      files = files.filter((f) => {
        const date = f.match(LOG_FILE_RE)?.[1];
        if (!date) return false;
        if (filters.fromDate && date < filters.fromDate) return false;
        if (filters.toDate && date > filters.toDate) return false;
        return true;
      });
    }

    for (const file of files) {
      let content: string;
      try {
        content = fs.readFileSync(path.join(this.logDir, file), "utf-8");
      } catch {
        continue;
      }

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let entry: AuditLogEntry;
        try {
          entry = JSON.parse(line); // SF-4: self-written JSONL, malformed lines skipped in catch
        } catch {
          continue; // Skip malformed lines
        }
        if (filters.sessionId && entry.sessionId !== filters.sessionId) continue;
        if (filters.kind && entry.kind !== filters.kind) continue;
        if (filters.decision && entry.decision !== filters.decision) continue;
        if (filters.source && entry.source !== filters.source) continue;
        if (filters.toolName && entry.toolName !== filters.toolName) continue;

        results.push(entry);
      }
    }

    return results;
  }

  /** Remove log files older than retentionDays (both permission and OAuth log files). */
  pruneOldLogs(retentionDays = 30): void {
    if (!this.enabled) return;

    let files: string[];
    try {
      files = fs
        .readdirSync(this.logDir)
        .filter((f) => LOG_FILE_RE.test(f) || OAUTH_LOG_FILE_RE.test(f));
    } catch {
      return;
    }

    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
    const cutoffStr = utcDateString(cutoff);

    for (const file of files) {
      const date = (file.match(LOG_FILE_RE) ?? file.match(OAUTH_LOG_FILE_RE))?.[1];
      if (!date) continue;
      if (date < cutoffStr) {
        try {
          fs.unlinkSync(path.join(this.logDir, file));
        } catch {
          // Deletion failure is non-fatal
        }
      }
    }
  }

  /** Get the path to today's log file (for diagnostics). */
  getCurrentLogPath(): string {
    return path.join(this.logDir, `permissions-${utcDateString()}.jsonl`);
  }
}
