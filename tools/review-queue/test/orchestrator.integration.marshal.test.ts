import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { Orchestrator } from "../src/marshal-review-orchestrator.ts";
import { StateStore } from "../src/marshal-review-state-store.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeAgent = path.join(__dirname, "../../marshal-acp/test/fixtures/fake-acp-agent.mjs");

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rq-orch-"));
  process.env.MARSHAL_REVIEW_QUEUE_HOME = tmp;
});

afterEach(async () => {
  delete process.env.MARSHAL_REVIEW_QUEUE_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("Orchestrator (integration)", () => {
  it("ticks once: enqueues a fresh PR, spawns the slot, writes the review markdown", async () => {
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
              number: 42,
              title: "T",
              author: "A",
              url: "https://example/pr/42",
              head_sha: "sha-42",
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
        env: { ...process.env, FAKE_REQUEST_CMD: "gh pr view 42" },
        cwd: process.cwd(),
      }),
    });

    await orch.tick();
    await orch.drain();

    const s = store.snapshot();
    expect(s.prs[42]?.status).toBe("pending-confirmation");
    expect(s.prs[42]?.iterations.length).toBe(1);
    expect(s.prs[42]?.iterations[0]?.sessionId).toBe("fake-session-1");
    expect(s.prs[42]?.iterations[0]?.status).toBe("pending-confirmation");

    const md = await fs.readFile(path.join(tmp, "reviews/pr-42.md"), "utf8");
    expect(md).toContain("# PR #42 — T");
    expect(md).toContain("fake review body");

    const status = await fs.readFile(path.join(tmp, "status.md"), "utf8");
    expect(status).toContain("Pending confirmation");

    // Phase 0 invariant: iteration carries the cwd it was spawned in. This
    // is what lets resume + keep-context find the on-disk Claude session
    // even after `config.repos.default.cwd` is changed (e.g. worktree
    // cutover). Asserting here so a refactor that drops the field fails
    // loudly.
    const iter = store.snapshot().prs[42]?.iterations[0];
    expect(iter?.cwd).toBe(process.cwd());
  });

  it("treats an ACP-completed iteration with empty body as failed, doesn't bump latestReviewedSha", async () => {
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
              number: 99,
              title: "T",
              author: "A",
              url: "https://example/pr/99",
              head_sha: "sha-99",
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
        env: { ...process.env, FAKE_REQUEST_CMD: "gh pr view 99", FAKE_EMPTY_BODY: "1" },
        cwd: process.cwd(),
      }),
    });

    await orch.tick();
    await orch.drain();

    const row = store.snapshot().prs[99];
    expect(row?.iterations.length).toBe(1);
    const iter = row?.iterations[0];
    expect(iter?.status).toBe("failed");
    expect(iter?.failureReason).toMatch(/empty review body/);
    // Critical: latestReviewedSha must stay null so the next tick re-reviews
    // at the same SHA. Without this, an empty 14-second run silently shadows
    // a real review and the queue thinks the PR has been reviewed.
    expect(row?.latestReviewedSha).toBeNull();
    expect(row?.status).toBe("failed");
  });
});

describe("Orchestrator retention sweep", () => {
  const emptyDashboard = () =>
    Promise.resolve({
      generated_at: "x",
      me: "me",
      window_days: 7,
      buckets: {
        needs_review: [],
        stale_my_review: [],
        my_prs_with_feedback: [],
        hidden_failing_ci: [],
      },
    });

  it("deletes the row and markdown file when gh confirms MERGED past retention", async () => {
    const store = await StateStore.create();
    const longAgo = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    await store.transaction((s) => {
      s.config.repos.default = { cwd: process.cwd(), dashboardCmd: ["unused"] };
      s.config.reviewRetentionHours = 24;
      s.prs[7] = {
        url: "https://github.com/OmerMachluf/marshal/pull/7",
        title: "t",
        author: "a",
        tier: "other",
        sizeBucket: "S",
        currentHeadSha: "sha",
        latestReviewedSha: "sha",
        status: "confirmed",
        iterations: [],
        lastSeenAt: longAgo,
      };
    });
    const reviewFile = path.join(tmp, "reviews", "pr-7.md");
    await fs.mkdir(path.dirname(reviewFile), { recursive: true });
    await fs.writeFile(reviewFile, "old review");

    const orch = new Orchestrator({
      store,
      runDashboard: emptyDashboard,
      fetchPrStatus: async () => ({
        state: "MERGED",
        closedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
      }),
      spawnConfigFor: () => ({ cmd: "noop", args: [], env: {}, cwd: process.cwd() }),
    });

    await orch.tick();

    expect(store.snapshot().prs[7]).toBeUndefined();
    await expect(fs.readFile(reviewFile, "utf8")).rejects.toThrow();
  });

  it("keeps a row whose PR is still OPEN, bumping lastSeenAt instead", async () => {
    const store = await StateStore.create();
    const longAgo = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    await store.transaction((s) => {
      s.config.repos.default = { cwd: process.cwd(), dashboardCmd: ["unused"] };
      s.config.reviewRetentionHours = 24;
      s.prs[9] = {
        url: "https://github.com/OmerMachluf/marshal/pull/9",
        title: "t",
        author: "a",
        tier: "other",
        sizeBucket: "S",
        currentHeadSha: "sha",
        latestReviewedSha: "sha",
        status: "failed",
        iterations: [],
        lastSeenAt: longAgo,
      };
    });

    const orch = new Orchestrator({
      store,
      runDashboard: emptyDashboard,
      // PR was hidden from the dashboard (failing CI), but still open — must NOT reap.
      fetchPrStatus: async () => ({ state: "OPEN", closedAt: null }),
      spawnConfigFor: () => ({ cmd: "noop", args: [], env: {}, cwd: process.cwd() }),
    });

    await orch.tick();

    const row = store.snapshot().prs[9];
    expect(row).toBeDefined();
    // lastSeenAt was bumped — the candidate won't re-trigger gh on the next tick
    // until another retention window elapses.
    expect(row?.lastSeenAt).not.toBe(longAgo);
  });

  it("keeps a row whose PR was merged inside the retention window", async () => {
    const store = await StateStore.create();
    const longAgo = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    await store.transaction((s) => {
      s.config.repos.default = { cwd: process.cwd(), dashboardCmd: ["unused"] };
      s.config.reviewRetentionHours = 24;
      s.prs[11] = {
        url: "https://github.com/OmerMachluf/marshal/pull/11",
        title: "t",
        author: "a",
        tier: "other",
        sizeBucket: "S",
        currentHeadSha: "sha",
        latestReviewedSha: "sha",
        status: "confirmed",
        iterations: [],
        lastSeenAt: longAgo,
      };
    });

    const orch = new Orchestrator({
      store,
      runDashboard: emptyDashboard,
      // Merged 2h ago — inside the 24h retention.
      fetchPrStatus: async () => ({
        state: "MERGED",
        closedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      }),
      spawnConfigFor: () => ({ cmd: "noop", args: [], env: {}, cwd: process.cwd() }),
    });

    await orch.tick();
    expect(store.snapshot().prs[11]).toBeDefined();
  });

  it("crashes the row when the post-runSlot path throws (IIFE catch)", async () => {
    // Wrap the store so the Nth transaction throws. The orchestrator's IIFE
    // catch should mark the iteration `crashed` and clear the running entry
    // so the slot doesn't sit wedged until the next daemon restart.
    const store = await StateStore.create();
    await store.transaction((s) => {
      s.config.repos.default = { cwd: process.cwd(), dashboardCmd: ["unused"] };
    });

    let txCount = 0;
    const original = store.transaction.bind(store);
    // 4th transaction in the slot flow is the FINAL one (status →
    // pending-confirmation, remove from running). Counts: tick state mutation,
    // initial running-row push, onSessionStarted sessionId stamp, final.
    const failOnTx = 4;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    (store as { transaction: typeof store.transaction }).transaction = async (fn) => {
      txCount++;
      if (txCount === failOnTx) throw new Error("test: forced final-transaction failure");
      return original(fn);
    };

    const orch = new Orchestrator({
      store,
      runDashboard: async () => ({
        generated_at: "x",
        me: "me",
        window_days: 3,
        buckets: {
          needs_review: [
            {
              number: 99,
              title: "T",
              author: "A",
              url: "https://example/pr/99",
              head_sha: "sha-99",
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
        env: { ...process.env, FAKE_REQUEST_CMD: "gh pr view 99" },
        cwd: process.cwd(),
      }),
    });

    await orch.tick();
    await orch.drain();

    const row = store.snapshot().prs[99];
    expect(row?.status).toBe("crashed");
    expect(store.snapshot().running.find((r) => r.prNumber === 99)).toBeUndefined();
  });

  it("reaps a pending-confirmation row when gh confirms MERGED past retention", async () => {
    const store = await StateStore.create();
    const longAgo = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    await store.transaction((s) => {
      s.config.repos.default = { cwd: process.cwd(), dashboardCmd: ["unused"] };
      s.config.reviewRetentionHours = 24;
      s.prs[15] = {
        url: "https://github.com/OmerMachluf/marshal/pull/15",
        title: "t",
        author: "a",
        tier: "other",
        sizeBucket: "S",
        currentHeadSha: "sha",
        latestReviewedSha: "sha",
        status: "pending-confirmation",
        iterations: [],
        lastSeenAt: longAgo,
      };
    });

    const orch = new Orchestrator({
      store,
      runDashboard: emptyDashboard,
      fetchPrStatus: async () => ({
        state: "MERGED",
        closedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
      }),
      spawnConfigFor: () => ({ cmd: "noop", args: [], env: {}, cwd: process.cwd() }),
    });

    await orch.tick();
    expect(store.snapshot().prs[15]).toBeUndefined();
  });

  it("keeps a pending-confirmation row whose PR is still OPEN", async () => {
    // The user reviewed it but hasn't gotten around to posting yet, and the
    // dashboard hides it (failing CI, outside window). The gh OPEN response
    // must take precedence over the local pending-confirmation reapable flag.
    const store = await StateStore.create();
    const longAgo = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    await store.transaction((s) => {
      s.config.repos.default = { cwd: process.cwd(), dashboardCmd: ["unused"] };
      s.config.reviewRetentionHours = 24;
      s.prs[17] = {
        url: "https://github.com/OmerMachluf/marshal/pull/17",
        title: "t",
        author: "a",
        tier: "other",
        sizeBucket: "S",
        currentHeadSha: "sha",
        latestReviewedSha: "sha",
        status: "pending-confirmation",
        iterations: [],
        lastSeenAt: longAgo,
      };
    });

    const orch = new Orchestrator({
      store,
      runDashboard: emptyDashboard,
      fetchPrStatus: async () => ({ state: "OPEN", closedAt: null }),
      spawnConfigFor: () => ({ cmd: "noop", args: [], env: {}, cwd: process.cwd() }),
    });

    await orch.tick();
    const row = store.snapshot().prs[17];
    expect(row).toBeDefined();
    expect(row?.status).toBe("pending-confirmation");
    expect(row?.lastSeenAt).not.toBe(longAgo);
  });

  it("keeps a row when gh lookup fails (null return)", async () => {
    const store = await StateStore.create();
    const longAgo = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    await store.transaction((s) => {
      s.config.repos.default = { cwd: process.cwd(), dashboardCmd: ["unused"] };
      s.config.reviewRetentionHours = 24;
      s.prs[13] = {
        url: "https://github.com/OmerMachluf/marshal/pull/13",
        title: "t",
        author: "a",
        tier: "other",
        sizeBucket: "S",
        currentHeadSha: "sha",
        latestReviewedSha: "sha",
        status: "crashed",
        iterations: [],
        lastSeenAt: longAgo,
      };
    });

    const orch = new Orchestrator({
      store,
      runDashboard: emptyDashboard,
      fetchPrStatus: async () => null,
      spawnConfigFor: () => ({ cmd: "noop", args: [], env: {}, cwd: process.cwd() }),
    });

    await orch.tick();
    expect(store.snapshot().prs[13]).toBeDefined();
  });
});
