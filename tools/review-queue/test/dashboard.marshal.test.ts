// Marshal-owned tooling test.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { runDashboard, parseDashboardJson, dashboardPrsInPriorityOrder } from "../src/marshal-review-dashboard.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "marshal-fixtures/dashboard-sample.json");

describe("parseDashboardJson", () => {
  it("parses the captured fixture without throwing", async () => {
    const raw = await fs.readFile(FIXTURE, "utf8");
    const parsed = parseDashboardJson(raw);
    expect(parsed.buckets.needs_review).toBeInstanceOf(Array);
  });

  it("rejects garbage", () => {
    expect(() => parseDashboardJson("not json")).toThrow();
    expect(() => parseDashboardJson('{"buckets": "wrong"}')).toThrow();
  });
});

describe("dashboardPrsInPriorityOrder", () => {
  it("yields stale_my_review first, then needs_review (by tier), then my_prs_with_feedback", () => {
    // Test fixture is intentionally minimal — dashboardPrsInPriorityOrder only
    // reads .tier and .number, so the partial shape is fine for this test.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const out = {
      generated_at: "now",
      me: "me",
      window_days: 3,
      buckets: {
        stale_my_review: [{ number: 100 }],
        needs_review: [
          { number: 200, tier: "other" },
          { number: 201, tier: "maintainer" },
          { number: 202, tier: "trusted" },
        ],
        my_prs_with_feedback: [{ number: 300 }],
        hidden_failing_ci: [],
      },
    } as never;
    const order = dashboardPrsInPriorityOrder(out).map((p) => p.number);
    expect(order).toEqual([100, 201, 202, 200, 300]);
  });
});

describe("runDashboard (smoke)", () => {
  it("invokes the configured command and returns parsed output", async () => {
    const cmd = [
      process.execPath,
      "-e",
      `process.stdout.write(${JSON.stringify(
        JSON.stringify({
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
      )})`,
    ];
    const out = await runDashboard({ cwd: process.cwd(), dashboardCmd: cmd });
    expect(out.me).toBe("me");
  });

  it("kills a hung child and rejects when timeoutMs elapses", async () => {
    const cmd = [process.execPath, "-e", "setInterval(() => {}, 1000)"];
    const started = Date.now();
    await expect(
      runDashboard({ cwd: process.cwd(), dashboardCmd: cmd }, { timeoutMs: 200 }),
    ).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
