import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { createLogger } from "../../../common/marshal-logger";
import type { RuntimeProcessHandle } from "../runtime-contract";
import {
  CodexProtocolError,
  CodexRpcError,
  type CodexRequestId,
  type CodexWireMessage,
  decodeWireMessage,
  type ResultDecoder,
} from "./protocol";

const log = createLogger("CodexJsonlRpc");

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const OVERLOAD_RETRY_LIMIT = 3;
const OVERLOAD_RETRY_BASE_MS = 50;

export interface CodexServerRequest {
  id: CodexRequestId;
  method: string;
  params: unknown;
}

export interface CodexNotification {
  method: string;
  params: unknown;
}

export interface CodexRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type CodexServerRequestHandler = (request: CodexServerRequest) => Promise<unknown>;
export type CodexNotificationHandler = (notification: CodexNotification) => void;
export type CodexTransportErrorHandler = (error: Error) => void;

export interface CodexRpcConnection {
  readonly process?: RuntimeProcessHandle;
  request<T>(
    method: string,
    params: unknown,
    decoder: ResultDecoder<T>,
    options?: CodexRequestOptions,
  ): Promise<T>;
  notify(method: string, params?: unknown): Promise<void>;
  onNotification(handler: CodexNotificationHandler): () => void;
  onError(handler: CodexTransportErrorHandler): () => void;
  setServerRequestHandler(handler: CodexServerRequestHandler | null): void;
  shutdown(options?: { timeoutMs?: number; force?: boolean }): Promise<Error[]>;
  /** True once the connection is shutting down or its process is gone; later calls fail. */
  isClosed?(): boolean;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

export class CodexJsonlRpcConnection implements CodexRpcConnection {
  private readonly pending = new Map<CodexRequestId, PendingRequest>();
  private readonly notificationHandlers = new Set<CodexNotificationHandler>();
  private readonly errorHandlers = new Set<CodexTransportErrorHandler>();
  private readonly maxMessageBytes: number;
  private readonly requestTimeoutMs: number;
  private readBuffer = Buffer.alloc(0);
  private nextRequestId = 1;
  private writeTail: Promise<void> = Promise.resolve();
  private serverRequestHandler: CodexServerRequestHandler | null = null;
  private closing = false;
  private closed = false;
  private forceStopping = false;
  private fatalError: Error | null = null;
  private stderrBytes = 0;
  private exitCode: number | null = null;
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    options: {
      requestTimeoutMs?: number;
      maxMessageBytes?: number;
      terminateProcess?: (signal: NodeJS.Signals) => Promise<void>;
    } = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.terminateProcess =
      options.terminateProcess ??
      (async (signal) => {
        child.kill(signal);
      });
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    child.stdout.on("data", (chunk: Buffer | string) => this.onStdout(chunk));
    child.stdout.on("end", () => this.onStdoutEnd());
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrBytes += Buffer.byteLength(chunk);
    });
    child.on("error", (error) => this.fail(asError(error, "Codex app-server process failed")));
    child.on("exit", (code, signal) => this.onExit(code, signal));
  }

  private readonly terminateProcess: (signal: NodeJS.Signals) => Promise<void>;

  get process(): RuntimeProcessHandle {
    const child = this.child;
    return {
      pid: child.pid,
      get exitCode() {
        return child.exitCode;
      },
      get killed() {
        return child.killed;
      },
      kill: (signal?: string) => {
        const supported =
          signal === undefined ||
          signal === "SIGKILL" ||
          signal === "SIGTERM" ||
          signal === "SIGINT" ||
          signal === "SIGHUP";
        if (!supported) return false;
        void this.terminateProcess(signal ?? "SIGTERM").catch((error: unknown) => {
          this.emitError(asError(error, "Failed to terminate Codex app-server process tree"));
        });
        return true;
      },
    };
  }

  request<T>(
    method: string,
    params: unknown,
    decoder: ResultDecoder<T>,
    options: CodexRequestOptions = {},
  ): Promise<T> {
    return this.requestWithOverloadRetry(method, params, decoder, options, 0);
  }

  private async requestWithOverloadRetry<T>(
    method: string,
    params: unknown,
    decoder: ResultDecoder<T>,
    options: CodexRequestOptions,
    attempt: number,
  ): Promise<T> {
    try {
      return await this.requestOnce(method, params, decoder, options);
    } catch (error) {
      if (
        !(error instanceof CodexRpcError) ||
        !error.retryable ||
        attempt >= OVERLOAD_RETRY_LIMIT ||
        options.signal?.aborted
      ) {
        throw error;
      }
      const exponential = OVERLOAD_RETRY_BASE_MS * 2 ** attempt;
      const delayMs = exponential + Math.floor(Math.random() * exponential);
      await this.waitForRetry(delayMs, options.signal);
      return this.requestWithOverloadRetry(method, params, decoder, options, attempt + 1);
    }
  }

  private requestOnce<T>(
    method: string,
    params: unknown,
    decoder: ResultDecoder<T>,
    options: CodexRequestOptions,
  ): Promise<T> {
    if (this.closing || this.closed) {
      return Promise.reject(
        new Error(`[codex-app-server] cannot call ${method}: connection closed`),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(abortError(`[codex-app-server] ${method} was aborted`));
    }

    const id = this.nextRequestId++;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const rawResponse = new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve,
        reject,
        timer: null,
        ...(options.signal ? { signal: options.signal } : {}),
      };

      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          this.cleanupPending(pending);
          reject(new Error(`[codex-app-server] ${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }

      if (options.signal) {
        const abortHandler = () => {
          if (!this.pending.delete(id)) return;
          this.cleanupPending(pending);
          reject(abortError(`[codex-app-server] ${method} was aborted`));
        };
        pending.abortHandler = abortHandler;
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      this.pending.set(id, pending);
      void this.writeMessage({ id, method, params }, { isLive: () => this.pending.has(id) }).catch(
        (error: unknown) => {
          if (!this.pending.delete(id)) return;
          this.cleanupPending(pending);
          reject(asError(error, `[codex-app-server] failed to send ${method}`));
        },
      );
    });

    return rawResponse.then(decoder);
  }

  isClosed(): boolean {
    return this.closing || this.closed;
  }

  notify(method: string, params?: unknown): Promise<void> {
    if (this.closing || this.closed) {
      return Promise.reject(
        new Error(`[codex-app-server] cannot send ${method}: connection closed`),
      );
    }
    return this.writeMessage(params === undefined ? { method } : { method, params });
  }

  onNotification(handler: CodexNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onError(handler: CodexTransportErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  setServerRequestHandler(handler: CodexServerRequestHandler | null): void {
    this.serverRequestHandler = handler;
  }

  async shutdown(options: { timeoutMs?: number; force?: boolean } = {}): Promise<Error[]> {
    if (this.closed) {
      return this.fatalError ? [this.fatalError] : [];
    }
    this.closing = true;
    this.forceStopping ||= options.force === true;
    const errors: Error[] = [];
    const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    let exited: boolean = this.closed;

    if (options.force === true) {
      try {
        await this.terminateProcess("SIGKILL");
      } catch (error) {
        errors.push(asError(error, "Failed to force-stop Codex app-server"));
      }
      exited = this.closed;
    } else {
      const gracefulDrain = (async () => {
        await this.writeTail;
        this.child.stdin.end();
        await this.exitPromise;
      })();
      const gracefulResult = await Promise.race([
        gracefulDrain.then(
          () => ({ exited: true as const }),
          (error: unknown) => ({ exited: false as const, error }),
        ),
        new Promise<{ exited: false; timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ exited: false, timedOut: true }), timeoutMs),
        ),
      ]);
      if (gracefulResult.exited) {
        exited = true;
      }
      if ("error" in gracefulResult) {
        errors.push(asError(gracefulResult.error, "Failed to close Codex app-server stdin"));
      }
    }

    if (!exited) {
      try {
        this.forceStopping = true;
        await this.terminateProcess("SIGKILL");
        const observedExit = await Promise.race([
          this.exitPromise.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
        ]);
        if (!observedExit) {
          const error = new Error(
            "[codex-app-server] process tree termination did not produce an exit event",
          );
          errors.push(error);
          this.rejectAllPending(error);
        }
      } catch (error) {
        errors.push(asError(error, "Failed to terminate Codex app-server"));
      }
    }

    if (this.exitCode !== null && this.exitCode !== 0 && !this.forceStopping) {
      errors.push(
        new Error(
          `[codex-app-server] exited with code ${this.exitCode} (stderr bytes: ${this.stderrBytes})`,
        ),
      );
    }
    if (this.fatalError && !errors.includes(this.fatalError)) {
      errors.push(this.fatalError);
    }
    return errors;
  }

  private onStdout(chunk: Buffer | string): void {
    if (this.closing || this.closed) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.readBuffer =
      this.readBuffer.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.readBuffer, bytes]);

    while (true) {
      const newline = this.readBuffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > this.maxMessageBytes) {
        this.fail(new CodexProtocolError("incoming JSONL message exceeds size limit"));
        return;
      }
      const rawLine = this.readBuffer.subarray(0, newline);
      this.readBuffer = this.readBuffer.subarray(newline + 1);
      const line =
        rawLine.length > 0 && rawLine.at(-1) === 0x0d
          ? rawLine.subarray(0, rawLine.length - 1)
          : rawLine;
      if (line.length === 0) continue;
      this.parseLine(line);
      if (this.closing || this.closed) return;
    }

    if (this.readBuffer.length > this.maxMessageBytes) {
      this.fail(new CodexProtocolError("incoming JSONL message exceeds size limit"));
    }
  }

  private onStdoutEnd(): void {
    if (this.closed || this.readBuffer.length === 0) return;
    const trailing = this.readBuffer;
    this.readBuffer = Buffer.alloc(0);
    if (trailing.toString("utf8").trim().length > 0) {
      this.parseLine(trailing);
    }
  }

  private parseLine(line: Buffer): void {
    try {
      // SF-4: subprocess data is parsed as unknown and narrowed by decodeWireMessage.
      const parsed: unknown = JSON.parse(line.toString("utf8"));
      this.dispatch(decodeWireMessage(parsed));
    } catch (error) {
      this.fail(asError(error, "Malformed Codex app-server JSONL message"));
    }
  }

  private dispatch(message: CodexWireMessage): void {
    if (this.closing || this.closed) return;
    switch (message.kind) {
      case "response":
        this.handleResponse(message);
        break;
      case "notification":
        for (const handler of this.notificationHandlers) {
          try {
            handler({ method: message.method, params: message.params });
          } catch (error) {
            this.emitError(asError(error, "Codex notification handler failed"));
          }
        }
        break;
      case "request":
        void this.handleServerRequest(message).catch((error: unknown) => {
          if (!this.closing && !this.closed) {
            this.emitError(asError(error, "Codex server-request task failed"));
          }
        });
        break;
    }
  }

  private handleResponse(message: Extract<CodexWireMessage, { kind: "response" }>): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      log.warn("Ignoring response with no pending request", String(message.id));
      return;
    }
    this.pending.delete(message.id);
    this.cleanupPending(pending);
    if (message.error) {
      pending.reject(
        new CodexRpcError(
          pending.method,
          message.error.code,
          message.error.message,
          message.error.data,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private async handleServerRequest(
    message: Extract<CodexWireMessage, { kind: "request" }>,
  ): Promise<void> {
    if (!this.serverRequestHandler) {
      if (!this.closing && !this.closed) {
        await this.writeServerError(message.id, -32601, "Method not supported by host");
      }
      return;
    }
    try {
      const result = await this.serverRequestHandler({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      if (!this.closing && !this.closed) {
        await this.writeMessage({ id: message.id, result: result ?? {} });
      }
    } catch (error) {
      log.warn("Server request handler failed", message.method, asError(error, "unknown").name);
      if (!this.closing && !this.closed) {
        await this.writeServerError(message.id, -32000, "Host request handler failed");
      }
    }
  }

  private writeServerError(id: CodexRequestId, code: number, message: string): Promise<void> {
    return this.writeMessage({ id, error: { code, message } });
  }

  private writeMessage(message: unknown, options: { isLive?: () => boolean } = {}): Promise<void> {
    let line: string;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch (error) {
      return Promise.reject(asError(error, "Failed to serialize Codex app-server message"));
    }
    if (Buffer.byteLength(line) > this.maxMessageBytes) {
      return Promise.reject(new CodexProtocolError("outgoing JSONL message exceeds size limit"));
    }

    const operation = this.writeTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (options.isLive && !options.isLive()) {
            reject(abortError("[codex-app-server] queued request is no longer active"));
            return;
          }
          if (this.closed || this.child.stdin.destroyed) {
            reject(new Error("[codex-app-server] stdin is closed"));
            return;
          }
          this.child.stdin.write(line, (error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    );
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  private cleanupPending(pending: PendingRequest): void {
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener("abort", pending.abortHandler);
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    const expectedExit = this.closing;
    this.exitCode = code;
    this.closed = true;
    this.closing = true;
    const error =
      this.fatalError ??
      new Error(
        `[codex-app-server] process exited ${
          code === null ? `from signal ${signal ?? "unknown"}` : `with code ${code}`
        }`,
      );
    this.rejectAllPending(error);
    this.resolveExit();
    if (!this.forceStopping && (code !== 0 || !expectedExit)) {
      void this.terminateProcess("SIGKILL").catch((terminateError: unknown) => {
        this.emitError(
          asError(terminateError, "Failed to reconcile Codex app-server process tree"),
        );
      });
      this.emitError(error);
    }
  }

  private waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(abortError("[codex-app-server] request was aborted before retry"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError("[codex-app-server] request was aborted before retry"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private fail(error: Error): void {
    if (this.fatalError || this.closed) return;
    this.fatalError = error;
    this.closing = true;
    this.rejectAllPending(error);
    this.emitError(error);
    try {
      this.forceStopping = true;
      void this.terminateProcess("SIGKILL").catch((terminateError: unknown) => {
        this.emitError(
          asError(terminateError, "Failed to terminate Codex app-server process tree"),
        );
      });
    } catch {
      // The process may already have exited.
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      this.cleanupPending(pending);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch {
        // Error observers must not destabilize the transport.
      }
    }
  }
}
