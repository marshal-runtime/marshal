import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { StateStore } from "../src/marshal-review-state-store.ts";
import { defaultState } from "../src/marshal-review-types.ts";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rq-state-"));
  process.env.MARSHAL_REVIEW_QUEUE_HOME = tmp;
});

afterEach(async () => {
  delete process.env.MARSHAL_REVIEW_QUEUE_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("StateStore", () => {
  it("returns default state when file missing", async () => {
    const store = await StateStore.create();
    const s = store.snapshot();
    expect(s.version).toBe(1);
    expect(s.prs).toEqual({});
    expect(s.queue).toEqual([]);
  });

  it("round-trips state through disk", async () => {
    const a = await StateStore.create();
    await a.transaction((draft) => {
      draft.queue = [42];
      draft.config.maxConcurrent = 3;
    });

    const b = await StateStore.create();
    const s = b.snapshot();
    expect(s.queue).toEqual([42]);
    expect(s.config.maxConcurrent).toBe(3);
  });

  it("writes atomically (state.json never half-written)", async () => {
    const store = await StateStore.create();
    const writes = Array.from({ length: 50 }, (_, i) =>
      store.transaction((draft) => {
        draft.queue = [i + 1];
      }),
    );
    await Promise.all(writes);

    const raw = await fs.readFile(path.join(tmp, "state.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("rejects writes that would produce schema-invalid state", async () => {
    const store = await StateStore.create();
    await expect(
      store.transaction((draft) => {
        // Negative test: bypass the type checker so zod's positive() rejects at runtime.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        draft.config.maxConcurrent = -1 as never;
      }),
    ).rejects.toThrow();
  });
});

describe("StateStore: status.md rendering", () => {
  it("writes status.md after every transaction", async () => {
    const store = await StateStore.create();
    await store.transaction((draft) => {
      draft.queue = [42];
    });

    const md = await fs.readFile(path.join(tmp, "status.md"), "utf8");
    expect(md).toContain("# marshal-review-queue status");
    expect(md).toContain("Queued: 1");
  });
});

describe("StateStore: crash recovery", () => {
  it("on init, flips orphaned running entries to crashed", async () => {
    const seed = defaultState();
    seed.running = [
      { prNumber: 1, sessionId: "s-1", childPid: 99999, startedAt: "2026-05-09T10:00:00Z" },
    ];
    seed.prs[1] = {
      url: "https://github.com/x/y/pull/1",
      title: "t",
      author: "a",
      tier: "other",
      sizeBucket: "S",
      currentHeadSha: "abc",
      latestReviewedSha: null,
      status: "running",
      iterations: [
        {
          sha: "abc",
          sessionId: "s-1",
          agentRuntime: "claude",
          startedAt: "2026-05-09T10:00:00Z",
          status: "running",
        },
      ],
    };
    await fs.writeFile(path.join(tmp, "state.json"), JSON.stringify(seed));

    const store = await StateStore.create();
    const s = store.snapshot();

    expect(s.running).toEqual([]);
    expect(s.prs[1]?.status).toBe("crashed");
    expect(s.prs[1]?.iterations.at(-1)?.status).toBe("crashed");
    expect(s.prs[1]?.iterations.at(-1)?.failureReason).toMatch(/daemon restart/i);
  });
});
