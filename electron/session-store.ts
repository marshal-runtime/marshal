/**
 * Persistence layer for session data (index + per-session JSON files).
 *
 * Extracted from SessionManager (Commit 1 of the SessionManager Tier 1 plan)
 * so that storage can be swapped (e.g. for testing) without
 * touching session orchestration logic.
 */

import * as fs from "fs";
import * as path from "path";

import {
  isHiddenInternalControlMessage,
  type GoalState,
  type PermissionCardData,
  type ReasoningEffort,
  type SessionMessage,
  type SessionRepositoryAgent,
  type SessionPermissionMode,
  type SessionSandboxConfig,
  type SessionMetadata,
  type WorkspaceInstanceIdentity,
} from "../common/marshal-ipc-contract";
import { createLogger } from "../common/marshal-logger";
import { resolveSessionRuntimeId } from "../common/runtime-config";
import { sessionErrors, makeSessionError } from "../common/telemetry/errors/marshal-session";
import { getAppDataDir } from "./app-paths";
import type { SessionsIndex } from "./backend/types";
import { computeSessionWorkerBaseDigest } from "./persistence/session-worker-base-proof";
import { secureMkdirSync } from "./platform-security";
import {
  readEncryptedFile,
  readEncryptedFileReadOnly,
  readEncryptedFileSync,
  writeEncryptedFile,
  writeEncryptedFileSync,
} from "./safe-storage-file";
import {
  migrateGoalDocumentForPersistence,
  type GoalDocumentMigrationResult,
  type GoalRecoveryState,
} from "./schemas/goal-schema";
import {
  SessionsIndexSchema,
  SessionMetadataSchema,
  StoredSessionSchema,
  StoredSessionHeaderSchema,
  MessageChunkSchema,
  normalizeLegacyReadinessMessages,
  normalizeInternalControlMessages,
  SESSION_CHUNK_FORMAT,
  MESSAGES_PER_CHUNK,
} from "./schemas/session-schema";
import { redactSecrets } from "./secret-redactor";
import { ReadOnlySessionArchive } from "./session-archive";
import { ParsedChunkCache } from "./session-chunk-cache";
import {
  SessionMetadataCache,
  sessionScopeOf,
  type SessionMetadataSnapshot,
  type SessionScope,
} from "./session-scope-cache";
import { sendErrorTelemetry } from "./telemetry-errors";

const log = createLogger("SessionStore");

// ---------------------------------------------------------------------------
// Migration helper
// ---------------------------------------------------------------------------

/** Migrate legacy fields in raw session JSON before schema validation. */
function migrateSessionFields(item: unknown): void {
  if (!item || typeof item !== "object") return;
  const obj = item as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof check above
  if (obj.source === "workflow") obj.source = "automation";
  if (obj.workflowId && !obj.automationId) obj.automationId = obj.workflowId;
  obj.runtimeId = resolveSessionRuntimeId({
    runtimeId: typeof obj.runtimeId === "string" ? obj.runtimeId : undefined,
    backendOrigin:
      obj.backendOrigin === "copilot" || obj.backendOrigin === "gateway"
        ? obj.backendOrigin
        : undefined,
  });
}

/** Migrate legacy gateway rows: promote cloudSessionId → backendId. */
function migrateGatewayBackendId(item: unknown): void {
  if (!item || typeof item !== "object") return;
  const obj = item as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof check above
  if (!obj.backendId && typeof obj.cloudSessionId === "string") {
    obj.backendId = obj.cloudSessionId;
  }
}

/** Migrate legacy copilot rows: promote sdkSessionId → backendId. */
function migrateCopilotBackendId(item: unknown): void {
  if (!item || typeof item !== "object") return;
  const obj = item as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof check above
  if (!obj.backendId && typeof obj.sdkSessionId === "string") {
    obj.backendId = obj.sdkSessionId;
  }
}

export type StoredSessionGoalMigrationKind =
  | "none"
  | "quarantined"
  | GoalDocumentMigrationResult["kind"];

/**
 * Upgrade a nested V1 goal in any raw stored-session shape before validation.
 * Unsupported future versions are deliberately left untouched so the schema
 * rejects them and no load path rewrites data it does not understand.
 *
 * A goal that is invalid even after salvage is QUARANTINED instead of failing
 * the whole session load: the parsed goal value is re-serialized verbatim into
 * `goalRecovery.raw` (value-faithful — the pre-parse file bytes are no longer
 * available at this layer) and `goal` is cleared, so the session stays
 * loadable, the loss is visible and recoverable (GoalManager surfaces a
 * recovery notice), and no load path ever invents intent from unreadable
 * data. A later quarantine replaces the single retained slot.
 */
export function migrateStoredSessionGoal(item: unknown): StoredSessionGoalMigrationKind {
  if (!item || typeof item !== "object" || Array.isArray(item)) return "none";
  const obj = item as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by object/array checks
  if (obj.goal === undefined) return "none";
  const result = migrateGoalDocumentForPersistence(obj.goal);
  if (result.kind === "current" || result.kind === "migrated") {
    obj.goal = result.document;
    return result.kind;
  }
  if (result.kind === "invalid") {
    const recovery: GoalRecoveryState = {
      reason: "invalid-document",
      raw: JSON.stringify(obj.goal),
      quarantinedAt: new Date().toISOString(),
    };
    obj.goalRecovery = recovery;
    delete obj.goal;
    return "quarantined";
  }
  return result.kind;
}

function sessionWithPortableGoal(session: PersistedSession): PersistedSession {
  if (session.goal === undefined) return session;
  const result = migrateGoalDocumentForPersistence(session.goal);
  if (result.kind === "current" || result.kind === "migrated") {
    return { ...session, goal: result.document };
  }
  if (result.kind === "unsupported-version") {
    throw new Error(
      `Refusing to persist unsupported goal schema version: ${String(result.version)}`,
    );
  }
  throw new Error("Refusing to persist invalid goal document");
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export type Message = SessionMessage;

export interface LiveTurnCheckpoint {
  version: 1;
  ownerId?: string;
  message: SessionMessage;
  updatedAt: string;
}

export interface PendingModelSwitch {
  model: string;
  reasoningEffort?: ReasoningEffort;
  accountSelection?: "default" | "explicit";
  liveSwitch?: boolean;
  requestedAt: string;
}

export interface PersistedSession extends SessionMetadata {
  runtimeConversationState?: import("../common/runtime-conversation-state").RuntimeConversationState;
  pendingRuntimeHandoff?: boolean;
  /** A model change requested while the chat was responding; applied when it is idle. */
  pendingModelSwitch?: PendingModelSwitch;
  runtimeActiveExecutionId?: string;
  runtimeExecutions?: import("./marshal-runtime/session-execution-evidence").SessionExecutionEvidence[];
  /** Runtime-owned agents are observed by their broker. Their
   *  completion must not wake the conversational parent orchestration loop. */
  suppressParentReadinessWake?: boolean;
  liveTurnCheckpoint?: LiveTurnCheckpoint;
  /** Effective Playwright headless flag at session-creation time. Used by
   *  AutomationManager to detect when an automation's flag has flipped and
   *  the pinned session needs to be rotated. */
  playwrightHeadless?: boolean;
  /** Explicit per-session runtime sandbox override (see SessionSandboxConfig). */
  sandbox?: SessionSandboxConfig;
  messages: Message[];
  permissionCards?: PermissionCardData[];
  contextSummary?: string;
  summaryUpToMessageId?: string;
  parentSessionId?: string;
  permissionMode?: SessionPermissionMode;
  workspaceIdentity?: WorkspaceInstanceIdentity;
  repositoryAgent?: SessionRepositoryAgent;
  aiGeneratedTitle?: string;
  needsAiTitle?: boolean;
  /** Per-session skills allowlist (skill names). Undefined = inherit global
   *  skill set; `[]` = no skills allowed. Set by the workflow engine when
   *  `ctx.spawn` / `ctx.run` is invoked with explicit `skills`. Enforced at
   *  list-time inside the `listSkills` / `getSkill` self-tools.
   *  See R1-FIXES A13 (per-call MCP/skills scoping). */
  scopedSkills?: string[];
  /** Per-session MCP server allowlist (config keys, e.g. `filesystem`,
   *  `playwright`, custom keys). Undefined = inherit global MCP set; `[]` =
   *  no MCP servers allowed. Set by the workflow engine when `ctx.spawn` /
   *  `ctx.run` is invoked with explicit `mcp`. Enforced pre-hook inside
   *  `PermissionPolicy.evaluatePreHook` via `setSessionMcpScope`. See
   *  R1-FIXES A13. */
  scopedMcp?: string[];
  /** Exact host tool names this session may call (see resolveSessionToolAllowlist).
   *  Undefined = unrestricted. Persisted so resumes keep the restriction. */
  allowedTools?: string[];
  /** System prompt that replaces Marshal's assembled prompt; set only at launch. */
  systemPromptOverride?: string;
  /** Lean-prompt decision stamped at creation (see electron/prompt/lean-prompt.ts); absent on sessions that predate the flag. */
  leanPrompt?: boolean;
  leanRepoRules?: boolean;
  leanCore?: boolean;
  /** Absolute file paths attached to the subagent's first message. */
  launchAttachments?: string[];
  /** Per-conversation autonomous goal state (managed by GoalManager). */
  goal?: GoalState;
  /** Quarantined unreadable goal, value-faithful copy retained. See migrateStoredSessionGoal. */
  goalRecovery?: GoalRecoveryState;
}

export interface SessionWorkerBaseProof {
  schemaVersion: 1;
  generationToken: string;
  canonicalDigest: string;
  messageCount: number;
}

export interface LocalSessionDataLoadResult {
  session: PersistedSession | null;
  workerBaseProof?: SessionWorkerBaseProof;
}

function isPersistedSession(value: unknown): value is PersistedSession {
  return StoredSessionSchema.safeParse(value).success;
}

export type { SessionsIndex };

// ---------------------------------------------------------------------------
// Chunked storage helpers (chunked-v1)
// ---------------------------------------------------------------------------

/** Result of a paginated message read. */
export interface SessionMessagesPage {
  messages: Message[];
  /** Total number of messages stored for this session. */
  total: number;
  /** True when older messages exist before the returned window. */
  hasMore: boolean;
  /** Index of the oldest chunk included in `messages` (0-based), or null when none. */
  oldestChunkIndex: number | null;
}

/** Session header (everything except `messages`), as persisted in the header file. */
export type SessionHeader = Omit<PersistedSession, "messages"> & {
  storageFormat?: typeof SESSION_CHUNK_FORMAT;
  /** Name of the generation subdirectory holding this session's chunk files. */
  chunkGen?: string;
  chunkCount?: number;
  messageCount: number;
  lastMessagePreview?: string;
};

/** Sentinel written into the header's `messages` field so an OLDER app version
 *  (whose StoredSessionSchema expects `messages` to be an array) FAILS CLOSED and
 *  treats the header as unreadable rather than as an empty session it could
 *  overwrite — which would orphan the chunk files. New code keys off
 *  `storageFormat` and ignores this field. */
const CHUNKED_MESSAGES_SENTINEL = "__chunked-v1__";

/** Bounded so a session saved on every streamed event cannot keep a reader restarting forever. */
const CHUNK_GENERATION_READ_ATTEMPTS = 3;

/** Decrypted JSON characters of parsed chunks kept in memory across full session loads. */
const PARSED_CHUNK_CACHE_MAX_CHARS = 192 * 1024 * 1024;

class ChunkGenerationSupersededError extends Error {
  constructor(sessionId: string) {
    super(`Chunk generation superseded during read for session ${sessionId}`);
    this.name = "ChunkGenerationSupersededError";
  }
}

function splitIntoChunks(messages: Message[], size: number): Message[][] {
  if (messages.length === 0) return [];
  const out: Message[][] = [];
  for (let i = 0; i < messages.length; i += size) {
    out.push(messages.slice(i, i + size));
  }
  return out;
}

/** A short, collision-resistant token naming a chunk generation directory. */
function newChunkGen(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Fast non-cryptographic 53-bit hash (cyrb53). Used to detect byte-identical
 *  chunk content so an unchanged chunk's encrypted file can be reused instead of
 *  re-encrypted — an append only changes the last chunk, so re-encrypting all
 *  chunks (multi-MB) on every save pegged the main thread. Paired with a length
 *  check, collisions are not a correctness risk (a mismatch just re-encrypts). */
function cyrb53(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Reuse an unchanged encrypted chunk in the new generation WITHOUT copying its
 *  bytes: a hard link is a second directory entry for the same on-disk data
 *  (instant, zero duplication). GC deleting the old generation's entry leaves
 *  the data alive via this link. Falls back to a byte copy if the filesystem
 *  rejects the link; returns false if neither works so the caller re-encrypts. */
function reuseChunkFile(src: string, dest: string): boolean {
  try {
    fs.linkSync(src, dest);
    return true;
  } catch {
    try {
      fs.copyFileSync(src, dest);
      return true;
    } catch {
      return false;
    }
  }
}

/** First non-empty content from the tail, truncated, for an index/header preview. */
function deriveLastMessagePreview(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      !message ||
      isHiddenInternalControlMessage(message) ||
      message.goalContinuation ||
      message.agentMessage?.kind === "readiness" ||
      message.suppressedAgentStatusResponse
    ) {
      continue;
    }
    const c = message.content;
    if (typeof c === "string" && c.trim().length > 0) {
      return redactSecrets(c).result.slice(0, 200);
    }
  }
  return undefined;
}

/** True when a parsed header object is in the chunked-v1 format. */
function isChunkedHeader(obj: unknown): boolean {
  return (
    !!obj &&
    typeof obj === "object" &&
    "storageFormat" in obj &&
    obj.storageFormat === SESSION_CHUNK_FORMAT
  );
}

/** Build the header object written to `{id}.json` for a chunked session. */
function buildChunkedHeader(
  session: PersistedSession,
  chunkGen: string,
  chunkCount: number,
): Record<string, unknown> {
  const { messages, ...rest } = session;
  return {
    ...rest,
    storageFormat: SESSION_CHUNK_FORMAT,
    // Fail-closed sentinel for older app versions (see CHUNKED_MESSAGES_SENTINEL).
    messages: CHUNKED_MESSAGES_SENTINEL,
    chunkGen,
    chunkCount,
    messageCount: messages.length,
    lastMessagePreview: deriveLastMessagePreview(messages),
  };
}

/** A shared index snapshot for callers that only read it; never mutate it. */
export type ReadonlySessionsIndex = Readonly<Omit<SessionsIndex, "sessions">> & {
  readonly sessions: readonly SessionMetadata[];
};

export interface ISessionStore {
  readonly sessionsDir: string;
  ensureSessionsDir(): void;
  loadIndex(): SessionsIndex;
  /** Like loadIndex without the per-call deep copy (the index is several MB). */
  loadIndexReadOnly?(): ReadonlySessionsIndex;
  /** All index mutations must go through withIndexLock to prevent load-modify-save races. */
  withIndexLock<T>(fn: (index: SessionsIndex) => T): Promise<T>;
  loadSessionData(id: string): PersistedSession | null;
  loadSessionDataAsync(id: string): Promise<PersistedSession | null>;
  /** Wait for queued local persistence work to settle before shutdown cleanup. */
  flushPendingWrites?(): Promise<void>;
  saveSessionData(session: PersistedSession): void;
  deleteSessionData(id: string): void;
  /** Load only the session header (metadata, no messages). Cheap — never reads
   *  message chunks. Returns null when the session does not exist. */
  loadSessionHeader(id: string): SessionHeader | null;
  /** Scope fields only (workspace, name, repo, source, runtime), from memory
   *  when the store has read or written the session since startup. */
  loadSessionScope?(id: string): SessionScope | null;
  /** Every field but messages, from memory when the store has read or written
   *  the session since startup; never rebuilds the transcript. */
  loadSessionMetadata?(id: string): SessionMetadataSnapshot | null;
  /** Load the most recent `maxMessages` messages (plus pagination info) without
   *  parsing the entire message history. Reads from the tail chunk(s) only. */
  loadSessionMessagesTail(id: string, maxMessages: number): Promise<SessionMessagesPage>;
  /** Read-only chronological iteration; decrypt at most one stored chunk at a time. */
  iterateSessionMessageChunks?(id: string): AsyncIterable<readonly Message[]>;
}

// ---------------------------------------------------------------------------
// LocalSessionStore — encrypted JSON on disk
// ---------------------------------------------------------------------------

type ArchiveRecoveryReason =
  | "missing"
  | "schema-invalid"
  | "invalid-or-empty"
  | "empty"
  | "read-failed";

export class LocalSessionStore implements ISessionStore {
  private readonly archive = new ReadOnlySessionArchive();
  private archiveRecoveryWarningEmitted = false;
  private readonly metadataCache = new SessionMetadataCache();
  private readonly parsedChunks = new ParsedChunkCache<Message[]>(PARSED_CHUNK_CACHE_MAX_CHARS);
  private indexCache: { readonly key: string; readonly index: SessionsIndex } | undefined;
  private indexLockQueue: Promise<void> = Promise.resolve();
  /** Per-session async write mutex (see withSessionWriteLock). */
  private readonly sessionWriteLocks = new Map<string, Promise<void>>();
  /** Per-session signatures of the last-written chunk generation, so an
   *  unchanged chunk can be reused (copied) instead of re-encrypted. */
  private readonly chunkGenCache = new Map<
    string,
    { gen: string; sigs: Array<{ h: number; n: number }> }
  >();

  constructor() {
    this.ensureSessionsDir();
  }

  /** Derived from getAppDataDir() on every access so it follows mock mode switches. */
  get sessionsDir(): string {
    return path.join(getAppDataDir(), "marshal-sessions");
  }

  ensureSessionsDir(): void {
    secureMkdirSync(this.sessionsDir, 0o700);
  }

  private getIndexPath(): string {
    return path.join(this.sessionsDir, "sessions-index.json");
  }

  getSessionPath(id: string): string {
    return path.join(this.sessionsDir, `${id}.json`);
  }

  /** Parent directory holding per-generation chunk subdirectories for a session. */
  private getChunksDir(id: string): string {
    return path.join(this.sessionsDir, `${id}.chunks`);
  }

  /** Directory holding the chunk files for one generation of a session. */
  private getChunkGenDir(id: string, gen: string): string {
    return path.join(this.getChunksDir(id), gen);
  }

  private getChunkPath(id: string, gen: string, index: number): string {
    return path.join(this.getChunkGenDir(id, gen), `${String(index).padStart(4, "0")}.json`);
  }

  /** Identity of the index file's current contents; any rewrite or replacement changes it. */
  private indexFileKey(): string | undefined {
    try {
      const stat = fs.statSync(this.getIndexPath(), { bigint: true });
      return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
    } catch {
      return undefined;
    }
  }

  /**
   * Per-call permission checks read the index; decrypting and validating ~1,700
   * entries each time cost tens of ms on the main thread. A validated copy is
   * reused while the file is unchanged; callers mutate what they get, so each
   * call receives its own clone.
   */
  loadIndex(): SessionsIndex {
    return structuredClone(this.cachedIndex());
  }

  loadIndexReadOnly(): ReadonlySessionsIndex {
    return this.cachedIndex();
  }

  private cachedIndex(): SessionsIndex {
    const key = this.indexFileKey();
    if (key !== undefined && this.indexCache?.key === key) return this.indexCache.index;
    const index = this.readIndexFile();
    if (index === undefined) return { sessions: [], activeSessionId: null };
    if (key !== undefined) this.indexCache = { key, index };
    return index;
  }

  private readIndexFile(): SessionsIndex | undefined {
    let data: string;
    try {
      data = readEncryptedFileSync(this.getIndexPath());
    } catch (err: unknown) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
        log.warn("sessions-index: failed to read:", err);
      }
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data); // SF-4: validated by SessionsIndexSchema.safeParse below
    } catch {
      sendErrorTelemetry(makeSessionError(sessionErrors.SESSION_INDEX_CORRUPT));
      log.warn("sessions-index: invalid JSON");
      return undefined;
    }
    const result = SessionsIndexSchema.safeParse(parsed);
    if (!result.success) {
      sendErrorTelemetry(makeSessionError(sessionErrors.SESSION_INDEX_CORRUPT));
      log.warn("sessions-index: invalid schema:", result.error.format());
      return undefined;
    }
    // Validate each session entry individually so one bad entry doesn't lose the entire index
    const sessions: SessionMetadata[] = [];
    for (const item of result.data.sessions) {
      migrateSessionFields(item);
      migrateGatewayBackendId(item);
      const entryResult = SessionMetadataSchema.safeParse(item);
      if (entryResult.success) {
        sessions.push(entryResult.data);
      } else {
        log.warn("Skipping invalid session index entry:", entryResult.error.format());
      }
    }
    return { ...result.data, sessions };
  }

  saveIndex(index: SessionsIndex): void {
    for (const session of index.sessions) {
      session.runtimeId = resolveSessionRuntimeId(session);
    }
    this.indexCache = undefined;
    writeEncryptedFileSync(this.getIndexPath(), JSON.stringify(index, null, 2));
  }

  /**
   * Serialize all index-mutating operations through a single async queue.
   * The callback receives the current index, mutates it, and the updated
   * index is persisted before the next queued operation runs.
   * This eliminates the load-modify-save race condition.
   */
  withIndexLock<T>(fn: (index: SessionsIndex) => T): Promise<T> {
    const next = this.indexLockQueue.then(() => {
      const index = this.loadIndex();
      const result = fn(index);
      this.saveIndex(index);
      return result;
    });
    // Keep the queue going regardless of success/failure so one error
    // doesn't block all subsequent operations.
    this.indexLockQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  async flushPendingWrites(): Promise<void> {
    while (true) {
      const indexQueue = this.indexLockQueue;
      const sessionQueues = [...this.sessionWriteLocks.entries()];
      const sessionQueueCount = this.sessionWriteLocks.size;
      // The queue set can grow while the captured generation drains, so this loop is sequential.
      // oxlint-disable-next-line eslint/no-await-in-loop
      await Promise.all([indexQueue, ...sessionQueues.map(([, queue]) => queue)]);
      if (
        indexQueue === this.indexLockQueue &&
        sessionQueueCount === this.sessionWriteLocks.size &&
        sessionQueues.every(([id, queue]) => this.sessionWriteLocks.get(id) === queue)
      ) {
        return;
      }
    }
  }

  loadSessionData(id: string): PersistedSession | null {
    const sessionPath = this.getSessionPath(id);
    if (!fs.existsSync(sessionPath)) return this.loadArchivedSession(id, "missing");
    const sl = log.with({ sessionId: id });
    try {
      const raw = readEncryptedFileSync(sessionPath);
      const parsed: unknown = JSON.parse(raw); // SF-4: validated by schema below
      migrateSessionFields(parsed);
      migrateCopilotBackendId(parsed);
      const goalMigration = migrateStoredSessionGoal(parsed);
      if (isChunkedHeader(parsed)) {
        const session = this.reconstructFromChunksSync(id, parsed);
        if (session && (goalMigration === "migrated" || goalMigration === "quarantined")) {
          this.persistMigratedGoalSync(session);
        }
        return this.preferArchivedSession(id, session, "invalid-or-empty");
      }
      // Legacy single-blob format: parse inline messages, then auto-migrate to chunks.
      const result = StoredSessionSchema.safeParse(parsed);
      if (!result.success) {
        sendErrorTelemetry(makeSessionError(sessionErrors.SESSION_LOAD_FAILED));
        sl.warn("Failed schema validation — returning null:", result.error.format());
        return this.loadArchivedSession(id, "schema-invalid");
      }
      const legacy: unknown = result.data;
      if (!isPersistedSession(legacy)) return this.loadArchivedSession(id, "schema-invalid");
      this.migrateLegacyToChunksSync(legacy);
      return this.preferArchivedSession(id, legacy, "empty");
    } catch (e) {
      sendErrorTelemetry(makeSessionError(sessionErrors.SESSION_LOAD_FAILED));
      sl.error("Failed to parse session, skipping:", e);
      return this.loadArchivedSession(id, "read-failed");
    }
  }

  async loadSessionDataAsync(id: string): Promise<PersistedSession | null> {
    return (await this.loadSessionDataWithWorkerBaseProofAsync(id)).session;
  }

  async loadSessionDataWithWorkerBaseProofAsync(id: string): Promise<LocalSessionDataLoadResult> {
    return this.loadSessionDataWithWorkerBaseProofAttempt(id, 1);
  }

  private async loadSessionDataWithWorkerBaseProofAttempt(
    id: string,
    attempt: number,
  ): Promise<LocalSessionDataLoadResult> {
    const sl = log.with({ sessionId: id });
    try {
      const raw = await readEncryptedFile(this.getSessionPath(id));
      const parsed: unknown = JSON.parse(raw); // SF-4: validated by schema below
      migrateSessionFields(parsed);
      migrateCopilotBackendId(parsed);
      const goalMigration = migrateStoredSessionGoal(parsed);
      if (isChunkedHeader(parsed)) {
        const parsedHeader = StoredSessionHeaderSchema.safeParse(parsed);
        const session = await this.reconstructFromChunksAsync(id, parsed);
        if (session && (goalMigration === "migrated" || goalMigration === "quarantined")) {
          await this.persistMigratedGoalAsync(session);
        }
        const preferred = this.preferArchivedSession(id, session, "invalid-or-empty");
        if (
          !preferred ||
          !session ||
          preferred !== session ||
          !parsedHeader.success ||
          goalMigration === "migrated" ||
          goalMigration === "quarantined"
        ) {
          return { session: preferred };
        }
        const generationToken = parsedHeader.data.persistenceGenerationToken;
        const canonicalDigest = parsedHeader.data.persistenceCanonicalDigest;
        if (
          parsedHeader.data.persistenceProofVersion !== 1 ||
          !generationToken ||
          !canonicalDigest ||
          parsedHeader.data.messageCount !== preferred.messages.length ||
          computeSessionWorkerBaseDigest(preferred.messages) !== canonicalDigest
        ) {
          return { session: preferred };
        }
        return {
          session: preferred,
          workerBaseProof: {
            schemaVersion: 1,
            generationToken,
            canonicalDigest,
            messageCount: preferred.messages.length,
          },
        };
      }
      const result = StoredSessionSchema.safeParse(parsed);
      if (!result.success) {
        sendErrorTelemetry(makeSessionError(sessionErrors.SESSION_LOAD_FAILED));
        sl.warn("Invalid stored session schema:", result.error.format());
        return { session: this.loadArchivedSession(id, "schema-invalid") };
      }
      const legacy: unknown = result.data;
      if (!isPersistedSession(legacy)) {
        return { session: this.loadArchivedSession(id, "schema-invalid") };
      }
      await this.migrateLegacyToChunksAsync(legacy);
      return { session: this.preferArchivedSession(id, legacy, "empty") };
    } catch (e) {
      if (e instanceof ChunkGenerationSupersededError && attempt < CHUNK_GENERATION_READ_ATTEMPTS) {
        return this.loadSessionDataWithWorkerBaseProofAttempt(id, attempt + 1);
      }
      // ENOENT is expected (file may not exist yet); only telemeter real errors.
      if (!(e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT")) {
        sendErrorTelemetry(makeSessionError(sessionErrors.SESSION_LOAD_FAILED));
        sl.error("Failed to load session async:", e);
      }
      return {
        session: this.loadArchivedSession(
          id,
          e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT"
            ? "missing"
            : "read-failed",
        ),
      };
    }
  }

  loadSessionScope(id: string): SessionScope | null {
    const metadata = this.loadSessionMetadata(id);
    return metadata ? sessionScopeOf(metadata) : null;
  }

  loadSessionMetadata(id: string): SessionMetadataSnapshot | null {
    const cached = this.metadataCache.get(id);
    if (cached && fs.existsSync(this.getSessionPath(id))) return cached;
    const header = this.loadSessionHeader(id);
    if (!header) {
      this.metadataCache.forget(id);
      return null;
    }
    return this.metadataCache.remember(header);
  }

  loadSessionHeader(id: string): SessionHeader | null {
    const sessionPath = this.getSessionPath(id);
    if (!fs.existsSync(sessionPath)) return this.loadArchivedHeader(id, "missing");
    const sl = log.with({ sessionId: id });
    try {
      const raw = readEncryptedFileSync(sessionPath);
      const parsed: unknown = JSON.parse(raw); // SF-4: validated by a stored-session schema below
      migrateStoredSessionGoal(parsed);
      if (isChunkedHeader(parsed)) {
        migrateSessionFields(parsed);
        migrateCopilotBackendId(parsed);
        const result = StoredSessionHeaderSchema.safeParse(parsed);
        if (!result.success) {
          sl.warn("Invalid chunked header schema:", result.error.format());
          return this.loadArchivedHeader(id, "schema-invalid");
        }
        const {
          persistenceProofVersion: _persistenceProofVersion,
          persistenceGenerationToken: _persistenceGenerationToken,
          persistenceCanonicalDigest: _persistenceCanonicalDigest,
          ...sessionHeader
        } = result.data;
        return this.preferArchivedHeader(id, sessionHeader as SessionHeader, "empty");
      }
      // Legacy blob: derive a header without migrating (read-only path).
      migrateSessionFields(parsed);
      migrateCopilotBackendId(parsed);
      const result = StoredSessionSchema.safeParse(parsed);
      if (!result.success) return this.loadArchivedHeader(id, "schema-invalid");
      const { messages, ...rest } = result.data;
      return this.preferArchivedHeader(
        id,
        {
          ...rest,
          messageCount: messages.length,
          lastMessagePreview: deriveLastMessagePreview(messages),
        } as SessionHeader,
        "empty",
      );
    } catch (e) {
      sl.error("Failed to read session header:", e);
      return this.loadArchivedHeader(id, "read-failed");
    }
  }

  async *iterateSessionMessageChunks(id: string): AsyncIterable<readonly Message[]> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(id))
      throw new Error("Invalid transcript session ID.");
    const parsed: unknown = JSON.parse(await readEncryptedFileReadOnly(this.getSessionPath(id))); // SF-4: validated by StoredSessionHeaderSchema or StoredSessionSchema below
    migrateStoredSessionGoal(parsed);
    migrateSessionFields(parsed);
    migrateCopilotBackendId(parsed);
    if (isChunkedHeader(parsed)) {
      const header = StoredSessionHeaderSchema.parse(parsed);
      if (header.id !== id) throw new Error("Transcript session header identity mismatch.");
      if (
        header.chunkCount > 0 &&
        (!header.chunkGen || !/^[A-Za-z0-9_-]+$/.test(header.chunkGen))
      ) {
        throw new Error("Invalid transcript chunk generation.");
      }
      let count = 0;
      for (let index = 0; index < header.chunkCount; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- chronological lazy iteration must not reconstruct full history
        const messages = await this.readChunkAsync(
          id,
          header.chunkGen ?? "",
          index,
          readEncryptedFileReadOnly,
        );
        count += messages.length;
        if (count > header.messageCount) throw new Error("Transcript message count mismatch.");
        yield messages;
      }
      if (count !== header.messageCount) throw new Error("Transcript message count mismatch.");
      return;
    }
    // Legacy encryption is one indivisible JSON blob. Parse once for this read,
    // yield bounded groups, and never migrate, persist, or cache its plaintext.
    const legacy = StoredSessionSchema.parse(parsed);
    if (legacy.id !== id) throw new Error("Transcript session header identity mismatch.");
    for (let index = 0; index < legacy.messages.length; index += MESSAGES_PER_CHUNK) {
      yield legacy.messages.slice(index, index + MESSAGES_PER_CHUNK);
    }
  }

  async loadSessionMessagesTail(id: string, maxMessages: number): Promise<SessionMessagesPage> {
    return this.loadSessionMessagesTailAttempt(id, maxMessages, 1);
  }

  private async loadSessionMessagesTailAttempt(
    id: string,
    maxMessages: number,
    attempt: number,
  ): Promise<SessionMessagesPage> {
    const sessionPath = this.getSessionPath(id);
    if (!fs.existsSync(sessionPath))
      return this.loadArchivedMessagesTail(id, maxMessages, "missing");
    const sl = log.with({ sessionId: id });
    let readGen: string | undefined;
    try {
      const raw = await readEncryptedFile(sessionPath);
      const parsed: unknown = JSON.parse(raw); // SF-4: validated by a stored-session schema below
      migrateStoredSessionGoal(parsed);
      if (isChunkedHeader(parsed)) {
        const header = StoredSessionHeaderSchema.safeParse(parsed);
        if (!header.success) {
          return this.loadArchivedMessagesTail(id, maxMessages, "schema-invalid");
        }
        const { chunkCount, messageCount, chunkGen } = header.data;
        if (chunkCount === 0 || maxMessages <= 0) {
          return this.preferArchivedMessagesTail(
            id,
            {
              messages: [],
              total: messageCount,
              hasMore: messageCount > 0,
              oldestChunkIndex: null,
            },
            maxMessages,
            "empty",
          );
        }
        if (!chunkGen) {
          sl.warn("Chunked header missing chunkGen; cannot read tail");
          return this.loadArchivedMessagesTail(id, maxMessages, "schema-invalid");
        }
        readGen = chunkGen;
        // Read chunks from the tail until we have at least maxMessages.
        const collected: Message[][] = [];
        let count = 0;
        let idx = chunkCount - 1;
        for (; idx >= 0; idx--) {
          // Read only as many tail chunks as needed; later reads depend on the accumulated count.
          // oxlint-disable-next-line eslint/no-await-in-loop
          const chunk = await this.readChunkAsync(id, chunkGen, idx);
          collected.unshift(chunk);
          count += chunk.length;
          if (count >= maxMessages) break;
        }
        const oldestChunkIndex = Math.max(0, idx);
        const flat = collected.flat();
        const migrationPrefix =
          oldestChunkIndex > 0 ? await this.readChunkAsync(id, chunkGen, oldestChunkIndex - 1) : [];
        const normalized = normalizeLegacyReadinessMessages(
          normalizeInternalControlMessages([...migrationPrefix, ...flat]),
        ).slice(migrationPrefix.length);
        const messages =
          normalized.length > maxMessages
            ? normalized.slice(normalized.length - maxMessages)
            : normalized;
        return this.preferArchivedMessagesTail(
          id,
          {
            messages,
            total: messageCount,
            hasMore: messageCount > messages.length,
            oldestChunkIndex,
          },
          maxMessages,
          "empty",
        );
      }
      // Legacy blob: parse all, slice the tail (no chunk-level savings until migrated).
      migrateSessionFields(parsed);
      migrateCopilotBackendId(parsed);
      const result = StoredSessionSchema.safeParse(parsed);
      if (!result.success) {
        return this.loadArchivedMessagesTail(id, maxMessages, "schema-invalid");
      }
      const all = result.data.messages;
      const messages = all.length > maxMessages ? all.slice(all.length - maxMessages) : all;
      return this.preferArchivedMessagesTail(
        id,
        {
          messages,
          total: all.length,
          hasMore: all.length > messages.length,
          oldestChunkIndex: null,
        },
        maxMessages,
        "empty",
      );
    } catch (e) {
      if (
        readGen &&
        attempt < CHUNK_GENERATION_READ_ATTEMPTS &&
        (await this.chunkGenerationSuperseded(id, readGen, e))
      ) {
        return this.loadSessionMessagesTailAttempt(id, maxMessages, attempt + 1);
      }
      if (!(e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT")) {
        sl.error("Failed to read session messages tail:", e);
      }
      return this.loadArchivedMessagesTail(id, maxMessages, "read-failed");
    }
  }

  private preferArchivedSession(
    id: string,
    local: PersistedSession | null,
    reason: ArchiveRecoveryReason,
  ): PersistedSession | null {
    if (local && local.messages.length > 0) return local;
    return this.loadArchivedSession(id, reason) ?? local;
  }

  private loadArchivedSession(id: string, reason: ArchiveRecoveryReason): PersistedSession | null {
    const messages = this.archive.loadMessages(id);
    if (messages.length === 0) return null;
    const metadata = this.loadArchiveMetadata(id);
    if (!metadata) return null;
    const result = StoredSessionSchema.safeParse({ ...metadata, messages });
    if (!result.success) {
      log.with({ sessionId: id }).warn("Archived session metadata failed schema validation");
      return null;
    }
    this.warnArchiveRecovery(id, messages.length, reason);
    const archived: unknown = result.data;
    return isPersistedSession(archived) ? archived : null;
  }

  private preferArchivedHeader(
    id: string,
    local: SessionHeader,
    reason: ArchiveRecoveryReason,
  ): SessionHeader {
    if (local.messageCount > 0) return local;
    return this.loadArchivedHeader(id, reason) ?? local;
  }

  private loadArchivedHeader(id: string, reason: ArchiveRecoveryReason): SessionHeader | null {
    const messageCount = this.archive.countMessages(id);
    if (messageCount === 0) return null;
    const metadata = this.loadArchiveMetadata(id);
    if (!metadata) return null;
    this.warnArchiveRecovery(id, messageCount, reason);
    return { ...metadata, messageCount };
  }

  private preferArchivedMessagesTail(
    id: string,
    local: SessionMessagesPage,
    maxMessages: number,
    reason: ArchiveRecoveryReason,
  ): SessionMessagesPage {
    if (local.messages.length > 0 || local.total > 0) return local;
    return this.loadArchivedMessagesTail(id, maxMessages, reason);
  }

  private loadArchivedMessagesTail(
    id: string,
    maxMessages: number,
    reason: ArchiveRecoveryReason,
  ): SessionMessagesPage {
    const page = this.archive.loadMessagesTail(id, maxMessages);
    if (page.total === 0) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        oldestChunkIndex: null,
      };
    }
    this.warnArchiveRecovery(id, page.total, reason);
    return {
      messages: page.messages,
      total: page.total,
      hasMore: page.hasMore,
      oldestChunkIndex: null,
    };
  }

  private warnArchiveRecovery(
    sessionId: string,
    messageCount: number,
    reason: ArchiveRecoveryReason,
  ): void {
    if (this.archiveRecoveryWarningEmitted) return;
    this.archiveRecoveryWarningEmitted = true;
    log
      .with({ sessionId, messageCount: String(messageCount), reason })
      .warn("Recovered session history from the read-only session archive");
  }

  private loadArchiveMetadata(id: string): SessionMetadata | null {
    return (
      this.loadIndex().sessions.find((session) => session.id === id) ??
      this.archive.loadMetadata(id)
    );
  }

  saveSessionData(session: PersistedSession): void {
    try {
      session.runtimeId = resolveSessionRuntimeId(session);
      this.writeChunkedSync(session);
    } catch (err) {
      sendErrorTelemetry(makeSessionError(sessionErrors.SESSION_PERSIST_FAILED), err);
      throw err;
    }
  }

  deleteSessionData(id: string): void {
    const sessionPath = this.getSessionPath(id);
    if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
    this.metadataCache.forget(id);
    this.chunkGenCache.delete(id);
    this.parsedChunks.dropSession(id);
    this.removeChunksDir(id);
  }

  // ── Chunked-storage internals ──────────────────────────────────────────────

  /** Reconstruct a full PersistedSession from a chunked header + chunk files (sync). */
  private reconstructFromChunksSync(id: string, header: unknown): PersistedSession | null {
    const sl = log.with({ sessionId: id });
    const parsedHeader = StoredSessionHeaderSchema.safeParse(header);
    if (!parsedHeader.success) {
      sendErrorTelemetry(makeSessionError(sessionErrors.SESSION_LOAD_FAILED));
      sl.warn("Invalid chunked header:", parsedHeader.error.format());
      return null;
    }
    const { chunkCount, chunkGen } = parsedHeader.data;
    if (chunkCount === 0) {
      return this.headerAndMessagesToSession(parsedHeader.data, []);
    }
    if (!chunkGen) {
      sendErrorTelemetry(makeSessionError(sessionErrors.SESSION_LOAD_FAILED));
      sl.warn("Chunked header missing chunkGen — refusing to load (fail-closed)");
      return null;
    }
    try {
      const messages: Message[] = [];
      for (let i = 0; i < chunkCount; i++) {
        messages.push(...this.readCachedChunkSync(id, chunkGen, i));
      }
      return this.headerAndMessagesToSession(parsedHeader.data, messages);
    } catch (e) {
      // A missing/corrupt chunk must FAIL CLOSED (return null), never silently
      // drop messages — silent truncation could be persisted on the next save.
      sendErrorTelemetry(makeSessionError(sessionErrors.SESSION_LOAD_FAILED));
      sl.error("Failed to read chunk(s) — refusing to load (fail-closed):", e);
      return null;
    }
  }

  private async reconstructFromChunksAsync(
    id: string,
    header: unknown,
  ): Promise<PersistedSession | null> {
    const sl = log.with({ sessionId: id });
    const parsedHeader = StoredSessionHeaderSchema.safeParse(header);
    if (!parsedHeader.success) {
      sendErrorTelemetry(makeSessionError(sessionErrors.SESSION_LOAD_FAILED));
      sl.warn("Invalid chunked header:", parsedHeader.error.format());
      return null;
    }
    const { chunkCount, chunkGen } = parsedHeader.data;
    if (chunkCount === 0) {
      return this.headerAndMessagesToSession(parsedHeader.data, []);
    }
    if (!chunkGen) {
      sendErrorTelemetry(makeSessionError(sessionErrors.SESSION_LOAD_FAILED));
      sl.warn("Chunked header missing chunkGen — refusing to load (fail-closed)");
      return null;
    }
    try {
      const chunks = await Promise.all(
        Array.from({ length: chunkCount }, (_, index) =>
          this.readCachedChunkAsync(id, chunkGen, index),
        ),
      );
      const messages = chunks.flat();
      return this.headerAndMessagesToSession(parsedHeader.data, messages);
    } catch (e) {
      if (await this.chunkGenerationSuperseded(id, chunkGen, e)) {
        throw new ChunkGenerationSupersededError(id);
      }
      sendErrorTelemetry(makeSessionError(sessionErrors.SESSION_LOAD_FAILED));
      sl.error("Failed to read chunk(s) — refusing to load (fail-closed):", e);
      return null;
    }
  }

  /** Combine a validated header with messages and validate as a full session.
   *  Verifies the reconstructed message count matches the header to guard against
   *  silent truncation. */
  private headerAndMessagesToSession(
    header: Record<string, unknown>,
    messages: Message[],
  ): PersistedSession | null {
    const expected = header.messageCount;
    if (typeof expected === "number" && messages.length !== expected) {
      sendErrorTelemetry(makeSessionError(sessionErrors.SESSION_LOAD_FAILED));
      log.warn(
        `Reconstructed message count ${messages.length} != header.messageCount ${expected} — fail-closed`,
      );
      return null;
    }
    const {
      storageFormat: _sf,
      chunkGen: _cg,
      chunkCount: _cc,
      messageCount: _mc,
      lastMessagePreview: _lp,
      persistenceProofVersion: _persistenceProofVersion,
      persistenceGenerationToken: _persistenceGenerationToken,
      persistenceCanonicalDigest: _persistenceCanonicalDigest,
      // `messages` in the header is the fail-closed sentinel string; drop it so
      // the real reconstructed array is used below.
      messages: _sentinel,
      ...rest
    } = header;
    const result = StoredSessionSchema.safeParse({ ...rest, messages });
    if (!result.success) {
      sendErrorTelemetry(makeSessionError(sessionErrors.SESSION_LOAD_FAILED));
      log.warn("Reconstructed session failed schema:", result.error.format());
      return null;
    }
    const reconstructed: unknown = result.data;
    return isPersistedSession(reconstructed) ? reconstructed : null;
  }

  /** Read+validate one chunk. THROWS on missing/corrupt/invalid chunk so callers
   *  fail closed rather than silently dropping messages. */
  private async readChunkAsync(
    id: string,
    gen: string,
    index: number,
    read = readEncryptedFile,
  ): Promise<Message[]> {
    return this.parseChunk(id, gen, index, await read(this.getChunkPath(id, gen, index)));
  }

  private parseChunk(id: string, gen: string, index: number, raw: string): Message[] {
    const parsed: unknown = JSON.parse(raw);
    const result = MessageChunkSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Chunk ${gen}/${index} failed schema validation for session ${id}`);
    }
    return result.data;
  }

  /**
   * For full-session reconstruction only: headerAndMessagesToSession re-parses
   * the result through StoredSessionSchema, which hands every caller its own
   * message objects, so cached arrays are never exposed for mutation.
   */
  private readCachedChunkSync(id: string, gen: string, index: number): Message[] {
    const cached = this.parsedChunks.get(id, gen, index);
    if (cached) return cached;
    const raw = readEncryptedFileSync(this.getChunkPath(id, gen, index));
    const messages = this.parseChunk(id, gen, index, raw);
    this.parsedChunks.set(id, gen, index, messages, raw.length);
    return messages;
  }

  private async readCachedChunkAsync(id: string, gen: string, index: number): Promise<Message[]> {
    const cached = this.parsedChunks.get(id, gen, index);
    if (cached) return cached;
    let rawLength = 0;
    const messages = await this.readChunkAsync(id, gen, index, async (chunkPath) => {
      const raw = await readEncryptedFile(chunkPath);
      rawLength = raw.length;
      return raw;
    });
    this.parsedChunks.set(id, gen, index, messages, rawLength);
    return messages;
  }

  /**
   * Async readers await between the header read and each chunk read, and a
   * synchronous save in that gap commits a new generation and garbage-collects
   * the one the reader started from (marking a session read on open does this).
   * True when a missing chunk is explained by the header now naming a newer
   * generation, so the read should start over from the current header.
   */
  private async chunkGenerationSuperseded(
    id: string,
    readGen: string,
    error: unknown,
  ): Promise<boolean> {
    if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
      return false;
    }
    try {
      const parsed: unknown = JSON.parse(await readEncryptedFile(this.getSessionPath(id))); // SF-4: only a string chunkGen is read
      const currentGen =
        typeof parsed === "object" && parsed !== null && "chunkGen" in parsed
          ? parsed.chunkGen
          : undefined;
      return typeof currentGen === "string" && currentGen !== readGen;
    } catch {
      return false;
    }
  }

  /**
   * Write a session in chunked-v1 format using a fresh GENERATION directory.
   * The previously-committed generation is never destroyed before the new header
   * commits, so a crash can never leave the committed header pointing at missing
   * chunks. Order: write all chunks into `{id}.chunks/{newGen}/`, write the header
   * (the commit point) referencing newGen, then garbage-collect older generations.
   */
  private writeChunkedSync(session: PersistedSession): void {
    session = sessionWithPortableGoal(session);
    const id = session.id;
    const chunks = splitIntoChunks(session.messages, MESSAGES_PER_CHUNK);
    const gen = newChunkGen();
    const prev = this.chunkGenCache.get(id);
    const sigs: Array<{ h: number; n: number }> = [];
    if (chunks.length > 0) {
      const genDir = this.getChunkGenDir(id, gen);
      secureMkdirSync(genDir, 0o700);
      chunks.forEach((chunk, idx) => {
        const json = JSON.stringify(chunk);
        const sig = { h: cyrb53(json), n: json.length };
        sigs.push(sig);
        const dest = this.getChunkPath(id, gen, idx);
        const prevSig = prev?.sigs[idx];
        // Reuse the prior generation's encrypted chunk when byte-identical
        // (an append only touches the last chunk) via a hard link — no
        // re-encrypt and no byte copy of unchanged megabytes on every save.
        if (prev && prevSig && prevSig.h === sig.h && prevSig.n === sig.n) {
          const src = this.getChunkPath(id, prev.gen, idx);
          if (fs.existsSync(src) && reuseChunkFile(src, dest)) {
            this.parsedChunks.carry(id, prev.gen, gen, idx);
            return;
          }
        }
        writeEncryptedFileSync(dest, json);
      });
    }
    // Commit point: header references the new generation.
    writeEncryptedFileSync(
      this.getSessionPath(id),
      JSON.stringify(buildChunkedHeader(session, gen, chunks.length)),
    );
    this.metadataCache.remember(session);
    this.gcOldGenerations(id, gen);
    this.chunkGenCache.set(id, { gen, sigs });
  }

  private async writeChunkedAsync(session: PersistedSession): Promise<void> {
    session = sessionWithPortableGoal(session);
    const id = session.id;
    const chunks = splitIntoChunks(session.messages, MESSAGES_PER_CHUNK);
    const gen = newChunkGen();
    const prev = this.chunkGenCache.get(id);
    const sigs: Array<{ h: number; n: number }> = [];
    if (chunks.length > 0) {
      const genDir = this.getChunkGenDir(id, gen);
      secureMkdirSync(genDir, 0o700);
      for (let idx = 0; idx < chunks.length; idx++) {
        const json = JSON.stringify(chunks[idx]);
        const sig = { h: cyrb53(json), n: json.length };
        sigs.push(sig);
        const dest = this.getChunkPath(id, gen, idx);
        const prevSig = prev?.sigs[idx];
        if (prev && prevSig && prevSig.h === sig.h && prevSig.n === sig.n) {
          const src = this.getChunkPath(id, prev.gen, idx);
          if (fs.existsSync(src) && reuseChunkFile(src, dest)) {
            this.parsedChunks.carry(id, prev.gen, gen, idx);
            continue;
          }
        }
        // eslint-disable-next-line no-await-in-loop -- chunks written sequentially for crash-atomic ordering
        await writeEncryptedFile(dest, json);
      }
    }
    await writeEncryptedFile(
      this.getSessionPath(id),
      JSON.stringify(buildChunkedHeader(session, gen, chunks.length)),
    );
    this.metadataCache.remember(session);
    this.gcOldGenerations(id, gen);
    this.chunkGenCache.set(id, { gen, sigs });
  }

  /** Remove every generation directory except `keepGen` (best-effort). */
  private gcOldGenerations(id: string, keepGen: string): void {
    this.parsedChunks.dropGenerationsBefore(id, keepGen);
    const chunksDir = this.getChunksDir(id);
    let entries: string[];
    try {
      entries = fs.readdirSync(chunksDir);
    } catch {
      return; // no chunks dir yet (e.g. empty session) — nothing to GC
    }
    for (const entry of entries) {
      // Only delete generations strictly older (lexicographically less) than the
      // one we just committed. Generation names are time-ordered
      // (Date.now()-base36 + random), so a concurrently-created newer generation
      // sorts greater and is preserved — avoiding deletion of another in-flight
      // writer's chunks. Crash-leftover older generations are reclaimed.
      if (entry >= keepGen) continue;
      try {
        fs.rmSync(path.join(chunksDir, entry), { recursive: true, force: true });
      } catch {
        // Best-effort; a concurrent reader may briefly hold the dir.
      }
    }
  }

  /** Auto-regressive migration: rewrite a legacy single-blob session into the
   *  chunked format. The header file ({id}.json) is overwritten so the old
   *  monolithic blob is replaced and the next load takes the chunked path. */
  private migrateLegacyToChunksSync(session: PersistedSession): void {
    try {
      this.writeChunkedSync(session);
    } catch (e) {
      // Best-effort; the in-memory session is already correct.
      log.with({ sessionId: session.id }).warn("Legacy→chunked migration failed:", e);
    }
  }

  private async migrateLegacyToChunksAsync(session: PersistedSession): Promise<void> {
    // Serialize with other async writes/deletes for this id to avoid racing.
    await this.withSessionWriteLock(session.id, async () => {
      try {
        await this.writeChunkedAsync(session);
      } catch (e) {
        log.with({ sessionId: session.id }).warn("Legacy→chunked migration failed:", e);
      }
    });
  }

  private persistMigratedGoalSync(session: PersistedSession): void {
    try {
      this.writeChunkedSync(session);
    } catch (e) {
      log.with({ sessionId: session.id }).warn("Goal V1→V2 persistence migration failed:", e);
    }
  }

  private async persistMigratedGoalAsync(session: PersistedSession): Promise<void> {
    await this.withSessionWriteLock(session.id, async () => {
      try {
        await this.writeChunkedAsync(session);
      } catch (e) {
        log.with({ sessionId: session.id }).warn("Goal V1→V2 persistence migration failed:", e);
      }
    });
  }

  private removeChunksDir(id: string): void {
    const chunksDir = this.getChunksDir(id);
    if (fs.existsSync(chunksDir)) fs.rmSync(chunksDir, { recursive: true, force: true });
  }

  /** Per-session async write mutex so async writes/migrations/deletes for the same
   *  id never interleave (sync writes are already atomic within one event-loop tick). */
  private withSessionWriteLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionWriteLocks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.sessionWriteLocks.set(
      id,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  }

  dispose(): void {
    this.archive.dispose();
  }
}
