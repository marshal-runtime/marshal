import { createHash, randomUUID } from "node:crypto";
import { createSocket, type Socket as DatagramSocket } from "node:dgram";
import { constants as fsConstants, promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  setImmediate as waitForImmediate,
  setTimeout as waitForTimeout,
} from "node:timers/promises";

import { app } from "electron";

import type { LocalTelemetryEventPayload } from "../common/local-telemetry";
import { createLogger } from "../common/marshal-logger";
import {
  authErrors,
  crashErrors,
  ipcErrors,
  makeAuthError,
  makeCrashError,
  makeIpcError,
  makeMcpError,
  makeSessionError,
  makeUpdaterError,
  mcpErrors,
  sessionErrors,
  updaterErrors,
} from "../common/telemetry/errors/marshal-index";
import {
  formatLocalTelemetryFileName,
  looksLikeLocalTelemetryFile,
  parseLocalTelemetryFileName,
} from "./local-telemetry-file-name";
const log = createLogger("LocalTelemetryStore");

export const LOCAL_TELEMETRY_SUBDIRECTORY = "telemetry";
export const LOCAL_TELEMETRY_MAX_FILE_BYTES = 1024 * 1024;
export const LOCAL_TELEMETRY_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const LOCAL_TELEMETRY_RETENTION_DAYS = 30;

const DEFAULT_PRUNE_EVERY_WRITES = 128;
const DEFAULT_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const SLOW_OPERATION_MS = 100;
const LOCAL_EVENT_TYPES = new Set([
  "Marshal.SessionStart",
  "Marshal.SessionEnd",
  "Marshal.UserAction",
  "Marshal.Fetch",
  "Marshal.Render",
  "Marshal.Error",
]);
const SAFE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;
const MAX_LABEL_LENGTH = 160;
const MAX_MISC_LENGTH = 8 * 1024;
const MAX_BLOCKED_FILE_NAMES = 128;
const MAX_BLOCKED_FILE_IDENTITIES = 128;
const MAX_BLOCKLIST_BYTES = 64 * 1024;
const BLOCKLIST_VERSION = "v1";
const DELETE_FENCE_FILE_VERSION = "v1";
const DELETE_FENCE_VERSION = "v2";
const DELETE_FENCE_LEGACY_VERSION = "v1";
const DELETE_FENCE_MAX_BYTES = 512;
const COMMIT_LEASE_ENDPOINTS = 5;
const COMMIT_LEASE_QUORUM = 3;
const COMMIT_LEASE_PORT_MIN = 20_000;
const COMMIT_LEASE_PORT_SPAN = 40_000;
const COMMIT_LEASE_CLOSE_TIMEOUT_MS = 250;
const OWNER_VERSION = "v1";
const ROOT_MARKER_VERSION = "v1";
const ROOT_MARKER_NAME = ".marshal-telemetry-root-v1";
const PRIVATE_METADATA_MAX_BYTES = 1024;
const LOGICAL_DATES_FILE_VERSION = "v2";
const LOGICAL_DATES_VERSION = "v3";
const LOGICAL_DATES_LEGACY_VERSION = "v2";
const LOGICAL_DATES_MAX_BYTES = 256 * 1024;
const LOGICAL_DATES_SWITCH_RESERVE_BYTES = 512;
const LOGICAL_DATES_REQUIRED_VERSION = "v1";
const MAX_TELEMETRY_SHELLS = 1001;
const FILE_INSPECTION_BATCH_SIZE = 32;

const REGISTERED_ERRORS = new Map<string, { [code: number]: string }>([
  [makeAuthError(authErrors.AUTH_SILENT_ACQUIRE_FAILED).family, authErrors],
  [makeCrashError(crashErrors.REACT_ERROR_BOUNDARY).family, crashErrors],
  [makeIpcError(ipcErrors.HANDLER_UNCAUGHT).family, ipcErrors],
  [makeMcpError(mcpErrors.SERVER_CONNECTION_FAILED).family, mcpErrors],
  [makeSessionError(sessionErrors.SESSION_INIT_FAILED).family, sessionErrors],
  [makeUpdaterError(updaterErrors.MANIFEST_TIMEOUT).family, updaterErrors],
]);

type PersistedField = boolean | number | string;

export interface SanitizedLocalTelemetryEvent {
  eventType: string;
  fields: Record<string, PersistedField>;
}

export interface LocalTelemetryCommitEndpoint {
  host: string;
  port: number;
}

export function resolveLocalTelemetryCommitEndpoints(
  profileKey: string,
  platform: NodeJS.Platform = process.platform,
): LocalTelemetryCommitEndpoint[] {
  return resolveLocalTelemetryLeaseEndpoints(
    profileKey,
    platform,
    "127.0.0.1",
    COMMIT_LEASE_PORT_MIN,
    COMMIT_LEASE_PORT_SPAN,
  );
}

export function resolveLocalTelemetryAdmissionEndpoints(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): LocalTelemetryCommitEndpoint[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const absolute = pathApi.resolve(directory).normalize("NFC");
  const profileKey = platform === "win32" ? absolute.toLowerCase() : absolute;
  return resolveLocalTelemetryLeaseEndpoints(
    `${profileKey}\0admission`,
    platform,
    "127.0.0.2",
    COMMIT_LEASE_PORT_MIN,
    COMMIT_LEASE_PORT_SPAN,
  );
}

function resolveLocalTelemetryLeaseEndpoints(
  profileKey: string,
  platform: NodeJS.Platform,
  host: string,
  portMin: number,
  portSpan: number,
): LocalTelemetryCommitEndpoint[] {
  const normalized = profileKey.normalize("NFC");
  const key = platform === "win32" ? normalized.toLowerCase() : normalized;
  const endpoints: LocalTelemetryCommitEndpoint[] = [];
  const seen = new Set<string>();
  const seenPorts = new Set<number>();
  for (let index = 0; endpoints.length < COMMIT_LEASE_ENDPOINTS; index++) {
    const digest = createHash("sha256").update(`${key}\0${index}`).digest();
    const port = portMin + (digest.readUInt32BE(3) % portSpan);
    const endpointKey = `${host}:${port}`;
    if (seen.has(endpointKey) || seenPorts.has(port)) continue;
    seen.add(endpointKey);
    seenPorts.add(port);
    endpoints.push({ host, port });
  }
  return endpoints;
}

interface TelemetryFile {
  key: string;
  directory: string;
  name: string;
  date: string;
  index: number;
  size: number;
  mtimeMs: number;
  dev?: number;
  ino?: number;
}

interface TelemetryDirectoryIdentity {
  dev?: number;
  ino?: number;
  realPath: string;
}

interface TelemetryFileIdentity {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
}

interface PreparedTelemetryAppend {
  file: TelemetryFile;
  filePath: string;
  handle: FileHandle;
  previousSize: number;
  now: Date;
  directoryIdentity: TelemetryDirectoryIdentity;
  fileIdentity: TelemetryFileIdentity;
}

export interface LocalTelemetryDeleteOutcome {
  complete: boolean;
  deletedFiles: number;
  deletedBytes: number;
  remainingFiles: number;
  remainingBytes: number;
  failedFiles: number;
  failureCodes: string[];
}

interface TelemetryEraseOutcome {
  erased: boolean;
  bytes: number;
}

interface TelemetryDeleteScan {
  files: TelemetryFile[];
  malformedFiles: number;
  malformedBytes: number;
  failureCodes: string[];
}

interface TelemetryDeleteFence {
  state: "idle" | "deleting";
  generation: number;
  token: string;
  pid: number;
  startedAtMs: number;
  completedAtMs: number;
}

interface TelemetryDeleteTransaction {
  generation: number;
  token: string;
  startedAtMs: number;
}

interface TelemetryAppendAdmission {
  blockedByLocalDelete: boolean;
  generation: number | null;
  lease: Promise<TelemetryCommitLease> | null;
}

interface TelemetryCommitLease {
  assertHealthy(): void;
  release(): Promise<void>;
}

interface OwnedTelemetryRoot {
  path: string;
  identity: TelemetryDirectoryIdentity;
  createdAtMs: number;
}

interface LogicalDatesBuffer {
  generation: number;
  buffer: "a" | "b";
  bytes: number;
  entries: Map<string, { date: string; index: number }>;
  version: typeof LOGICAL_DATES_VERSION | typeof LOGICAL_DATES_LEGACY_VERSION;
  sequence: number;
  snapshotDigest: string;
  previousGeneration: number;
  previousSnapshotDigest: string;
  switchTarget: LogicalDatesSwitch | null;
}

interface LogicalDatesSwitch {
  buffer: "a" | "b";
  generation: number;
  snapshotDigest: string;
  sequence: number;
}

interface LogicalDatesSelection {
  selected: LogicalDatesBuffer;
  witness: LogicalDatesBuffer | null;
}

type LogicalDatesBufferState =
  | {
      state: "valid";
      buffer: "a" | "b";
      value: LogicalDatesBuffer;
    }
  | {
      state: "missing";
      buffer: "a" | "b";
    }
  | {
      state: "incomplete" | "corrupt";
      buffer: "a" | "b";
      generation: number | null;
      snapshotCommitted: boolean;
      code: string;
    };

export interface LocalTelemetryStoreOptions {
  directory?: string;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxShells?: number;
  maxLogicalDatesBytes?: number;
  retentionDays?: number;
  pruneEveryWrites?: number;
  pruneIntervalMs?: number;
  now?: () => Date;
  onOperationTiming?: (timing: LocalTelemetryOperationTiming) => void;
  platform?: NodeJS.Platform;
  securityOps?: LocalTelemetrySecurityOps;
  beforeDirectoryCreate?: (parentDirectory: string) => void | Promise<void>;
  beforeFileCreate?: (filePath: string) => void | Promise<void>;
  beforeBoundFileCreate?: (directory: string) => void | Promise<void>;
  beforeFileOpen?: (filePath: string) => void | Promise<void>;
  afterFileOpen?: (filePath: string) => void | Promise<void>;
  beforeAppendCommit?: (filePath: string) => void | Promise<void>;
  beforeAppendCommitLease?: () => void | Promise<void>;
  beforeAppendAdmissionBind?: (endpoint: LocalTelemetryCommitEndpoint) => void | Promise<void>;
  afterDeleteFenceObserved?: (fence: {
    state: "idle" | "deleting";
    generation: number;
  }) => void | Promise<void>;
  beforeAppendWrite?: (filePath: string) => void | Promise<void>;
  afterAppendWrite?: (filePath: string) => void | Promise<void>;
  beforeFileRemove?: (filePath: string) => void | Promise<void>;
  truncateFile?: (handle: FileHandle, filePath: string) => Promise<void>;
  rollbackFile?: (handle: FileHandle, size: number) => Promise<void>;
  syncFile?: (handle: FileHandle) => Promise<void>;
  writeChunk?: (
    handle: FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<number>;
  closeFile?: (handle: FileHandle) => Promise<void>;
}

export interface LocalTelemetryPathInfo {
  kind: "file" | "directory" | "other";
  mode: number;
  dev?: number;
  ino?: number;
  nlink?: number;
  size?: number;
  mtimeMs?: number;
}

export interface LocalTelemetrySecurityOps {
  getPathInfo(path: string): Promise<LocalTelemetryPathInfo>;
  chmod(path: string, mode: number): Promise<void>;
  realpath(path: string): Promise<string>;
}

export interface LocalTelemetryOperationTiming {
  operation: string;
  queueWaitMs: number;
  serviceMs: number;
  queueDepth: number;
  payloadBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LABEL_LENGTH) {
    return undefined;
  }
  return SAFE_LABEL_RE.test(value) ? value : undefined;
}

function safeSessionId(value: unknown): string | undefined {
  const label = safeLabel(value);
  return label && !label.includes(" ") ? label : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function copyLabel(
  source: Record<string, unknown>,
  target: Record<string, PersistedField>,
  key: string,
): void {
  const value = safeLabel(source[key]);
  if (value !== undefined) target[key] = value;
}

function copyNumber(
  source: Record<string, unknown>,
  target: Record<string, PersistedField>,
  key: string,
): void {
  const value = safeNumber(source[key]);
  if (value !== undefined) target[key] = value;
}

function copyBoolean(
  source: Record<string, unknown>,
  target: Record<string, PersistedField>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "boolean") target[key] = value;
}

function parseMisc(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_MISC_LENGTH)
    return null;
  try {
    // SF-4: bounded telemetry misc is narrowed to a record, then read through named allowlists only.
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function copyCommonFields(
  source: Record<string, unknown>,
  target: Record<string, PersistedField>,
): void {
  copyLabel(source, target, "appVersion");
  copyLabel(source, target, "hostAppPlatform");
  copyLabel(source, target, "hostAppVersion");
  const sessionCorrelationId = safeSessionId(source.sessionCorrelationId);
  if (sessionCorrelationId !== undefined) target.sessionCorrelationId = sessionCorrelationId;
}

function copyLlmUsageFields(
  misc: Record<string, unknown>,
  target: Record<string, PersistedField>,
): void {
  copyLabel(misc, target, "model");
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "cost",
    "ttftMs",
    "interTokenLatencyMs",
  ]) {
    copyNumber(misc, target, key);
  }
}

export function sanitizeLocalTelemetryEvent(
  event: LocalTelemetryEventPayload,
): SanitizedLocalTelemetryEvent | null {
  if (!LOCAL_EVENT_TYPES.has(event.eventType) || !isRecord(event.fields)) return null;

  const source = event.fields;
  const fields: Record<string, PersistedField> = {};
  copyCommonFields(source, fields);

  switch (event.eventType) {
    case "Marshal.SessionStart":
      copyLabel(source, fields, "gesture");
      copyLabel(source, fields, "initialSize");
      break;
    case "Marshal.SessionEnd":
      copyLabel(source, fields, "gesture");
      copyLabel(source, fields, "finalSize");
      break;
    case "Marshal.UserAction":
      for (const key of ["action", "component", "gesture", "moduleName", "size"]) {
        copyLabel(source, fields, key);
      }
      {
        const renderScenarioCorrelationId = safeSessionId(source.renderScenarioCorrelationId);
        if (renderScenarioCorrelationId !== undefined) {
          fields.renderScenarioCorrelationId = renderScenarioCorrelationId;
        }
      }
      {
        const index = safeInteger(source.index);
        if (index !== undefined) fields.index = index;
      }
      break;
    case "Marshal.Fetch": {
      for (const key of ["errorCode", "moduleName", "result", "scenario", "source"]) {
        copyLabel(source, fields, key);
      }
      copyNumber(source, fields, "duration");
      const renderScenarioCorrelationId = safeSessionId(source.renderScenarioCorrelationId);
      if (renderScenarioCorrelationId !== undefined) {
        fields.renderScenarioCorrelationId = renderScenarioCorrelationId;
      }
      const misc = parseMisc(source.misc);
      if (source.scenario === "LlmTokenUsage" && misc) {
        copyLlmUsageFields(misc, fields);
      } else if (source.scenario === "ipc.unauthorized_sender" && misc) {
        copyLabel(misc, fields, "channel");
      }
      break;
    }
    case "Marshal.Render":
      for (const key of ["action", "intendedSize", "size", "state", "targetView"]) {
        copyLabel(source, fields, key);
      }
      copyNumber(source, fields, "duration");
      copyNumber(source, fields, "preRenderLatency");
      copyBoolean(source, fields, "didScroll");
      {
        const renderScenarioCorrelationId = safeSessionId(source.renderScenarioCorrelationId);
        if (renderScenarioCorrelationId !== undefined) {
          fields.renderScenarioCorrelationId = renderScenarioCorrelationId;
        }
      }
      break;
    case "Marshal.Error": {
      const family = source.family;
      const code = safeInteger(source.code);
      const message = source.message;
      if (
        typeof family !== "string" ||
        code === undefined ||
        typeof message !== "string" ||
        REGISTERED_ERRORS.get(family)?.[code] !== message
      ) {
        return null;
      }
      fields.family = family;
      fields.code = code;
      fields.message = message;
      break;
    }
  }

  return { eventType: event.eventType, fields };
}

function errorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "unknown";
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRetryableSecurityError(error: unknown): boolean {
  if (!isRecord(error) || typeof error.code !== "string") return false;
  return error.code === "EACCES" || error.code === "EPERM" || error.code === "EBUSY";
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class LocalTelemetryStore {
  readonly directory: string;
  private storageDirectory: string;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxShells: number;
  private readonly maxLogicalDatesBytes: number;
  private readonly retentionDays: number;
  private readonly pruneEveryWrites: number;
  private readonly pruneIntervalMs: number;
  private readonly now: () => Date;
  private readonly onOperationTiming: ((timing: LocalTelemetryOperationTiming) => void) | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly securityOps: LocalTelemetrySecurityOps;
  private readonly verifyOpenHandleMode: boolean;
  private readonly beforeDirectoryCreate:
    | ((parentDirectory: string) => void | Promise<void>)
    | undefined;
  private readonly beforeFileCreate: ((filePath: string) => void | Promise<void>) | undefined;
  private readonly beforeBoundFileCreate: ((directory: string) => void | Promise<void>) | undefined;
  private readonly beforeFileOpen: ((filePath: string) => void | Promise<void>) | undefined;
  private readonly afterFileOpen: ((filePath: string) => void | Promise<void>) | undefined;
  private readonly beforeAppendCommit: ((filePath: string) => void | Promise<void>) | undefined;
  private readonly beforeAppendCommitLease: (() => void | Promise<void>) | undefined;
  private readonly beforeAppendAdmissionBind:
    | ((endpoint: LocalTelemetryCommitEndpoint) => void | Promise<void>)
    | undefined;
  private readonly afterDeleteFenceObserved:
    | ((fence: { state: "idle" | "deleting"; generation: number }) => void | Promise<void>)
    | undefined;
  private readonly beforeAppendWrite: ((filePath: string) => void | Promise<void>) | undefined;
  private readonly afterAppendWrite: ((filePath: string) => void | Promise<void>) | undefined;
  private readonly beforeFileRemove: ((filePath: string) => void | Promise<void>) | undefined;
  private readonly truncateFile: (handle: FileHandle, filePath: string) => Promise<void>;
  private readonly rollbackFile: (handle: FileHandle, size: number) => Promise<void>;
  private readonly syncFile: (handle: FileHandle) => Promise<void>;
  private readonly writeChunk: NonNullable<LocalTelemetryStoreOptions["writeChunk"]>;
  private commitLeaseEndpoints: LocalTelemetryCommitEndpoint[] | null = null;
  private readonly admissionLeaseEndpoints: LocalTelemetryCommitEndpoint[];
  private readonly closeFile: (handle: FileHandle) => Promise<void>;
  private pendingWrite: Promise<void> = Promise.resolve();
  private queueDepth = 0;
  private admissionEpoch = 0;
  private readonly activeDeleteAdmissionEpochs = new Set<number>();
  private observedDeleteGeneration: number | null = null;
  private initialized = false;
  private activeFile: TelemetryFile | null = null;
  private activeAppend: PreparedTelemetryAppend | null = null;
  private ancestorIdentity: TelemetryDirectoryIdentity | null = null;
  private ownerToken: string | null = null;
  private directoryIdentity: TelemetryDirectoryIdentity | null = null;
  private readonly recoveryDirectoryIdentities = new Map<string, TelemetryDirectoryIdentity>();
  private readonly files = new Map<string, TelemetryFile>();
  private readonly zeroShells = new Map<string, TelemetryFile>();
  private readonly primaryTelemetryNames = new Set<string>();
  private readonly logicalDates = new Map<string, { date: string; index: number }>();
  private logicalDatesGeneration = 0;
  private logicalDatesBuffer: "a" | "b" = "a";
  private logicalDatesBytes = 0;
  private logicalDatesRequired = false;
  private logicalDatesVersion: typeof LOGICAL_DATES_VERSION | typeof LOGICAL_DATES_LEGACY_VERSION =
    LOGICAL_DATES_VERSION;
  private logicalDatesSequence = 0;
  private logicalDatesSnapshotDigest = "-";
  private logicalDatesWitnessBuffer: "a" | "b" | null = null;
  private logicalDatesWitnessBytes = 0;
  private logicalDatesWitnessedSequence = 0;
  private logicalDatesNeedsReload = false;
  private readonly blockedFileNames = new Set<string>();
  private readonly blockedFileIdentities = new Set<string>();
  private blockAllFiles = false;
  private totalBytes = 0;
  private writesSincePrune = 0;
  private lastPruneAtMs = 0;

  constructor(options: LocalTelemetryStoreOptions = {}) {
    this.directory =
      options.directory ?? path.join(app.getPath("userData"), LOCAL_TELEMETRY_SUBDIRECTORY);
    this.storageDirectory = this.directory;
    this.maxFileBytes = options.maxFileBytes ?? LOCAL_TELEMETRY_MAX_FILE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? LOCAL_TELEMETRY_MAX_TOTAL_BYTES;
    this.maxShells = Math.max(2, options.maxShells ?? MAX_TELEMETRY_SHELLS);
    this.maxLogicalDatesBytes = Math.max(
      1024,
      options.maxLogicalDatesBytes ?? LOGICAL_DATES_MAX_BYTES,
    );
    this.retentionDays = options.retentionDays ?? LOCAL_TELEMETRY_RETENTION_DAYS;
    this.pruneEveryWrites = Math.max(1, options.pruneEveryWrites ?? DEFAULT_PRUNE_EVERY_WRITES);
    this.pruneIntervalMs = Math.max(1, options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS);
    this.now = options.now ?? (() => new Date());
    this.onOperationTiming = options.onOperationTiming;
    this.platform = options.platform ?? process.platform;
    this.admissionLeaseEndpoints = resolveLocalTelemetryAdmissionEndpoints(
      this.directory,
      this.platform,
    );
    this.verifyOpenHandleMode = options.securityOps === undefined;
    this.securityOps = options.securityOps ?? {
      getPathInfo: async (targetPath) => {
        const stat = await fs.lstat(targetPath);
        return {
          kind: stat.isSymbolicLink()
            ? "other"
            : stat.isDirectory()
              ? "directory"
              : stat.isFile()
                ? "file"
                : "other",
          mode: stat.mode,
          dev: stat.dev,
          ino: stat.ino,
          nlink: stat.nlink,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      },
      chmod: (targetPath, mode) => fs.chmod(targetPath, mode),
      realpath: (targetPath) => fs.realpath(targetPath),
    };
    this.beforeDirectoryCreate = options.beforeDirectoryCreate;
    this.beforeFileCreate = options.beforeFileCreate;
    this.beforeBoundFileCreate = options.beforeBoundFileCreate;
    this.beforeFileOpen = options.beforeFileOpen;
    this.afterFileOpen = options.afterFileOpen;
    this.beforeAppendCommit = options.beforeAppendCommit;
    this.beforeAppendCommitLease = options.beforeAppendCommitLease;
    this.beforeAppendAdmissionBind = options.beforeAppendAdmissionBind;
    this.afterDeleteFenceObserved = options.afterDeleteFenceObserved;
    this.beforeAppendWrite = options.beforeAppendWrite;
    this.afterAppendWrite = options.afterAppendWrite;
    this.beforeFileRemove = options.beforeFileRemove;
    this.truncateFile = options.truncateFile ?? ((handle) => handle.truncate(0));
    this.rollbackFile = options.rollbackFile ?? ((handle, size) => handle.truncate(size));
    this.syncFile = options.syncFile ?? ((handle) => handle.sync());
    this.writeChunk =
      options.writeChunk ??
      (async (handle, buffer, offset, length, position) => {
        const result = await handle.write(buffer, offset, length, position);
        return result.bytesWritten;
      });
    this.closeFile = options.closeFile ?? ((handle) => handle.close());
  }

  append(event: SanitizedLocalTelemetryEvent): Promise<void> {
    const admissionSnapshot = {
      blockedByLocalDelete: this.activeDeleteAdmissionEpochs.size > 0,
      generation: this.observedDeleteGeneration,
    };
    const line =
      JSON.stringify({
        schemaVersion: 1,
        recordedAt: this.now().toISOString(),
        eventType: event.eventType,
        fields: event.fields,
      }) + "\n";
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > this.maxFileBytes) {
      return this.enqueue(
        "write",
        async () => {
          throw new Error("event_too_large");
        },
        lineBytes,
      );
    }
    const admission = this.startAppendAdmission(admissionSnapshot);
    return this.enqueue(
      "write",
      async () => {
        if (admission.blockedByLocalDelete || !admission.lease) {
          throw new Error("telemetry_delete_in_progress");
        }
        const admissionLease = await admission.lease;
        try {
          admissionLease.assertHealthy();
          await this.beforeAppendCommitLease?.();
          const lease = await this.acquireCommitLease("append");
          try {
            await this.appendLine(line, lineBytes, admission.generation, lease, admissionLease);
          } finally {
            await lease.release();
          }
        } finally {
          await admissionLease.release();
        }
      },
      lineBytes,
    );
  }

  prune(): Promise<void> {
    return this.enqueue("prune", async () => {
      const observedFence = await this.observeDeleteFence();
      const lease = await this.acquireCommitLease("append");
      try {
        lease.assertHealthy();
        await this.assertAppendGeneration(observedFence);
        if (!this.initialized) {
          await this.initialize();
          return;
        }
        if (await this.ensureBoundDirectoryFast()) {
          this.clearCachedFileState();
        }
        await this.closeActiveFile();
        await this.refreshFilesAndPrune();
      } finally {
        await lease.release();
      }
    });
  }

  deleteAll(): Promise<LocalTelemetryDeleteOutcome> {
    const deleteAdmissionEpoch = ++this.admissionEpoch;
    this.activeDeleteAdmissionEpochs.add(deleteAdmissionEpoch);
    let deleteAdmissionLease: TelemetryCommitLease | null = null;
    const result = this.enqueue("delete", async () => {
      let lease: TelemetryCommitLease | null = null;
      let transaction: TelemetryDeleteTransaction | null = null;
      const deletedFileKeys = new Set<string>();
      const failedFileKeys = new Set<string>();
      const failureCodes = new Set<string>();
      let deletedBytes = 0;
      let malformedFiles = 0;
      let malformedBytes = 0;
      let finalScan: TelemetryDeleteScan | null = null;
      try {
        deleteAdmissionLease = await this.beginAdmissionLease("delete");
        deleteAdmissionLease.assertHealthy();
        lease = await this.acquireCommitLease("delete");
        lease.assertHealthy();
        if (!this.initialized) await this.initializeForDelete();
        else await this.ensureBoundDirectoryFast();
        transaction = await this.beginDeleteTransaction();
        await this.closeActiveFile();
        for (let pass = 0; pass < 2; pass++) {
          // eslint-disable-next-line no-await-in-loop -- the second pass catches writers already in flight at fence creation
          const scan = await this.listFilesForDeletion();
          malformedFiles = Math.max(malformedFiles, scan.malformedFiles);
          malformedBytes = Math.max(malformedBytes, scan.malformedBytes);
          for (const code of scan.failureCodes) failureCodes.add(code);
          for (const file of scan.files) {
            try {
              // eslint-disable-next-line no-await-in-loop -- privacy erasure verifies each opened handle independently
              const erased = await this.removeFile(file);
              if (erased.erased) {
                deletedFileKeys.add(file.key);
                deletedBytes += erased.bytes;
              }
            } catch (error) {
              failedFileKeys.add(file.key);
              failureCodes.add(errorCode(error));
            }
          }
          // eslint-disable-next-line no-await-in-loop -- yield lets pre-fence writers either commit or observe the fence
          await waitForImmediate();
        }
        finalScan = await this.listFilesForDeletion();
        for (const code of finalScan.failureCodes) failureCodes.add(code);
        lease.assertHealthy();
        const fenceOwned = await this.deleteFenceMatches(transaction);
        if (!fenceOwned) failureCodes.add("telemetry_delete_fence_lost");
        const remainingFiles = finalScan.files.length + finalScan.malformedFiles;
        const remainingBytes =
          finalScan.files.reduce((sum, file) => sum + file.size, 0) + finalScan.malformedBytes;
        const failedFiles =
          failedFileKeys.size + Math.max(malformedFiles, finalScan.malformedFiles);
        this.applyFileSnapshot(finalScan.files);
        return {
          complete:
            fenceOwned &&
            failedFiles === 0 &&
            failureCodes.size === 0 &&
            remainingFiles === 0 &&
            remainingBytes === 0,
          deletedFiles: deletedFileKeys.size,
          deletedBytes,
          remainingFiles,
          remainingBytes,
          failedFiles,
          failureCodes: [...failureCodes].sort(),
        };
      } finally {
        if (transaction && lease) {
          await this.finishDeleteTransaction(transaction, lease);
        } else {
          if (lease) await lease.release();
        }
      }
    });
    return result.then(
      async (outcome) => {
        this.activeDeleteAdmissionEpochs.delete(deleteAdmissionEpoch);
        if (deleteAdmissionLease) await deleteAdmissionLease.release();
        return outcome;
      },
      async (error: unknown) => {
        this.activeDeleteAdmissionEpochs.delete(deleteAdmissionEpoch);
        if (deleteAdmissionLease) await deleteAdmissionLease.release();
        throw error;
      },
    );
  }

  async flush(): Promise<void> {
    await this.pendingWrite;
    await this.closeActiveFile();
  }

  private enqueue<T>(operation: string, task: () => Promise<T>, payloadBytes = 0): Promise<T> {
    const enqueuedAt = performance.now();
    const queueDepth = ++this.queueDepth;
    const result = this.pendingWrite.then(async () => {
      const startedAt = performance.now();
      try {
        return await task();
      } finally {
        const finishedAt = performance.now();
        this.queueDepth -= 1;
        const timing = {
          operation,
          queueWaitMs: startedAt - enqueuedAt,
          serviceMs: finishedAt - startedAt,
          queueDepth,
          payloadBytes,
        };
        try {
          this.onOperationTiming?.(timing);
        } catch (error) {
          log.warn("Local telemetry timing observer failed", { code: errorCode(error) });
        }
        if (timing.queueWaitMs >= SLOW_OPERATION_MS || timing.serviceMs >= SLOW_OPERATION_MS) {
          log.info("Local telemetry operation timing", timing);
        }
      }
    });
    this.pendingWrite = result.then(
      () => undefined,
      (error) => {
        log.error("Local telemetry operation failed", { operation, code: errorCode(error) });
      },
    );
    return result;
  }

  private async initialize(): Promise<void> {
    await this.bindAncestorIdentity();
    this.ownerToken = await this.loadOrCreateOwnerToken();
    await this.discoverStorageDirectories();
    await this.ensureBoundDirectory();
    await this.loadLogicalDates();
    await this.loadBlocklist();
    await this.refreshFilesAndPrune();
    this.initialized = true;
  }

  private async initializeForDelete(): Promise<void> {
    await this.bindAncestorIdentity();
    this.ownerToken = await this.loadOrCreateOwnerToken();
    await this.discoverStorageDirectories();
    await this.ensureBoundDirectory();
  }

  private async appendLine(
    line: string,
    lineBytes: number,
    admissionGeneration: number | null,
    lease: TelemetryCommitLease,
    admissionLease: TelemetryCommitLease,
  ): Promise<void> {
    lease.assertHealthy();
    admissionLease.assertHealthy();
    const currentFence = await this.normalizeDeleteFenceUnderLock();
    if (admissionGeneration === null) {
      throw new Error("telemetry_delete_generation_unknown");
    }
    if (currentFence.generation !== admissionGeneration) {
      throw new Error("telemetry_delete_generation_changed");
    }
    const prepared = await this.prepareAppend(lineBytes);
    let committed = false;
    let writeStarted = false;
    let preimage: Buffer | null = null;
    let postCommitError: unknown;
    try {
      await this.beforeAppendCommit?.(prepared.filePath);
      const current = await this.validatePreparedAppend(prepared);
      if (current.size > this.maxFileBytes) throw new Error("telemetry_file_too_large");
      preimage = await this.readBufferAt(prepared.handle, current.size);
      prepared.previousSize = current.size;
      prepared.fileIdentity = current;
      await this.ensureLogicalDateForCommit(prepared.file);
      await this.beforeAppendWrite?.(prepared.filePath);
      writeStarted = true;
      await this.writeBufferAt(prepared.handle, Buffer.from(line, "utf8"), current.size);
      await this.syncFile(prepared.handle);
      await this.afterAppendWrite?.(prepared.filePath);
      const committedIdentity = await this.validatePreparedAppend(prepared);
      if (committedIdentity.size !== current.size + lineBytes) {
        throw new Error("telemetry_append_size_changed");
      }
      admissionLease.assertHealthy();
      lease.assertHealthy();
      committed = true;
    } catch (error) {
      if (writeStarted && preimage) {
        try {
          await this.rollbackCommittedAppend(prepared, preimage);
        } catch (rollbackError) {
          await this.closeActiveFileAfterError(rollbackError);
          throw rollbackError;
        }
      }
      await this.closeActiveFileAfterError(error);
      throw error;
    }

    const updated = {
      ...prepared.file,
      size: prepared.previousSize + lineBytes,
      mtimeMs: prepared.now.getTime(),
      dev: prepared.fileIdentity.dev,
      ino: prepared.fileIdentity.ino,
    };
    this.files.set(updated.key, updated);
    this.zeroShells.delete(updated.key);
    this.activeFile = updated;
    this.totalBytes += updated.size - prepared.file.size;
    this.writesSincePrune += 1;
    if (this.activeAppend === prepared) {
      prepared.file = updated;
      prepared.previousSize = updated.size;
      prepared.fileIdentity = { ...prepared.fileIdentity, size: updated.size };
    }

    try {
      if (this.totalBytes > this.maxTotalBytes) {
        await this.closeActiveFile();
        await this.pruneKnownFiles();
      } else if (
        this.writesSincePrune >= this.pruneEveryWrites ||
        prepared.now.getTime() - this.lastPruneAtMs >= this.pruneIntervalMs
      ) {
        await this.closeActiveFile();
        await this.refreshFilesAndPrune();
      }
    } catch (error) {
      postCommitError = error;
      log.warn("Local telemetry post-append maintenance failed", { code: errorCode(error) });
    }
    if (!committed) throw new Error("telemetry_append_not_committed");
    if (postCommitError !== undefined) throw postCommitError;
  }

  private async writeBufferAt(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
    let offset = 0;
    while (offset < buffer.length) {
      // eslint-disable-next-line no-await-in-loop -- positional writes advance one bounded telemetry record
      const bytesWritten = await this.writeChunk(
        handle,
        buffer,
        offset,
        buffer.length - offset,
        position + offset,
      );
      if (bytesWritten <= 0) throw new Error("telemetry_append_write_stalled");
      offset += bytesWritten;
    }
  }

  private async readBufferAt(handle: FileHandle, size: number): Promise<Buffer> {
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      // eslint-disable-next-line no-await-in-loop -- bounded positional reads capture one telemetry-file preimage
      const result = await handle.read(buffer, offset, size - offset, offset);
      if (result.bytesRead <= 0) throw new Error("telemetry_preimage_read_stalled");
      offset += result.bytesRead;
    }
    return buffer;
  }

  private async rollbackCommittedAppend(
    prepared: PreparedTelemetryAppend,
    preimage: Buffer,
  ): Promise<void> {
    let primaryError: unknown;
    try {
      await this.rollbackFile(prepared.handle, prepared.previousSize);
      await this.syncFile(prepared.handle);
      await this.verifyRollbackPreimage(prepared.handle, preimage);
      return;
    } catch (error) {
      primaryError = error;
    }

    try {
      if (preimage.length > 0) await this.writeBufferAt(prepared.handle, preimage, 0);
      await this.syncFile(prepared.handle);
      await prepared.handle.truncate(prepared.previousSize);
      await this.syncFile(prepared.handle);
      await this.verifyRollbackPreimage(prepared.handle, preimage);
    } catch (fallbackError) {
      log.error("Primary local telemetry append rollback failed", {
        code: errorCode(primaryError),
      });
      await this.blockFile(prepared.file.name, prepared.fileIdentity).catch(() => {});
      throw new Error("telemetry_append_rollback_irrecoverable", { cause: fallbackError });
    }
  }

  private async verifyRollbackPreimage(handle: FileHandle, preimage: Buffer): Promise<void> {
    const verified = await handle.stat();
    if (verified.size !== preimage.length) {
      throw new Error("telemetry_append_rollback_size_mismatch");
    }
    const restored = await this.readBufferAt(handle, preimage.length);
    if (!restored.equals(preimage)) {
      throw new Error("telemetry_append_rollback_content_mismatch");
    }
  }

  private async prepareAppend(lineBytes: number): Promise<PreparedTelemetryAppend> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop -- one bounded retry handles missing paths or transient permissions
        return await this.prepareAppendOnce(lineBytes);
      } catch (error) {
        if (attempt > 0 || (!isNotFound(error) && !isRetryableSecurityError(error))) throw error;
        // eslint-disable-next-line no-await-in-loop -- retry cleanup must finish before rebuilding identities
        await this.resetFileState();
      }
    }
    throw new Error("telemetry_append_preparation_failed");
  }

  private async prepareAppendOnce(lineBytes: number): Promise<PreparedTelemetryAppend> {
    if (!this.initialized) {
      await this.initialize();
    } else if (await this.ensureBoundDirectoryFast()) {
      this.clearCachedFileState();
      await this.refreshFilesAndPrune();
    }

    const now = this.now();
    const date = utcDate(now);
    if (
      this.activeFile &&
      (this.activeFile.date !== date ||
        (this.activeFile.size > 0 && this.activeFile.size + lineBytes > this.maxFileBytes))
    ) {
      await this.closeActiveFile();
      await this.refreshFilesAndPrune();
    }

    const file = await this.selectFile(lineBytes, now);
    const directoryIdentity = this.requireDirectoryIdentity();
    const filePath = path.join(file.directory, file.name);
    await this.beforeFileOpen?.(filePath);
    if (this.beforeFileOpen) {
      await this.verifyDirectoryIdentityFast(directoryIdentity, file.directory);
    }
    let prepared = this.activeAppend;
    if (!prepared || prepared.file.key !== file.key) {
      await this.closeActiveFile();
      prepared = await this.openTelemetryFile(file, directoryIdentity, now);
      this.activeAppend = prepared;
    } else {
      prepared.file = file;
      prepared.now = now;
      prepared.directoryIdentity = directoryIdentity;
    }
    return prepared;
  }

  private async bindAncestorIdentity(): Promise<void> {
    const ancestor = await this.readDirectoryIdentity(path.dirname(this.directory), true);
    if (this.ancestorIdentity && !this.directoryIdentitiesMatch(this.ancestorIdentity, ancestor)) {
      throw new Error("telemetry_ancestor_identity_changed");
    }
    this.ancestorIdentity = ancestor;
  }

  private async discoverStorageDirectories(): Promise<void> {
    const parent = path.dirname(this.directory);
    const base = path.basename(this.directory);
    const prefixes = [`.${base}-create-`, `.${base}-delete-`];
    await this.assertAncestorIdentity();
    const names = await fs.readdir(parent);
    await this.assertAncestorIdentity();

    const captures: OwnedTelemetryRoot[] = [];
    for (const name of names) {
      if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
      const candidate = path.join(parent, name);
      try {
        // eslint-disable-next-line no-await-in-loop -- legacy roots are rare and each requires a complete ownership proof
        const identity = await this.readDirectoryIdentity(candidate, true);
        // eslint-disable-next-line no-await-in-loop -- marker identity must be read from the candidate itself
        const createdAtMs = await this.readOwnedRootMarker(candidate, identity);
        if (createdAtMs !== null) captures.push({ path: candidate, identity, createdAtMs });
      } catch (error) {
        if (!isNotFound(error)) {
          log.warn("Ignoring invalid legacy telemetry capture", { code: errorCode(error) });
        }
      }
    }
    captures.sort(
      (left, right) => left.createdAtMs - right.createdAtMs || left.path.localeCompare(right.path),
    );

    const configured = await this.tryReadDirectoryIdentity(this.directory, true);
    this.recoveryDirectoryIdentities.clear();
    if (configured) {
      this.storageDirectory = this.directory;
      for (const capture of captures) {
        this.recoveryDirectoryIdentities.set(capture.path, capture.identity);
      }
    } else if (captures.length > 0) {
      const primary = captures[0];
      this.storageDirectory = primary.path;
      this.directoryIdentity = primary.identity;
      for (const capture of captures.slice(1)) {
        this.recoveryDirectoryIdentities.set(capture.path, capture.identity);
      }
    } else {
      this.storageDirectory = this.directory;
      this.directoryIdentity = null;
    }
  }

  private async ensureBoundDirectory(): Promise<boolean> {
    await this.bindAncestorIdentity();
    const previousDirectory = this.storageDirectory;
    const previousIdentity = this.directoryIdentity;
    let created = false;
    let info: LocalTelemetryPathInfo;
    try {
      info = await this.securityOps.getPathInfo(this.storageDirectory);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      if (this.storageDirectory !== this.directory) {
        this.storageDirectory = this.directory;
        this.directoryIdentity = null;
      }
      const parent = path.dirname(this.directory);
      await this.beforeDirectoryCreate?.(parent);
      await this.assertAncestorIdentity();
      try {
        await fs.mkdir(this.storageDirectory, { mode: 0o700 });
        created = true;
      } catch (createError) {
        if (!isRecord(createError) || createError.code !== "EEXIST") throw createError;
      }
      await this.assertAncestorIdentity();
      info = await this.securityOps.getPathInfo(this.storageDirectory);
    }
    if (info.kind !== "directory") throw new Error("telemetry_path_is_not_directory");
    await this.enforceDirectoryMode(this.storageDirectory, info);
    const identity = await this.readDirectoryIdentity(this.storageDirectory, true);
    if (
      previousIdentity &&
      previousDirectory === this.storageDirectory &&
      !created &&
      !this.directoryIdentitiesMatch(previousIdentity, identity)
    ) {
      throw new Error("telemetry_directory_identity_changed");
    }
    this.directoryIdentity = identity;
    await this.ensureOwnedRootMarker(this.storageDirectory, identity);
    return created || !previousIdentity || previousDirectory !== this.storageDirectory;
  }

  private async ensureBoundDirectoryFast(): Promise<boolean> {
    const expected = this.directoryIdentity;
    if (!expected) return this.ensureBoundDirectory();
    let info: LocalTelemetryPathInfo;
    try {
      info = await this.securityOps.getPathInfo(this.storageDirectory);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await this.closeActiveFile();
      this.storageDirectory = this.directory;
      this.directoryIdentity = null;
      await this.discoverStorageDirectories();
      return this.ensureBoundDirectory();
    }
    this.assertDirectoryPathInfo(expected, info);
    await this.enforceDirectoryMode(this.storageDirectory, info);
    return false;
  }

  private async enforceDirectoryMode(
    directory: string,
    info: LocalTelemetryPathInfo,
  ): Promise<void> {
    if (this.platform === "win32" || (info.mode & 0o777) === 0o700) return;
    if (!this.verifyOpenHandleMode) {
      await this.securityOps.chmod(directory, 0o700);
      const verified = await this.securityOps.getPathInfo(directory);
      this.assertSamePathIdentity(info, verified, "telemetry_directory_identity_changed");
      if ((verified.mode & 0o777) !== 0o700) {
        throw new Error("telemetry_permissions_not_enforced");
      }
      return;
    }
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const directoryFlag = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
    const handle = await fs.open(directory, fsConstants.O_RDONLY | noFollow | directoryFlag);
    try {
      const opened = await handle.stat();
      if (!opened.isDirectory()) throw new Error("telemetry_path_is_not_directory");
      if (info.dev !== opened.dev || info.ino !== opened.ino) {
        throw new Error("telemetry_directory_identity_changed");
      }
      await handle.chmod(0o700);
      const verified = await handle.stat();
      if ((verified.mode & 0o777) !== 0o700) {
        throw new Error("telemetry_permissions_not_enforced");
      }
    } finally {
      await handle.close();
    }
  }

  private async appendBoundTextFile(
    filePath: string,
    parentIdentity: TelemetryDirectoryIdentity,
    payload: string,
    maxBytes: number,
  ): Promise<void> {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    await this.verifyDirectoryIdentityFast(parentIdentity, path.dirname(filePath));
    const handle = await fs.open(
      filePath,
      fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | noFollow,
      0o600,
    );
    try {
      let opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.nlink > 1 ||
        opened.size + Buffer.byteLength(payload, "utf8") > maxBytes
      ) {
        throw new Error("telemetry_private_metadata_invalid");
      }
      await this.enforceOpenedFileMode(handle, filePath, opened);
      opened = await handle.stat();
      await this.verifyDirectoryIdentityFast(parentIdentity, path.dirname(filePath));
      const info = await this.securityOps.getPathInfo(filePath);
      this.assertTelemetryFilePathInfo(info);
      if (info.dev !== opened.dev || info.ino !== opened.ino) {
        throw new Error("telemetry_private_metadata_identity_changed");
      }
      const resolvedParent = this.normalizeIdentityPath(
        path.dirname(await this.securityOps.realpath(filePath)),
      );
      if (resolvedParent !== parentIdentity.realPath) {
        throw new Error("telemetry_private_metadata_outside_parent");
      }
      await handle.appendFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async openTelemetryFile(
    file: TelemetryFile,
    directoryIdentity: TelemetryDirectoryIdentity,
    now: Date,
    attempt = 0,
  ): Promise<PreparedTelemetryAppend> {
    const filePath = path.join(file.directory, file.name);
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    let existing: LocalTelemetryPathInfo | null = null;
    try {
      existing = await this.securityOps.getPathInfo(filePath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (existing) this.assertTelemetryFilePathInfo(existing);

    let created = false;
    let handle: FileHandle;
    try {
      if (!existing) {
        await this.beforeFileCreate?.(filePath);
        await this.beforeBoundFileCreate?.(file.directory);
        await this.verifyDirectoryIdentityFast(directoryIdentity, file.directory);
      }
      handle = await fs.open(
        filePath,
        existing
          ? fsConstants.O_RDWR | noFollow
          : fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | noFollow,
        0o600,
      );
      created = !existing;
    } catch (error) {
      if (isRecord(error) && error.code === "EEXIST" && attempt === 0) {
        return this.openTelemetryFile(file, directoryIdentity, now, 1);
      }
      throw error;
    }

    try {
      await this.afterFileOpen?.(filePath);
      const opened = await handle.stat();
      if (!opened.isFile()) throw new Error("telemetry_opened_path_is_not_file");
      if (opened.nlink > 1) throw new Error("telemetry_file_has_multiple_links");
      if (existing && (existing.dev !== opened.dev || existing.ino !== opened.ino)) {
        await this.blockFile(file.name, existing, opened);
        throw new Error("telemetry_file_identity_changed");
      }
      await this.enforceOpenedFileMode(handle, filePath, opened);
      const identity = await this.validateOpenedFileBinding(filePath, handle, directoryIdentity);
      return {
        file,
        filePath,
        handle,
        previousSize: identity.size,
        now,
        directoryIdentity,
        fileIdentity: identity,
      };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("telemetry_file_")) {
        const [openedResult, pathResult] = await Promise.allSettled([
          handle.stat(),
          this.securityOps.getPathInfo(filePath),
        ]);
        await this.blockFile(
          file.name,
          ...(openedResult.status === "fulfilled" ? [openedResult.value] : []),
          ...(pathResult.status === "fulfilled" ? [pathResult.value] : []),
        );
      }
      if (created) {
        await handle.truncate(0).catch(() => {});
      }
      await handle.close().catch(() => {});
      throw error;
    }
  }

  private async enforceOpenedFileMode(
    handle: FileHandle,
    filePath: string,
    opened: Stats,
  ): Promise<void> {
    if (this.platform === "win32" || (opened.mode & 0o777) === 0o600) return;
    if (!this.verifyOpenHandleMode) {
      const before = await this.securityOps.getPathInfo(filePath);
      if (before.dev !== opened.dev || before.ino !== opened.ino) {
        throw new Error("telemetry_file_identity_changed");
      }
      await this.securityOps.chmod(filePath, 0o600);
      const verified = await this.securityOps.getPathInfo(filePath);
      if (
        verified.dev !== opened.dev ||
        verified.ino !== opened.ino ||
        (verified.mode & 0o777) !== 0o600
      ) {
        throw new Error("telemetry_permissions_not_enforced");
      }
      return;
    }
    await handle.chmod(0o600);
    const verified = await handle.stat();
    if ((verified.mode & 0o777) !== 0o600) {
      throw new Error("telemetry_permissions_not_enforced");
    }
  }

  private async validateOpenedFileBinding(
    filePath: string,
    handle: FileHandle,
    directoryIdentity: TelemetryDirectoryIdentity,
  ): Promise<TelemetryFileIdentity> {
    await this.verifyDirectoryIdentityFast(directoryIdentity, path.dirname(filePath));
    const before = await this.securityOps.getPathInfo(filePath);
    this.assertTelemetryFilePathInfo(before);
    const resolvedParent = this.normalizeIdentityPath(
      path.dirname(await this.securityOps.realpath(filePath)),
    );
    if (resolvedParent !== directoryIdentity.realPath) {
      throw new Error("telemetry_file_outside_directory");
    }
    const after = await this.securityOps.getPathInfo(filePath);
    this.assertSamePathIdentity(before, after, "telemetry_file_identity_changed");
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1) {
      throw new Error("telemetry_opened_path_is_not_file");
    }
    if (after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error("telemetry_file_identity_changed");
    }
    return this.fileIdentityFromStat(opened);
  }

  private async validatePreparedAppend(
    prepared: PreparedTelemetryAppend,
  ): Promise<TelemetryFileIdentity> {
    const ancestryCheck = this.validateCommitAncestry(prepared);
    const pathCheck = this.securityOps.getPathInfo(prepared.filePath);
    const handleCheck = prepared.handle.stat();
    let info: LocalTelemetryPathInfo;
    let opened: Stats;
    try {
      [info, opened] = await Promise.all([pathCheck, handleCheck, ancestryCheck]).then(
        ([pathInfo, stat]) => [pathInfo, stat],
      );
      this.assertTelemetryFilePathInfo(info);
      if (!opened.isFile() || opened.nlink > 1) {
        throw new Error("telemetry_opened_path_is_not_file");
      }
      if (
        info.dev !== opened.dev ||
        info.ino !== opened.ino ||
        prepared.fileIdentity.dev !== opened.dev ||
        prepared.fileIdentity.ino !== opened.ino
      ) {
        await this.blockFile(prepared.file.name, prepared.fileIdentity, info, opened);
        throw new Error("telemetry_file_identity_changed");
      }
      await this.enforceOpenedFileMode(prepared.handle, prepared.filePath, opened);
      const verified = await prepared.handle.stat();
      if (!verified.isFile() || verified.nlink > 1) {
        throw new Error("telemetry_opened_path_is_not_file");
      }
      return this.fileIdentityFromStat(verified);
    } catch (error) {
      if (isNotFound(error)) {
        await this.blockFile(prepared.file.name, prepared.fileIdentity);
        throw new Error("telemetry_file_identity_changed", { cause: error });
      }
      throw error;
    }
  }

  private async validateCommitAncestry(prepared: PreparedTelemetryAppend): Promise<void> {
    const ancestor = this.ancestorIdentity;
    if (!ancestor) throw new Error("telemetry_ancestor_identity_missing");
    const ancestorPath = path.dirname(this.directory);
    const directoryPath = prepared.file.directory;
    const [ancestorInfo, ancestorRealPath, directoryInfo, directoryRealPath] = await Promise.all([
      this.securityOps.getPathInfo(ancestorPath),
      this.securityOps.realpath(ancestorPath),
      this.securityOps.getPathInfo(directoryPath),
      this.securityOps.realpath(directoryPath),
    ]);
    this.assertDirectoryPathInfo(ancestor, ancestorInfo);
    this.assertDirectoryPathInfo(prepared.directoryIdentity, directoryInfo);
    if (this.normalizeIdentityPath(ancestorRealPath) !== ancestor.realPath) {
      throw new Error("telemetry_ancestor_identity_changed");
    }
    if (this.normalizeIdentityPath(directoryRealPath) !== prepared.directoryIdentity.realPath) {
      throw new Error("telemetry_directory_identity_changed");
    }
  }

  private async selectFile(lineBytes: number, now: Date): Promise<TelemetryFile> {
    if (this.blockAllFiles) throw new Error("telemetry_file_identity_capacity_exceeded");
    const date = utcDate(now);
    const todaysFiles = [...this.files.values()]
      .filter((file) => file.directory === this.storageDirectory && file.date === date)
      .sort((a, b) => a.index - b.index);
    const latest = todaysFiles.at(-1);
    if (latest && latest.size + lineBytes <= this.maxFileBytes) {
      this.activeFile = latest;
      return latest;
    }
    const reusableToday = [...this.zeroShells.values()]
      .filter((shell) => shell.date === date && !this.blockedFileNames.has(shell.name))
      .sort((left, right) => left.index - right.index)
      .at(-1);
    if (reusableToday) {
      this.zeroShells.delete(reusableToday.key);
      const reused = {
        ...reusableToday,
        date,
        index: reusableToday.index,
        mtimeMs: now.getTime(),
      };
      this.files.set(reused.key, reused);
      this.activeFile = reused;
      return reused;
    }
    let index = 0;
    for (const name of this.primaryTelemetryNames) {
      const parsed = parseLocalTelemetryFileName(name);
      if (parsed?.date === date && parsed.index >= index) index = parsed.index + 1;
    }
    let name = formatLocalTelemetryFileName(date, index);
    while (this.blockedFileNames.has(name)) {
      index += 1;
      name = formatLocalTelemetryFileName(date, index);
    }
    let key = this.fileKey(this.storageDirectory, name);
    let selectedShell: TelemetryFile | undefined;
    if (
      !this.primaryTelemetryNames.has(name) &&
      this.primaryTelemetryNames.size >= this.maxShells
    ) {
      let shell = this.zeroShells.values().next().value;
      if (!shell) {
        const oldest = [...this.files.values()]
          .filter((file) => file.directory === this.storageDirectory)
          .sort(
            (left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name),
          )[0];
        if (!oldest) throw new Error("telemetry_shell_capacity_exhausted");
        await this.closeActiveFile();
        await this.removeFile(oldest);
        shell = this.zeroShells.get(oldest.key);
      }
      if (!shell) throw new Error("telemetry_shell_capacity_exhausted");
      this.zeroShells.delete(shell.key);
      selectedShell = shell;
      key = shell.key;
      name = shell.name;
    }
    const file = selectedShell
      ? {
          ...selectedShell,
          date,
          index,
          size: 0,
          mtimeMs: now.getTime(),
        }
      : (this.files.get(key) ??
        ({
          key,
          directory: this.storageDirectory,
          name,
          date,
          index,
          size: 0,
          mtimeMs: now.getTime(),
        } satisfies TelemetryFile));
    this.files.set(key, file);
    this.primaryTelemetryNames.add(name);
    this.activeFile = file;
    return file;
  }

  private async refreshFilesAndPrune(): Promise<void> {
    const files = await this.pruneFiles(await this.listFiles());
    this.applyFileSnapshot(files);
  }

  private async pruneKnownFiles(): Promise<void> {
    const files = await this.pruneFiles([...this.files.values()]);
    this.applyFileSnapshot(files);
  }

  private async pruneFiles(files: TelemetryFile[]): Promise<TelemetryFile[]> {
    const cutoff = this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
    const retained: TelemetryFile[] = [];
    for (const file of files) {
      if (this.telemetryFileAgeMs(file) >= cutoff) {
        retained.push(file);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- handle-bound truncation is intentionally sequential
      await this.removeFile(file);
    }

    retained.sort(
      (a, b) =>
        this.telemetryFileAgeMs(a) - this.telemetryFileAgeMs(b) ||
        a.directory.localeCompare(b.directory) ||
        a.name.localeCompare(b.name),
    );
    let totalBytes = retained.reduce((sum, file) => sum + file.size, 0);
    const kept: TelemetryFile[] = [];
    for (const file of retained) {
      if (totalBytes > this.maxTotalBytes) {
        // eslint-disable-next-line no-await-in-loop -- cap enforcement uses the same handle-bound erasure
        const erased = await this.removeFile(file);
        if (erased.erased) {
          totalBytes -= file.size;
          continue;
        }
      }
      kept.push(file);
    }
    return kept;
  }

  private telemetryFileAgeMs(file: Pick<TelemetryFile, "date" | "mtimeMs">): number {
    const logicalDateMs = Date.parse(`${file.date}T00:00:00.000Z`);
    return Number.isFinite(logicalDateMs) ? logicalDateMs : file.mtimeMs;
  }

  private async removeFile(file: TelemetryFile): Promise<TelemetryEraseOutcome> {
    const directoryIdentity = this.directoryIdentityFor(file.directory);
    const filePath = path.join(file.directory, file.name);
    await this.beforeFileRemove?.(filePath);
    await this.verifyDirectoryIdentityFast(directoryIdentity, file.directory);
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    let handle: FileHandle;
    try {
      handle = await fs.open(filePath, fsConstants.O_RDWR | noFollow);
    } catch (error) {
      if (isNotFound(error)) {
        await this.blockFile(file.name, file);
        throw new Error("telemetry_file_identity_changed", { cause: error });
      }
      throw error;
    }

    let removalError: unknown;
    let bytesBefore = 0;
    let erased = false;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink > 1) {
        throw new Error("telemetry_opened_path_is_not_file");
      }
      if (!this.fileIdentityMatches(file, this.fileIdentityFromStat(opened))) {
        await this.blockFile(file.name, file, opened);
        throw new Error("telemetry_file_identity_changed");
      }
      bytesBefore = opened.size;
      if (bytesBefore > 0) {
        await this.validateEraseBinding(filePath, file, handle, directoryIdentity);
        await this.truncateFile(handle, filePath);
        const truncated = await handle.stat();
        if (!truncated.isFile() || truncated.nlink > 1 || truncated.size !== 0) {
          throw new Error("telemetry_file_erasure_failed");
        }
        erased = true;
        try {
          const current = await this.securityOps.getPathInfo(filePath);
          this.assertTelemetryFilePathInfo(current);
          if (current.dev !== truncated.dev || current.ino !== truncated.ino) {
            await this.blockFile(file.name, file, current, truncated);
            throw new Error("telemetry_file_identity_changed");
          }
        } catch (error) {
          if (isNotFound(error)) {
            await this.blockFile(file.name, file, truncated);
            throw new Error("telemetry_file_identity_changed", { cause: error });
          }
          throw error;
        }
      }
    } catch (error) {
      removalError = error;
    } finally {
      try {
        await this.closeFile(handle);
      } catch (error) {
        removalError ??= error;
      }
    }
    if (removalError !== undefined) {
      throw removalError;
    }
    if (file.directory === this.storageDirectory) {
      this.zeroShells.set(file.key, { ...file, size: 0 });
      this.primaryTelemetryNames.add(file.name);
    }
    return { erased, bytes: erased ? bytesBefore : 0 };
  }

  private async validateEraseBinding(
    filePath: string,
    file: TelemetryFile,
    handle: FileHandle,
    directoryIdentity: TelemetryDirectoryIdentity,
  ): Promise<void> {
    await this.verifyDirectoryIdentityFast(directoryIdentity, file.directory);
    const [info, opened] = await Promise.all([
      this.securityOps.getPathInfo(filePath),
      handle.stat(),
    ]);
    this.assertTelemetryFilePathInfo(info);
    if (
      !opened.isFile() ||
      opened.nlink > 1 ||
      !this.fileIdentityMatches(file, this.fileIdentityFromStat(opened)) ||
      info.dev !== opened.dev ||
      info.ino !== opened.ino
    ) {
      await this.blockFile(file.name, file, info, opened);
      throw new Error("telemetry_file_identity_changed");
    }
  }

  private async listFiles(): Promise<TelemetryFile[]> {
    this.zeroShells.clear();
    this.primaryTelemetryNames.clear();
    const bindings = new Map(this.recoveryDirectoryIdentities);
    bindings.set(this.storageDirectory, this.requireDirectoryIdentity());
    const groups = await Promise.all(
      [...bindings].map(([directory, identity]) => this.listFilesInDirectory(directory, identity)),
    );
    return groups.flat();
  }

  private async listFilesForDeletion(): Promise<TelemetryDeleteScan> {
    const bindings = new Map(this.recoveryDirectoryIdentities);
    bindings.set(this.storageDirectory, this.requireDirectoryIdentity());
    const scans = await Promise.all(
      [...bindings].map(([directory, identity]) =>
        this.listFilesForDeletionInDirectory(directory, identity),
      ),
    );
    return {
      files: scans.flatMap((scan) => scan.files),
      malformedFiles: scans.reduce((sum, scan) => sum + scan.malformedFiles, 0),
      malformedBytes: scans.reduce((sum, scan) => sum + scan.malformedBytes, 0),
      failureCodes: scans.flatMap((scan) => scan.failureCodes),
    };
  }

  private async listFilesForDeletionInDirectory(
    directory: string,
    identity: TelemetryDirectoryIdentity,
  ): Promise<TelemetryDeleteScan> {
    await this.verifyDirectoryIdentityFast(identity, directory);
    const names = await fs.readdir(directory);
    const inspected = await this.inspectInBatches(names, async (name) => {
      const parsed = parseLocalTelemetryFileName(name);
      if (!parsed && !looksLikeLocalTelemetryFile(name)) return null;
      const filePath = path.join(directory, name);
      try {
        const info = await this.securityOps.getPathInfo(filePath);
        const size = this.requirePathNumber(info.size, "telemetry_file_size_missing");
        if (
          !parsed ||
          info.kind !== "file" ||
          (info.nlink ?? 1) > 1 ||
          info.dev === undefined ||
          info.ino === undefined
        ) {
          return {
            file: null,
            malformedFiles: size > 0 || info.kind !== "file" ? 1 : 0,
            malformedBytes: info.kind === "file" ? size : 0,
            failureCode: "telemetry_delete_unerasable_path",
          };
        }
        if (size === 0) return null;
        const resolvedParent = this.normalizeIdentityPath(
          path.dirname(await this.securityOps.realpath(filePath)),
        );
        if (resolvedParent !== identity.realPath) {
          return {
            file: null,
            malformedFiles: 1,
            malformedBytes: size,
            failureCode: "telemetry_file_outside_directory",
          };
        }
        const verified = await this.securityOps.getPathInfo(filePath);
        this.assertSamePathIdentity(info, verified, "telemetry_file_identity_changed");
        return {
          file: {
            key: this.fileKey(directory, name),
            directory,
            name,
            date: parsed.date,
            index: parsed.index,
            size: this.requirePathNumber(verified.size, "telemetry_file_size_missing"),
            mtimeMs: this.requirePathNumber(verified.mtimeMs, "telemetry_file_mtime_missing"),
            dev: verified.dev,
            ino: verified.ino,
          } satisfies TelemetryFile,
          malformedFiles: 0,
          malformedBytes: 0,
          failureCode: null,
        };
      } catch (error) {
        return {
          file: null,
          malformedFiles: 1,
          malformedBytes: 0,
          failureCode: errorCode(error),
        };
      }
    });
    await this.verifyDirectoryIdentityFast(identity, directory);
    return {
      files: inspected.flatMap((entry) => (entry?.file ? [entry.file] : [])),
      malformedFiles: inspected.reduce((sum, entry) => sum + (entry?.malformedFiles ?? 0), 0),
      malformedBytes: inspected.reduce((sum, entry) => sum + (entry?.malformedBytes ?? 0), 0),
      failureCodes: inspected.flatMap((entry) => (entry?.failureCode ? [entry.failureCode] : [])),
    };
  }

  private async listFilesInDirectory(
    directory: string,
    identity: TelemetryDirectoryIdentity,
  ): Promise<TelemetryFile[]> {
    await this.verifyDirectoryIdentityFast(identity, directory);
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if (isNotFound(error) && directory !== this.storageDirectory) return [];
      throw error;
    }
    await this.verifyDirectoryIdentityFast(identity, directory);
    if (directory === this.storageDirectory) {
      for (const name of names) {
        if (parseLocalTelemetryFileName(name)) this.primaryTelemetryNames.add(name);
      }
    }

    const inspected = await this.inspectInBatches(
      names,
      async (name): Promise<TelemetryFile | null> => {
        const parsed = parseLocalTelemetryFileName(name);
        if (!parsed || this.blockAllFiles || this.blockedFileNames.has(name)) return null;
        const logical =
          directory === this.storageDirectory ? this.logicalDates.get(name) : undefined;
        const filePath = path.join(directory, name);
        try {
          const info = await this.securityOps.getPathInfo(filePath);
          if (info.kind !== "file" || (info.nlink ?? 1) > 1) return null;
          this.requireStablePathIdentity(info, "telemetry_file_identity_missing");
          if (this.isBlockedFileIdentity(info)) return null;
          if (
            info.size !== 0 &&
            directory === this.storageDirectory &&
            this.logicalDatesRequired &&
            logical === undefined
          ) {
            throw new Error("telemetry_logical_dates_untrusted");
          }
          if (info.size === 0) {
            if (directory === this.storageDirectory) {
              const shell = {
                key: this.fileKey(directory, name),
                directory,
                name,
                date: logical?.date ?? parsed.date,
                index: logical?.index ?? parsed.index,
                size: 0,
                mtimeMs: this.requirePathNumber(info.mtimeMs, "telemetry_file_mtime_missing"),
                dev: info.dev,
                ino: info.ino,
              } satisfies TelemetryFile;
              this.zeroShells.set(shell.key, shell);
            }
            return null;
          }
          const resolvedParent = this.normalizeIdentityPath(
            path.dirname(await this.securityOps.realpath(filePath)),
          );
          if (resolvedParent !== identity.realPath) {
            throw new Error("telemetry_file_outside_directory");
          }
          const verified = await this.securityOps.getPathInfo(filePath);
          this.assertSamePathIdentity(info, verified, "telemetry_file_identity_changed");
          const key = this.fileKey(directory, name);
          const cached = this.files.get(key);
          if (
            cached?.dev !== undefined &&
            cached.ino !== undefined &&
            (cached.dev !== verified.dev || cached.ino !== verified.ino)
          ) {
            await this.blockFile(name, cached, verified);
            throw new Error("telemetry_file_identity_changed");
          }
          return {
            key,
            directory,
            name,
            date: logical?.date ?? parsed.date,
            index: logical?.index ?? parsed.index,
            size: this.requirePathNumber(verified.size, "telemetry_file_size_missing"),
            mtimeMs: this.requirePathNumber(verified.mtimeMs, "telemetry_file_mtime_missing"),
            dev: verified.dev,
            ino: verified.ino,
          };
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("telemetry_")) throw error;
          if (!isNotFound(error)) {
            log.warn("Failed to inspect local telemetry file", { code: errorCode(error) });
          }
          return null;
        }
      },
    );
    await this.verifyDirectoryIdentityFast(identity, directory);
    return inspected.filter((file): file is TelemetryFile => file !== null);
  }

  private async inspectInBatches<T>(
    names: string[],
    inspect: (name: string) => Promise<T>,
  ): Promise<T[]> {
    const results: T[] = [];
    for (let offset = 0; offset < names.length; offset += FILE_INSPECTION_BATCH_SIZE) {
      const batch = names.slice(offset, offset + FILE_INSPECTION_BATCH_SIZE);
      // eslint-disable-next-line no-await-in-loop -- bounded batches keep filesystem callbacks from monopolizing Electron main
      results.push(...(await Promise.all(batch.map((name) => inspect(name)))));
      if (offset + FILE_INSPECTION_BATCH_SIZE < names.length) {
        // eslint-disable-next-line no-await-in-loop -- yield between batches to bound event-loop delay
        await waitForImmediate();
      }
    }
    return results;
  }

  private applyFileSnapshot(files: TelemetryFile[]): void {
    this.files.clear();
    for (const file of files) this.files.set(file.key, file);
    this.totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const date = utcDate(this.now());
    this.activeFile =
      files
        .filter((file) => file.directory === this.storageDirectory && file.date === date)
        .sort((a, b) => a.index - b.index)
        .at(-1) ?? null;
    this.writesSincePrune = 0;
    this.lastPruneAtMs = this.now().getTime();
  }

  private async resetFileState(): Promise<void> {
    await this.closeActiveFile().catch(() => {});
    this.initialized = false;
    this.storageDirectory = this.directory;
    this.directoryIdentity = null;
    this.recoveryDirectoryIdentities.clear();
    this.clearCachedFileState();
    this.lastPruneAtMs = 0;
  }

  private clearCachedFileState(): void {
    this.activeFile = null;
    this.files.clear();
    this.totalBytes = 0;
    this.writesSincePrune = 0;
  }

  private async closeActiveFile(): Promise<void> {
    const active = this.activeAppend;
    if (!active) return;
    this.activeAppend = null;
    await this.closeFile(active.handle);
  }

  private async closeActiveFileAfterError(error: unknown): Promise<void> {
    try {
      await this.closeActiveFile();
    } catch (closeError) {
      log.warn("Local telemetry file close failed after error", {
        code: errorCode(closeError),
        originalCode: errorCode(error),
      });
    }
  }

  private requireDirectoryIdentity(): TelemetryDirectoryIdentity {
    if (!this.directoryIdentity) throw new Error("telemetry_directory_identity_missing");
    return this.directoryIdentity;
  }

  private directoryIdentityFor(directory: string): TelemetryDirectoryIdentity {
    if (directory === this.storageDirectory) return this.requireDirectoryIdentity();
    const identity = this.recoveryDirectoryIdentities.get(directory);
    if (!identity) throw new Error("telemetry_directory_identity_missing");
    return identity;
  }

  private async readDirectoryIdentity(
    directory: string,
    rejectReparsePoint: boolean,
  ): Promise<TelemetryDirectoryIdentity> {
    const before = await this.securityOps.getPathInfo(directory);
    if (before.kind !== "directory") throw new Error("telemetry_path_is_not_directory");
    this.requireStablePathIdentity(before, "telemetry_directory_identity_missing");
    const realPath = this.normalizeIdentityPath(await this.securityOps.realpath(directory));
    if (rejectReparsePoint && realPath !== this.normalizeIdentityPath(directory)) {
      throw new Error("telemetry_directory_is_reparse_point");
    }
    const after = await this.securityOps.getPathInfo(directory);
    if (after.kind !== "directory") throw new Error("telemetry_path_is_not_directory");
    this.assertSamePathIdentity(before, after, "telemetry_directory_identity_changed");
    return { dev: after.dev, ino: after.ino, realPath };
  }

  private async tryReadDirectoryIdentity(
    directory: string,
    rejectReparsePoint: boolean,
  ): Promise<TelemetryDirectoryIdentity | null> {
    try {
      return await this.readDirectoryIdentity(directory, rejectReparsePoint);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async assertAncestorIdentity(): Promise<void> {
    const expected = this.ancestorIdentity;
    if (!expected) throw new Error("telemetry_ancestor_identity_missing");
    const actual = await this.readDirectoryIdentity(path.dirname(this.directory), true);
    if (!this.directoryIdentitiesMatch(expected, actual)) {
      throw new Error("telemetry_ancestor_identity_changed");
    }
  }

  private async verifyDirectoryIdentityFast(
    expected: TelemetryDirectoryIdentity,
    directory: string,
  ): Promise<void> {
    const info = await this.securityOps.getPathInfo(directory);
    this.assertDirectoryPathInfo(expected, info);
  }

  private assertDirectoryPathInfo(
    expected: TelemetryDirectoryIdentity,
    info: LocalTelemetryPathInfo,
  ): void {
    if (info.kind !== "directory") throw new Error("telemetry_path_is_not_directory");
    if (
      expected.dev === undefined ||
      expected.ino === undefined ||
      info.dev !== expected.dev ||
      info.ino !== expected.ino
    ) {
      throw new Error("telemetry_directory_identity_changed");
    }
  }

  private directoryIdentitiesMatch(
    expected: TelemetryDirectoryIdentity,
    actual: TelemetryDirectoryIdentity,
  ): boolean {
    return (
      expected.dev !== undefined &&
      expected.ino !== undefined &&
      actual.dev !== undefined &&
      actual.ino !== undefined &&
      expected.dev === actual.dev &&
      expected.ino === actual.ino &&
      expected.realPath === actual.realPath
    );
  }

  private normalizeIdentityPath(value: string): string {
    const normalized = path.resolve(value);
    return this.platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  private assertTelemetryFilePathInfo(info: LocalTelemetryPathInfo): void {
    if (info.kind !== "file") throw new Error("telemetry_path_is_not_file");
    if ((info.nlink ?? 1) > 1) throw new Error("telemetry_file_has_multiple_links");
    this.requireStablePathIdentity(info, "telemetry_file_identity_missing");
  }

  private assertSamePathIdentity(
    expected: LocalTelemetryPathInfo,
    actual: LocalTelemetryPathInfo,
    error: string,
  ): void {
    this.requireStablePathIdentity(expected, error);
    this.requireStablePathIdentity(actual, error);
    if (expected.dev !== actual.dev || expected.ino !== actual.ino) throw new Error(error);
  }

  private requireStablePathIdentity(info: LocalTelemetryPathInfo, error: string): void {
    if (info.dev === undefined || info.ino === undefined) throw new Error(error);
  }

  private requirePathNumber(value: number | undefined, error: string): number {
    if (value === undefined) throw new Error(error);
    return value;
  }

  private fileIdentityFromStat(stat: {
    dev: number;
    ino: number;
    mode: number;
    nlink: number;
    size: number;
  }): TelemetryFileIdentity {
    return {
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      nlink: stat.nlink,
      size: stat.size,
    };
  }

  private fileIdentityMatches(
    expected: Pick<TelemetryFile, "dev" | "ino">,
    actual: TelemetryFileIdentity,
  ): boolean {
    return (
      expected.dev !== undefined &&
      expected.ino !== undefined &&
      expected.dev === actual.dev &&
      expected.ino === actual.ino
    );
  }

  private fileIdentityKey(identity: { dev?: number; ino?: number }): string | undefined {
    if (identity.dev === undefined || identity.ino === undefined) return undefined;
    return `${identity.dev}:${identity.ino}`;
  }

  private async loadOrCreateOwnerToken(): Promise<string> {
    const existing = await this.readOwnerToken();
    if (existing) return existing;
    const token = randomUUID();
    const ancestor = this.ancestorIdentity;
    if (!ancestor) throw new Error("telemetry_ancestor_identity_missing");
    try {
      await this.writeBoundTextFile(
        this.ownerPath(),
        ancestor,
        `${OWNER_VERSION}\t${token}\n`,
        true,
      );
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
    }
    const confirmed = await this.readOwnerToken();
    if (!confirmed) throw new Error("telemetry_owner_token_missing");
    return confirmed;
  }

  private async readOwnerToken(): Promise<string | null> {
    const ancestor = this.ancestorIdentity;
    if (!ancestor) throw new Error("telemetry_ancestor_identity_missing");
    const content = await this.readBoundTextFile(
      this.ownerPath(),
      ancestor,
      PRIVATE_METADATA_MAX_BYTES,
    );
    if (content === null) return null;
    const [version, token] = content.trim().split("\t");
    if (
      version !== OWNER_VERSION ||
      !token ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)
    ) {
      throw new Error("telemetry_owner_token_invalid");
    }
    return token;
  }

  private async ensureOwnedRootMarker(
    directory: string,
    identity: TelemetryDirectoryIdentity,
  ): Promise<number> {
    const existing = await this.readOwnedRootMarker(directory, identity);
    if (existing !== null) return existing;
    const ownerToken = this.ownerToken;
    if (!ownerToken || identity.dev === undefined || identity.ino === undefined) {
      throw new Error("telemetry_owner_token_missing");
    }
    const createdAtMs = Date.now();
    try {
      await this.writeBoundTextFile(
        path.join(directory, ROOT_MARKER_NAME),
        identity,
        `${ROOT_MARKER_VERSION}\t${ownerToken}\t${identity.dev}\t${identity.ino}\t${createdAtMs}\n`,
        true,
      );
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
    }
    const confirmed = await this.readOwnedRootMarker(directory, identity);
    if (confirmed === null) throw new Error("telemetry_root_marker_missing");
    return confirmed;
  }

  private async readOwnedRootMarker(
    directory: string,
    identity: TelemetryDirectoryIdentity,
  ): Promise<number | null> {
    const content = await this.readBoundTextFile(
      path.join(directory, ROOT_MARKER_NAME),
      identity,
      PRIVATE_METADATA_MAX_BYTES,
    );
    if (content === null) return null;
    const [version, ownerToken, devText, inoText, createdAtText] = content.trim().split("\t");
    const dev = Number(devText);
    const ino = Number(inoText);
    const createdAtMs = Number(createdAtText);
    if (
      version !== ROOT_MARKER_VERSION ||
      ownerToken !== this.ownerToken ||
      !Number.isFinite(dev) ||
      !Number.isFinite(ino) ||
      dev !== identity.dev ||
      ino !== identity.ino ||
      !Number.isFinite(createdAtMs) ||
      createdAtMs < 0
    ) {
      throw new Error("telemetry_root_marker_invalid");
    }
    return createdAtMs;
  }

  private async readBoundTextFile(
    filePath: string,
    parentIdentity: TelemetryDirectoryIdentity,
    maxBytes: number,
  ): Promise<string | null> {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    let handle: FileHandle;
    try {
      handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink > 1 || opened.size > maxBytes) {
        throw new Error("telemetry_private_metadata_invalid");
      }
      await this.verifyDirectoryIdentityFast(parentIdentity, path.dirname(filePath));
      const info = await this.securityOps.getPathInfo(filePath);
      this.assertTelemetryFilePathInfo(info);
      if (info.dev !== opened.dev || info.ino !== opened.ino) {
        throw new Error("telemetry_private_metadata_identity_changed");
      }
      const resolvedParent = this.normalizeIdentityPath(
        path.dirname(await this.securityOps.realpath(filePath)),
      );
      if (resolvedParent !== parentIdentity.realPath) {
        throw new Error("telemetry_private_metadata_outside_parent");
      }
      return await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  }

  private async writeBoundTextFile(
    filePath: string,
    parentIdentity: TelemetryDirectoryIdentity,
    payload: string,
    exclusive: boolean,
    maxBytes = PRIVATE_METADATA_MAX_BYTES,
  ): Promise<void> {
    if (Buffer.byteLength(payload, "utf8") > maxBytes) {
      throw new Error("telemetry_private_metadata_invalid");
    }
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    await this.verifyDirectoryIdentityFast(parentIdentity, path.dirname(filePath));
    const handle = await fs.open(
      filePath,
      fsConstants.O_CREAT | fsConstants.O_RDWR | (exclusive ? fsConstants.O_EXCL : 0) | noFollow,
      0o600,
    );
    try {
      let opened = await handle.stat();
      if (!opened.isFile() || opened.nlink > 1) {
        throw new Error("telemetry_private_metadata_invalid");
      }
      await this.enforceOpenedFileMode(handle, filePath, opened);
      opened = await handle.stat();
      await this.verifyDirectoryIdentityFast(parentIdentity, path.dirname(filePath));
      const info = await this.securityOps.getPathInfo(filePath);
      this.assertTelemetryFilePathInfo(info);
      if (info.dev !== opened.dev || info.ino !== opened.ino) {
        throw new Error("telemetry_private_metadata_identity_changed");
      }
      const resolvedParent = this.normalizeIdentityPath(
        path.dirname(await this.securityOps.realpath(filePath)),
      );
      if (resolvedParent !== parentIdentity.realPath) {
        throw new Error("telemetry_private_metadata_outside_parent");
      }
      await handle.truncate(0);
      await handle.writeFile(payload, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async loadLogicalDates(): Promise<void> {
    const ancestor = this.ancestorIdentity;
    if (!ancestor) throw new Error("telemetry_ancestor_identity_missing");
    this.logicalDatesRequired =
      (await this.readBoundTextFile(
        this.logicalDatesRequiredPath(),
        ancestor,
        PRIVATE_METADATA_MAX_BYTES,
      )) !== null;
    const states = await Promise.all(
      (["a", "b"] as const).map((buffer) => this.readLogicalDatesBufferState(buffer, ancestor)),
    );
    const selection = this.selectTrustedLogicalDatesBuffer(states);
    this.logicalDates.clear();
    if (!selection) {
      this.logicalDatesGeneration = 0;
      this.logicalDatesBuffer = "a";
      this.logicalDatesBytes = 0;
      this.logicalDatesVersion = LOGICAL_DATES_VERSION;
      this.logicalDatesSequence = 0;
      this.logicalDatesSnapshotDigest = "-";
      this.logicalDatesWitnessBuffer = null;
      this.logicalDatesWitnessBytes = 0;
      this.logicalDatesWitnessedSequence = 0;
      this.logicalDatesNeedsReload = false;
      if (this.logicalDatesRequired) throw new Error("telemetry_logical_dates_untrusted");
      return;
    }
    const { selected, witness } = selection;
    for (const [name, logical] of selected.entries) this.logicalDates.set(name, logical);
    this.logicalDatesGeneration = selected.generation;
    this.logicalDatesBuffer = selected.buffer;
    this.logicalDatesBytes = selected.bytes;
    this.logicalDatesVersion = selected.version;
    this.logicalDatesSequence = selected.sequence;
    this.logicalDatesSnapshotDigest = selected.snapshotDigest;
    this.logicalDatesWitnessBuffer = witness?.buffer ?? null;
    this.logicalDatesWitnessBytes = witness?.bytes ?? 0;
    this.logicalDatesWitnessedSequence = witness?.switchTarget?.sequence ?? selected.sequence;
    this.logicalDatesNeedsReload = false;
  }

  private async readLogicalDatesBufferState(
    buffer: "a" | "b",
    ancestor: TelemetryDirectoryIdentity,
  ): Promise<LogicalDatesBufferState> {
    let content: string | null;
    try {
      content = await this.readBoundTextFile(
        this.logicalDatesPath(buffer),
        ancestor,
        this.logicalDatesPhysicalMaxBytes(),
      );
    } catch (error) {
      const code = errorCode(error);
      log.warn("Rejecting unreadable local telemetry logical-date generation", { buffer, code });
      return {
        state: "corrupt",
        buffer,
        generation: null,
        snapshotCommitted: false,
        code,
      };
    }
    if (content === null) return { state: "missing", buffer };
    try {
      return { state: "valid", buffer, value: this.parseLogicalDatesBuffer(content, buffer) };
    } catch (error) {
      const generation = this.logicalDatesGenerationHint(content);
      const snapshotCommitted = this.logicalDatesSnapshotIsCommitted(content);
      const state = snapshotCommitted ? "corrupt" : "incomplete";
      const code = errorCode(error);
      log.warn("Rejecting untrusted local telemetry logical-date generation", {
        buffer,
        generation,
        state,
        code,
      });
      return { state, buffer, generation, snapshotCommitted, code };
    }
  }

  private selectTrustedLogicalDatesBuffer(
    states: LogicalDatesBufferState[],
  ): LogicalDatesSelection | null {
    const valid = states
      .flatMap((state) => (state.state === "valid" ? [state.value] : []))
      .sort((left, right) => right.generation - left.generation);
    const selected = valid[0];
    if (!selected) return null;
    if (
      valid[1] &&
      (valid[1].generation === selected.generation || selected.generation - valid[1].generation > 1)
    ) {
      throw new Error("telemetry_logical_dates_untrusted");
    }
    for (const source of valid) {
      if (!source.switchTarget) continue;
      const target = valid.find((candidate) => candidate.buffer === source.switchTarget?.buffer);
      if (
        !target ||
        target.generation !== source.switchTarget.generation ||
        target.snapshotDigest !== source.switchTarget.snapshotDigest ||
        target.sequence !== source.switchTarget.sequence
      ) {
        throw new Error("telemetry_logical_dates_untrusted");
      }
    }
    const witness =
      valid.find(
        (candidate) =>
          candidate.switchTarget?.buffer === selected.buffer &&
          candidate.switchTarget.generation === selected.generation,
      ) ?? null;
    for (const state of states) {
      if (state.state === "valid" || state.state === "missing") continue;
      if (
        selected.version === LOGICAL_DATES_LEGACY_VERSION &&
        state.state === "corrupt" &&
        (state.generation === null || state.generation >= selected.generation)
      ) {
        throw new Error("telemetry_logical_dates_untrusted");
      }
      if (state.generation === selected.generation) {
        throw new Error("telemetry_logical_dates_untrusted");
      }
    }
    if (selected.version === LOGICAL_DATES_VERSION && selected.generation > 1 && !witness) {
      const interruptedNextGeneration = states.some(
        (state) =>
          state.state === "incomplete" &&
          (state.generation === null || state.generation === selected.generation + 1) &&
          !state.snapshotCommitted,
      );
      if (!interruptedNextGeneration) {
        throw new Error("telemetry_logical_dates_untrusted");
      }
    }
    return { selected, witness };
  }

  private async ensureLogicalDateForCommit(file: TelemetryFile): Promise<void> {
    if (this.logicalDatesNeedsReload) await this.loadLogicalDates();
    const physical = parseLocalTelemetryFileName(file.name);
    if (!physical) throw new Error("telemetry_file_name_invalid");
    const current = this.logicalDates.get(file.name);
    const diverges = physical.date !== file.date || physical.index !== file.index;
    if (current?.date === file.date && current.index === file.index) {
      await this.ensureLogicalDateWitnessCurrent();
      return;
    }
    await this.loadLogicalDates();
    if (!this.logicalDatesRequired && !diverges && !this.logicalDates.has(file.name)) return;
    if (!this.logicalDatesRequired) {
      await this.ensureLogicalDatesRequired();
      for (const name of this.primaryTelemetryNames) {
        const parsed = parseLocalTelemetryFileName(name);
        if (!parsed) continue;
        const key = this.fileKey(this.storageDirectory, name);
        const known = this.files.get(key) ?? this.zeroShells.get(key);
        this.logicalDates.set(name, {
          date: known?.date ?? parsed.date,
          index: known?.index ?? parsed.index,
        });
      }
    }
    this.logicalDates.set(file.name, { date: file.date, index: file.index });
    if (this.logicalDates.size > this.maxShells) {
      throw new Error("telemetry_logical_dates_invalid");
    }
    if (
      this.logicalDatesGeneration === 0 ||
      this.logicalDatesVersion === LOGICAL_DATES_LEGACY_VERSION ||
      this.logicalDatesWitnessBuffer === null
    ) {
      try {
        await this.compactLogicalDates();
      } catch (error) {
        this.logicalDatesNeedsReload = true;
        throw error;
      }
      return;
    }
    const nextSequence = this.logicalDatesSequence + 1;
    const update = this.serializeLogicalDateUpdate(nextSequence, file.name, file.date, file.index);
    const witness = this.serializeLogicalDateWitness(
      this.logicalDatesBuffer,
      this.logicalDatesGeneration,
      nextSequence,
    );
    if (
      this.logicalDatesBytes + Buffer.byteLength(update, "utf8") > this.maxLogicalDatesBytes ||
      this.logicalDatesWitnessBytes + Buffer.byteLength(witness, "utf8") >
        this.logicalDatesPhysicalMaxBytes()
    ) {
      await this.compactLogicalDates();
      return;
    }
    const ancestor = this.ancestorIdentity;
    if (!ancestor) throw new Error("telemetry_ancestor_identity_missing");
    try {
      await this.appendBoundTextFile(
        this.logicalDatesPath(this.logicalDatesBuffer),
        ancestor,
        update,
        this.maxLogicalDatesBytes,
      );
      await this.appendBoundTextFile(
        this.logicalDatesPath(this.logicalDatesWitnessBuffer),
        ancestor,
        witness,
        this.logicalDatesPhysicalMaxBytes(),
      );
    } catch (error) {
      this.logicalDatesNeedsReload = true;
      throw error;
    }
    this.logicalDatesBytes += Buffer.byteLength(update, "utf8");
    this.logicalDatesWitnessBytes += Buffer.byteLength(witness, "utf8");
    this.logicalDatesSequence = nextSequence;
    this.logicalDatesWitnessedSequence = nextSequence;
  }

  private async ensureLogicalDateWitnessCurrent(): Promise<void> {
    if (
      !this.logicalDatesRequired ||
      this.logicalDatesWitnessedSequence >= this.logicalDatesSequence
    ) {
      return;
    }
    if (!this.logicalDatesWitnessBuffer) {
      await this.compactLogicalDates();
      return;
    }
    const ancestor = this.ancestorIdentity;
    if (!ancestor) throw new Error("telemetry_ancestor_identity_missing");
    for (
      let sequence = this.logicalDatesWitnessedSequence + 1;
      sequence <= this.logicalDatesSequence;
      sequence++
    ) {
      const witness = this.serializeLogicalDateWitness(
        this.logicalDatesBuffer,
        this.logicalDatesGeneration,
        sequence,
      );
      if (
        this.logicalDatesWitnessBytes + Buffer.byteLength(witness, "utf8") >
        this.logicalDatesPhysicalMaxBytes()
      ) {
        // eslint-disable-next-line no-await-in-loop -- compaction replaces the remaining witness repair
        await this.compactLogicalDates();
        return;
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- repairs a bounded sequence gap before event commit
        await this.appendBoundTextFile(
          this.logicalDatesPath(this.logicalDatesWitnessBuffer),
          ancestor,
          witness,
          this.logicalDatesPhysicalMaxBytes(),
        );
      } catch (error) {
        this.logicalDatesNeedsReload = true;
        throw error;
      }
      this.logicalDatesWitnessBytes += Buffer.byteLength(witness, "utf8");
      this.logicalDatesWitnessedSequence = sequence;
    }
  }

  private parseLogicalDatesBuffer(content: string, buffer: "a" | "b"): LogicalDatesBuffer {
    const lines = content.split("\n");
    const header = lines[0]?.split("\t");
    const generation = Number(header?.[2]);
    const version = header?.[1];
    if (
      header?.[0] !== "H" ||
      (version !== LOGICAL_DATES_VERSION && version !== LOGICAL_DATES_LEGACY_VERSION) ||
      !Number.isSafeInteger(generation) ||
      generation <= 0
    ) {
      throw new Error("telemetry_logical_dates_invalid");
    }
    const baseSequence = version === LOGICAL_DATES_VERSION ? Number(header[3]) : 0;
    const previousGeneration = version === LOGICAL_DATES_VERSION ? Number(header[4]) : 0;
    const previousSnapshotDigest = version === LOGICAL_DATES_VERSION ? header[5] : "-";
    if (
      !Number.isSafeInteger(baseSequence) ||
      baseSequence < 0 ||
      !Number.isSafeInteger(previousGeneration) ||
      previousGeneration < 0 ||
      (version === LOGICAL_DATES_VERSION &&
        (header.length !== 6 ||
          previousGeneration !== generation - 1 ||
          (previousGeneration === 0
            ? previousSnapshotDigest !== "-"
            : !this.isLogicalDatesDigest(previousSnapshotDigest))))
    ) {
      throw new Error("telemetry_logical_dates_invalid");
    }
    const commitIndex = lines.findIndex((line) => line.startsWith("C\t"));
    if (commitIndex < 1) throw new Error("telemetry_logical_dates_invalid");
    const body = `${lines.slice(0, commitIndex).join("\n")}\n`;
    const commit = lines[commitIndex].split("\t");
    const snapshotDigest = this.hashLogicalDates(body);
    const validCommit =
      version === LOGICAL_DATES_VERSION
        ? commit.length === 4 &&
          commit[0] === "C" &&
          Number(commit[1]) === generation &&
          Number(commit[2]) === baseSequence &&
          commit[3] === snapshotDigest
        : commit.length === 3 &&
          commit[0] === "C" &&
          Number(commit[1]) === generation &&
          commit[2] === snapshotDigest;
    if (!validCommit) {
      throw new Error("telemetry_logical_dates_invalid");
    }
    const entries = new Map<string, { date: string; index: number }>();
    for (const line of lines.slice(1, commitIndex)) {
      this.applyLogicalDateRecord(line, "R", entries);
    }
    const hasCompleteTrailingLine = content.endsWith("\n");
    const updates = lines.slice(commitIndex + 1);
    let sequence = baseSequence;
    let switchTarget: LogicalDatesSwitch | null = null;
    for (let index = 0; index < updates.length; index++) {
      const line = updates[index];
      if (!line) continue;
      if (!hasCompleteTrailingLine && index === updates.length - 1) break;
      if (line.startsWith("S\t")) {
        if (switchTarget) throw new Error("telemetry_logical_dates_invalid");
        switchTarget = this.parseLogicalDateSwitch(line, buffer, generation);
        continue;
      }
      if (line.startsWith("W\t")) {
        if (!switchTarget) throw new Error("telemetry_logical_dates_invalid");
        switchTarget = this.applyLogicalDateWitness(line, switchTarget);
        continue;
      }
      if (switchTarget) throw new Error("telemetry_logical_dates_invalid");
      if (version === LOGICAL_DATES_VERSION) {
        sequence = this.applySequencedLogicalDateUpdate(line, sequence, entries);
      } else {
        this.applyLogicalDateRecord(line, "U", entries);
      }
    }
    if (entries.size > this.maxShells) throw new Error("telemetry_logical_dates_invalid");
    return {
      generation,
      buffer,
      bytes: Buffer.byteLength(content, "utf8"),
      entries,
      version,
      sequence,
      snapshotDigest,
      previousGeneration,
      previousSnapshotDigest,
      switchTarget,
    };
  }

  private applyLogicalDateRecord(
    line: string,
    expectedKind: "R" | "U",
    entries: Map<string, { date: string; index: number }>,
  ): void {
    const [kind, encodedName, date, indexText, checksum] = line.split("\t");
    const payload = [kind, encodedName, date, indexText].join("\t");
    if (kind !== expectedKind || checksum !== this.hashLogicalDates(payload)) {
      throw new Error("telemetry_logical_dates_invalid");
    }
    let name: string;
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      throw new Error("telemetry_logical_dates_invalid");
    }
    const index = Number(indexText);
    if (
      !parseLocalTelemetryFileName(name) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isSafeInteger(index) ||
      index < 0
    ) {
      throw new Error("telemetry_logical_dates_invalid");
    }
    entries.set(name, { date, index });
  }

  private applySequencedLogicalDateUpdate(
    line: string,
    previousSequence: number,
    entries: Map<string, { date: string; index: number }>,
  ): number {
    const [kind, sequenceText, encodedName, date, indexText, checksum] = line.split("\t");
    const payload = [kind, sequenceText, encodedName, date, indexText].join("\t");
    const sequence = Number(sequenceText);
    if (
      kind !== "U" ||
      !Number.isSafeInteger(sequence) ||
      sequence !== previousSequence + 1 ||
      checksum !== this.hashLogicalDates(payload)
    ) {
      throw new Error("telemetry_logical_dates_invalid");
    }
    this.applyLogicalDateFields(encodedName, date, indexText, entries);
    return sequence;
  }

  private applyLogicalDateFields(
    encodedName: string,
    date: string,
    indexText: string,
    entries: Map<string, { date: string; index: number }>,
  ): void {
    let name: string;
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      throw new Error("telemetry_logical_dates_invalid");
    }
    const index = Number(indexText);
    if (
      !parseLocalTelemetryFileName(name) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isSafeInteger(index) ||
      index < 0
    ) {
      throw new Error("telemetry_logical_dates_invalid");
    }
    entries.set(name, { date, index });
  }

  private parseLogicalDateSwitch(
    line: string,
    sourceBuffer: "a" | "b",
    sourceGeneration: number,
  ): LogicalDatesSwitch {
    const [kind, targetBuffer, generationText, sequenceText, snapshotDigest, checksum] =
      line.split("\t");
    const payload = [kind, targetBuffer, generationText, sequenceText, snapshotDigest].join("\t");
    const generation = Number(generationText);
    const sequence = Number(sequenceText);
    if (
      kind !== "S" ||
      (targetBuffer !== "a" && targetBuffer !== "b") ||
      targetBuffer === sourceBuffer ||
      !Number.isSafeInteger(generation) ||
      generation !== sourceGeneration + 1 ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      !this.isLogicalDatesDigest(snapshotDigest) ||
      checksum !== this.hashLogicalDates(payload)
    ) {
      throw new Error("telemetry_logical_dates_invalid");
    }
    return { buffer: targetBuffer, generation, snapshotDigest, sequence };
  }

  private applyLogicalDateWitness(line: string, target: LogicalDatesSwitch): LogicalDatesSwitch {
    const [kind, buffer, generationText, sequenceText, checksum] = line.split("\t");
    const payload = [kind, buffer, generationText, sequenceText].join("\t");
    const generation = Number(generationText);
    const sequence = Number(sequenceText);
    if (
      kind !== "W" ||
      buffer !== target.buffer ||
      generation !== target.generation ||
      !Number.isSafeInteger(sequence) ||
      sequence !== target.sequence + 1 ||
      checksum !== this.hashLogicalDates(payload)
    ) {
      throw new Error("telemetry_logical_dates_invalid");
    }
    return { ...target, sequence };
  }

  private serializeLogicalDateUpdate(
    sequence: number,
    name: string,
    date: string,
    index: number,
  ): string {
    const payload = `U\t${sequence}\t${encodeURIComponent(name)}\t${date}\t${index}`;
    return `${payload}\t${this.hashLogicalDates(payload)}\n`;
  }

  private async compactLogicalDates(): Promise<void> {
    const previousBuffer = this.logicalDatesGeneration === 0 ? null : this.logicalDatesBuffer;
    const target =
      this.logicalDatesGeneration === 0 ? "a" : this.logicalDatesBuffer === "a" ? "b" : "a";
    const generation = this.logicalDatesGeneration + 1;
    const records = [...this.logicalDates.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, logical]) => {
        const payload = `R\t${encodeURIComponent(name)}\t${logical.date}\t${logical.index}`;
        return `${payload}\t${this.hashLogicalDates(payload)}\n`;
      })
      .join("");
    const previousGeneration = this.logicalDatesGeneration;
    const previousSnapshotDigest = previousGeneration === 0 ? "-" : this.logicalDatesSnapshotDigest;
    const body = `H\t${LOGICAL_DATES_VERSION}\t${generation}\t${this.logicalDatesSequence}\t${previousGeneration}\t${previousSnapshotDigest}\n${records}`;
    const snapshotDigest = this.hashLogicalDates(body);
    const payload = `${body}C\t${generation}\t${this.logicalDatesSequence}\t${snapshotDigest}\n`;
    if (Buffer.byteLength(payload, "utf8") > this.maxLogicalDatesBytes) {
      throw new Error("telemetry_logical_dates_capacity_exceeded");
    }
    const ancestor = this.ancestorIdentity;
    if (!ancestor) throw new Error("telemetry_ancestor_identity_missing");
    await this.writeBoundTextFile(
      this.logicalDatesPath(target),
      ancestor,
      payload,
      false,
      this.maxLogicalDatesBytes,
    );
    const verifiedContent = await this.readBoundTextFile(
      this.logicalDatesPath(target),
      ancestor,
      this.logicalDatesPhysicalMaxBytes(),
    );
    if (verifiedContent === null) throw new Error("telemetry_logical_dates_invalid");
    const verified = this.parseLogicalDatesBuffer(verifiedContent, target);
    if (
      verified.generation !== generation ||
      verified.snapshotDigest !== snapshotDigest ||
      verified.sequence !== this.logicalDatesSequence
    ) {
      throw new Error("telemetry_logical_dates_invalid");
    }
    let witnessBytes = 0;
    if (previousBuffer) {
      const switchRecord = this.serializeLogicalDateSwitch(
        target,
        generation,
        verified.sequence,
        verified.snapshotDigest,
      );
      await this.appendBoundTextFile(
        this.logicalDatesPath(previousBuffer),
        ancestor,
        switchRecord,
        this.logicalDatesPhysicalMaxBytes(),
      );
      const previousContent = await this.readBoundTextFile(
        this.logicalDatesPath(previousBuffer),
        ancestor,
        this.logicalDatesPhysicalMaxBytes(),
      );
      if (previousContent === null) throw new Error("telemetry_logical_dates_invalid");
      const previous = this.parseLogicalDatesBuffer(previousContent, previousBuffer);
      const switchTarget = previous.switchTarget;
      if (
        !switchTarget ||
        switchTarget.buffer !== target ||
        switchTarget.generation !== generation ||
        switchTarget.sequence !== verified.sequence ||
        switchTarget.snapshotDigest !== verified.snapshotDigest
      ) {
        throw new Error("telemetry_logical_dates_invalid");
      }
      witnessBytes = previous.bytes;
    }
    this.logicalDatesGeneration = generation;
    this.logicalDatesBuffer = target;
    this.logicalDatesBytes = verified.bytes;
    this.logicalDatesVersion = LOGICAL_DATES_VERSION;
    this.logicalDatesSnapshotDigest = verified.snapshotDigest;
    this.logicalDatesWitnessBuffer = previousBuffer;
    this.logicalDatesWitnessBytes = witnessBytes;
    this.logicalDatesWitnessedSequence = verified.sequence;
    this.logicalDatesNeedsReload = false;
  }

  private async ensureLogicalDatesRequired(): Promise<void> {
    const ancestor = this.ancestorIdentity;
    if (!ancestor) throw new Error("telemetry_ancestor_identity_missing");
    try {
      await this.writeBoundTextFile(
        this.logicalDatesRequiredPath(),
        ancestor,
        `${LOGICAL_DATES_REQUIRED_VERSION}\n`,
        true,
      );
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
    }
    this.logicalDatesRequired = true;
  }

  private hashLogicalDates(payload: string): string {
    return createHash("sha256").update(payload).digest("hex");
  }

  private serializeLogicalDateSwitch(
    buffer: "a" | "b",
    generation: number,
    sequence: number,
    snapshotDigest: string,
  ): string {
    const payload = `S\t${buffer}\t${generation}\t${sequence}\t${snapshotDigest}`;
    return `${payload}\t${this.hashLogicalDates(payload)}\n`;
  }

  private serializeLogicalDateWitness(
    buffer: "a" | "b",
    generation: number,
    sequence: number,
  ): string {
    const payload = `W\t${buffer}\t${generation}\t${sequence}`;
    return `${payload}\t${this.hashLogicalDates(payload)}\n`;
  }

  private logicalDatesGenerationHint(content: string): number | null {
    const [kind, version, generationText] = content.split("\n", 1)[0]?.split("\t") ?? [];
    const generation = Number(generationText);
    return kind === "H" &&
      (version === LOGICAL_DATES_VERSION || version === LOGICAL_DATES_LEGACY_VERSION) &&
      Number.isSafeInteger(generation) &&
      generation > 0
      ? generation
      : null;
  }

  private logicalDatesSnapshotIsCommitted(content: string): boolean {
    const lines = content.split("\n");
    const header = lines[0]?.split("\t");
    const generation = Number(header?.[2]);
    const version = header?.[1];
    const commitIndex = lines.findIndex((line) => line.startsWith("C\t"));
    if (
      header?.[0] !== "H" ||
      (version !== LOGICAL_DATES_VERSION && version !== LOGICAL_DATES_LEGACY_VERSION) ||
      !Number.isSafeInteger(generation) ||
      generation <= 0 ||
      commitIndex < 1
    ) {
      return false;
    }
    const body = `${lines.slice(0, commitIndex).join("\n")}\n`;
    const commit = lines[commitIndex].split("\t");
    if (version === LOGICAL_DATES_VERSION) {
      const sequence = Number(header[3]);
      return (
        Number.isSafeInteger(sequence) &&
        sequence >= 0 &&
        commit.length === 4 &&
        commit[0] === "C" &&
        Number(commit[1]) === generation &&
        Number(commit[2]) === sequence &&
        commit[3] === this.hashLogicalDates(body)
      );
    }
    return (
      commit.length === 3 &&
      commit[0] === "C" &&
      Number(commit[1]) === generation &&
      commit[2] === this.hashLogicalDates(body)
    );
  }

  private isLogicalDatesDigest(value: string | undefined): value is string {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  }

  private logicalDatesPhysicalMaxBytes(): number {
    return this.maxLogicalDatesBytes + LOGICAL_DATES_SWITCH_RESERVE_BYTES;
  }

  private async loadBlocklist(): Promise<void> {
    const filePath = this.blocklistPath();
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    let handle: FileHandle;
    try {
      handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }

    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink > 1) {
        throw new Error("telemetry_blocklist_is_not_private_file");
      }
      if (opened.size > MAX_BLOCKLIST_BYTES) {
        this.blockAllFiles = true;
        return;
      }
      await this.assertAncestorIdentity();
      const info = await this.securityOps.getPathInfo(filePath);
      this.assertTelemetryFilePathInfo(info);
      if (info.dev !== opened.dev || info.ino !== opened.ino) {
        throw new Error("telemetry_blocklist_identity_changed");
      }
      const expectedParent = this.ancestorIdentity;
      if (!expectedParent) throw new Error("telemetry_ancestor_identity_missing");
      const resolvedParent = this.normalizeIdentityPath(
        path.dirname(await this.securityOps.realpath(filePath)),
      );
      if (resolvedParent !== expectedParent.realPath) {
        throw new Error("telemetry_blocklist_outside_parent");
      }
      const content = await handle.readFile({ encoding: "utf8" });
      if (Buffer.byteLength(content, "utf8") > MAX_BLOCKLIST_BYTES) {
        this.blockAllFiles = true;
        return;
      }
      this.parseBlocklist(content);
    } finally {
      await handle.close();
    }
  }

  private async acquireCommitLease(mode: "append" | "delete"): Promise<TelemetryCommitLease> {
    const endpoints = await this.getCommitLeaseEndpoints();
    const attempts = mode === "append" ? 101 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      // eslint-disable-next-line no-await-in-loop -- retries await one parallel quorum attempt at a time
      const results = await Promise.all(
        endpoints.map(async (endpoint) => {
          try {
            return { held: await this.listenLeaseEndpoint(endpoint, false), error: null };
          } catch (error) {
            return { held: null, error };
          }
        }),
      );
      const held = results.flatMap((result) => (result.held ? [result.held] : []));
      const fatalError = results
        .map((result) => result.error)
        .find((error) => error !== null && !this.isCommitEndpointUnavailable(error));
      if (fatalError !== undefined) {
        // eslint-disable-next-line no-await-in-loop -- failed quorum attempts release partial endpoints before aborting
        await this.closeCommitServers(held);
        throw fatalError;
      }
      const contentionError = results.map((result) => result.error).find((error) => error !== null);
      if (held.length >= COMMIT_LEASE_QUORUM) {
        return this.createLease(held, "telemetry_commit_lock_compromised");
      }
      // eslint-disable-next-line no-await-in-loop -- each retry releases its partial endpoint set first
      await this.closeCommitServers(held);
      if (mode === "delete") {
        throw new Error("telemetry_commit_locked", { cause: contentionError });
      }
      if (attempt + 1 >= attempts) {
        throw new Error("telemetry_commit_lock_timeout", { cause: contentionError });
      }
      // eslint-disable-next-line no-await-in-loop -- bounded contention retry for cross-process writers
      await waitForTimeout(Math.min(100, 5 + attempt * 2));
    }
    throw new Error("telemetry_commit_lock_timeout");
  }

  private beginAdmissionLease(mode: "append" | "delete"): Promise<TelemetryCommitLease> {
    const shared = mode === "append";
    const attempts = this.admissionLeaseEndpoints.map(async (endpoint) => {
      try {
        if (shared) await this.beforeAppendAdmissionBind?.(endpoint);
        return { held: await this.listenLeaseEndpoint(endpoint, shared), error: null };
      } catch (error) {
        return { held: null, error };
      }
    });
    return Promise.all(attempts).then(async (results) => {
      const held = results.flatMap((result) => (result.held ? [result.held] : []));
      const fatalError = results
        .map((result) => result.error)
        .find((error) => error !== null && !this.isCommitEndpointUnavailable(error));
      if (fatalError !== undefined) {
        await this.closeCommitServers(held);
        throw fatalError;
      }
      if (held.length >= COMMIT_LEASE_QUORUM) {
        return this.createLease(held, "telemetry_admission_lock_compromised");
      }
      await this.closeCommitServers(held);
      throw new Error(
        mode === "delete" ? "telemetry_commit_locked" : "telemetry_delete_in_progress",
        {
          cause: results.map((result) => result.error).find((error) => error !== null) ?? undefined,
        },
      );
    });
  }

  private async getCommitLeaseEndpoints(): Promise<LocalTelemetryCommitEndpoint[]> {
    if (this.commitLeaseEndpoints) return this.commitLeaseEndpoints;
    if (!this.ancestorIdentity) await this.bindAncestorIdentity();
    const ancestor = this.ancestorIdentity;
    if (!ancestor) throw new Error("telemetry_ancestor_identity_missing");
    const basename = path.basename(this.directory).normalize("NFC");
    const profileKey = `${ancestor.realPath}\0${
      this.platform === "win32" ? basename.toLowerCase() : basename
    }`;
    this.commitLeaseEndpoints = resolveLocalTelemetryCommitEndpoints(profileKey, this.platform);
    return this.commitLeaseEndpoints;
  }

  private isCommitEndpointUnavailable(error: unknown): boolean {
    if (!isRecord(error) || typeof error.code !== "string") return false;
    return (
      error.code === "EADDRINUSE" ||
      error.code === "EACCES" ||
      error.code === "EPERM" ||
      error.code === "EADDRNOTAVAIL"
    );
  }

  private async listenLeaseEndpoint(
    endpoint: LocalTelemetryCommitEndpoint,
    reuseAddr: boolean,
  ): Promise<{
    socket: DatagramSocket;
    getCompromisedError(): Error | null;
  }> {
    let compromised: Error | null = null;
    const socket = createSocket({ type: "udp4", reuseAddr });
    socket.on("message", () => {});
    socket.on("error", (error) => {
      compromised ??= error;
    });
    await new Promise<void>((resolve, reject) => {
      const onInitialError = (error: Error) => {
        try {
          socket.close();
        } catch {
          // A failed UDP bind may already have closed its native handle.
        }
        reject(error);
      };
      socket.once("error", onInitialError);
      socket.bind(
        {
          address: endpoint.host,
          port: endpoint.port,
          exclusive: true,
        },
        () => {
          socket.off("error", onInitialError);
          resolve();
        },
      );
    });
    socket.unref();
    return {
      socket,
      getCompromisedError: () => compromised,
    };
  }

  private createLease(
    held: Array<{
      socket: DatagramSocket;
      getCompromisedError(): Error | null;
    }>,
    compromisedCode: string,
  ): TelemetryCommitLease {
    let released = false;
    return {
      assertHealthy: () => {
        const healthy = held.filter((entry) => entry.getCompromisedError() === null).length;
        if (healthy < COMMIT_LEASE_QUORUM) {
          throw new Error(compromisedCode, {
            cause: held.map((entry) => entry.getCompromisedError()).find(Boolean) ?? undefined,
          });
        }
      },
      release: async () => {
        if (released) return;
        released = true;
        await this.closeCommitServers(held);
      },
    };
  }

  private async closeCommitServers(held: Array<{ socket: DatagramSocket }>): Promise<void> {
    await Promise.all(
      held.map(async ({ socket }) => {
        const closed = new Promise<void>((resolve) => {
          try {
            socket.close(() => resolve());
          } catch (error) {
            if (isRecord(error) && error.code === "ERR_SOCKET_DGRAM_NOT_RUNNING") {
              resolve();
            } else {
              throw error;
            }
          }
        });
        await Promise.race([closed, waitForTimeout(COMMIT_LEASE_CLOSE_TIMEOUT_MS)]);
      }),
    );
  }

  private startAppendAdmission(snapshot: {
    blockedByLocalDelete: boolean;
    generation: number | null;
  }): TelemetryAppendAdmission {
    const lease = snapshot.blockedByLocalDelete ? null : this.beginAdmissionLease("append");
    if (lease) {
      void lease.catch(() => undefined);
    }
    return {
      ...snapshot,
      lease,
    };
  }

  private async assertAppendGeneration(observed: TelemetryDeleteFence): Promise<void> {
    const current = await this.normalizeDeleteFenceUnderLock();
    if (current.state === "deleting") throw new Error("telemetry_delete_in_progress");
    if (current.generation !== observed.generation) {
      throw new Error("telemetry_delete_generation_changed");
    }
  }

  private async observeDeleteFence(): Promise<TelemetryDeleteFence> {
    if (!this.ancestorIdentity) await this.bindAncestorIdentity();
    const fence = await this.readDeleteFence();
    if (fence.state === "idle") {
      this.observedDeleteGeneration = fence.generation;
    }
    await this.afterDeleteFenceObserved?.({
      state: fence.state,
      generation: fence.generation,
    });
    return fence;
  }

  private async beginDeleteTransaction(): Promise<TelemetryDeleteTransaction> {
    const current = await this.normalizeDeleteFenceUnderLock();
    if (current.state === "deleting") throw new Error("telemetry_delete_in_progress");
    const transaction = {
      generation: current.generation + 1,
      token: randomUUID(),
      startedAtMs: Date.now(),
    };
    await this.writeDeleteFence({
      state: "deleting",
      generation: transaction.generation,
      token: transaction.token,
      pid: process.pid,
      startedAtMs: transaction.startedAtMs,
      completedAtMs: 0,
    });
    if (!(await this.deleteFenceMatches(transaction))) {
      await this.writeDeleteFence({
        state: "idle",
        generation: transaction.generation,
        token: "-",
        pid: 0,
        startedAtMs: 0,
        completedAtMs: Date.now(),
      });
      throw new Error("telemetry_delete_fence_lost");
    }
    return transaction;
  }

  private async normalizeDeleteFenceUnderLock(): Promise<TelemetryDeleteFence> {
    const current = await this.readDeleteFence();
    if (current.state !== "deleting") {
      this.observedDeleteGeneration = current.generation;
      return current;
    }
    const recovered = {
      state: "idle" as const,
      generation: current.generation,
      token: "-",
      pid: 0,
      startedAtMs: 0,
      completedAtMs: Date.now(),
    };
    await this.writeDeleteFence(recovered);
    return recovered;
  }

  private async deleteFenceMatches(transaction: TelemetryDeleteTransaction): Promise<boolean> {
    const fence = await this.readDeleteFence();
    return (
      fence.state === "deleting" &&
      fence.generation === transaction.generation &&
      fence.token === transaction.token &&
      fence.pid === process.pid
    );
  }

  private async finishDeleteTransaction(
    transaction: TelemetryDeleteTransaction,
    lease: TelemetryCommitLease,
  ): Promise<void> {
    try {
      if (await this.deleteFenceMatches(transaction)) {
        await this.writeDeleteFence({
          state: "idle",
          generation: transaction.generation,
          token: "-",
          pid: 0,
          startedAtMs: transaction.startedAtMs,
          completedAtMs: Date.now(),
        });
      }
    } finally {
      await lease.release();
    }
  }

  private async readDeleteFence(): Promise<TelemetryDeleteFence> {
    const filePath = this.deleteFencePath();
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    let handle: FileHandle;
    try {
      handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      if (isNotFound(error)) {
        return {
          state: "idle",
          generation: 0,
          token: "-",
          pid: 0,
          startedAtMs: 0,
          completedAtMs: 0,
        };
      }
      throw error;
    }
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink > 1 || opened.size > DELETE_FENCE_MAX_BYTES) {
        throw new Error("telemetry_delete_fence_invalid");
      }
      await this.assertAncestorIdentity();
      const info = await this.securityOps.getPathInfo(filePath);
      this.assertTelemetryFilePathInfo(info);
      if (info.dev !== opened.dev || info.ino !== opened.ino) {
        throw new Error("telemetry_delete_fence_identity_changed");
      }
      const expectedParent = this.ancestorIdentity;
      if (!expectedParent) throw new Error("telemetry_ancestor_identity_missing");
      const resolvedParent = this.normalizeIdentityPath(
        path.dirname(await this.securityOps.realpath(filePath)),
      );
      if (resolvedParent !== expectedParent.realPath) {
        throw new Error("telemetry_delete_fence_outside_parent");
      }
      const content = await handle.readFile({ encoding: "utf8" });
      return this.parseDeleteFence(content);
    } finally {
      await handle.close();
    }
  }

  private parseDeleteFence(content: string): TelemetryDeleteFence {
    const [version, state, generationText, token, pidText, startedAtText, completedAtText] = content
      .trim()
      .split("\t");
    if (content.length === 0) {
      return {
        state: "idle",
        generation: 0,
        token: "-",
        pid: 0,
        startedAtMs: 0,
        completedAtMs: 0,
      };
    }
    const generation = Number(generationText);
    const pid = Number(pidText);
    const startedAtMs = Number(startedAtText);
    const completedAtMs = version === DELETE_FENCE_LEGACY_VERSION ? 0 : Number(completedAtText);
    if (
      (version !== DELETE_FENCE_VERSION && version !== DELETE_FENCE_LEGACY_VERSION) ||
      (state !== "idle" && state !== "deleting") ||
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      !token ||
      !Number.isSafeInteger(pid) ||
      pid < 0 ||
      !Number.isFinite(startedAtMs) ||
      startedAtMs < 0 ||
      !Number.isFinite(completedAtMs) ||
      completedAtMs < 0
    ) {
      throw new Error("telemetry_delete_fence_invalid");
    }
    return { state, generation, token, pid, startedAtMs, completedAtMs };
  }

  private async writeDeleteFence(fence: TelemetryDeleteFence): Promise<void> {
    const filePath = this.deleteFencePath();
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    await this.assertAncestorIdentity();
    const handle = await fs.open(
      filePath,
      fsConstants.O_CREAT | fsConstants.O_RDWR | noFollow,
      0o600,
    );
    try {
      let opened = await handle.stat();
      if (!opened.isFile() || opened.nlink > 1) {
        throw new Error("telemetry_delete_fence_invalid");
      }
      await this.enforceOpenedFileMode(handle, filePath, opened);
      opened = await handle.stat();
      await this.assertAncestorIdentity();
      const info = await this.securityOps.getPathInfo(filePath);
      this.assertTelemetryFilePathInfo(info);
      if (info.dev !== opened.dev || info.ino !== opened.ino) {
        throw new Error("telemetry_delete_fence_identity_changed");
      }
      const payload = `${DELETE_FENCE_VERSION}\t${fence.state}\t${fence.generation}\t${fence.token}\t${fence.pid}\t${fence.startedAtMs}\t${fence.completedAtMs}\n`;
      if (Buffer.byteLength(payload, "utf8") > DELETE_FENCE_MAX_BYTES) {
        throw new Error("telemetry_delete_fence_invalid");
      }
      await handle.truncate(0);
      await handle.writeFile(payload, { encoding: "utf8" });
      await handle.sync();
      if (fence.state === "idle") {
        this.observedDeleteGeneration = fence.generation;
      }
    } finally {
      await handle.close();
    }
  }

  private parseBlocklist(content: string): void {
    for (const line of content.split("\n")) {
      if (!line) continue;
      const [version, kind, first, second] = line.split("\t");
      if (version !== BLOCKLIST_VERSION) {
        this.blockAllFiles = true;
        return;
      }
      if (kind === "all") {
        this.blockAllFiles = true;
        return;
      }
      if (kind === "name" && first) {
        let name: string;
        try {
          name = decodeURIComponent(first);
        } catch {
          this.blockAllFiles = true;
          return;
        }
        if (!parseLocalTelemetryFileName(name)) {
          this.blockAllFiles = true;
          return;
        }
        if (this.blockedFileNames.size >= MAX_BLOCKED_FILE_NAMES) {
          this.blockAllFiles = true;
          return;
        }
        this.blockedFileNames.add(name);
        continue;
      }
      if (kind === "id" && first && second) {
        const dev = Number(first);
        const ino = Number(second);
        if (!Number.isFinite(dev) || !Number.isFinite(ino)) {
          this.blockAllFiles = true;
          return;
        }
        if (this.blockedFileIdentities.size >= MAX_BLOCKED_FILE_IDENTITIES) {
          this.blockAllFiles = true;
          return;
        }
        this.blockedFileIdentities.add(`${dev}:${ino}`);
        continue;
      }
      this.blockAllFiles = true;
      return;
    }
  }

  private async blockFile(
    name: string,
    ...identities: Array<{ dev?: number; ino?: number }>
  ): Promise<void> {
    if (this.blockAllFiles) return;
    const lines: string[] = [];
    if (!this.blockedFileNames.has(name) && this.blockedFileNames.size >= MAX_BLOCKED_FILE_NAMES) {
      this.blockAllFiles = true;
      this.blockedFileNames.clear();
      this.blockedFileIdentities.clear();
      lines.push(`${BLOCKLIST_VERSION}\tall\n`);
    } else if (!this.blockedFileNames.has(name)) {
      this.blockedFileNames.add(name);
      lines.push(`${BLOCKLIST_VERSION}\tname\t${encodeURIComponent(name)}\n`);
    }

    if (!this.blockAllFiles) {
      for (const identity of identities) {
        const key = this.fileIdentityKey(identity);
        if (!key || this.blockedFileIdentities.has(key)) continue;
        if (this.blockedFileIdentities.size >= MAX_BLOCKED_FILE_IDENTITIES) {
          this.blockAllFiles = true;
          this.blockedFileNames.clear();
          this.blockedFileIdentities.clear();
          lines.length = 0;
          lines.push(`${BLOCKLIST_VERSION}\tall\n`);
          break;
        }
        this.blockedFileIdentities.add(key);
        lines.push(`${BLOCKLIST_VERSION}\tid\t${identity.dev}\t${identity.ino}\n`);
      }
    }
    if (lines.length === 0) return;
    try {
      await this.persistBlocklist(lines.join(""));
    } catch (error) {
      this.blockAllFiles = true;
      throw new Error("telemetry_blocklist_persist_failed", { cause: error });
    }
  }

  private async persistBlocklist(payload: string): Promise<void> {
    const filePath = this.blocklistPath();
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    await this.assertAncestorIdentity();
    const handle = await fs.open(
      filePath,
      fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | noFollow,
      0o600,
    );
    try {
      let opened = await handle.stat();
      if (!opened.isFile() || opened.nlink > 1) {
        throw new Error("telemetry_blocklist_is_not_private_file");
      }
      await this.enforceOpenedFileMode(handle, filePath, opened);
      opened = await handle.stat();
      await this.assertAncestorIdentity();
      const info = await this.securityOps.getPathInfo(filePath);
      this.assertTelemetryFilePathInfo(info);
      if (info.dev !== opened.dev || info.ino !== opened.ino) {
        throw new Error("telemetry_blocklist_identity_changed");
      }
      const expectedParent = this.ancestorIdentity;
      if (!expectedParent) throw new Error("telemetry_ancestor_identity_missing");
      const resolvedParent = this.normalizeIdentityPath(
        path.dirname(await this.securityOps.realpath(filePath)),
      );
      if (resolvedParent !== expectedParent.realPath) {
        throw new Error("telemetry_blocklist_outside_parent");
      }
      if (opened.size + Buffer.byteLength(payload, "utf8") > MAX_BLOCKLIST_BYTES) {
        this.blockAllFiles = true;
        payload = `${BLOCKLIST_VERSION}\tall\n`;
        await handle.truncate(0);
      }
      await handle.appendFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private isBlockedFileIdentity(identity: { dev?: number; ino?: number }): boolean {
    const key = this.fileIdentityKey(identity);
    return key !== undefined && this.blockedFileIdentities.has(key);
  }

  private fileKey(directory: string, name: string): string {
    return `${this.normalizeIdentityPath(directory)}\0${name}`;
  }

  private blocklistPath(): string {
    return path.join(
      path.dirname(this.directory),
      `.${path.basename(this.directory)}-blocked-${BLOCKLIST_VERSION}`,
    );
  }

  private deleteFencePath(): string {
    return path.join(
      path.dirname(this.directory),
      `.${path.basename(this.directory)}-delete-fence-${DELETE_FENCE_FILE_VERSION}`,
    );
  }

  private logicalDatesPath(buffer: "a" | "b"): string {
    return path.join(
      path.dirname(this.directory),
      `.${path.basename(this.directory)}-logical-dates-${LOGICAL_DATES_FILE_VERSION}-${buffer}`,
    );
  }

  private logicalDatesRequiredPath(): string {
    return path.join(
      path.dirname(this.directory),
      `.${path.basename(this.directory)}-logical-dates-required-${LOGICAL_DATES_REQUIRED_VERSION}`,
    );
  }

  private ownerPath(): string {
    return path.join(
      path.dirname(this.directory),
      `.${path.basename(this.directory)}-owner-${OWNER_VERSION}`,
    );
  }
}
