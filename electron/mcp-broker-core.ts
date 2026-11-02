import { createHash, randomBytes } from "node:crypto";
import * as path from "node:path";

export interface McpBrokerUpstreamConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  workingDirectory: string;
  workspaceDir: string;
  identityKey: string;
  configGeneration: number;
}

export interface McpBrokerUpstream {
  listTools(signal?: AbortSignal): Promise<unknown>;
  callTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export type McpBrokerUpstreamFactory = (
  config: McpBrokerUpstreamConfig,
  signal?: AbortSignal,
) => Promise<McpBrokerUpstream>;

export interface McpBrokerCapabilityOptions {
  sessionId: string;
  serverKey: string;
  config: McpBrokerUpstreamConfig;
  isEnabled: () => boolean;
  authorize?: (request: {
    sessionId: string;
    serverKey: string;
    operation: "tools/list" | "tools/call";
    toolName?: string;
  }) => boolean | Promise<boolean>;
}

export interface McpBrokerInvocationRecord {
  sessionId: string;
  serverKey: string;
  operation: "tools/list" | "tools/call";
  toolName?: string;
  outcome: "succeeded" | "failed" | "cancelled" | "denied";
  durationMs: number;
}

export interface McpBrokerCoreOptions {
  createUpstream: McpBrokerUpstreamFactory;
  maxConcurrencyPerUpstream?: number;
  maxOutputBytes?: number;
  onInvocation?: (record: McpBrokerInvocationRecord) => void;
}

export interface McpBrokerCapability {
  readonly id: string;
  readonly token: string;
  readonly sessionId: string;
  readonly serverKey: string;
  listTools(signal?: AbortSignal): Promise<unknown>;
  callTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  revoke(): Promise<void>;
}

interface CapabilityState {
  id: string;
  token: string;
  options: McpBrokerCapabilityOptions;
  revoked: boolean;
  abortController: AbortController;
  binding?: Promise<UpstreamEntry>;
  boundEntry?: UpstreamEntry;
}

interface UpstreamEntry {
  upstream: McpBrokerUpstream;
  concurrency: Semaphore;
  references: number;
  closePromise?: Promise<void>;
}

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export class McpBrokerCore {
  private readonly capabilities = new Map<string, CapabilityState>();
  private readonly upstreams = new Map<string, UpstreamEntry>();
  private readonly connecting = new Map<string, Promise<UpstreamEntry>>();
  private readonly disposeController = new AbortController();
  private readonly options: Required<
    Pick<McpBrokerCoreOptions, "maxConcurrencyPerUpstream" | "maxOutputBytes">
  > &
    McpBrokerCoreOptions;
  private disposed = false;

  constructor(options: McpBrokerCoreOptions) {
    this.options = {
      ...options,
      maxConcurrencyPerUpstream: options.maxConcurrencyPerUpstream ?? DEFAULT_MAX_CONCURRENCY,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    };
  }

  createCapability(options: McpBrokerCapabilityOptions): McpBrokerCapability {
    if (this.disposed) throw new Error("MCP broker is disposed");
    const id = randomBytes(16).toString("hex");
    const token = randomBytes(32).toString("base64url");
    const state: CapabilityState = {
      id,
      token,
      options,
      revoked: false,
      abortController: new AbortController(),
    };
    this.capabilities.set(token, state);

    return {
      id,
      token,
      sessionId: options.sessionId,
      serverKey: options.serverKey,
      listTools: (signal) => this.invoke(state, "tools/list", undefined, undefined, signal),
      callTool: (toolName, args, signal) =>
        this.invoke(state, "tools/call", toolName, args, signal),
      revoke: () => this.revoke(state),
    };
  }

  getCapability(token: string): McpBrokerCapability | undefined {
    const state = this.capabilities.get(token);
    if (!state || state.revoked) return undefined;
    return {
      id: state.id,
      token: state.token,
      sessionId: state.options.sessionId,
      serverKey: state.options.serverKey,
      listTools: (signal) => this.invoke(state, "tools/list", undefined, undefined, signal),
      callTool: (toolName, args, signal) =>
        this.invoke(state, "tools/call", toolName, args, signal),
      revoke: () => this.revoke(state),
    };
  }

  get upstreamCount(): number {
    return this.upstreams.size;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeController.abort();
    for (const state of this.capabilities.values()) {
      state.revoked = true;
      state.abortController.abort();
    }
    this.capabilities.clear();
    const pending = [...this.connecting.values()];
    this.connecting.clear();
    await Promise.allSettled(pending);
    const entries = [...this.upstreams.values()];
    this.upstreams.clear();
    await Promise.allSettled(entries.map((entry) => this.closeUpstream(entry)));
  }

  private async invoke(
    state: CapabilityState,
    operation: "tools/list" | "tools/call",
    toolName?: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const startedAt = Date.now();
    let outcome: McpBrokerInvocationRecord["outcome"] = "failed";
    const invocationSignal = signal
      ? AbortSignal.any([signal, state.abortController.signal])
      : state.abortController.signal;
    try {
      this.assertAvailable(state, invocationSignal);
      const authorized =
        (await state.options.authorize?.({
          sessionId: state.options.sessionId,
          serverKey: state.options.serverKey,
          operation,
          ...(toolName ? { toolName } : {}),
        })) ?? true;
      if (!authorized) {
        outcome = "denied";
        throw new Error("MCP capability denied by session policy");
      }

      this.assertAvailable(state, invocationSignal);
      const entry = await this.bindUpstream(state);
      const result = await entry.concurrency.run(invocationSignal, async () => {
        this.assertAvailable(state, invocationSignal);
        return operation === "tools/list"
          ? entry.upstream.listTools(invocationSignal)
          : entry.upstream.callTool(toolName ?? "", args ?? {}, invocationSignal);
      });
      assertOutputSize(result, this.options.maxOutputBytes);
      outcome = "succeeded";
      return result;
    } catch (error) {
      if (invocationSignal.aborted || isAbortError(error)) outcome = "cancelled";
      throw error;
    } finally {
      this.options.onInvocation?.({
        sessionId: state.options.sessionId,
        serverKey: state.options.serverKey,
        operation,
        ...(toolName ? { toolName } : {}),
        outcome,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  private assertAvailable(state: CapabilityState, signal?: AbortSignal): void {
    if (this.disposed) throw new Error("MCP broker is disposed");
    if (state.revoked || !state.options.isEnabled()) {
      throw new Error("MCP capability has been revoked");
    }
    signal?.throwIfAborted();
  }

  private async bindUpstream(state: CapabilityState): Promise<UpstreamEntry> {
    const binding = (state.binding ??= this.acquireUpstream(state));
    try {
      const entry = await binding;
      state.boundEntry = entry;
      return entry;
    } catch (error) {
      if (state.binding === binding) state.binding = undefined;
      throw error;
    }
  }

  private async acquireUpstream(state: CapabilityState): Promise<UpstreamEntry> {
    const poolKey = `${state.id}:${canonicalUpstreamKey(state.options.config)}`;
    let entry = this.upstreams.get(poolKey);
    if (!entry) {
      let pending = this.connecting.get(poolKey);
      if (!pending) {
        pending = this.options
          .createUpstream(state.options.config, this.disposeController.signal)
          .then((upstream) => {
            const created: UpstreamEntry = {
              upstream,
              concurrency: new Semaphore(this.options.maxConcurrencyPerUpstream),
              references: 0,
            };
            this.upstreams.set(poolKey, created);
            return created;
          })
          .finally(() => this.connecting.delete(poolKey));
        this.connecting.set(poolKey, pending);
      }
      entry = await pending;
    }
    entry.references += 1;
    return entry;
  }

  private async revoke(state: CapabilityState): Promise<void> {
    if (state.revoked) return;
    state.revoked = true;
    state.abortController.abort();
    this.capabilities.delete(state.token);
    if (state.boundEntry) {
      await this.releaseUpstream(state.boundEntry);
      return;
    }
    const binding = state.binding;
    if (!binding) return;
    void binding
      .then((entry) => this.releaseUpstream(entry))
      .catch(() => undefined);
  }

  private async releaseUpstream(entry: UpstreamEntry): Promise<void> {
    entry.references -= 1;
    if (entry.references > 0) return;
    const key = [...this.upstreams.entries()].find(([, candidate]) => candidate === entry)?.[0];
    if (key) this.upstreams.delete(key);
    await this.closeUpstream(entry);
  }

  private closeUpstream(entry: UpstreamEntry): Promise<void> {
    return (entry.closePromise ??= entry.upstream.close());
  }
}

export function canonicalUpstreamKey(config: McpBrokerUpstreamConfig): string {
  const workingDirectory = canonicalPath(config.workingDirectory);
  const command = canonicalCommand(config.command, workingDirectory);
  const env = Object.fromEntries(
    Object.entries(config.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  );
  const canonical = JSON.stringify({
    command,
    args: config.args,
    env,
    workingDirectory,
    workspaceDir: canonicalPath(config.workspaceDir),
    identityKey: config.identityKey,
    configGeneration: config.configGeneration,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalCommand(command: string, workingDirectory: string): string {
  const normalized =
    path.isAbsolute(command) || command.includes("/") || command.includes("\\")
      ? path.resolve(workingDirectory, command)
      : command;
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function canonicalPath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertOutputSize(result: unknown, maxBytes: number): void {
  const serialized = JSON.stringify(result);
  if (serialized !== undefined && Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new Error(`MCP upstream response exceeded ${maxBytes} bytes`);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("MCP upstream concurrency must be a positive integer");
    }
  }

  async run<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const wake = (): void => {
        signal?.removeEventListener("abort", abort);
        this.active += 1;
        resolve();
      };
      const abort = (): void => {
        const index = this.waiters.indexOf(wake);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      this.waiters.push(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}
