import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatCompactElapsed,
  formatElapsed,
  formatTokenCount,
  humanizeDuration,
  truncateObjective,
} from "./format";

function makeGoal(
  overrides: Partial<{
    lifecycle: string;
    activeMs: number;
    startedPursuingAt: string | null;
  }> = {},
) {
  return {
    lifecycle: "pursuing",
    activeMs: 0,
    startedPursuingAt: null,
    ...overrides,
  };
}

describe("formatTokenCount", () => {
  it("renders raw counts under 1000", () => {
    expect(formatTokenCount(850)).toBe("850");
    expect(formatTokenCount(0)).toBe("0");
  });

  it("renders thousands with a K suffix", () => {
    expect(formatTokenCount(4200)).toBe("4.2K");
    expect(formatTokenCount(12000)).toBe("12K");
  });

  it("renders millions with an M suffix", () => {
    expect(formatTokenCount(12_000_000)).toBe("12M");
    expect(formatTokenCount(4_200_000)).toBe("4.2M");
  });
});

describe("humanizeDuration", () => {
  it("renders seconds", () => {
    expect(humanizeDuration(30_000)).toBe("30 seconds");
    expect(humanizeDuration(1000)).toBe("1 second");
  });

  it("renders minutes", () => {
    expect(humanizeDuration(45 * 60_000)).toBe("45 minutes");
    expect(humanizeDuration(60_000)).toBe("1 minute");
  });

  it("renders hours with an 'about' qualifier except exact singular", () => {
    expect(humanizeDuration(3_600_000)).toBe("1 hour");
    expect(humanizeDuration(2 * 3_600_000)).toBe("about 2 hours");
  });

  it("renders days", () => {
    expect(humanizeDuration(3 * 86_400_000)).toBe("about 3 days");
    expect(humanizeDuration(86_400_000)).toBe("1 day");
  });

  it("handles zero / invalid input", () => {
    expect(humanizeDuration(0)).toBe("0 seconds");
    expect(humanizeDuration(-5)).toBe("0 seconds");
  });
});

describe("formatElapsed", () => {
  afterEach(() => vi.useRealTimers());

  it("returns activeMs when not pursuing", () => {
    const goal = makeGoal({ lifecycle: "paused", activeMs: 5000 });
    expect(formatElapsed(goal)).toBe(5000);
  });

  it("adds the live tail while pursuing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:10.000Z"));
    const goal = makeGoal({
      lifecycle: "pursuing",
      activeMs: 2000,
      startedPursuingAt: "2025-01-01T00:00:00.000Z",
    });
    expect(formatElapsed(goal)).toBe(12_000);
  });
});

describe("formatCompactElapsed", () => {
  it("renders hours and minutes", () => {
    expect(formatCompactElapsed(83 * 60_000)).toBe("1h 23m");
  });

  it("renders minutes and seconds", () => {
    expect(formatCompactElapsed(5 * 60_000 + 9000)).toBe("5m 9s");
  });

  it("renders bare seconds", () => {
    expect(formatCompactElapsed(7000)).toBe("7s");
  });
});

describe("truncateObjective", () => {
  it("leaves short strings untouched", () => {
    expect(truncateObjective("short goal")).toBe("short goal");
  });

  it("truncates long strings with an ellipsis", () => {
    const long = "a".repeat(80);
    const result = truncateObjective(long, 60);
    expect(result).toHaveLength(61);
    expect(result.endsWith("\u2026")).toBe(true);
  });
});
