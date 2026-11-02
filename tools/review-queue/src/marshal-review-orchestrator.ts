import fs from "node:fs/promises";

import { isToolUseAllowed } from "../../marshal-acp/src/permission-policy.ts";
import type { SpawnConfig } from "../../marshal-acp/src/runtimes/index.ts";
import { spawnConfigFor as defaultSpawnConfigFor } from "../../marshal-acp/src/runtimes/index.ts";
import { runSlot } from "../../marshal-acp/src/slot.ts";
import { dashboardPrsInPriorityOrder } from "./marshal-review-dashboard.ts";
import { fetchPrStatus as defaultFetchPrStatus, parseRepoSlug, type FetchPrStatus } from "./marshal-review-github.ts";
import { reviewFilePath } from "./marshal-review-paths.ts";
import { tick, type SpawnRequest } from "./marshal-review-queue.ts";
import { renderInitial, appendIteration } from "./marshal-review-renderer.ts";
import type { StateStore } from "./marshal-review-state-store.ts";
import type { AgentRuntime, Iteration, State } from "./marshal-review-types.ts";
import type { DashboardOutput } from "./marshal-review-types.ts";

export type RunDashboard = () => Promise<DashboardOutput>;

export type OrchestratorOpts = {
  store: StateStore;
  runDashboard: RunDashboard;
  spawnConfigFor?: (runtime: AgentRuntime, opts: { cwd: string }) => SpawnConfig;
  /** Injected so the retention sweep can be unit-tested without shelling to gh. */
  fetchPrStatus?: FetchPrStatus;
};

export class Orchestrator {
  private store: StateStore;
  private runDashboard: RunDashboard;
  private spawnConfigFor: (runtime: AgentRuntime, opts: { cwd: string }) => SpawnConfig;
  private fetchPrStatus: FetchPrStatus;
  private active = new Map<number, { abort: AbortController; finished: Promise<void> }>();
  private tickRunning = false;

  constructor(opts: OrchestratorOpts) {
    this.store = opts.store;
    this.runDashboard = opts.runDashboard;
    this.spawnConfigFor = opts.spawnConfigFor ?? defaultSpawnConfigFor;
    this.fetchPrStatus = opts.fetchPrStatus ?? defaultFetchPrStatus;
  }

  /** Returns true if this call actually ran a tick, false if another tick was
   *  already in flight and this one was a no-op. Callers (HTTP /tick) can use
   *  the boolean to decide whether to retry — though the auto-refill chain
   *  almost always picks up the dashboard state on the next slot completion. */
  async tick(): Promise<boolean> {
    if (this.tickRunning) return false;
    this.tickRunning = true;
    try {
      const dashOut = await this.runDashboard();
      const dashPrs = dashboardPrsInPriorityOrder(dashOut);

      let toSpawn: SpawnRequest[] = [];
      let toCancel: { prNumber: number; sessionId: string; childPid: number }[] = [];
      let reapCandidates: number[] = [];

      await this.store.transaction((draft) => {
        const r = tick(draft, dashPrs, Date.now());
        Object.assign(draft, r.nextState);
        toSpawn = r.toSpawn;
        toCancel = r.toCancel;
        reapCandidates = r.reapCandidates;
      });

      for (const c of toCancel) {
        const a = this.active.get(c.prNumber);
        if (a) a.abort.abort();
      }

      await this.verifyAndReap(reapCandidates);

      for (const s of toSpawn) {
        this.startSlot(s);
      }
      return true;
    } finally {
      this.tickRunning = false;
    }
  }

  /** Confirm each reap candidate via `gh pr view`. Only PRs in MERGED or
   *  CLOSED state with `closedAt` older than `config.reviewRetentionHours`
   *  actually get deleted. Everything else (open, indeterminate, gh failure)
   *  gets its `lastSeenAt` bumped so we don't burn another gh call on the
   *  next tick. */
  private async verifyAndReap(candidates: number[]): Promise<void> {
    if (candidates.length === 0) return;

    const snapshot = this.store.snapshot();
    const retentionMs = snapshot.config.reviewRetentionHours * 3_600_000;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    type Verdict = { prNumber: number; action: "reap" | "bump" };
    const verdicts = await Promise.all(
      candidates.map(async (n): Promise<Verdict> => {
        const row = snapshot.prs[n];
        if (!row) return { prNumber: n, action: "bump" };
        const repo = parseRepoSlug(row.url);
        if (!repo) return { prNumber: n, action: "bump" };
        const status = await this.fetchPrStatus(repo, n);
        if (!status) return { prNumber: n, action: "bump" };
        if (status.state === "OPEN") return { prNumber: n, action: "bump" };
        // MERGED / CLOSED — but only reap if it's been long enough since.
        // Without a closedAt we still reap (gh said it's closed; no later
        // grace period to enforce).
        const closedMs = status.closedAt ? new Date(status.closedAt).getTime() : 0;
        if (!status.closedAt || nowMs - closedMs > retentionMs) {
          return { prNumber: n, action: "reap" };
        }
        return { prNumber: n, action: "bump" };
      }),
    );

    const toReap = verdicts.filter((v) => v.action === "reap").map((v) => v.prNumber);
    const toBump = verdicts.filter((v) => v.action === "bump").map((v) => v.prNumber);

    if (toReap.length > 0 || toBump.length > 0) {
      await this.store.transaction((draft) => {
        for (const n of toReap) {
          delete draft.prs[n];
          draft.queue = draft.queue.filter((x) => x !== n);
        }
        for (const n of toBump) {
          const row = draft.prs[n];
          if (row) row.lastSeenAt = nowIso;
        }
      });
    }

    // Delete review markdown files in parallel. `force: true` swallows ENOENT;
    // anything else is logged but doesn't abort the tick.
    await Promise.all(
      toReap.map((n) =>
        fs.rm(reviewFilePath(n), { force: true }).catch((err: unknown) => {
          process.stderr.write(
            `[review-queue] reap pr#${n}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }),
      ),
    );
  }

  private startSlot(req: SpawnRequest): void {
    const abort = new AbortController();
    const finished = (async () => {
      const startedAt = new Date().toISOString();
      const tentativeIter: Iteration = {
        sha: req.sha,
        sessionId: "",
        agentRuntime: req.runtime,
        startedAt,
        status: "running",
        cwd: req.cwd,
      };

      let prSummary = { number: req.prNumber, url: "", title: "", author: "" };
      await this.store.transaction((draft) => {
        const row = draft.prs[req.prNumber];
        if (!row) return;
        row.iterations.push(tentativeIter);
        row.status = "running";
        prSummary = { number: req.prNumber, url: row.url, title: row.title, author: row.author };
        draft.running.push({ prNumber: req.prNumber, sessionId: "", childPid: 0, startedAt });
      });

      const cfg = this.spawnConfigFor(req.runtime, { cwd: req.cwd });
      const followUpOnTruncation = this.store.snapshot().config.followUpOnTruncation;
      const result = await runSlot({
        spawn: cfg,
        // Always pass the fresh-session prompt; the slot uses this on
        // `session/new` and on the fallback path if `session/load` errors.
        prompt: this.promptFor(req.prNumber, prSummary.url),
        ...(req.resumeSessionId
          ? {
              resumeSessionId: req.resumeSessionId,
              // Only used after a confirmed session/load (slot enforces).
              resumePrompt: this.resumePromptFor(prSummary.url),
            }
          : {}),
        isAllowed: (rq) => isToolUseAllowed(rq, { profile: "review" }),
        onUpdate: () => {},
        followUpOnTruncation,
        // Persist sessionId + pid the moment the agent reports them, so a
        // hung or long-running iteration is still resumable from disk.
        onSessionStarted: async (sessionId, childPid) => {
          await this.store.transaction((draft) => {
            const row = draft.prs[req.prNumber];
            if (row) {
              const iter = row.iterations.at(-1);
              if (iter) iter.sessionId = sessionId;
            }
            const entry = draft.running.find((r) => r.prNumber === req.prNumber);
            if (entry) {
              entry.sessionId = sessionId;
              entry.childPid = childPid;
            }
          });
        },
        signal: abort.signal,
      });

      const completedAt = new Date().toISOString();
      // An ACP `completed` with no body usually means the child reported a
      // sessionId then exited fast without persisting anything — we'd flip
      // `latestReviewedSha` to a SHA we haven't actually reviewed, and the
      // dangling sessionId can't be resumed because Claude never wrote the
      // JSONL. Treat as failed so the next tick re-runs at the same SHA.
      const isEmptyBody = result.status === "completed" && !result.body?.trim();
      const effectiveStatus = isEmptyBody ? "failed" : result.status;
      const emptyBodyReason = "empty review body — agent ended without producing output";
      const finalIter: Iteration = {
        sha: req.sha,
        sessionId: result.sessionId ?? "",
        agentRuntime: req.runtime,
        startedAt,
        completedAt,
        status:
          effectiveStatus === "completed"
            ? "pending-confirmation"
            : effectiveStatus === "cancelled"
              ? "superseded"
              : effectiveStatus === "crashed"
                ? "crashed"
                : "failed",
        // finalIter replaces tentativeIter in state — must re-include cwd.
        cwd: req.cwd,
        ...(result.failureReason
          ? { failureReason: result.failureReason }
          : isEmptyBody
            ? { failureReason: emptyBodyReason }
            : {}),
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
        ...(result.usageOutputTokens !== undefined
          ? { usageOutputTokens: result.usageOutputTokens }
          : {}),
      };

      // Write the markdown BEFORE the final state transaction. If the write
      // fails, mark the iteration `failed` so state.json + disk stay in sync
      // — otherwise we'd record `pending-confirmation` with no file on disk
      // and the next tick would skip re-review (latestReviewedSha matches).
      try {
        await this.writeReviewMarkdown(prSummary, finalIter, result.body || "_(empty)_");
      } catch (writeErr: unknown) {
        finalIter.status = "failed";
        finalIter.failureReason = `markdown write failed: ${
          writeErr instanceof Error ? writeErr.message : String(writeErr)
        }`;
      }

      // Surface denied tool calls — useful for debugging "agent gave up; nothing
      // explained why". Persist a count on the iteration; log the full list to
      // daemon.log (paths.daemonLogPath would import-cycle; just use console.error
      // which the daemon's stdio is routed away from, but appears in test output).
      if (result.deniedRequests.length > 0) {
        const summary = result.deniedRequests
          .map((d) => {
            const cmd = typeof d.input.command === "string" ? d.input.command : "";
            return `${d.tool}: ${cmd.slice(0, 80)}`;
          })
          .join(" | ");
        process.stderr.write(
          `[review-queue] pr#${req.prNumber}: ${result.deniedRequests.length} tool calls denied — ${summary}\n`,
        );
      }

      await this.store.transaction((draft) => {
        const row = draft.prs[req.prNumber];
        if (row) {
          row.iterations[row.iterations.length - 1] = finalIter;
          row.status = pickRowStatus(finalIter.status);
          if (finalIter.status === "pending-confirmation") row.latestReviewedSha = req.sha;
        }
        draft.running = draft.running.filter((r) => r.prNumber !== req.prNumber);
      });

      this.active.delete(req.prNumber);

      // Refill any newly-freed slot. Awaited (not fire-and-forget) so drain()
      // observes chained ticks too — a fire-and-forget tick can race with the
      // owning process tearing down (env vars, fs paths) and write to the
      // wrong location.
      await this.tick();
    })().catch(async (err: unknown) => {
      // The happy path inside the IIFE writes the final state transaction.
      // If anything between runSlot resolution and that transaction throws
      // (markdown write, refill tick, etc.), the row would stay stuck in
      // `running` until the next daemon restart's crash recovery. Mark it
      // crashed here so the queue can re-pick it up on the next tick.
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[review-queue] slot pr#${req.prNumber} crashed: ${reason}\n`);
      try {
        await this.store.transaction((draft) => {
          const row = draft.prs[req.prNumber];
          if (row) {
            const iter = row.iterations.at(-1);
            if (iter && iter.status === "running") {
              iter.status = "crashed";
              iter.completedAt = new Date().toISOString();
              iter.failureReason = reason;
            }
            if (row.status === "running") row.status = "crashed";
          }
          draft.running = draft.running.filter((r) => r.prNumber !== req.prNumber);
        });
      } catch {
        // Best-effort: don't double-fault if the store itself is the source
        // of the original throw.
      }
      this.active.delete(req.prNumber);
    });

    this.active.set(req.prNumber, { abort, finished });
  }

  async cancelOne(prNumber: number): Promise<void> {
    const a = this.active.get(prNumber);
    if (a) {
      a.abort.abort();
      await a.finished.catch(() => {});
    } else {
      await this.store.transaction((draft) => {
        draft.queue = draft.queue.filter((n) => n !== prNumber);
        const row = draft.prs[prNumber];
        if (row && row.status === "queued") row.status = "dismissed";
      });
    }
  }

  private promptFor(_prNumber: number, url: string): string {
    if (!url) {
      // url is required on DashboardPrSchema; reaching this branch means the
      // upstream invariant broke. Better to fail loudly than to bake a
      // single-repo URL fallback that lies about the target.
      throw new Error("promptFor: dashboard PR has no url — upstream invariant violation");
    }
    return `/marshal-code-review ${url}`;
  }

  private resumePromptFor(url: string): string {
    if (!url) throw new Error("resumePromptFor: dashboard PR has no url");
    return [
      "The author has pushed new commits since our prior review.",
      `Run a fresh /marshal-code-review ${url} at the current head SHA — dispatch sub-agents anew, do not assume earlier findings still apply.`,
      "After the standard review, append a final section titled `## Comparison to prior findings` that lists each finding from our earlier conversation as: addressed / partial / unchanged / new-issue-in-this-iteration.",
    ].join(" ");
  }

  private async writeReviewMarkdown(
    pr: { number: number; url: string; title: string; author: string },
    iter: Iteration,
    body: string,
  ): Promise<void> {
    const fp = reviewFilePath(pr.number);
    let existing: string | null = null;
    try {
      existing = await fs.readFile(fp, "utf8");
    } catch (err: unknown) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
    }
    const md = existing ? appendIteration(existing, iter, body) : renderInitial(pr, iter, body);
    await fs.writeFile(fp, md, "utf8");
  }

  /** Wait for all active slots to finish, including any chained ticks they trigger. */
  async drain(): Promise<void> {
    while (this.active.size > 0) {
      const all = [...this.active.values()].map((a) => a.finished);
      // Sequential drain rounds — each iteration's settled batch may add new
      // active entries via chained ticks. Parallel rounds would skip them.
      // oxlint-disable-next-line no-await-in-loop
      await Promise.allSettled(all);
    }
  }

  /** Cancel everything in flight; return after they exit. */
  async cancelAll(): Promise<void> {
    for (const a of this.active.values()) a.abort.abort();
    await this.drain();
  }
}

function pickRowStatus(it: Iteration["status"]): State["prs"][number]["status"] {
  switch (it) {
    case "pending-confirmation":
      return "pending-confirmation";
    case "superseded":
      return "queued";
    case "failed":
      return "failed";
    case "crashed":
      return "crashed";
    default:
      return "running";
  }
}
