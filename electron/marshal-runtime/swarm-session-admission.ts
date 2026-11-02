import { classifySwarmLaunchFailure, type SwarmLaunchFailure } from "./swarm-launch-failure";

export const SWARM_SESSION_ADMISSION_DEFAULTS = {
  maxConcurrentStarts: 4,
  startSpacingMs: 250,
  maxAttempts: 3,
  backoffMs: [1000, 3000] as readonly number[],
  maxJitterMs: 500,
} as const;

export type SwarmAdmissionDelayReason = "start-spacing" | "retry-backoff";

export type SwarmAdmissionSleep = (
  milliseconds: number,
  reason: SwarmAdmissionDelayReason,
  signal?: AbortSignal,
) => Promise<void>;

export interface SwarmSessionAdmissionOptions {
  readonly maxConcurrentStarts?: number;
  readonly startSpacingMs?: number;
  readonly maxAttempts?: number;
  readonly backoffMs?: readonly number[];
  readonly maxJitterMs?: number;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: SwarmAdmissionSleep;
  readonly classify?: (error: unknown) => SwarmLaunchFailure;
}

export interface SwarmAdmissionAttemptFailure {
  readonly attempt: number;
  readonly failure: SwarmLaunchFailure;
  readonly error: unknown;
  readonly willRetry: boolean;
  readonly backoffMs: number;
}

export interface SwarmAdmissionRunOptions {
  readonly signal?: AbortSignal;
  readonly onAttemptFailed?: (failure: SwarmAdmissionAttemptFailure) => void;
}

interface Waiter {
  resolve(): void;
  detach(): void;
}

function abortReason(signal: AbortSignal | undefined): unknown {
  const reason: unknown = signal?.reason;
  return reason ?? new Error("Swarm session admission was aborted.");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function defaultSleep(
  milliseconds: number,
  _reason: SwarmAdmissionDelayReason,
  signal?: AbortSignal,
): Promise<void> {
  if (milliseconds <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Bounds concurrent session *starts* only. A slot is held for the duration of one
 * launch dispatch and released the moment that dispatch settles — before any retry
 * backoff — so the number of agents left running is never capped by this gate.
 */
export class SwarmSessionAdmission {
  private readonly maxConcurrentStartsValue: number;
  private readonly startSpacingMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: readonly number[];
  private readonly maxJitterMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: SwarmAdmissionSleep;
  private readonly classify: (error: unknown) => SwarmLaunchFailure;

  private readonly waiters: Waiter[] = [];
  private active = 0;
  private nextStartAt = Number.NEGATIVE_INFINITY;

  constructor(options: SwarmSessionAdmissionOptions = {}) {
    this.maxConcurrentStartsValue = Math.max(
      1,
      options.maxConcurrentStarts ?? SWARM_SESSION_ADMISSION_DEFAULTS.maxConcurrentStarts,
    );
    this.startSpacingMs = Math.max(
      0,
      options.startSpacingMs ?? SWARM_SESSION_ADMISSION_DEFAULTS.startSpacingMs,
    );
    this.maxAttempts = Math.max(
      1,
      options.maxAttempts ?? SWARM_SESSION_ADMISSION_DEFAULTS.maxAttempts,
    );
    this.backoffMs =
      options.backoffMs && options.backoffMs.length > 0
        ? [...options.backoffMs]
        : SWARM_SESSION_ADMISSION_DEFAULTS.backoffMs;
    this.maxJitterMs = Math.max(
      0,
      options.maxJitterMs ?? SWARM_SESSION_ADMISSION_DEFAULTS.maxJitterMs,
    );
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.classify = options.classify ?? classifySwarmLaunchFailure;
  }

  get maxConcurrentStarts(): number {
    return this.maxConcurrentStartsValue;
  }

  get activeStarts(): number {
    return this.active;
  }

  get queuedStarts(): number {
    return this.waiters.length;
  }

  /** Admitted launch: FIFO-queued, concurrency-capped, spaced, and retried. */
  run<T>(
    launch: (attempt: number) => Promise<T>,
    options: SwarmAdmissionRunOptions = {},
  ): Promise<T> {
    return this.execute(launch, options, true);
  }

  /** Bypasses the queue, the start cap, and start spacing; retry policy still applies. */
  runUnadmitted<T>(
    launch: (attempt: number) => Promise<T>,
    options: SwarmAdmissionRunOptions = {},
  ): Promise<T> {
    return this.execute(launch, options, false);
  }

  private async execute<T>(
    launch: (attempt: number) => Promise<T>,
    options: SwarmAdmissionRunOptions,
    admitted: boolean,
    attempt = 1,
  ): Promise<T> {
    const signal = options.signal;
    throwIfAborted(signal);
    if (admitted) await this.admit(signal);
    let caught: unknown;
    try {
      return await launch(attempt);
    } catch (error) {
      caught = error;
    } finally {
      if (admitted) this.releaseSlot();
    }

    const failure = this.classify(caught);
    const willRetry = failure.retryable && attempt < this.maxAttempts && signal?.aborted !== true;
    const backoffMs = willRetry ? this.backoffDelay(attempt) : 0;
    options.onAttemptFailed?.({ attempt, failure, error: caught, willRetry, backoffMs });
    if (!willRetry) throw caught;
    await this.sleep(backoffMs, "retry-backoff", signal);
    return this.execute(launch, options, admitted, attempt + 1);
  }

  private backoffDelay(attempt: number): number {
    const base = this.backoffMs[attempt - 1] ?? this.backoffMs[this.backoffMs.length - 1] ?? 0;
    const jitter = Math.min(
      this.maxJitterMs,
      Math.max(0, Math.floor(this.random() * (this.maxJitterMs + 1))),
    );
    return base + jitter;
  }

  private async admit(signal: AbortSignal | undefined): Promise<void> {
    await this.acquireSlot(signal);
    try {
      throwIfAborted(signal);
      await this.awaitStartWindow(signal);
    } catch (error) {
      this.releaseSlot();
      throw error;
    }
  }

  private acquireSlot(signal: AbortSignal | undefined): Promise<void> {
    throwIfAborted(signal);
    if (this.active < this.maxConcurrentStartsValue) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let detached = false;
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        detached = true;
        reject(abortReason(signal));
      };
      const waiter: Waiter = {
        resolve: () => resolve(),
        detach: () => {
          if (detached) return;
          detached = true;
          signal?.removeEventListener("abort", onAbort);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseSlot(): void {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.active = Math.max(0, this.active - 1);
      return;
    }
    // Slot ownership transfers to the next FIFO waiter; `active` stays unchanged.
    waiter.detach();
    waiter.resolve();
  }

  private async awaitStartWindow(signal: AbortSignal | undefined): Promise<void> {
    if (this.startSpacingMs === 0) return;
    const now = this.now();
    const startAt = Math.max(now, this.nextStartAt);
    this.nextStartAt = startAt + this.startSpacingMs;
    const delay = startAt - now;
    if (delay > 0) await this.sleep(delay, "start-spacing", signal);
  }
}
