// Marshal-owned test
import { describe, it, expect } from "vitest";

import { aggregateMultiStepRuns } from "./history-aggregator";

describe("aggregateMultiStepRuns", () => {
  const parentId = "parent-1";
  const stepCount = 3;

  it("groups parent + tail run-log entries into one AutomationRunData", () => {
    const parentRuns = [
      {
        runAtMs: 1000,
        ts: 1000,
        durationMs: 100,
        status: "ok" as const,
        sessionId: "s",
        summary: "step 1 ok",
      },
    ];
    const tailRunsById = new Map<
      string,
      Array<{
        runAtMs?: number;
        ts: number;
        durationMs?: number;
        status: "ok" | "error" | "skipped";
        summary?: string;
        error?: string;
      }>
    >([
      [
        "tail-1-id",
        [{ runAtMs: 1200, ts: 1200, durationMs: 200, status: "ok", summary: "step 2 ok" }],
      ],
      [
        "tail-2-id",
        [{ runAtMs: 1500, ts: 1500, durationMs: 100, status: "ok", summary: "step 3 ok" }],
      ],
    ]);
    const tailMeta = [
      { id: "tail-1-id", name: `auto-${parentId}-r1000-s1` },
      { id: "tail-2-id", name: `auto-${parentId}-r1000-s2` },
    ];

    const runs = aggregateMultiStepRuns({
      parentId,
      stepCount,
      parentRuns,
      tailMeta,
      tailRunsById,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("completed");
    expect(runs[0].stepResults).toHaveLength(3);
    expect(runs[0].stepResults[0].status).toBe("completed");
    expect(runs[0].stepResults[1].status).toBe("completed");
    expect(runs[0].stepResults[2].status).toBe("completed");
  });

  it("marks remaining steps as 'skipped' when a step failed", () => {
    const parentRuns = [
      { runAtMs: 1000, ts: 1000, durationMs: 100, status: "ok" as const, summary: "step 1 ok" },
    ];
    const tailRunsById = new Map([
      [
        "t1",
        [{ runAtMs: 1200, ts: 1200, durationMs: 100, status: "error" as const, error: "boom" }],
      ],
    ]);
    const tailMeta = [{ id: "t1", name: `auto-${parentId}-r1000-s1` }];

    const runs = aggregateMultiStepRuns({
      parentId,
      stepCount: 3,
      parentRuns,
      tailMeta,
      tailRunsById,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].stepResults[0].status).toBe("completed");
    expect(runs[0].stepResults[1].status).toBe("failed");
    expect(runs[0].stepResults[2].status).toBe("skipped");
  });

  it("treats step as 'running' when tail is scheduled but no run-log entry yet", () => {
    const parentRuns = [
      { runAtMs: 1000, ts: 1000, durationMs: 50, status: "ok" as const, summary: "step 1 ok" },
    ];
    const tailRunsById = new Map<
      string,
      Array<{
        runAtMs?: number;
        ts: number;
        durationMs?: number;
        status: "ok" | "error" | "skipped";
        summary?: string;
        error?: string;
      }>
    >([["t1", []]]);
    const tailMeta = [{ id: "t1", name: `auto-${parentId}-r1000-s1` }];

    const runs = aggregateMultiStepRuns({
      parentId,
      stepCount: 3,
      parentRuns,
      tailMeta,
      tailRunsById,
    });
    expect(runs[0].status).toBe("running");
    expect(runs[0].stepResults[1].status).toBe("running");
  });

  it("dedups duplicate tail crons by stepIndex (keeps the earliest by id)", () => {
    const parentRuns = [
      { runAtMs: 1000, ts: 1000, durationMs: 50, status: "ok" as const, summary: "ok" },
    ];
    const tailRunsById = new Map([
      [
        "aaa-tail",
        [{ runAtMs: 1200, ts: 1200, durationMs: 80, status: "ok" as const, summary: "first" }],
      ],
      [
        "bbb-tail",
        [{ runAtMs: 1250, ts: 1250, durationMs: 80, status: "ok" as const, summary: "second" }],
      ],
    ]);
    const tailMeta = [
      { id: "aaa-tail", name: `auto-${parentId}-r1000-s1` },
      { id: "bbb-tail", name: `auto-${parentId}-r1000-s1` },
    ];

    const runs = aggregateMultiStepRuns({
      parentId,
      stepCount: 2,
      parentRuns,
      tailMeta,
      tailRunsById,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].stepResults).toHaveLength(2);
    expect(runs[0].stepResults[1].output).toBe("first");
  });

  it("returns one AutomationRunData per parent runInstance (chain instance)", () => {
    const parentRuns = [
      { runAtMs: 1000, ts: 1000, durationMs: 50, status: "ok" as const, summary: "Mon ok" },
      {
        runAtMs: 86_401_000,
        ts: 86_401_000,
        durationMs: 50,
        status: "ok" as const,
        summary: "Tue ok",
      },
    ];
    const tailRunsById = new Map([
      [
        "t-mon",
        [{ runAtMs: 1100, ts: 1100, durationMs: 80, status: "ok" as const, summary: "Mon s2" }],
      ],
      [
        "t-tue",
        [
          {
            runAtMs: 86_401_100,
            ts: 86_401_100,
            durationMs: 80,
            status: "ok" as const,
            summary: "Tue s2",
          },
        ],
      ],
    ]);
    const tailMeta = [
      { id: "t-mon", name: `auto-${parentId}-r1000-s1` },
      { id: "t-tue", name: `auto-${parentId}-r86401000-s1` },
    ];

    const runs = aggregateMultiStepRuns({
      parentId,
      stepCount: 2,
      parentRuns,
      tailMeta,
      tailRunsById,
    });
    expect(runs).toHaveLength(2);
  });

  it("completedAt reflects the last successful step's time, not just the parent", () => {
    // Parent finished at 1000+100 = 1100. Last tail finished at 5000+200 = 5200.
    // completedAt must be 5200, not 1100.
    const parentRuns = [
      { runAtMs: 1000, ts: 1000, durationMs: 100, status: "ok" as const, summary: "step 1 ok" },
    ];
    const tailRunsById = new Map<
      string,
      Array<{
        runAtMs?: number;
        ts: number;
        durationMs?: number;
        status: "ok" | "error" | "skipped";
        summary?: string;
        error?: string;
      }>
    >([
      ["t1", [{ runAtMs: 3000, ts: 3000, durationMs: 100, status: "ok", summary: "step 2 ok" }]],
      ["t2", [{ runAtMs: 5000, ts: 5000, durationMs: 200, status: "ok", summary: "step 3 ok" }]],
    ]);
    const tailMeta = [
      { id: "t1", name: `auto-${parentId}-r1000-s1` },
      { id: "t2", name: `auto-${parentId}-r1000-s2` },
    ];

    const runs = aggregateMultiStepRuns({
      parentId,
      stepCount: 3,
      parentRuns,
      tailMeta,
      tailRunsById,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("completed");
    expect(runs[0].completedAt).toBe(new Date(5200).toISOString());
  });

  it("marks all tail steps as 'skipped' when step 0 (parent) fails", () => {
    // If the parent step itself fails, no tails will exist (orchestrator
    // short-circuits on error). The aggregator must still pad the chain with
    // 'skipped' so the UI shows a complete chain shape rather than a stub.
    const parentRuns = [
      { runAtMs: 1000, ts: 1000, durationMs: 100, status: "error" as const, error: "boom" },
    ];
    const runs = aggregateMultiStepRuns({
      parentId,
      stepCount: 3,
      parentRuns,
      tailMeta: [],
      tailRunsById: new Map(),
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].stepResults).toHaveLength(3);
    expect(runs[0].stepResults[0].status).toBe("failed");
    expect(runs[0].stepResults[1].status).toBe("skipped");
    expect(runs[0].stepResults[2].status).toBe("skipped");
  });

  it("ignores tails belonging to a different parent", () => {
    const parentRuns = [
      { runAtMs: 1000, ts: 1000, durationMs: 50, status: "ok" as const, summary: "ok" },
    ];
    const tailRunsById = new Map([
      [
        "ours",
        [{ runAtMs: 1100, ts: 1100, durationMs: 80, status: "ok" as const, summary: "ours" }],
      ],
      [
        "other",
        [{ runAtMs: 1100, ts: 1100, durationMs: 80, status: "ok" as const, summary: "other" }],
      ],
    ]);
    const tailMeta = [
      { id: "ours", name: `auto-${parentId}-r1000-s1` },
      { id: "other", name: `auto-other-parent-r1000-s1` },
    ];

    const runs = aggregateMultiStepRuns({
      parentId,
      stepCount: 2,
      parentRuns,
      tailMeta,
      tailRunsById,
    });
    expect(runs[0].stepResults[1].output).toBe("ours");
  });
});
