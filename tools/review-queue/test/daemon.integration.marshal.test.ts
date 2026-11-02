import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { makeRouter } from "../src/marshal-review-daemon-router.ts";
import { httpRequest } from "../src/marshal-review-http-client.ts";
import { startHttpServer } from "../src/marshal-review-http-server.ts";
import { Orchestrator } from "../src/marshal-review-orchestrator.ts";
import { StateStore } from "../src/marshal-review-state-store.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeAgent = path.join(__dirname, "../../marshal-acp/test/fixtures/fake-acp-agent.mjs");

let tmp: string;
let sock: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rq-daemon-"));
  process.env.MARSHAL_REVIEW_QUEUE_HOME = tmp;
  sock =
    process.platform === "win32"
      ? `\\\\.\\pipe\\m-rq-daemon-${process.pid}-${Date.now()}`
      : path.join(tmp, "daemon.sock");
});

afterEach(async () => {
  delete process.env.MARSHAL_REVIEW_QUEUE_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("daemon router (integration)", () => {
  it("status reports zero, tick enqueues + spawns + completes", async () => {
    const store = await StateStore.create();
    await store.transaction((s) => {
      s.config.repos.default = { cwd: process.cwd(), dashboardCmd: ["unused"] };
    });

    const orch = new Orchestrator({
      store,
      runDashboard: async () => ({
        generated_at: "x",
        me: "me",
        window_days: 3,
        buckets: {
          needs_review: [
            {
              number: 7,
              title: "T",
              author: "A",
              url: "https://example/pr/7",
              head_sha: "sha-7",
              additions: 1,
              deletions: 0,
              changed_files: 1,
              size_bucket: "S",
              tier: "other",
              blocking_failures: [],
            },
          ],
          stale_my_review: [],
          my_prs_with_feedback: [],
          hidden_failing_ci: [],
        },
      }),
      spawnConfigFor: () => ({
        cmd: process.execPath,
        args: [fakeAgent],
        env: { ...process.env, FAKE_REQUEST_CMD: "gh pr view 7" },
        cwd: process.cwd(),
      }),
    });

    const router = makeRouter({ store, orch });
    const server = await startHttpServer({ socketPath: sock, router });
    try {
      const before = await httpRequest({ socketPath: sock, method: "GET", path: "/status" });
      expect(before.status).toBe(200);
      const beforeBody = JSON.parse(before.body);
      expect(beforeBody.running.length).toBe(0);

      const tick = await httpRequest({ socketPath: sock, method: "POST", path: "/tick" });
      expect(tick.status).toBe(200);

      await orch.drain();

      const after = await httpRequest({ socketPath: sock, method: "GET", path: "/status" });
      const afterBody = JSON.parse(after.body);
      expect(afterBody.prs["7"].status).toBe("pending-confirmation");
    } finally {
      await server.close();
    }
  });

  it("confirm and dismiss update PR status; requeue forces a fresh iteration regardless of cooldown", async () => {
    const store = await StateStore.create();
    await store.transaction((s) => {
      s.config.repos.default = { cwd: process.cwd(), dashboardCmd: ["unused"] };
      s.prs[9] = {
        url: "https://example/pr/9",
        title: "T",
        author: "A",
        tier: "other",
        sizeBucket: "S",
        currentHeadSha: "sha-9",
        latestReviewedSha: "sha-9",
        status: "pending-confirmation",
        iterations: [
          {
            sha: "sha-9",
            sessionId: "x",
            agentRuntime: "claude",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            status: "pending-confirmation",
          },
        ],
      };
    });
    const orch = new Orchestrator({
      store,
      runDashboard: async () => ({
        generated_at: "x",
        me: "me",
        window_days: 3,
        buckets: {
          needs_review: [],
          stale_my_review: [],
          my_prs_with_feedback: [],
          hidden_failing_ci: [],
        },
      }),
    });
    const router = makeRouter({ store, orch });
    const server = await startHttpServer({ socketPath: sock, router });
    try {
      let r = await httpRequest({
        socketPath: sock,
        method: "POST",
        path: "/confirm",
        body: { pr: 9 },
      });
      expect(r.status).toBe(200);
      expect(store.snapshot().prs[9]?.status).toBe("confirmed");

      r = await httpRequest({
        socketPath: sock,
        method: "POST",
        path: "/dismiss",
        body: { pr: 9 },
      });
      expect(r.status).toBe(200);
      expect(store.snapshot().prs[9]?.status).toBe("dismissed");

      r = await httpRequest({
        socketPath: sock,
        method: "POST",
        path: "/requeue",
        body: { pr: 9 },
      });
      expect(r.status).toBe(200);
      expect(store.snapshot().prs[9]?.status).toBe("queued");

      r = await httpRequest({
        socketPath: sock,
        method: "POST",
        path: "/keep-context",
        body: { pr: 9 },
      });
      expect(r.status).toBe(200);
      expect(store.snapshot().prs[9]?.keepContextNextIteration).toBe(true);

      // keep-context against a PR with no prior session id should return
      // 409 Conflict with a structured error body (NOT 500) so the CLI
      // can surface the message instead of a generic "internal error."
      await store.transaction((s) => {
        s.prs[10] = {
          url: "https://example/pr/10",
          title: "Fresh",
          author: "A",
          tier: "other",
          sizeBucket: "S",
          currentHeadSha: "sha",
          latestReviewedSha: null,
          status: "queued",
          iterations: [],
        };
      });
      r = await httpRequest({
        socketPath: sock,
        method: "POST",
        path: "/keep-context",
        body: { pr: 10 },
      });
      expect(r.status).toBe(409);
      expect(JSON.parse(r.body).error).toMatch(/no prior session/i);
      expect(store.snapshot().prs[10]?.keepContextNextIteration).toBeUndefined();

      // Operating on an unknown pr returns 404 with a specific message.
      r = await httpRequest({
        socketPath: sock,
        method: "POST",
        path: "/confirm",
        body: { pr: 99999 },
      });
      expect(r.status).toBe(404);
      expect(JSON.parse(r.body).error).toMatch(/unknown pr 99999/);
    } finally {
      await server.close();
    }
  });
});
