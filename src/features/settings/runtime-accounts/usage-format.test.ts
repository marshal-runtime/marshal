import { describe, expect, it } from "vitest";

import { formatUsageReset, sortUsageWindows, usageWindowLabel } from "./usage-format";

const NOW = Date.parse("2026-10-18T08:00:00Z");
const MINUTE = 60_000;

describe("formatUsageReset", () => {
  it("counts down within a day", () => {
    expect(formatUsageReset(NOW + 135 * MINUTE, NOW)).toBe("resets in 2h 15m");
    expect(formatUsageReset(NOW + 20 * MINUTE, NOW)).toBe("resets in 20m");
    expect(formatUsageReset(NOW + 5_000, NOW)).toBe("resets in 1m");
  });

  it("names the weekday beyond a day, and handles past or missing resets", () => {
    expect(formatUsageReset(NOW + 3 * 24 * 60 * MINUTE, NOW)).toMatch(/^resets \w{3}/);
    expect(formatUsageReset(NOW - 1, NOW)).toBe("resetting now");
    expect(formatUsageReset(undefined, NOW)).toBeNull();
  });
});

describe("usage window presentation", () => {
  it("orders windows five-hour, weekly, Opus, Sonnet, then others", () => {
    const window = (kind: Parameters<typeof usageWindowLabel>[0]["kind"], label?: string) => ({
      kind,
      ...(label ? { label } : {}),
      usedPercent: 1,
      source: "fetch" as const,
      fetchedAt: 1,
    });
    const sorted = sortUsageWindows([
      window("other", "Fable"),
      window("weekly_sonnet"),
      window("weekly"),
      window("weekly_opus"),
      window("five_hour"),
    ]);
    expect(sorted.map(usageWindowLabel)).toEqual([
      "5-hour",
      "Weekly",
      "Opus weekly",
      "Sonnet weekly",
      "Fable limit",
    ]);
  });
});
