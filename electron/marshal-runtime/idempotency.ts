import { createHash } from "node:crypto";

import type { MarshalRuntimeApiResult } from "./contracts";
import { RuntimeApiError } from "./runtime-api-error";

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 512;

interface IdempotencyEntry {
  readonly requestDigest: string;
  readonly controller: AbortController;
  readonly promise: Promise<MarshalRuntimeApiResult<unknown>>;
  waiters: number;
  settled: boolean;
  expiresAt: number;
}

export interface RuntimeIdempotencyOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

export interface RuntimeIdempotencyRequest {
  readonly operation: string;
  readonly identity: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly signal?: AbortSignal;
  /** Synchronous commits must finish rather than return aborted after persistence. */
  readonly abortAfterStart?: boolean;
}

function stableJson(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new RuntimeApiError("aborted", "Marshal Runtime operation was aborted.");
}

async function awaitAbortable<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return operation;
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    listener = () =>
      reject(new RuntimeApiError("aborted", "Marshal Runtime operation was aborted."));
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}

export class RuntimeIdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: RuntimeIdempotencyOptions = {}) {
    this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS);
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
  }

  async execute<T>(
    request: RuntimeIdempotencyRequest,
    operation: (signal: AbortSignal) => Promise<MarshalRuntimeApiResult<T>>,
  ): Promise<MarshalRuntimeApiResult<T>> {
    throwIfAborted(request.signal);
    this.prune();
    const entryKey = digest({
      operation: request.operation,
      identity: request.identity,
      idempotencyKey: request.idempotencyKey,
    });
    const requestDigest = digest(request.payload);
    const existing = this.entries.get(entryKey);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        throw new RuntimeApiError(
          "idempotency-conflict",
          "The idempotency key was reused with a different Marshal Runtime request.",
        );
      }
      return this.waitForEntry(
        entryKey,
        existing,
        request.abortAfterStart === false ? undefined : request.signal,
      );
    }

    this.makeCapacity();
    const controller = new AbortController();
    const promise: Promise<MarshalRuntimeApiResult<unknown>> = Promise.resolve().then(() =>
      operation(controller.signal),
    );
    const entry: IdempotencyEntry = {
      requestDigest,
      controller,
      promise,
      waiters: 0,
      settled: false,
      expiresAt: Number.POSITIVE_INFINITY,
    };
    this.entries.set(entryKey, entry);
    void promise.then(
      () => {
        entry.settled = true;
        entry.expiresAt = this.now() + this.ttlMs;
      },
      () => {
        entry.settled = true;
        if (this.entries.get(entryKey) === entry) this.entries.delete(entryKey);
      },
    );
    return this.waitForEntry(
      entryKey,
      entry,
      request.abortAfterStart === false ? undefined : request.signal,
    );
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      if (!entry.settled) entry.controller.abort();
    }
    this.entries.clear();
  }

  private async waitForEntry<T>(
    entryKey: string,
    entry: IdempotencyEntry,
    signal: AbortSignal | undefined,
  ): Promise<MarshalRuntimeApiResult<T>> {
    entry.waiters++;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the request digest preserves the cached request/result generic correlation
      return (await awaitAbortable(entry.promise, signal)) as MarshalRuntimeApiResult<T>;
    } finally {
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (!entry.settled && entry.waiters === 0) {
        entry.controller.abort();
        if (this.entries.get(entryKey) === entry) this.entries.delete(entryKey);
      }
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.settled && entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private makeCapacity(): void {
    if (this.entries.size < this.maxEntries) return;
    for (const [key, entry] of this.entries) {
      if (!entry.settled) continue;
      this.entries.delete(key);
      if (this.entries.size < this.maxEntries) return;
    }
    throw new RuntimeApiError(
      "idempotency-capacity",
      "Marshal Runtime idempotency capacity is exhausted.",
    );
  }
}
