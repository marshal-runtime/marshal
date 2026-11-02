import {
  type ChildProcessWithoutNullStreams,
  spawn,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import { createLogger } from "../../../../../common/marshal-logger";
import type {
  WhatsAppAuthStoreError,
  WhatsAppAuthStoreUpdate,
  WhatsAppAuthStoreValue as StoredWhatsAppAuthValue,
  WhatsAppSignalKeyUpdates,
} from "../auth-store";
import {
  decodeWhatsAppAuthValue,
  encodeWhatsAppAuthValue,
  parseWhatsAppSidecarChildFrame,
  serializeWhatsAppSidecarFrame,
  WHATSAPP_SIDECAR_BUNDLE_NAME,
  WHATSAPP_SIDECAR_FRAME_PREFIX,
  WHATSAPP_SIDECAR_RESOURCE_DIR,
  WHATSAPP_SIDECAR_SCHEMA_VERSION,
  type WhatsAppAuthStoreErrorCode,
  type WhatsAppConnectionEvent,
  type WhatsAppSidecarAuthRequest,
  type WhatsAppSidecarAuthResponse,
  type WhatsAppSidecarChildFrame,
  type WhatsAppSidecarCommand,
  type WhatsAppSidecarParentFrame,
  type WhatsAppSidecarRequest,
  type WhatsAppSidecarRequestResponse,
} from "./protocol";

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_STDOUT_NOISE_BYTES = 64 * 1024;
const log = createLogger("WhatsAppSidecarClient");
const ENVIRONMENT_ALLOWLIST = new Set([
  "appdata",
  "home",
  "lang",
  "lc_all",
  "localappdata",
  "systemroot",
  "temp",
  "tmp",
  "tmpdir",
  "userprofile",
  "windir",
]);

type MaybePromise<T> = T | Promise<T>;

export interface WhatsAppSidecarAuthStore {
  readCredentials(): MaybePromise<StoredWhatsAppAuthValue | null>;
  readSignalKeys(
    category: string,
    ids: readonly string[],
  ): MaybePromise<Record<string, StoredWhatsAppAuthValue>>;
  applyTransaction(update: WhatsAppAuthStoreUpdate): MaybePromise<void>;
  resetAfterTerminalDisconnect(): MaybePromise<void>;
}

export type WhatsAppSidecarLaunchOptions =
  | {
      mode: "development";
      sidecarPath: string;
      nodeExecutable?: string;
      timeoutMs?: number;
    }
  | {
      mode: "packaged";
      resourcesPath: string;
      platform: NodeJS.Platform;
      timeoutMs?: number;
    };

export interface WhatsAppSidecarResolvedLaunch {
  command: string;
  args: string[];
  sidecarPath: string;
}

type SpawnSidecar = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

export interface WhatsAppSidecarClientDependencies {
  spawnSidecar?: SpawnSidecar;
}

export class WhatsAppSidecarCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WhatsAppSidecarCommandError";
  }
}

export class WhatsAppSidecarClient {
  private readonly timeoutMs: number;
  private readonly output;
  private readonly listeners = new Set<(event: WhatsAppConnectionEvent) => void>();
  private readonly pendingCommands = new Map<
    string,
    {
      command: WhatsAppSidecarCommand;
      resolve: () => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly pendingRequests = new Map<
    string,
    {
      requestType: WhatsAppSidecarRequest["type"];
      resolve: (response: WhatsAppSidecarRequestResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly ready = createDeferred<void>();
  private readonly exit: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>;
  private nextRequest = 0;
  private stderrBytes = 0;
  private stdoutNoiseBytes = 0;
  private fatalError: Error | undefined;
  private shutdownStarted = false;
  private closed = false;
  private readyReceived = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly authStore: WhatsAppSidecarAuthStore,
    timeoutMs: number,
  ) {
    this.timeoutMs = timeoutMs;
    this.output = createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.stderr.on("data", (chunk: string | Buffer) => {
      if (this.stderrBytes >= MAX_STDERR_BYTES) return;
      this.stderrBytes = Math.min(MAX_STDERR_BYTES, this.stderrBytes + Buffer.byteLength(chunk));
    });
    child.stdin.on("error", (error) => {
      if (this.closed) return;
      this.fail(new Error("WhatsApp sidecar input pipe failed.", { cause: error }));
    });
    this.exit = new Promise((resolve) => {
      let settled = false;
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        const normalized = new Error(
          this.readyReceived
            ? "WhatsApp sidecar process failed."
            : "WhatsApp sidecar process failed to start.",
          { cause: error },
        );
        this.fail(normalized);
        resolve({ code: null, signal: null, error: normalized });
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        resolve({ code, signal });
      });
    });
    void this.readFrames().catch((error: unknown) => {
      this.fail(normalizeError(error));
    });
  }

  static async launch(
    options: WhatsAppSidecarLaunchOptions,
    authStore: WhatsAppSidecarAuthStore,
    dependencies: WhatsAppSidecarClientDependencies = {},
  ): Promise<WhatsAppSidecarClient> {
    const launch = resolveWhatsAppSidecarLaunch(options);
    const child = (dependencies.spawnSidecar ?? spawn)(launch.command, launch.args, {
      cwd: path.dirname(launch.sidecarPath),
      env: buildWhatsAppSidecarEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new WhatsAppSidecarClient(
      child,
      authStore,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      await withTimeout(client.ready.promise, client.timeoutMs, "sidecar readiness");
      return client;
    } catch (error) {
      client.terminate();
      throw error;
    }
  }

  subscribe(listener: (event: WhatsAppConnectionEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.fatalError && this.readyReceived) {
      for (const event of sidecarFailureEvents()) listener(event);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): Promise<void> {
    return this.sendCommand("start");
  }

  stop(): Promise<void> {
    return this.sendCommand("stop");
  }

  resetAndStart(): Promise<void> {
    return this.sendCommand("reset");
  }

  provisionManagedGroups(): Promise<void> {
    return this.sendCommand("provision");
  }

  async sendText(
    request: Extract<WhatsAppSidecarRequest, { type: "send-text" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "send-text" }>> {
    const response = await this.sendRequest(request);
    if (response.type !== "send-text") {
      throw new Error("WhatsApp sidecar returned an unexpected send-text response");
    }
    return response;
  }

  async ensureSessionGroup(
    request: Extract<WhatsAppSidecarRequest, { type: "ensure-session-group" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "ensure-session-group" }>> {
    const response = await this.sendRequest(request);
    if (response.type !== "ensure-session-group") {
      throw new Error("WhatsApp sidecar returned an unexpected session-group response");
    }
    return response;
  }

  async retireSessionGroup(
    request: Extract<WhatsAppSidecarRequest, { type: "retire-session-group" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "retire-session-group" }>> {
    const response = await this.sendRequest(request);
    if (response.type !== "retire-session-group") {
      throw new Error("WhatsApp sidecar returned an unexpected retire-session-group response");
    }
    return response;
  }

  async sendInteraction(
    request: Extract<WhatsAppSidecarRequest, { type: "send-interaction" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "send-interaction" }>> {
    const response = await this.sendRequest(request);
    if (response.type !== "send-interaction") {
      throw new Error("WhatsApp sidecar returned an unexpected interaction response");
    }
    return response;
  }

  async downloadMedia(
    request: Extract<WhatsAppSidecarRequest, { type: "download-media" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "download-media" }>> {
    const response = await this.sendRequest(request);
    if (response.type !== "download-media") {
      throw new Error("WhatsApp sidecar returned an unexpected media download response");
    }
    return response;
  }

  async releaseMedia(
    request: Extract<WhatsAppSidecarRequest, { type: "release-media" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "release-media" }>> {
    const response = await this.sendRequest(request);
    if (response.type !== "release-media") {
      throw new Error("WhatsApp sidecar returned an unexpected media release response");
    }
    return response;
  }

  async cancelInteraction(
    request: Extract<WhatsAppSidecarRequest, { type: "cancel-interaction" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "cancel-interaction" }>> {
    const response = await this.sendRequest(request);
    if (response.type !== "cancel-interaction") {
      throw new Error("WhatsApp sidecar returned an unexpected interaction cancellation");
    }
    return response;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    if (this.shutdownStarted) {
      await withTimeout(this.exit, this.timeoutMs, "sidecar exit");
      return;
    }
    this.shutdownStarted = true;
    try {
      await this.sendCommand("shutdown");
      this.child.stdin.end();
      const result = await withTimeout(this.exit, this.timeoutMs, "sidecar exit");
      if (result.error || result.code !== 0 || result.signal !== null) {
        throw new Error(
          `WhatsApp sidecar exited with code ${String(result.code)} and signal ${String(
            result.signal,
          )}${this.stderrSummary()}`,
        );
      }
      this.closed = true;
      this.output.close();
    } catch (error) {
      this.terminate();
      throw error;
    }
  }

  private async sendCommand(command: WhatsAppSidecarCommand): Promise<void> {
    if (this.fatalError) throw this.fatalError;
    if (this.closed) throw new Error("WhatsApp sidecar client is closed");
    await withTimeout(this.ready.promise, this.timeoutMs, "sidecar readiness");
    const requestId = `command-${++this.nextRequest}`;
    const response = new Promise<void>((resolve, reject) => {
      this.pendingCommands.set(requestId, { command, resolve, reject });
    });
    this.writeFrame({
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "command",
      requestId,
      command,
    });
    try {
      await withTimeout(response, this.timeoutMs, `${command} acknowledgement`);
    } catch (error) {
      const normalized = normalizeError(error);
      this.fail(normalized);
      throw normalized;
    } finally {
      this.pendingCommands.delete(requestId);
    }
  }

  private async sendRequest(
    request: WhatsAppSidecarRequest,
  ): Promise<WhatsAppSidecarRequestResponse> {
    if (this.fatalError) throw this.fatalError;
    if (this.closed) throw new Error("WhatsApp sidecar client is closed");
    await withTimeout(this.ready.promise, this.timeoutMs, "sidecar readiness");
    const requestId = `request-${++this.nextRequest}`;
    const response = new Promise<WhatsAppSidecarRequestResponse>((resolve, reject) => {
      this.pendingRequests.set(requestId, { requestType: request.type, resolve, reject });
    });
    this.writeFrame({
      schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
      kind: "request",
      requestId,
      request,
    });
    try {
      return await withTimeout(response, this.timeoutMs, `${request.type} response`);
    } catch (error) {
      const normalized = normalizeError(error);
      this.fail(normalized);
      throw normalized;
    } finally {
      this.pendingRequests.delete(requestId);
    }
  }

  private async readFrames(): Promise<void> {
    for await (const line of this.output) {
      if (!line.startsWith(WHATSAPP_SIDECAR_FRAME_PREFIX)) {
        this.stdoutNoiseBytes += Buffer.byteLength(line, "utf8");
        if (this.stdoutNoiseBytes > MAX_STDOUT_NOISE_BYTES) {
          throw new Error("WhatsApp sidecar emitted excessive non-protocol output");
        }
        continue;
      }
      const frame = parseWhatsAppSidecarChildFrame(line);
      this.handleFrame(frame);
    }
    if (this.closed) return;
    const shutdownPending = [...this.pendingCommands.values()].some(
      ({ command }) => command === "shutdown",
    );
    if (shutdownPending) {
      throw new Error(
        `WhatsApp sidecar closed stdout before shutdown acknowledgement${this.stderrSummary()}`,
      );
    }
    if (!this.shutdownStarted) {
      throw new Error(`WhatsApp sidecar closed stdout unexpectedly${this.stderrSummary()}`);
    }
  }

  private handleFrame(frame: WhatsAppSidecarChildFrame): void {
    if (frame.kind === "ready") {
      if (this.readyReceived) {
        throw new Error("WhatsApp sidecar returned duplicate readiness");
      }
      this.readyReceived = true;
      this.ready.resolve();
      return;
    }
    if (!this.readyReceived) {
      throw new Error("WhatsApp sidecar returned a frame before readiness");
    }
    if (frame.kind === "event") {
      for (const listener of this.listeners) listener(frame.event);
      return;
    }
    if (frame.kind === "auth-request") {
      void this.respondToAuthRequest(frame).catch((error: unknown) => {
        this.fail(normalizeError(error));
      });
      return;
    }
    if (frame.kind === "request-result") {
      const pending = this.pendingRequests.get(frame.requestId);
      if (!pending || pending.requestType !== frame.requestType) {
        throw new Error("WhatsApp sidecar returned an unexpected request result");
      }
      this.pendingRequests.delete(frame.requestId);
      if (frame.ok) pending.resolve(frame.response);
      else {
        pending.reject(
          new WhatsAppSidecarCommandError(
            frame.error.code,
            `WhatsApp sidecar request failed (${frame.error.code}).`,
          ),
        );
      }
      return;
    }
    if (frame.kind === "command-result") {
      const pending = this.pendingCommands.get(frame.requestId);
      if (!pending || pending.command !== frame.command) {
        throw new Error("WhatsApp sidecar returned an unexpected command result");
      }
      this.pendingCommands.delete(frame.requestId);
      if (frame.ok) pending.resolve();
      else {
        pending.reject(
          new WhatsAppSidecarCommandError(
            frame.error.code,
            `WhatsApp sidecar command failed (${frame.error.code}).`,
          ),
        );
      }
      return;
    }
    this.fail(new Error(`WhatsApp sidecar fatal error (${frame.code}).`));
  }

  private async respondToAuthRequest(request: WhatsAppSidecarAuthRequest): Promise<void> {
    let response: WhatsAppSidecarAuthResponse;
    try {
      response = await createAuthResponse(request, this.authStore);
    } catch (error) {
      response = {
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "auth-response",
        requestId: request.requestId,
        operation: request.operation,
        ok: false,
        error: {
          code: readAuthStoreErrorCode(error),
          message: "WhatsApp auth-store operation failed.",
        },
      };
    }
    this.writeFrame(response);
  }

  private writeFrame(frame: WhatsAppSidecarParentFrame): void {
    if (this.closed || this.child.stdin.destroyed) {
      throw new Error("WhatsApp sidecar stdin is closed");
    }
    try {
      this.child.stdin.write(serializeWhatsAppSidecarFrame(frame));
    } catch (error) {
      const normalized = new Error("WhatsApp sidecar input pipe failed.", { cause: error });
      this.fail(normalized);
      throw normalized;
    }
  }

  private fail(error: Error): void {
    if (this.fatalError) return;
    log.error(error.message);
    this.fatalError = error;
    this.ready.reject(error);
    for (const pending of this.pendingCommands.values()) pending.reject(error);
    this.pendingCommands.clear();
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
    if (this.readyReceived) {
      for (const event of sidecarFailureEvents()) {
        for (const listener of this.listeners) listener(event);
      }
    }
    if (!this.shutdownStarted) this.terminate();
  }

  private terminate(): void {
    if (this.closed) return;
    this.closed = true;
    this.output.close();
    if (this.child.exitCode === null && !this.child.killed) this.child.kill();
  }

  private stderrSummary(): string {
    return this.stderrBytes === 0
      ? ""
      : `; sidecar stderr was suppressed (${this.stderrBytes} bytes)`;
  }
}

export function resolveWhatsAppSidecarLaunch(
  options: WhatsAppSidecarLaunchOptions,
): WhatsAppSidecarResolvedLaunch {
  if (options.mode === "development") {
    const command = options.nodeExecutable ?? process.execPath;
    assertAbsoluteFile(command, "WhatsApp sidecar Node executable");
    assertAbsoluteFile(options.sidecarPath, "WhatsApp sidecar");
    return { command, args: [options.sidecarPath], sidecarPath: options.sidecarPath };
  }

  if (!path.isAbsolute(options.resourcesPath)) {
    throw new Error(`Packaged resources path must be absolute: ${options.resourcesPath}`);
  }
  const sidecarPath =
    options.platform === "win32"
      ? path.win32.join(
          options.resourcesPath,
          WHATSAPP_SIDECAR_RESOURCE_DIR,
          WHATSAPP_SIDECAR_BUNDLE_NAME,
        )
      : path.posix.join(
          options.resourcesPath,
          WHATSAPP_SIDECAR_RESOURCE_DIR,
          WHATSAPP_SIDECAR_BUNDLE_NAME,
        );
  const nodeExecutable = resolvePackagedNode(options.resourcesPath, options.platform);
  assertAbsoluteFile(nodeExecutable, "Packaged WhatsApp sidecar Node executable");
  assertAbsoluteFile(sidecarPath, "Packaged WhatsApp sidecar");

  if (options.platform === "win32") {
    const runner = path.win32.join(path.win32.dirname(options.resourcesPath), "node-runner.exe");
    assertAbsoluteFile(runner, "Packaged WhatsApp sidecar Windows runner");
    return {
      command: runner,
      args: [nodeExecutable, sidecarPath],
      sidecarPath,
    };
  }
  return { command: nodeExecutable, args: [sidecarPath], sidecarPath };
}

export function buildWhatsAppSidecarEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    APP_ROOT: "",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    NO_COLOR: "1",
    VITE_DEV_SERVER_URL: "",
    VITE_PUBLIC: "",
    WS_NO_BUFFER_UTIL: "1",
    WS_NO_UTF_8_VALIDATE: "1",
  };
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENVIRONMENT_ALLOWLIST.has(key.toLowerCase())) {
      environment[key] = value;
    }
  }
  return environment;
}

export async function createAuthResponse(
  request: WhatsAppSidecarAuthRequest,
  authStore: WhatsAppSidecarAuthStore,
): Promise<WhatsAppSidecarAuthResponse> {
  switch (request.operation) {
    case "read-credentials": {
      const credentials = await authStore.readCredentials();
      return {
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "auth-response",
        requestId: request.requestId,
        operation: "read-credentials",
        ok: true,
        credentials: credentials === null ? null : encodeWhatsAppAuthValue(credentials),
      };
    }
    case "read-signal-keys": {
      const values = await authStore.readSignalKeys(request.category, request.ids);
      return {
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "auth-response",
        requestId: request.requestId,
        operation: "read-signal-keys",
        ok: true,
        values: Object.fromEntries(
          Object.entries(values).map(([id, value]) => [id, encodeWhatsAppAuthValue(value)]),
        ),
      };
    }
    case "apply-transaction": {
      const update: WhatsAppAuthStoreUpdate = {};
      if (Object.hasOwn(request.update, "credentials")) {
        update.credentials =
          request.update.credentials === null || request.update.credentials === undefined
            ? null
            : decodeWhatsAppAuthValue(request.update.credentials);
      }
      if (request.update.signalKeys) {
        update.signalKeys = Object.fromEntries(
          Object.entries(request.update.signalKeys).map(([category, entries]) => [
            category,
            Object.fromEntries(
              Object.entries(entries).map(([id, value]) => [
                id,
                value === null ? null : decodeWhatsAppAuthValue(value),
              ]),
            ),
          ]),
        ) as WhatsAppSignalKeyUpdates;
      }
      await authStore.applyTransaction(update);
      return {
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "auth-response",
        requestId: request.requestId,
        operation: "apply-transaction",
        ok: true,
      };
    }
    case "reset":
      await authStore.resetAfterTerminalDisconnect();
      return {
        schemaVersion: WHATSAPP_SIDECAR_SCHEMA_VERSION,
        kind: "auth-response",
        requestId: request.requestId,
        operation: "reset",
        ok: true,
      };
  }
}

function resolvePackagedNode(resourcesPath: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return path.win32.join(resourcesPath, "node", "node.exe");
  return path.posix.join(resourcesPath, "node", "node");
}

function assertAbsoluteFile(filePath: string, label: string): void {
  if (!path.isAbsolute(filePath)) throw new Error(`${label} path must be absolute: ${filePath}`);
  if (!existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`);
}

function readAuthStoreErrorCode(error: unknown): WhatsAppAuthStoreErrorCode {
  if (isRecord(error) && isAuthStoreErrorCode(error.code)) return error.code;
  return "UNKNOWN";
}

function isAuthStoreErrorCode(value: unknown): value is WhatsAppAuthStoreError["code"] {
  return (
    value === "INVALID_CONFIGURATION" ||
    value === "SQLITE_UNAVAILABLE" ||
    value === "IO_FAILURE" ||
    value === "SCHEMA_MISMATCH" ||
    value === "WRONG_KEY" ||
    value === "CORRUPT_STORE" ||
    value === "TRANSACTION_FAILED" ||
    value === "STORE_CLOSED"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for WhatsApp ${label}`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error("WhatsApp sidecar failed");
}

function sidecarFailureEvents(): WhatsAppConnectionEvent[] {
  return [
    {
      type: "error",
      code: "SIDECAR_FAILED",
      message: "WhatsApp sidecar process failed.",
    },
    { type: "status", status: "stopped", attempt: 0 },
  ];
}
