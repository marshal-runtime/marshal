// electron/workflows/subagent-pool.ts
//
// Three-layer FIFO token bucket (global / per-run / per-fanOut) backing
// `ctx.spawn` and `ctx.run`. Spec: c-runtime §8 + r1-fixes A20.
//
// Concurrency safety: all mutations to `globalTokens`, `perRun`,
// `perFanOut`, and `waiters` happen synchronously inside `acquire`,
// `release`, `drain`, or `cancelRun` — Node's event loop guarantees
// atomicity between awaits, so no mutex is needed.

import { createLogger } from "../../common/marshal-logger";

const log = createLogger("WorkflowPool");

export type ReleaseFn = () => void;

export interface PoolDeps {
  readonly globalMax: number;
  readonly defaultPerRunMax: number;
  readonly defaultPerFanOutMax: number;
}

export interface AcquireRequest {
  readonly runId: string;
  readonly fanOutScope?: string;
}

export interface PoolMetrics {
  readonly globalUsed: number;
  readonly globalMax: number;
  readonly runUsed: number;
  readonly runMax: number;
  readonly queueLength: number;
}

interface Waiter {
  readonly runId: string;
  readonly fanOutScope?: string;
  readonly resolve: (release: ReleaseFn) => void;
  readonly reject: (err: Error) => void;
  cancelled: boolean;
}

interface RunSlot {
  used: number;
  max: number;
}

export class SubagentPool {
  private globalTokens: number;
  private readonly perRun = new Map<string, RunSlot>();
  private readonly perFanOut = new Map<string, RunSlot>();
  private waiters: Waiter[] = [];

  constructor(private readonly deps: PoolDeps) {
    this.globalTokens = deps.globalMax;
  }

  /**
   * Acquire one slot from every relevant layer (global, per-run, optional
   * per-fanOut). Never rejects unless the run is cancelled via
   * `cancelRun`. Resolves with a release function that returns all three
   * tokens.
   */
  acquire(req: AcquireRequest): Promise<ReleaseFn> {
    // Auto-register a per-run slot if absent — the default cap covers the
    // common case where the engine has not customised the budget.
    if (!this.perRun.has(req.runId)) {
      this.perRun.set(req.runId, { used: 0, max: this.deps.defaultPerRunMax });
    }
    return new Promise<ReleaseFn>((resolve, reject) => {
      const waiter: Waiter = {
        runId: req.runId,
        fanOutScope: req.fanOutScope,
        resolve,
        reject,
        cancelled: false,
      };
      this.waiters.push(waiter);
      this.drain();
    });
  }

  setRunBudget(runId: string, max: number): void {
    const existing = this.perRun.get(runId);
    if (existing) existing.max = max;
    else this.perRun.set(runId, { used: 0, max });
    this.drain();
  }

  openScope(scope: string, max: number): void {
    if (!this.perFanOut.has(scope)) {
      this.perFanOut.set(scope, { used: 0, max });
    }
    this.drain();
  }

  closeScope(scope: string): void {
    this.perFanOut.delete(scope);
    // No drain needed — closing a scope can only loosen constraints for
    // waiters not bound to it, who are already eligible.
    this.drain();
  }

  /**
   * Fail every pending waiter belonging to `runId`. Already-acquired
   * tokens are released naturally as their unit's `ctx.run` body
   * short-circuits via the run's `AbortSignal`.
   */
  cancelRun(runId: string): void {
    const remaining: Waiter[] = [];
    for (const w of this.waiters) {
      if (w.runId === runId) {
        w.cancelled = true;
        w.reject(new Error(`Workflow run ${runId} cancelled`));
      } else {
        remaining.push(w);
      }
    }
    this.waiters = remaining;
    this.perRun.delete(runId);
    // FanOut scopes are run-scoped — strip any that belonged to the run.
    for (const scope of Array.from(this.perFanOut.keys())) {
      if (scope.startsWith(`${runId}:`)) this.perFanOut.delete(scope);
    }
  }

  /** Forget a per-run budget after the run terminates. */
  releaseRun(runId: string): void {
    this.perRun.delete(runId);
    for (const scope of Array.from(this.perFanOut.keys())) {
      if (scope.startsWith(`${runId}:`)) this.perFanOut.delete(scope);
    }
  }

  metrics(runId: string): PoolMetrics {
    const run = this.perRun.get(runId);
    return {
      globalUsed: this.deps.globalMax - this.globalTokens,
      globalMax: this.deps.globalMax,
      runUsed: run?.used ?? 0,
      runMax: run?.max ?? this.deps.defaultPerRunMax,
      queueLength: this.waiters.filter((w) => w.runId === runId).length,
    };
  }

  /**
   * FIFO drain — at each step, scan from the head and admit the first
   * eligible waiter. Loop continues until no progress can be made.
   */
  private drain(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i];
        if (w.cancelled) continue;
        const run = this.perRun.get(w.runId);
        if (!run) continue;
        const fan = w.fanOutScope ? this.perFanOut.get(w.fanOutScope) : undefined;
        const globalOk = this.globalTokens > 0;
        const runOk = run.used < run.max;
        const fanOk = !fan || fan.used < fan.max;
        if (!(globalOk && runOk && fanOk)) continue;
        // Admit
        this.waiters.splice(i, 1);
        this.globalTokens--;
        run.used++;
        if (fan) fan.used++;
        let released = false;
        const release: ReleaseFn = () => {
          if (released) return;
          released = true;
          this.globalTokens++;
          // Per-run / per-fan-out slots may have been cleared by cancelRun
          // — guard the decrements.
          const r2 = this.perRun.get(w.runId);
          if (r2 && r2.used > 0) r2.used--;
          if (w.fanOutScope) {
            const f2 = this.perFanOut.get(w.fanOutScope);
            if (f2 && f2.used > 0) f2.used--;
          }
          this.drain();
        };
        w.resolve(release);
        progressed = true;
        break; // Re-scan from the head; the global counter changed.
      }
    }
    if (this.waiters.length > 0 && log) {
      // Cheap visibility for stuck pools; no-op when queue drains promptly.
      // (Kept at debug level so existing tests stay quiet.)
    }
  }
}
