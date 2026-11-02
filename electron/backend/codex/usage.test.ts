import { describe, expect, it } from "vitest";

import { codexUsageFromRateLimits } from "./usage";

const NOW = Date.parse("2026-10-18T08:00:00Z");

describe("codexUsageFromRateLimits", () => {
  it("maps the 5-hour and weekly windows from unix-second resets", () => {
    const usage = codexUsageFromRateLimits(
      {
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_792_000_000 },
        secondary: { usedPercent: 60.04, windowDurationMins: 10_080, resetsAt: 1_792_500_000 },
      },
      { plan: "Plus", source: "fetch", now: NOW },
    );

    expect(usage).toEqual({
      available: true,
      plan: "plus",
      fetchedAt: NOW,
      windows: [
        {
          kind: "five_hour",
          usedPercent: 12,
          resetsAt: 1_792_000_000_000,
          source: "fetch",
          fetchedAt: NOW,
        },
        {
          kind: "weekly",
          usedPercent: 60,
          resetsAt: 1_792_500_000_000,
          source: "fetch",
          fetchedAt: NOW,
        },
      ],
    });
  });

  it("labels windows of any other length and tolerates missing fields", () => {
    const usage = codexUsageFromRateLimits(
      {
        primary: { usedPercent: 150, windowDurationMins: 90 },
        secondary: { windowDurationMins: 300 },
      },
      { source: "event", now: NOW },
    );

    expect(usage).toMatchObject({
      available: true,
      windows: [{ kind: "other", label: "90-minute", usedPercent: 100, source: "event" }],
    });
    expect(usage.available && "plan" in usage).toBe(false);
  });

  it("returns no windows for an unusable snapshot", () => {
    expect(codexUsageFromRateLimits(null, { source: "fetch", now: NOW })).toMatchObject({
      available: true,
      windows: [],
    });
  });
});
