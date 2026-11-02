// Marshal-owned tooling test.
import { describe, it, expect } from "vitest";

import { tick } from "../src/marshal-review-queue.ts";
import { defaultState } from "../src/marshal-review-types.ts";
import type { DashboardPr } from "../src/marshal-review-types.ts";

const baseDashboardPr = (
  n: number,
  sha = `sha-${n}`,
  tier: DashboardPr["tier"] = "other",
): DashboardPr => ({
  number: n,
  title: `t${n}`,
  author: `u${n}`,
  url: `https://github.com/x/y/pull/${n}`,
  head_sha: sha,
  additions: 10,
  deletions: 5,
  changed_files: 2,
  size_bucket: "S",
  tier,
  blocking_failures: [],
});

const NOW = new Date("2026-05-09T12:00:00Z").getTime();

describe("queue.tick", () => {
  it("enqueues fresh PRs and fills slots up to maxConcurrent", () => {
    const state = defaultState();
    state.config.maxConcurrent = 2;
    state.config.repos.default = { cwd: "/tmp", dashboardCmd: ["x"] };
    const order = [baseDashboardPr(1), baseDashboardPr(2), baseDashboardPr(3)];
    const out = tick(state, order, NOW);

    expect(out.toSpawn.map((s) => s.prNumber)).toEqual([1, 2]);
    expect(out.nextState.queue).toEqual([3]);
    expect(out.nextState.prs[1]?.status).toBe("running");
    expect(out.nextState.prs[2]?.status).toBe("running");
    expect(out.nextState.prs[3]?.status).toBe("queued");
  });

  it("skips PRs already reviewed at the current SHA (pending-confirmation, same sha)", () => {
    const state = defaultState();
    state.config.repos.default = { cwd: "/tmp", dashboardCmd: ["x"] };
    state.prs[1] = {
      url: "u",
      title: "t",
      author: "a",
      tier: "other",
      sizeBucket: "S",
      currentHeadSha: "sha-1",
      latestReviewedSha: "sha-1",
      status: "pending-confirmation",
      iterations: [
        {
          sha: "sha-1",
          sessionId: "x",
          agentRuntime: "claude",
          startedAt: "2026-05-08T00:00:00Z",
          completedAt: "2026-05-08T00:05:00Z",
          status: "pending-confirmation",
        },
      ],
    };
    const out = tick(state, [baseDashboardPr(1, "sha-1")], NOW);
    expect(out.toSpawn).toEqual([]);
    expect(out.nextState.queue).toEqual([]);
    expect(out.nextState.prs[1]?.status).toBe("pending-confirmation");
  });

  it("re-enqueues a PR whose SHA has changed AND is past cooldown", () => {
    const state = defaultState();
    state.config.cooldownMinutes = 60;
    state.config.repos.default = { cwd: "/tmp", dashboardCmd: ["x"] };
    const oldStart = new Date(NOW - 90 * 60_000).toISOString();
    state.prs[1] = {
      url: "u",
      title: "t",
      author: "a",
      tier: "other",
      sizeBucket: "S",
      currentHeadSha: "sha-1",
      latestReviewedSha: "sha-1",
      status: "pending-confirmation",
      iterations: [
        {
          sha: "sha-1",
          sessionId: "x",
          agentRuntime: "claude",
          startedAt: oldStart,
          completedAt: oldStart,
          status: "pending-confirmation",
        },
      ],
    };
    const out = tick(state, [baseDashboardPr(1, "sha-2")], NOW);
    expect(out.toSpawn.map((s) => s.prNumber)).toEqual([1]);
    expect(out.nextState.prs[1]?.currentHeadSha).toBe("sha-2");
  });

  it("respects cooldown — recent prior iteration blocks re-enqueue on SHA change", () => {
    const state = defaultState();
    state.config.cooldownMinutes = 60;
    state.config.repos.default = { cwd: "/tmp", dashboardCmd: ["x"] };
    const recentStart = new Date(NOW - 10 * 60_000).toISOString();
    state.prs[1] = {
      url: "u",
      title: "t",
      author: "a",
      tier: "other",
      sizeBucket: "S",
      currentHeadSha: "sha-1",
      latestReviewedSha: "sha-1",
      status: "pending-confirmation",
      iterations: [
        {
          sha: "sha-1",
          sessionId: "x",
          agentRuntime: "claude",
          startedAt: recentStart,
          completedAt: recentStart,
          status: "pending-confirmation",
        },
      ],
    };
    const out = tick(state, [baseDashboardPr(1, "sha-2")], NOW);
    expect(out.toSpawn).toEqual([]);
    expect(out.nextState.prs[1]?.status).toBe("pending-confirmation");
  });

  it("force-push during run: cancels stale running, immediately respawns at the new SHA", () => {
    const state = defaultState();
    state.config.repos.default = { cwd: "/tmp", dashboardCmd: ["x"] };
    state.prs[1] = {
      url: "u",
      title: "t",
      author: "a",
      tier: "other",
      sizeBucket: "S",
      currentHeadSha: "sha-1",
      latestReviewedSha: null,
      status: "running",
      iterations: [
        {
          sha: "sha-1",
          sessionId: "x",
          agentRuntime: "claude",
          startedAt: "2026-05-09T11:55:00Z",
          status: "running",
        },
      ],
    };
    state.running = [
      { prNumber: 1, sessionId: "x", childPid: 1234, startedAt: "2026-05-09T11:55:00Z" },
    ];

    const out = tick(state, [baseDashboardPr(1, "sha-2")], NOW);

    expect(out.toCancel).toEqual([{ prNumber: 1, sessionId: "x", childPid: 1234 }]);
    expect(out.nextState.prs[1]?.iterations.at(-1)?.status).toBe("superseded");
    expect(out.toSpawn.map((s) => s.prNumber)).toEqual([1]);
    expect(out.toSpawn[0]?.sha).toBe("sha-2");
    expect(out.nextState.prs[1]?.status).toBe("running");
    expect(out.nextState.queue).toEqual([]);
  });

  it("priority order matches dashboard order", () => {
    const state = defaultState();
    state.config.maxConcurrent = 0;
    state.config.repos.default = { cwd: "/tmp", dashboardCmd: ["x"] };
    const order = [
      baseDashboardPr(100),
      baseDashboardPr(201, "s201", "maintainer"),
      baseDashboardPr(202, "s202", "trusted"),
      baseDashboardPr(200, "s200", "other"),
      baseDashboardPr(300),
    ];
    const out = tick(state, order, NOW);
    expect(out.nextState.queue).toEqual([100, 201, 202, 200, 300]);
  });

  it("does not spawn a PR that's currently in running already", () => {
    const state = defaultState();
    state.config.repos.default = { cwd: "/tmp", dashboardCmd: ["x"] };
    state.config.maxConcurrent = 5;
    state.prs[1] = {
      url: "u",
      title: "t",
      author: "a",
      tier: "other",
      sizeBucket: "S",
      currentHeadSha: "sha-1",
      latestReviewedSha: null,
      status: "running",
      iterations: [
        {
          sha: "sha-1",
          sessionId: "x",
          agentRuntime: "claude",
          startedAt: "2026-05-09T11:59:00Z",
          status: "running",
        },
      ],
    };
    state.running = [
      { prNumber: 1, sessionId: "x", childPid: 1234, startedAt: "2026-05-09T11:59:00Z" },
    ];
    const out = tick(state, [baseDashboardPr(1, "sha-1")], NOW);
    expect(out.toSpawn).toEqual([]);
    expect(out.nextState.running.length).toBe(1);
  });

  it("skips dashboard PRs that lack a head_sha (cannot be reviewed without one)", () => {
    const state = defaultState();
    state.config.repos.default = { cwd: "/tmp", dashboardCmd: ["x"] };
    const noSha = { ...baseDashboardPr(1) } as DashboardPr;
    delete (noSha as Partial<DashboardPr>).head_sha;
    const out = tick(state, [noSha], NOW);
    expect(out.toSpawn).toEqual([]);
    expect(out.nextState.queue).toEqual([]);
    expect(out.nextState.prs[1]).toBeUndefined();
  });
});

describe("queue.tick — keep-context resume flow", () => {
  // NOTE: this helper INTENTIONALLY omits `cwd` from the iteration. The
  // "legacy fallback" test relies on the absence to exercise the
  // `priorIter?.cwd ?? repoCwd` branch in queue.tick. If you add `cwd`
  // here, that test silently moves to a different branch — update the
  // test inline (see "resume uses the cwd recorded on the prior iteration"
  // for the inline-construction pattern) rather than the helper.
  const queuedRowWithPriorIter = (sessionId: string) => ({
    url: "u",
    title: "t",
    author: "a",
    tier: "other" as const,
    sizeBucket: "S" as const,
    currentHeadSha: "sha-2",
    latestReviewedSha: "sha-1",
    status: "queued" as const,
    iterations: [
      {
        sha: "sha-1",
        sessionId,
        agentRuntime: "claude" as const,
        startedAt: "2026-05-08T00:00:00Z",
        completedAt: "2026-05-08T00:05:00Z",
        status: "pending-confirmation" as const,
      },
    ],
  });

  it("attaches resumeSessionId and clears the flag when keep-context is set", () => {
    const state = defaultState();
    state.config.repos.default = { cwd: "/tmp", dashboardCmd: ["x"] };
    state.prs[42] = {
      ...queuedRowWithPriorIter("session-A"),
      keepContextNextIteration: true,
    };
    state.queue = [42];

    const out = tick(state, [baseDashboardPr(42, "sha-2")], NOW);
    expect(out.toSpawn[0]?.resumeSessionId).toBe("session-A");
    // One-shot: flag is cleared on consumption.
    expect(out.nextState.prs[42]?.keepContextNextIteration).toBe(false);
  });

  it("does NOT attach resumeSessionId when keep-context is unset", () => {
    const state = defaultState();
    state.config.repos.default = { cwd: "/tmp", dashboardCmd: ["x"] };
    state.prs[42] = queuedRowWithPriorIter("session-A");
    state.queue = [42];

    const out = tick(state, [baseDashboardPr(42, "sha-2")], NOW);
    expect(out.toSpawn[0]?.resumeSessionId).toBeUndefined();
  });

  it("clears keep-context even when there's no prior session id to attach", () => {
    const state = defaultState();
    state.config.repos.default = { cwd: "/tmp", dashboardCmd: ["x"] };
    state.prs[42] = {
      ...queuedRowWithPriorIter(""),
      keepContextNextIteration: true,
    };
    state.queue = [42];

    const out = tick(state, [baseDashboardPr(42, "sha-2")], NOW);
    expect(out.toSpawn[0]?.resumeSessionId).toBeUndefined();
    // Flag clears regardless so a stale prior iteration doesn't keep
    // triggering the resume path on future ticks.
    expect(out.nextState.prs[42]?.keepContextNextIteration).toBe(false);
  });

  it("resume uses the cwd recorded on the prior iteration, not the current config cwd", () => {
    // Simulates the worktree cutover: config was reconfigured from
    // /old-repo to /new-worktree, but a pending iteration's session was
    // created in /old-repo. Resume must target /old-repo.
    const state = defaultState();
    state.config.repos.default = { cwd: "/new-worktree", dashboardCmd: ["x"] };
    const priorIter = {
      sha: "sha-1",
      sessionId: "session-A",
      agentRuntime: "claude" as const,
      startedAt: "2026-05-08T00:00:00Z",
      completedAt: "2026-05-08T00:05:00Z",
      status: "pending-confirmation" as const,
      cwd: "/old-repo",
    };
    state.prs[42] = {
      url: "u",
      title: "t",
      author: "a",
      tier: "other",
      sizeBucket: "S",
      currentHeadSha: "sha-2",
      latestReviewedSha: "sha-1",
      status: "queued",
      iterations: [priorIter],
      keepContextNextIteration: true,
    };
    state.queue = [42];

    const out = tick(state, [baseDashboardPr(42, "sha-2")], NOW);
    expect(out.toSpawn[0]?.cwd).toBe("/old-repo");
    expect(out.toSpawn[0]?.resumeSessionId).toBe("session-A");
  });

  it("fresh iterations (no resume) always use the current config cwd", () => {
    // The worktree migration case: config now points at /new-worktree;
    // a fresh iteration on a row whose prior iteration was at /old-repo
    // should still target /new-worktree (it's a fresh session, no resume).
    const state = defaultState();
    state.config.repos.default = { cwd: "/new-worktree", dashboardCmd: ["x"] };
    state.prs[42] = {
      url: "u",
      title: "t",
      author: "a",
      tier: "other",
      sizeBucket: "S",
      currentHeadSha: "sha-2",
      latestReviewedSha: "sha-1",
      status: "queued",
      iterations: [
        {
          sha: "sha-1",
          sessionId: "session-A",
          agentRuntime: "claude",
          startedAt: "2026-05-08T00:00:00Z",
          completedAt: "2026-05-08T00:05:00Z",
          status: "pending-confirmation",
          cwd: "/old-repo",
        },
      ],
    };
    // No keepContextNextIteration → no resume → fresh session at new cwd.
    state.queue = [42];

    const out = tick(state, [baseDashboardPr(42, "sha-2")], NOW);
    expect(out.toSpawn[0]?.cwd).toBe("/new-worktree");
    expect(out.toSpawn[0]?.resumeSessionId).toBeUndefined();
  });

  it("resume falls back to config cwd when the prior iteration has no cwd stamp (legacy)", () => {
    // Legacy iteration written before Iteration.cwd existed — should not
    // crash; falls back to current config cwd. The setup-worktree script
    // backfills these, but in-flight rows might miss it.
    const state = defaultState();
    state.config.repos.default = { cwd: "/new-worktree", dashboardCmd: ["x"] };
    const row = queuedRowWithPriorIter("session-A");
    // Don't set cwd on the prior iteration — simulates legacy state.
    state.prs[42] = { ...row, keepContextNextIteration: true };
    state.queue = [42];

    const out = tick(state, [baseDashboardPr(42, "sha-2")], NOW);
    expect(out.toSpawn[0]?.cwd).toBe("/new-worktree");
    expect(out.toSpawn[0]?.resumeSessionId).toBe("session-A");
  });
});

describe("queue.tick — retention sweep", () => {
  const terminalRow = (sha: string, status: "confirmed" | "dismissed" | "failed" | "crashed") => ({
    url: "u",
    title: "t",
    author: "a",
    tier: "other" as const,
    sizeBucket: "S" as const,
    currentHeadSha: sha,
    latestReviewedSha: sha,
    status,
    iterations: [],
  });

  it("flags a confirmed row as a reap candidate when past retention", () => {
    const state = defaultState();
    state.config.repos.default = { cwd: "/tmp", dashboardCmd: ["x"] };
    state.config.reviewRetentionHours = 24;
    state.prs[42] = {
      ...terminalRow("sha-42", "confirmed"),
      // Last seen 25h ago — past the 24h retention.
      lastSeenAt: new Date(NOW - 25 * 3_600_000).toISOString(),
    };

    const out = tick(state, [], NOW);
    expect(out.reapCandidates).toEqual([42]);
    // tick() only proposes; orchestrator must verify via gh before deleting.
    expect(out.nextState.prs[42]).toBeDefined();
  });

  it("proposes a pending-confirmation row as a reap candidate when past retention", () => {
    // pending-confirmation rows are eligible candidates so PRs the user
    // reviewed-and-forgot get cleared once they ship upstream. The orchestrator
    // still gates actual deletion on `gh pr view` (verified in
    // orchestrator.integration.test.ts) — OPEN PRs the user hasn't confirmed
    // yet are safe; only MERGED/CLOSED past the grace period get reaped.
    const state = defaultState();
    state.config.repos.default = { cwd: "/tmp", dashboardCmd: ["x"] };
    state.config.reviewRetentionHours = 24;
    state.prs[7] = {
      ...terminalRow("sha-7", "confirmed"),
      status: "pending-confirmation",
      lastSeenAt: new Date(NOW - 30 * 24 * 3_600_000).toISOString(),
    };

    const out = tick(state, [], NOW);
    expect(out.reapCandidates).toEqual([7]);
    // tick() only proposes; orchestrator must verify via gh before deleting.
    expect(out.nextState.prs[7]).toBeDefined();
  });

  it("does NOT reap a still-running or queued row", () => {
    const state = defaultState();
    state.config.repos.default = { cwd: "/tmp", dashboardCmd: ["x"] };
    state.config.reviewRetentionHours = 24;
    const ancient = new Date(NOW - 7 * 24 * 3_600_000).toISOString();
    state.prs[1] = { ...terminalRow("s1", "confirmed"), status: "queued", lastSeenAt: ancient };
    state.prs[2] = { ...terminalRow("s2", "confirmed"), status: "running", lastSeenAt: ancient };

    const out = tick(state, [], NOW);
    expect(out.reapCandidates).toEqual([]);
  });

  it("stamps lastSeenAt on first tick for legacy rows and does NOT reap them yet", () => {
    const state = defaultState();
    state.config.repos.default = { cwd: "/tmp", dashboardCmd: ["x"] };
    state.config.reviewRetentionHours = 24;
    // No `lastSeenAt` — simulating a state file written before the field existed.
    state.prs[99] = terminalRow("sha-99", "failed");

    const out = tick(state, [], NOW);
    expect(out.reapCandidates).toEqual([]);
    expect(out.nextState.prs[99]?.lastSeenAt).toBe(new Date(NOW).toISOString());
  });

  it("refreshes lastSeenAt when the dashboard returns the PR again", () => {
    const state = defaultState();
    state.config.repos.default = { cwd: "/tmp", dashboardCmd: ["x"] };
    state.config.reviewRetentionHours = 24;
    state.prs[5] = {
      ...terminalRow("sha-5", "confirmed"),
      lastSeenAt: new Date(NOW - 25 * 3_600_000).toISOString(),
    };

    const out = tick(state, [baseDashboardPr(5, "sha-5")], NOW);
    expect(out.reapCandidates).toEqual([]);
    expect(out.nextState.prs[5]?.lastSeenAt).toBe(new Date(NOW).toISOString());
  });

  it("retention=0 disables the sweep entirely", () => {
    const state = defaultState();
    state.config.repos.default = { cwd: "/tmp", dashboardCmd: ["x"] };
    state.config.reviewRetentionHours = 0;
    state.prs[1] = {
      ...terminalRow("s1", "confirmed"),
      lastSeenAt: new Date(NOW - 365 * 24 * 3_600_000).toISOString(),
    };

    const out = tick(state, [], NOW);
    expect(out.reapCandidates).toEqual([]);
    expect(out.nextState.prs[1]).toBeDefined();
  });
});
