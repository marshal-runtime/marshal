// WORKAROUND: gateway-mode multi-step orchestration. Each step is scheduled
// as its own one-shot cron because marshal lacks a chained-payload primitive
// today. Replace this whole module with a single agentTurnChain payload once
// marshal supports one.
//
// Spec: docs/specs/gateway-automations-phase-2b-design.md §4

import { createLogger } from "../../../../common/marshal-logger";
import { normalizeHistoryMessages } from "../normalize-event";
import {
  buildTailCronName,
  decodeMultiStepDescription,
  matchesParentTailPattern,
  parseTailCronName,
  substitutePreviousOutput,
  type MultiStepState,
} from "./map";

const log = createLogger("GatewayAutomationOrchestrator");

/**
 * If a desktop comes online and replays a 'finished' cron event for a step
 * whose finishedAt is older than this, the chain is abandoned. Avoids
 * 'step 2 runs Friday for Monday's data' pathology when offline for days.
 *
 * Spec §4.5.
 */
const CATCH_UP_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface OrchestratorRpcClient {
  onEvent: (listener: (eventName: string, payload: Record<string, unknown>) => void) => () => void;
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}

type CronEvent = {
  jobId: string;
  action: string;
  job?: CronJobSnapshot;
  status?: string;
  runAtMs?: number;
  durationMs?: number;
  sessionId?: string;
  sessionKey?: string;
  summary?: string;
  error?: string;
};

type CronJobSnapshot = {
  id: string;
  name: string;
  description?: string;
  sessionKey?: string;
  payload?: Record<string, unknown>;
};

export class GatewayAutomationOrchestrator {
  private client: OrchestratorRpcClient | null = null;
  private unsub: (() => void) | null = null;

  attachClient(client: OrchestratorRpcClient): void {
    if (this.client) {
      // Idempotent re-attach: detach old first
      this.detachClient();
    }
    this.client = client;
    this.unsub = client.onEvent((name, payload) => {
      this.onCronEvent(name, payload);
    });
  }

  detachClient(): void {
    this.unsub?.();
    this.unsub = null;
    this.client = null;
  }

  // Stateless recovery for missed 'finished' events. marshal is source of truth.
  async reconcile(): Promise<void> {
    if (!this.client) return;
    const listResp = await this.client.request("cron.list", {});
    if (!isRecord(listResp)) return;
    const allJobs = listResp.jobs;
    if (!Array.isArray(allJobs)) return;
    await this.reconcileChains(allJobs);
    // GC sweep runs after chain advance so newly-scheduled tails (from this
    // very reconcile pass) aren't accidentally swept because they don't yet
    // have a run-log entry.
    await this.sweepStaleTails(allJobs);
  }

  // Resume any chains that missed a 'finished' event while we were offline.
  private async reconcileChains(allJobs: unknown[]): Promise<void> {
    if (!this.client) return;

    type JobRow = Record<string, unknown>;
    const recordJobs: JobRow[] = [];
    const parsedJobs: CronJobSnapshot[] = [];
    for (const j of allJobs) {
      if (isRecord(j)) {
        recordJobs.push(j);
        const parsed = toCronJobSnapshot(j);
        if (parsed) parsedJobs.push(parsed);
      }
    }

    for (const parent of recordJobs) {
      const parentId = typeof parent.id === "string" ? parent.id : null;
      const parentDesc = typeof parent.description === "string" ? parent.description : "";
      const sentinel = decodeMultiStepDescription(parentDesc);
      if (!sentinel.state || !parentId) continue;

      const tailPattern = matchesParentTailPattern(parentId);
      const tailCrons = recordJobs.filter((j) => {
        const n = j.name;
        return typeof n === "string" && tailPattern.test(n);
      });

      // Group existing tails by runInstanceId (string of runAtMs) → list of {id, stepIndex}
      const tailsByRun = new Map<string, Array<{ id: string; stepIndex: number }>>();
      for (const tc of tailCrons) {
        const name = typeof tc.name === "string" ? tc.name : "";
        const id = typeof tc.id === "string" ? tc.id : "";
        if (!name || !id) continue;
        const parsed = parseTailCronName(name);
        if (!parsed) continue;
        const arr = tailsByRun.get(parsed.runInstanceId) ?? [];
        arr.push({ id, stepIndex: parsed.stepIndex });
        tailsByRun.set(parsed.runInstanceId, arr);
      }

      // eslint-disable-next-line no-await-in-loop -- sequential cron.runs; marshal isn't guaranteed parallel-safe
      const parentRunsResp = await this.client.request("cron.runs", {
        id: parentId,
        sortDir: "asc",
      });
      const parentRuns: Array<{ runAtMs: number; durationMs: number }> = [];
      if (isRecord(parentRunsResp) && Array.isArray(parentRunsResp.entries)) {
        for (const entry of parentRunsResp.entries) {
          if (!isRecord(entry)) continue;
          const runAtMs = numberOf(entry.runAtMs ?? entry.ts);
          if (runAtMs === null) continue;
          const durationMs = numberOf(entry.durationMs) ?? 0;
          parentRuns.push({ runAtMs, durationMs });
        }
      }

      // Each parent run is one chain instance keyed by its runAtMs.
      // We also process orphan runInstanceIds with tails but no parent run-log
      // (e.g. parent's run-log was rotated out) — they still might need s_{k+1}.
      const allRunInstances = new Set<string>();
      for (const r of parentRuns) allRunInstances.add(String(r.runAtMs));
      for (const k of tailsByRun.keys()) allRunInstances.add(k);

      for (const runInstanceId of allRunInstances) {
        const tails = tailsByRun.get(runInstanceId) ?? [];
        // Highest stepIndex already scheduled (existence in cron.list = scheduled,
        // even if not yet fired). 0 if no tails exist.
        const maxScheduledStep =
          tails.length === 0 ? 0 : Math.max(...tails.map((t) => t.stepIndex));
        const nextStepIndex = maxScheduledStep + 1;
        if (nextStepIndex >= sentinel.state.stepCount) continue; // chain done

        // Determine finishedAt for the latest *completed* step in this chain.
        // For step 0 (parent): parent's run-log entry for this runInstance.
        // For step k>0: tail s_k's run-log first entry. We require run-log
        // entries to exist (= the step actually fired) before scheduling next.
        //
        // Track the actual run timing (start + duration) of the completed
        // step so we can hand it to scheduleNextStep / fetchPreviousOutput.
        // Synthesizing (runAtMs: finishedAtMs, durationMs: 0) would push the
        // assistant-message search window to [finishedAtMs, finishedAtMs+5s],
        // which misses real assistant messages that are timestamped DURING
        // the run (ts < finishedAtMs).
        let finishedAtMs = 0;
        let completedRunAtMs = 0;
        let completedDurationMs = 0;
        if (maxScheduledStep === 0) {
          const pr = parentRuns.find((r) => String(r.runAtMs) === runInstanceId);
          if (!pr) continue; // no parent run → can't tell when step 1 finished
          completedRunAtMs = pr.runAtMs;
          completedDurationMs = pr.durationMs;
          finishedAtMs = pr.runAtMs + pr.durationMs;
        } else {
          const latestTail = tails.find((t) => t.stepIndex === maxScheduledStep);
          if (!latestTail) continue;
          // eslint-disable-next-line no-await-in-loop -- sequential cron.runs; marshal isn't guaranteed parallel-safe
          const tailRunsResp = await this.client.request("cron.runs", {
            id: latestTail.id,
            sortDir: "asc",
          });
          if (!isRecord(tailRunsResp) || !Array.isArray(tailRunsResp.entries)) continue;
          if (tailRunsResp.entries.length === 0) continue; // not yet fired
          const first = tailRunsResp.entries[0];
          if (!isRecord(first)) continue;
          const runAt = numberOf(first.runAtMs ?? first.ts);
          if (runAt === null) continue;
          const dur = numberOf(first.durationMs) ?? 0;
          completedRunAtMs = runAt;
          completedDurationMs = dur;
          finishedAtMs = runAt + dur;
        }

        if (finishedAtMs <= 0) continue;
        if (Date.now() - finishedAtMs > CATCH_UP_TTL_MS) {
          log.info(`reconcile skips stale chain parent=${parentId} runInstance=${runInstanceId}`);
          continue;
        }

        const sessionKey = `session:auto-${parentId}`;
        const parentName = typeof parent.name === "string" ? parent.name : parentId;
        // eslint-disable-next-line no-await-in-loop -- sequential cron.add; marshal isn't guaranteed parallel-safe
        await this.scheduleNextStep({
          parentId,
          parentName,
          runInstanceId,
          completedStepIndex: maxScheduledStep,
          evt: {
            jobId: parentId,
            action: "finished",
            status: "ok",
            runAtMs: completedRunAtMs,
            durationMs: completedDurationMs,
            sessionKey,
          },
          plan: sentinel.state,
          cachedJobs: parsedJobs,
        });
      }
    }
  }

  /**
   * GC sweep for tail crons whose chain has fully completed and aged past the
   * catch-up TTL. Tails are scheduled with deleteAfterRun: false (intentional —
   * a disabled stub remains in cron.list so a second device reconnecting within
   * the TTL doesn't re-add already-completed steps; spec §4.5). Without a sweep
   * they accumulate forever.
   *
   * Eligibility per tail:
   *   - run-log first entry exists (= the step actually fired) AND
   *   - status === "ok" (errored chains are kept for human inspection) AND
   *   - finishedAt = runAtMs + durationMs is older than CATCH_UP_TTL_MS AND
   *   - no tail in the same runInstanceId is still "active" (run-log empty,
   *     i.e. not yet fired, OR finishedAt within TTL).
   *
   * The runInstanceId guard preserves the "active chain stays scheduled"
   * invariant: as long as one step in a chain is still running or recently
   * completed, the orchestrator may need to advance it again, so we don't
   * prune the chain's earlier tails out from under that decision.
   */
  private async sweepStaleTails(allJobs: unknown[]): Promise<void> {
    if (!this.client) return;

    type TailRow = { id: string; name: string; runInstanceId: string };
    const tailRows: TailRow[] = [];
    for (const j of allJobs) {
      if (!isRecord(j)) continue;
      const id = typeof j.id === "string" ? j.id : null;
      const name = typeof j.name === "string" ? j.name : null;
      if (!id || !name) continue;
      const parsed = parseTailCronName(name);
      if (!parsed) continue;
      tailRows.push({ id, name, runInstanceId: parsed.runInstanceId });
    }
    if (tailRows.length === 0) return;

    // Fetch run-logs for every tail (sequential — marshal isn't guaranteed
    // parallel-safe, see surrounding cron.runs comments). Cost: O(tails); the
    // sweep runs once per reconcile, not per chain advance, so this is bounded.
    type TailWithLog = TailRow & {
      finishedAtMs: number | null; // null = no run-log entry yet (not fired)
      status: "ok" | "error" | "skipped" | null;
    };
    const tailsWithLog: TailWithLog[] = [];
    for (const row of tailRows) {
      // eslint-disable-next-line no-await-in-loop -- sequential cron.runs; marshal isn't guaranteed parallel-safe
      const resp = await this.client.request("cron.runs", { id: row.id, sortDir: "asc" });
      if (!isRecord(resp) || !Array.isArray(resp.entries) || resp.entries.length === 0) {
        tailsWithLog.push({ ...row, finishedAtMs: null, status: null });
        continue;
      }
      const first = resp.entries[0];
      if (!isRecord(first)) {
        tailsWithLog.push({ ...row, finishedAtMs: null, status: null });
        continue;
      }
      const runAt = numberOf(first.runAtMs ?? first.ts);
      const dur = numberOf(first.durationMs) ?? 0;
      const status =
        first.status === "ok" || first.status === "error" || first.status === "skipped"
          ? first.status
          : null;
      tailsWithLog.push({
        ...row,
        finishedAtMs: runAt === null ? null : runAt + dur,
        status,
      });
    }

    // Mark a runInstanceId "active" if ANY of its tails is unfired or finished
    // within the TTL. We don't prune tails from active chains.
    const now = Date.now();
    const activeRunInstances = new Set<string>();
    for (const t of tailsWithLog) {
      if (t.finishedAtMs === null) {
        activeRunInstances.add(t.runInstanceId);
        continue;
      }
      if (now - t.finishedAtMs <= CATCH_UP_TTL_MS) {
        activeRunInstances.add(t.runInstanceId);
      }
    }

    for (const t of tailsWithLog) {
      if (activeRunInstances.has(t.runInstanceId)) continue;
      if (t.finishedAtMs === null) continue;
      if (t.status !== "ok") continue; // keep errored/skipped chains for inspection
      if (now - t.finishedAtMs <= CATCH_UP_TTL_MS) continue;
      // eslint-disable-next-line no-await-in-loop -- sequential cron.remove; marshal isn't guaranteed parallel-safe
      await this.client.request("cron.remove", { id: t.id }).catch((err) => {
        // Best-effort: a transient remove failure shouldn't abort the whole sweep
        log.warn(`sweepStaleTails: cron.remove failed for tail=${t.id}`, err);
      });
    }
  }

  private onCronEvent(name: string, payload: Record<string, unknown>): void {
    if (name !== "cron") return;
    if (!isCronEvent(payload)) return;
    if (payload.action !== "finished") return;
    void this.advanceChain(payload).catch((err) => {
      log.warn("advanceChain failed", err);
    });
  }

  private async advanceChain(evt: CronEvent): Promise<void> {
    if (!this.client) return;
    if (evt.status === "error") {
      log.info(`chain short-circuit on error for jobId=${evt.jobId}`);
      return;
    }
    if (this.isStale(evt)) {
      log.info(`catch-up-window-elapsed for jobId=${evt.jobId} (>${CATCH_UP_TTL_MS}ms old)`);
      return;
    }
    // Prefer evt.job when the server attaches it; fall back to cron.list.
    // Fast-path leaves cachedJobs undefined so scheduleNextStep's dedup
    // pre-flight fetches a fresh view (load-bearing for multi-device safety).
    const { job: cronJob, jobs: cachedJobs } = evt.job
      ? { job: evt.job, jobs: undefined as CronJobSnapshot[] | undefined }
      : await this.fetchJob(evt.jobId);
    if (!cronJob) return;

    const tailParse = parseTailCronName(cronJob.name);
    const sentinel = decodeMultiStepDescription(cronJob.description ?? "");

    if (sentinel.state) {
      await this.scheduleNextStep({
        parentId: cronJob.id,
        parentName: cronJob.name,
        runInstanceId: String(evt.runAtMs ?? Date.now()),
        completedStepIndex: 0,
        evt,
        plan: sentinel.state,
        cachedJobs,
      });
      return;
    }

    if (tailParse) {
      const { job: parent, jobs: parentCachedJobs } = await this.fetchJob(tailParse.parentId);
      if (!parent) return;
      const parentSentinel = decodeMultiStepDescription(parent.description ?? "");
      if (!parentSentinel.state) return;
      await this.scheduleNextStep({
        parentId: tailParse.parentId,
        parentName: parent.name,
        runInstanceId: tailParse.runInstanceId,
        completedStepIndex: tailParse.stepIndex,
        evt,
        plan: parentSentinel.state,
        cachedJobs: parentCachedJobs,
      });
    }
  }

  /**
   * Schedule the next step of a multi-step chain.
   *
   * Index convention (`completedStepIndex`):
   *   0 — parent (step 1) just finished; we're scheduling the first tail (step 2).
   *   k — tail at user-chain step k+1 just finished; we're scheduling step k+2.
   *
   * The user-facing chain has `plan.stepCount` total steps. The deterministic
   * tail-cron name uses the user-chain step index (1-indexed):
   *   `auto-<parentId>-r<runInstance>-s1` is the first tail (= step 2).
   *
   * `plan.steps[]` is the sentinel-encoded array of steps[1..N-1] (zero-indexed
   * within the array). To find the prompt for the next step, with
   * nextStepIndex = completedStepIndex + 1 in the user chain, we read
   * `plan.steps[nextStepIndex - 1]`.
   */
  private async scheduleNextStep(args: {
    parentId: string;
    parentName: string;
    runInstanceId: string;
    completedStepIndex: number;
    evt: CronEvent;
    plan: MultiStepState;
    cachedJobs?: CronJobSnapshot[];
  }): Promise<void> {
    const nextStepIndex = args.completedStepIndex + 1;
    if (nextStepIndex >= args.plan.stepCount) return; // chain done

    const previousOutput = await this.fetchPreviousOutput(args.evt);
    if (previousOutput === null) {
      log.warn(
        `empty/missing previousOutput for parent=${args.parentId} step=${args.completedStepIndex}`,
      );
      return; // failure short-circuit; Task 12 expands this
    }

    const tailStep = args.plan.steps[nextStepIndex - 1];
    if (!tailStep) return;

    const message = substitutePreviousOutput(tailStep.prompt, previousOutput);
    const name = buildTailCronName(args.parentId, args.runInstanceId, nextStepIndex);

    if (!this.client) return;

    // Pre-flight idempotency by deterministic name; race-survivor dedup keeps
    // the earliest id (lex-sorted) and removes the rest. Reuses cachedJobs
    // when provided to avoid a redundant cron.list per advance.
    const existingByName = await this.findCronsByName(name, args.cachedJobs);
    if (existingByName.length > 0) {
      if (existingByName.length > 1) {
        const sorted = [...existingByName].sort((a, b) => a.id.localeCompare(b.id));
        for (const dup of sorted.slice(1)) {
          // eslint-disable-next-line no-await-in-loop -- sequential cron.remove; marshal isn't guaranteed parallel-safe
          await this.client.request("cron.remove", { id: dup.id }).catch(() => {
            // best-effort: log silently — duplicate cleanup is opportunistic
          });
        }
      }
      return;
    }

    await this.client.request("cron.add", {
      name,
      description: `[step ${nextStepIndex + 1}/${args.plan.stepCount} of '${args.parentName}']`,
      enabled: true,
      // Multi-device safety: keep the disabled stub post-run so a second
      // desktop reconnecting within the catch-up TTL sees the tail in
      // cron.list and skips re-adding it. Spec §4.5.
      deleteAfterRun: false,
      schedule: { kind: "at", runAtMs: Date.now() + 100 },
      sessionTarget: `session:auto-${args.parentId}`,
      wakeMode: "now",
      payload: { kind: "agentTurn", message },
      delivery: { mode: "none" },
    });
  }

  private isStale(evt: CronEvent): boolean {
    const finishedAtMs = (evt.runAtMs ?? 0) + (evt.durationMs ?? 0);
    if (finishedAtMs <= 0) return false;
    return Date.now() - finishedAtMs > CATCH_UP_TTL_MS;
  }

  /**
   * Find crons matching `name`. `cachedJobs === undefined` triggers a fresh
   * `cron.list` fetch; an array (including `[]`) is trusted as the
   * authoritative view of the server.
   */
  private async findCronsByName(
    name: string,
    cachedJobs: CronJobSnapshot[] | undefined,
  ): Promise<Array<{ id: string; name: string }>> {
    if (cachedJobs === undefined) {
      if (!this.client) return [];
      const resp = await this.client.request("cron.list", {});
      if (!isRecord(resp)) return [];
      const jobs = resp.jobs;
      if (!Array.isArray(jobs)) return [];
      const matches: Array<{ id: string; name: string }> = [];
      for (const j of jobs) {
        if (!isRecord(j)) continue;
        if (typeof j.id !== "string" || typeof j.name !== "string") continue;
        if (j.name === name) matches.push({ id: j.id, name: j.name });
      }
      return matches;
    }

    const matches: Array<{ id: string; name: string }> = [];
    for (const j of cachedJobs) {
      if (j.name === name) matches.push({ id: j.id, name: j.name });
    }
    return matches;
  }

  private async fetchJob(
    jobId: string,
  ): Promise<{ job: CronJobSnapshot | null; jobs: CronJobSnapshot[] }> {
    if (!this.client) {
      return { job: null, jobs: [] };
    }
    const result = await this.client.request("cron.list", {});
    if (!isRecord(result)) {
      return { job: null, jobs: [] };
    }
    const jobs = result.jobs;
    if (!Array.isArray(jobs)) {
      return { job: null, jobs: [] };
    }
    const parsedJobs: CronJobSnapshot[] = [];
    let foundJob: CronJobSnapshot | null = null;
    for (const j of jobs) {
      if (!isRecord(j)) continue;
      const parsed = toCronJobSnapshot(j);
      if (parsed) {
        parsedJobs.push(parsed);
        if (j.id === jobId) {
          foundJob = parsed;
        }
      }
    }
    return { job: foundJob, jobs: parsedJobs };
  }

  private async fetchPreviousOutput(evt: CronEvent): Promise<string | null> {
    if (!this.client) return null;
    if (!evt.sessionKey) return null;
    let resp: unknown;
    try {
      resp = await this.client.request("chat.history", {
        sessionKey: evt.sessionKey,
        limit: 200,
      });
    } catch (err) {
      log.warn("chat.history failed", err);
      return null;
    }
    if (!isRecord(resp)) return null;
    const rawMessages = resp.messages;
    if (!Array.isArray(rawMessages)) return null;

    // Route through the same normalization pipeline as gateway-backend.getHistory.
    // Two reasons: (1) marshal's chat.history returns assistant `content` as
    // Array<{type:"text", text:"..."}> blocks — reading it as a string yields
    // empty; (2) cron-fired turns carry marshal plumbing in the text (leading
    // [cron:<id> <name>] header, trailing "Current time:" suffix) that should
    // not leak into substituted {{previousOutput}}. normalizeHistoryMessages
    // handles both: flattens text blocks and strips the cron headers/suffixes.
    const recordMessages = rawMessages.filter(isRecord);
    const messages = normalizeHistoryMessages(recordMessages);

    const runAtMs = evt.runAtMs ?? 0;
    const durationMs = evt.durationMs ?? 0;
    const slack = 5000;
    const start = runAtMs;
    const end = runAtMs + durationMs + slack;

    const tsOf = (m: { timestamp: string }): number => {
      const ts = m.timestamp;
      if (!ts) return 0;
      // normalizeHistoryMessages stringifies numeric timestamps verbatim
      // (e.g. "1714435200000"). Parse as number first; fall back to Date.
      const asNum = Number(ts);
      if (Number.isFinite(asNum) && asNum > 0) return asNum;
      const asDate = new Date(ts).getTime();
      return Number.isFinite(asDate) ? asDate : 0;
    };

    const assistantMsgs = messages.filter((m) => m.role === "assistant");

    const inWindow = assistantMsgs.filter((m) => {
      const t = tsOf(m);
      return t >= start && t <= end;
    });

    let chosen: { content: string } | null = null;
    if (inWindow.length > 0) {
      chosen = inWindow[inWindow.length - 1];
    } else {
      // Fallback: latest assistant message strictly inside
      // [runAtMs, runAtMs + CATCH_UP_TTL_MS] — capped to avoid picking up a
      // much later user-initiated message in a shared session. Matches the
      // existing chain-abandonment policy (chains older than the TTL are
      // not resumed), so a message authored after the TTL is logically not
      // part of this run.
      const fallbackEnd = runAtMs + CATCH_UP_TTL_MS;
      const fallbacks = assistantMsgs.filter((m) => {
        const t = tsOf(m);
        return t >= start && t <= fallbackEnd;
      });
      if (fallbacks.length > 0) chosen = fallbacks[fallbacks.length - 1];
    }

    if (!chosen) return null;
    const text = chosen.content;
    if (text.trim() === "") return null;
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isCronEvent(value: unknown): value is CronEvent {
  if (!isRecord(value)) return false;
  return typeof value.jobId === "string" && typeof value.action === "string";
}

function toCronJobSnapshot(j: Record<string, unknown>): CronJobSnapshot | null {
  if (typeof j.id !== "string" || typeof j.name !== "string") return null;
  return {
    id: j.id,
    name: j.name,
    description: typeof j.description === "string" ? j.description : undefined,
    sessionKey: typeof j.sessionKey === "string" ? j.sessionKey : undefined,
    payload: isRecord(j.payload) ? j.payload : undefined,
  };
}
