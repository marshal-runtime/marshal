import { describe, it, expect } from "vitest";

import { renderStatusMd } from "../src/marshal-review-status-renderer.ts";
import { defaultState } from "../src/marshal-review-types.ts";

describe("renderStatusMd", () => {
  it("empty state shows zero counts and no PR sections", () => {
    const md = renderStatusMd(defaultState(), new Date("2026-05-09T12:00:00Z"));
    expect(md).toContain("# marshal-review-queue status");
    expect(md).toContain("Running: 0 / 5");
    expect(md).toContain("Queued: 0");
    expect(md).not.toMatch(/^## Running$/m);
    expect(md).not.toMatch(/^## Queued$/m);
  });

  it("running + queued + cooldown sections render with PR details", () => {
    const s = defaultState();
    s.config.cooldownMinutes = 60;
    s.running = [
      { prNumber: 1147, sessionId: "cc-abc", childPid: 1234, startedAt: "2026-05-09T11:55:00Z" },
    ];
    s.queue = [1152];
    s.prs[1147] = {
      url: "https://github.com/OmerMachluf/marshal/pull/1147",
      title: "Add tunnel cache",
      author: "alice",
      tier: "maintainer",
      sizeBucket: "M",
      currentHeadSha: "7f3a9c2",
      latestReviewedSha: null,
      status: "running",
      iterations: [
        {
          sha: "7f3a9c2",
          sessionId: "cc-abc",
          agentRuntime: "claude",
          startedAt: "2026-05-09T11:55:00Z",
          status: "running",
        },
      ],
    };
    s.prs[1152] = {
      url: "https://github.com/OmerMachluf/marshal/pull/1152",
      title: "Bugfix",
      author: "bob",
      tier: "trusted",
      sizeBucket: "S",
      currentHeadSha: "abcdef0",
      latestReviewedSha: null,
      status: "queued",
      iterations: [],
    };
    s.prs[1100] = {
      url: "https://github.com/OmerMachluf/marshal/pull/1100",
      title: "Big refactor",
      author: "carol",
      tier: "other",
      sizeBucket: "L",
      currentHeadSha: "newsha2",
      latestReviewedSha: "oldsha1",
      status: "pending-confirmation",
      iterations: [
        {
          sha: "newsha2",
          sessionId: "cc-xyz",
          agentRuntime: "claude",
          startedAt: "2026-05-09T11:30:00Z",
          completedAt: "2026-05-09T11:38:00Z",
          status: "pending-confirmation",
        },
      ],
    };

    const md = renderStatusMd(s, new Date("2026-05-09T12:00:00Z"));

    expect(md).toContain("Running: 1 / 5");
    expect(md).toContain("Queued: 1");
    expect(md).toContain("## Running");
    expect(md).toMatch(/PR #1147.*Add tunnel cache/);
    expect(md).toContain("## Queued");
    expect(md).toMatch(/PR #1152.*Bugfix/);
    expect(md).toContain("## Pending confirmation");
    expect(md).toMatch(/PR #1100.*Big refactor/);
    // Pending-confirmation section carries a discoverability hint about
    // keep-context (only renders when at least one pending row exists).
    expect(md).toContain("marshal-review-queue keep-context");
  });

  it("annotates a pending-confirmation row with `keep-context queued` when the flag is set", () => {
    const s = defaultState();
    s.prs[1] = {
      url: "https://github.com/OmerMachluf/marshal/pull/1",
      title: "T",
      author: "a",
      tier: "other",
      sizeBucket: "S",
      currentHeadSha: "sha",
      latestReviewedSha: "sha",
      status: "pending-confirmation",
      iterations: [
        {
          sha: "sha",
          sessionId: "cc-abc",
          agentRuntime: "claude",
          startedAt: "2026-05-09T11:30:00Z",
          completedAt: "2026-05-09T11:38:00Z",
          status: "pending-confirmation",
        },
      ],
      keepContextNextIteration: true,
    };
    const md = renderStatusMd(s, new Date("2026-05-09T12:00:00Z"));
    expect(md).toContain("keep-context queued");
  });
});
