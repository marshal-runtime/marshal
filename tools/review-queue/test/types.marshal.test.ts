// Marshal-owned tooling test.
import { describe, it, expect } from "vitest";

import { StateSchema, defaultState } from "../src/marshal-review-types.ts";

describe("types: StateSchema", () => {
  it("parses a default state", () => {
    const s = defaultState();
    const parsed = StateSchema.parse(s);
    expect(parsed.version).toBe(1);
    expect(parsed.queue).toEqual([]);
    expect(parsed.running).toEqual([]);
    expect(parsed.config.maxConcurrent).toBe(5);
    expect(parsed.config.cooldownMinutes).toBe(60);
    expect(parsed.config.defaultRuntime).toBe("claude");
  });

  it("rejects unknown PrStatus", () => {
    const s = defaultState();
    s.prs[1] = {
      url: "https://github.com/x/y/pull/1",
      title: "t",
      author: "a",
      tier: "other",
      sizeBucket: "S",
      currentHeadSha: "abc",
      latestReviewedSha: null,
      // Negative test: bypass the type checker so zod rejects at runtime.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      status: "totally-bogus" as never,
      iterations: [],
    };
    expect(() => StateSchema.parse(s)).toThrow();
  });

  it("accepts a fully-populated PR row with iterations", () => {
    const s = defaultState();
    s.prs[1147] = {
      url: "https://github.com/OmerMachluf/marshal/pull/1147",
      title: "Add tunnel cache",
      author: "alice",
      tier: "maintainer",
      sizeBucket: "M",
      currentHeadSha: "7f3a9c2",
      latestReviewedSha: "7f3a9c2",
      status: "pending-confirmation",
      iterations: [
        {
          sha: "7f3a9c2",
          sessionId: "cc-abc",
          agentRuntime: "claude",
          startedAt: "2026-05-09T11:30:00Z",
          completedAt: "2026-05-09T11:39:00Z",
          status: "pending-confirmation",
        },
      ],
    };
    expect(() => StateSchema.parse(s)).not.toThrow();
  });
});
