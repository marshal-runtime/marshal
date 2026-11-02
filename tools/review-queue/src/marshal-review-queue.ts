import type { AgentRuntime, DashboardPr, PrRow, State } from "./marshal-review-types.ts";

export type SpawnRequest = {
  prNumber: number;
  sha: string;
  runtime: AgentRuntime;
  cwd: string;
  /** Set when the row was marked with `keepContextNextIteration` and its prior
   *  iteration has a sessionId. The orchestrator passes this to the slot,
   *  which uses ACP `session/load` instead of `session/new`. One-shot — the
   *  flag is cleared on this same tick. */
  resumeSessionId?: string;
};

export type CancelRequest = {
  prNumber: number;
  sessionId: string;
  childPid: number;
};

export type TickResult = {
  nextState: State;
  toSpawn: SpawnRequest[];
  toCancel: CancelRequest[];
  /** Row keys that are candidates for reaping — they're in terminal state and
   *  haven't been refreshed in `config.reviewRetentionHours`. The orchestrator
   *  must verify each via `gh pr view` before actually deleting, since absence
   *  from the dashboard alone can also mean "failing CI" or "outside the
   *  lookback window," not just "merged." */
  reapCandidates: number[];
};

const DEFAULT_REPO_NAME = "default";

// `pending-confirmation` is included because once the PR ships upstream
// (MERGED / CLOSED), nothing the user does locally — confirm, dismiss,
// post-and-confirm — affects that fact. The orchestrator's `verifyAndReap`
// still gates actual deletion on `gh pr view` returning MERGED or CLOSED, so
// reviews of still-OPEN PRs the user hasn't confirmed yet are safe; they hit
// the OPEN branch and get their `lastSeenAt` bumped instead of reaped.
const REAPABLE_STATUSES: ReadonlySet<PrRow["status"]> = new Set([
  "confirmed",
  "dismissed",
  "failed",
  "crashed",
  "pending-confirmation",
]);

export function tick(prev: State, dashboardPrs: DashboardPr[], nowMs: number): TickResult {
  const next = structuredClone(prev);
  const toCancel: CancelRequest[] = [];
  const cooldownMs = next.config.cooldownMinutes * 60_000;
  const nowIso = new Date(nowMs).toISOString();
  const repoCwd =
    next.config.repos[DEFAULT_REPO_NAME]?.cwd ??
    Object.values(next.config.repos)[0]?.cwd ??
    process.cwd();

  for (const pr of dashboardPrs) {
    // Skip PRs without a head_sha — we cannot detect staleness or skip-already-reviewed without one.
    if (!pr.head_sha) continue;

    let row = next.prs[pr.number];
    if (!row) {
      row = freshRow(pr, pr.head_sha);
      next.prs[pr.number] = row;
    } else {
      row.url = pr.url;
      row.title = pr.title;
      row.author = pr.author ?? row.author;
      if (pr.tier) row.tier = pr.tier;
      row.sizeBucket = pr.size_bucket;
      row.currentHeadSha = pr.head_sha;
    }
    row.lastSeenAt = nowIso;

    if (row.status === "running") {
      const lastIter = row.iterations.at(-1);
      if (lastIter && lastIter.sha !== pr.head_sha) {
        // Force-push detected while review is running — cancel and re-enqueue.
        const runIdx = next.running.findIndex((r) => r.prNumber === pr.number);
        if (runIdx >= 0) {
          const run = next.running[runIdx]!;
          toCancel.push({ prNumber: pr.number, sessionId: run.sessionId, childPid: run.childPid });
          next.running.splice(runIdx, 1);
        }
        lastIter.status = "superseded";
        lastIter.completedAt = new Date(nowMs).toISOString();
        row.status = "queued";
      } else {
        // SHA unchanged — already running, nothing to do.
        continue;
      }
    }

    // Already waiting in queue — will be re-ordered below.
    if (row.status === "queued") continue;

    // Dismissed is a deliberate user decision ("I don't want this reviewed").
    // Stay dismissed across SHA changes, ticks, and dashboard reappearances
    // until the user explicitly runs `marshal-review-queue requeue <pr>`. Without
    // this branch, `dismissed` is a single-tick state — the trailing
    // `row.status = "queued"` further down resets it on the next tick.
    if (row.status === "dismissed") continue;

    // Already reviewed at this SHA — skip.
    if (
      (row.status === "pending-confirmation" || row.status === "confirmed") &&
      row.latestReviewedSha === pr.head_sha
    ) {
      continue;
    }

    // SHA has changed but we're still within the cooldown window.
    const lastIter = row.iterations.at(-1);
    if (lastIter && cooldownMs > 0 && nowMs - new Date(lastIter.startedAt).getTime() < cooldownMs) {
      continue;
    }

    // Eligible — mark queued.
    row.status = "queued";
  }

  // Rebuild queue from dashboard order, preserving only `queued` rows.
  const dashboardOrder = dashboardPrs.filter((p) => p.head_sha).map((p) => p.number);
  const queued = new Set<number>();
  for (const [k, row] of Object.entries(next.prs)) {
    if (row.status === "queued") queued.add(Number(k));
  }
  const newQueue: number[] = [];
  for (const n of dashboardOrder) {
    if (queued.has(n)) {
      newQueue.push(n);
      queued.delete(n);
    }
  }
  // Append any queued PRs not seen in this dashboard tick (keep them draining).
  for (const n of queued) newQueue.push(n);
  next.queue = newQueue;

  // Fill slots up to maxConcurrent.
  // next.running reflects currently running children; toSpawn tracks new slots
  // consumed this tick (the orchestrator will push to running after spawn).
  const toSpawn: SpawnRequest[] = [];
  let occupiedSlots = next.running.length;
  while (occupiedSlots < next.config.maxConcurrent && next.queue.length > 0) {
    const n = next.queue.shift()!;
    const row = next.prs[n];
    if (!row) continue;
    const runtime: AgentRuntime = row.runtimeOverride ?? next.config.defaultRuntime;
    row.status = "running";
    // keep-context is one-shot: cleared on consumption regardless of whether
    // there's a prior sessionId to attach.
    let resumeSessionId: string | undefined;
    let spawnCwd = repoCwd;
    if (row.keepContextNextIteration) {
      const priorIter = row.iterations.at(-1);
      const priorSessionId = priorIter?.sessionId;
      if (priorSessionId) {
        resumeSessionId = priorSessionId;
        // Resume needs the prior cwd — Claude stores sessions per-encoded-cwd.
        if (priorIter?.cwd) spawnCwd = priorIter.cwd;
      }
      row.keepContextNextIteration = false;
    }
    toSpawn.push({
      prNumber: n,
      sha: row.currentHeadSha,
      runtime,
      cwd: spawnCwd,
      ...(resumeSessionId ? { resumeSessionId } : {}),
    });
    occupiedSlots++;
  }

  // Retention candidates — terminal-state rows whose lastSeenAt is older than
  // retentionMs (or unset on first-tick migration; we stamp them now so the
  // clock starts here, not from epoch). The orchestrator confirms each
  // candidate via `gh pr view` before actually deleting, because dashboard
  // absence has multiple causes (merged, closed, failing CI, hidden by
  // include-mine, outside lookback) — only merged/closed should trigger reap.
  const reapCandidates: number[] = [];
  const retentionHours = next.config.reviewRetentionHours;
  const retentionMs = retentionHours * 3_600_000;
  if (retentionHours > 0) {
    for (const [k, row] of Object.entries(next.prs)) {
      if (!REAPABLE_STATUSES.has(row.status)) continue;
      if (!row.lastSeenAt) {
        row.lastSeenAt = nowIso;
        continue;
      }
      if (nowMs - new Date(row.lastSeenAt).getTime() > retentionMs) {
        reapCandidates.push(Number(k));
      }
    }
  }

  return { nextState: next, toSpawn, toCancel, reapCandidates };
}

function freshRow(pr: DashboardPr, headSha: string): PrRow {
  return {
    url: pr.url,
    title: pr.title,
    author: pr.author ?? "unknown",
    tier: pr.tier ?? "other",
    sizeBucket: pr.size_bucket,
    currentHeadSha: headSha,
    latestReviewedSha: null,
    status: "queued",
    iterations: [],
  };
}
