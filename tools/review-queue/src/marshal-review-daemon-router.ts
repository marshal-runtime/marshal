// Marshal-owned module.
import type { Router } from "./marshal-review-http-server.ts";
import type { Orchestrator } from "./marshal-review-orchestrator.ts";
import type { StateStore } from "./marshal-review-state-store.ts";

export type RouterDeps = {
  store: StateStore;
  orch: Orchestrator;
  /** Optional info-log sink. Daemon wires this to daemon.log; tests omit it. */
  onLog?: (line: string) => void;
};

export function makeRouter(deps: RouterDeps): Router {
  return async (method, path, body) => {
    if (method === "GET" && path === "/status") {
      return { status: 200, body: deps.store.snapshot() };
    }

    if (method === "POST" && path === "/tick") {
      const ranTick = await deps.orch.tick();
      // Log no-op ticks so cron-driven stalls leave a trail.
      if (!ranTick && deps.onLog) {
        deps.onLog(`[${new Date().toISOString()}] /tick coalesced — another tick is in flight`);
      }
      return { status: 200, body: { ok: true, ranTick } };
    }

    const pr =
      typeof body === "object" && body !== null && "pr" in body && typeof body.pr === "number"
        ? body.pr
        : NaN;

    // Routes that operate on a specific PR. We pre-check existence here so
    // "unknown pr" returns 404 with a specific message — throwing through to
    // the http-server's catch would produce a generic 500 "internal error"
    // that the CLI can't surface usefully to the user.
    if (
      method === "POST" &&
      (path === "/confirm" ||
        path === "/dismiss" ||
        path === "/requeue" ||
        path === "/cancel" ||
        path === "/keep-context")
    ) {
      if (!Number.isFinite(pr)) return { status: 400, body: { error: "missing pr" } };
      const snap = deps.store.snapshot();
      if (!snap.prs[pr]) {
        return { status: 404, body: { error: `unknown pr ${pr}` } };
      }
    }

    if (method === "POST" && path === "/confirm") {
      await deps.store.transaction((s) => {
        const r = s.prs[pr];
        if (r) r.status = "confirmed";
      });
      return { status: 200, body: { ok: true } };
    }

    if (method === "POST" && path === "/dismiss") {
      await deps.store.transaction((s) => {
        const r = s.prs[pr];
        if (r) r.status = "dismissed";
      });
      return { status: 200, body: { ok: true } };
    }

    if (method === "POST" && path === "/requeue") {
      await deps.store.transaction((s) => {
        const r = s.prs[pr];
        if (r) {
          r.status = "queued";
          r.latestReviewedSha = null;
          if (!s.queue.includes(pr)) s.queue.unshift(pr);
        }
      });
      // /requeue only changes state; the next /tick picks it up. Keeps the
      // route's effect predictable and sidesteps fire-and-forget races.
      return { status: 200, body: { ok: true } };
    }

    if (method === "POST" && path === "/cancel") {
      await deps.orch.cancelOne(pr);
      return { status: 200, body: { ok: true } };
    }

    if (method === "POST" && path === "/keep-context") {
      const snap = deps.store.snapshot();
      const lastSessionId = snap.prs[pr]?.iterations.at(-1)?.sessionId;
      if (!lastSessionId) {
        return {
          status: 409,
          body: {
            error: `pr ${pr}: no prior session id to resume — wait until at least one iteration completes`,
          },
        };
      }
      await deps.store.transaction((s) => {
        const r = s.prs[pr];
        if (r) r.keepContextNextIteration = true;
      });
      return { status: 200, body: { ok: true } };
    }

    if (method === "POST" && path === "/shutdown") {
      // Defer the kill so the 200 response gets a chance to flush before
      // the SIGTERM handler tears down the HTTP server. Without setImmediate,
      // server.close() can race the writer and the client sees a hangup.
      setImmediate(() => process.kill(process.pid, "SIGTERM"));
      return { status: 200, body: { ok: true } };
    }

    return { status: 404, body: { error: "not found" } };
  };
}
