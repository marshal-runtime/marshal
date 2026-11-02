// electron/workflows/fan-out.ts
//
// `ctx.fanOut(items, fn, opts)` implementation. Built as a free function
// taking the engine as `this`-equivalent so it can use the engine's
// private state without re-exposing it on the public type.
//
// Key behaviours:
//  * Per-unit step keys: each unit's body executes inside `runStep("[itemKey]", …)`
//    so memo replay distinguishes units.
//  * Drift detection on replay: the original `fanOut.started` event
//    records `itemKeys[]`; if a replay produces a different sequence the
//    engine throws `FanOutItemDriftError`. (V1 simplification: we read
//    the previous itemKeys from memo cache populated at engine boot; if
//    no prior event exists, no drift check fires.)
//  * Failure policy: `"abort" | "continue" | { failFraction } | { failCount }`
//    per r1-fixes. Default is `"abort"`.

import { FanOutItemDriftError } from "@marshal/workflow-sdk";
import type { FanOutOptions, FanOutResult, UnitFailurePolicy } from "@marshal/workflow-sdk";

import { serializeError } from "../../common/workflows-contract";
import { sanitizeArtifactSegment } from "./sanitize-key";
import type { WorkflowEngine } from "./workflow-engine";

/** Pull-out the public engine surface our module uses to keep the import
 *  graph small. */
interface EngineHandle {
  readonly runId: string;
  runStep<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /** Run a single fanOut unit with a deterministic, sibling step key + the
   *  unit's fanOut item established in a fresh async context. */
  runFanOutUnit<T>(
    fanOutStepKey: string,
    itemKey: string,
    idx: number,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T>;
  currentStepKey(): string | undefined;
  openFanOutScope(scope: string, max: number): void;
  closeFanOutScope(scope: string): void;
  setFanOutScope(scope: string | undefined): void;
  emitEvent(partial: Parameters<WorkflowEngine["emitEvent"]>[0]): Promise<void>;
  /** Optional drift snapshot: prior fanOut.started.itemKeys keyed by stepKey. */
  getPriorFanOutItemKeys?(stepKey: string): ReadonlyArray<string> | undefined;
}

const DEFAULT_MAX_CONCURRENCY = 8;

/**
 * Normalise both the canonical `r1-fixes` shape and the legacy
 * `{ kind }` shape from the foundations shell. Returns a tagged object
 * the runtime switch can pattern-match against.
 */
type NormalisedPolicy =
  | { tag: "abort" }
  | { tag: "continue" }
  | { tag: "failFraction"; value: number }
  | { tag: "failCount"; value: number };

function normalisePolicy(policy: UnitFailurePolicy): NormalisedPolicy {
  if (policy === "abort") return { tag: "abort" };
  if (policy === "continue") return { tag: "continue" };
  if ("failFraction" in policy) return { tag: "failFraction", value: policy.failFraction };
  if ("failCount" in policy) return { tag: "failCount", value: policy.failCount };
  // Legacy { kind: ... } shape from the foundations shell — kept for the
  // bundled workflow-author skill's worked examples. Equivalent mapping
  // per r1-fixes "fanOut failure policy naming" decision.
  if (policy.kind === "fail-fast") return { tag: "abort" };
  if (policy.kind === "continue") return { tag: "continue" };
  return { tag: "failCount", value: policy.maxFailures };
}

export async function runFanOut<TItem, TOut>(
  engine: EngineHandle,
  items: readonly TItem[],
  fn: (item: TItem, idx: number) => Promise<TOut>,
  opts: FanOutOptions<TItem, TOut> = {},
): Promise<FanOutResult<TOut>> {
  const max = Math.max(1, opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  const keyFor = opts.keyFor ?? ((_item: TItem, idx: number): string => `unit-${idx}`);
  const policy = normalisePolicy(opts.onUnitFailure ?? "abort");

  const itemKeys = items.map((item, idx) =>
    sanitizeArtifactSegment(keyFor(item, idx), `unit-${idx}`),
  );

  // Wrap the whole fanOut in a parent step so memo distinguishes it from
  // sibling control flow.
  const fanOutStepLabel = "__fanOut";
  return engine.runStep(fanOutStepLabel, async () => {
    const fanOutStepKey = engine.currentStepKey() ?? "";
    // Drift detection — refuse to proceed if a prior run recorded a
    // different item set at this same step key.
    const prior = engine.getPriorFanOutItemKeys?.(fanOutStepKey);
    if (prior && (prior.length !== itemKeys.length || prior.some((k, i) => k !== itemKeys[i]))) {
      throw new FanOutItemDriftError(fanOutStepKey, prior, itemKeys);
    }
    const scope = `${engine.runId}:${fanOutStepKey}`;
    engine.openFanOutScope(scope, max);
    engine.setFanOutScope(scope);

    await engine.emitEvent({
      type: "fanOut.started",
      payload: { stepKey: fanOutStepKey, count: items.length, itemKeys, maxConcurrency: max },
    });

    const results: Array<TOut | { ok: true; value: TOut } | { ok: false; error: Error }> =
      new Array(items.length);
    let failedCount = 0;
    let aborted = false;
    const aborter = new AbortController();

    // Mini p-limit: a worker pool that pulls from a queue of pending indices.
    const queue = items.map((_item, idx) => idx);
    const inFlight: Promise<void>[] = [];

    const runOne = async (idx: number): Promise<void> => {
      if (aborter.signal.aborted) return;
      const item = items[idx];
      const itemKey = itemKeys[idx];
      const unitLabel = `[${itemKey}]`;
      try {
        // Deterministic sibling step key + the unit's fanOut item are set in a
        // fresh async context by `runFanOutUnit`, so parallel units never read
        // each other's step key (the bug that nested every unit's key inside
        // the previous one and mis-attributed spawned agents).
        const value = await engine.runFanOutUnit<TOut>(fanOutStepKey, itemKey, idx, unitLabel, () =>
          fn(item, idx),
        );
        if (policy.tag === "continue") {
          results[idx] = { ok: true as const, value };
        } else {
          results[idx] = value;
        }
        await engine.emitEvent({
          type: "fanOut.unit-completed",
          payload: { stepKey: fanOutStepKey, itemKey },
        });
      } catch (err) {
        failedCount++;
        const error = err instanceof Error ? err : new Error(String(err));
        await engine.emitEvent({
          type: "fanOut.unit-failed",
          payload: { stepKey: fanOutStepKey, itemKey, error: serializeError(error) },
        });
        switch (policy.tag) {
          case "continue":
            results[idx] = { ok: false as const, error };
            break;
          case "abort":
            aborter.abort();
            aborted = true;
            throw error;
          case "failCount":
            if (failedCount >= policy.value) {
              aborter.abort();
              aborted = true;
              throw error;
            }
            break;
          case "failFraction":
            if (failedCount / items.length >= policy.value) {
              aborter.abort();
              aborted = true;
              throw error;
            }
            break;
        }
      }
    };

    const pump = async (): Promise<void> => {
      while (queue.length > 0) {
        if (aborter.signal.aborted) return;
        const idx = queue.shift();
        if (idx === undefined) return;
        // eslint-disable-next-line no-await-in-loop -- worker pulls items sequentially; bounded by `max` concurrent pumps
        await runOne(idx);
      }
    };

    for (let i = 0; i < Math.min(max, items.length); i++) {
      inFlight.push(pump());
    }
    const settled = await Promise.allSettled(inFlight);

    engine.setFanOutScope(undefined);
    engine.closeFanOutScope(scope);

    const successCount = results.filter((r) => {
      if (policy.tag === "continue") {
        if (r && typeof r === "object" && "ok" in r) {
          return r.ok;
        }
        return false;
      }
      return r !== undefined;
    }).length;
    await engine.emitEvent({
      type: "fanOut.completed",
      payload: { stepKey: fanOutStepKey, successCount, failCount: failedCount, aborted },
    });

    // For "abort" policies, propagate the first rejection so the workflow's
    // try/catch sees it.
    if (aborted && policy.tag === "abort") {
      const firstRejected = settled.find((s) => s.status === "rejected");
      if (firstRejected) throw firstRejected.reason;
    }
    return results;
  });
}
