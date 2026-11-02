import * as fs from "fs";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");
vi.mock("../platform-security", async () => {
  const mockedFs = await import("fs");
  return {
    secureMkdirSync: (dir: string, mode: number) =>
      mockedFs.mkdirSync(dir, { recursive: true, mode }),
    secureWriteFileSync: (file: string, data: string | Buffer) =>
      mockedFs.writeFileSync(file, data),
  };
});
vi.mock("../app-paths", () => ({ getAppDataDir: () => "/tmp/test-home" }));
vi.mock("../mock-mode", () => ({
  isMockMode: () => false,
}));
vi.mock("electron", () => ({ app: { isPackaged: false } }));

const mockedFs = vi.mocked(fs);

beforeEach(() => {
  vi.clearAllMocks();
  mockedFs.existsSync.mockReturnValue(false);
  mockedFs.mkdirSync.mockImplementation(() => undefined);
  mockedFs.writeFileSync.mockImplementation(() => {});
  mockedFs.readFileSync.mockReturnValue("[]");
  mockedFs.rmSync.mockImplementation(() => {});
});

import type { StrictAutomationSchedule } from "./domain/contracts";
import {
  ALL_DAYS,
  MAX_ONE_OFF_AHEAD_MS,
  ONE_OFF_ERRORS,
  WEEKDAYS,
  WEEKENDS,
  formatScheduleNL,
  normalizeSchedule,
  parseSchedule,
  resolveOneOffInstant,
  resolveOneOffSchedule,
} from "./schedule";
import { asInterval, asMulti, asSingle } from "./testing/schedule-assertions";

function requireSchedule(input: string): StrictAutomationSchedule {
  const schedule = parseSchedule(input);
  expect(schedule).not.toBeNull();
  if (!schedule) throw new Error(`Expected schedule for: ${input}`);
  return schedule;
}

describe("parseSchedule", () => {
  it('parses "every day at 9am"', () => {
    const s = requireSchedule("every day at 9am");
    expect(s.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(s.hour).toBe(9);
    expect(s.minute).toBe(0);
  });

  it('parses "every day at 10:30am"', () => {
    const s = requireSchedule("every day at 10:30am");
    expect(s.hour).toBe(10);
    expect(s.minute).toBe(30);
  });

  it('parses "every weekday at 2pm"', () => {
    const s = requireSchedule("every weekday at 2pm");
    expect(s.days).toEqual([1, 2, 3, 4, 5]);
    expect(s.hour).toBe(14);
    expect(s.minute).toBe(0);
  });

  it('parses "every weekend at 11:00"', () => {
    const s = requireSchedule("every weekend at 11:00");
    expect(s.days).toEqual([0, 6]);
    expect(s.hour).toBe(11);
    expect(s.minute).toBe(0);
  });

  it('parses "every monday at 9am"', () => {
    const s = requireSchedule("every monday at 9am");
    expect(s.days).toEqual([1]);
    expect(s.hour).toBe(9);
  });

  it('parses "every friday at 3:45pm"', () => {
    const s = requireSchedule("every friday at 3:45pm");
    expect(s.days).toEqual([5]);
    expect(s.hour).toBe(15);
    expect(s.minute).toBe(45);
  });

  it("handles 12pm correctly (noon)", () => {
    const s = requireSchedule("every day at 12pm");
    expect(s.hour).toBe(12);
  });

  it("handles 12am correctly (midnight)", () => {
    const s = requireSchedule("every day at 12am");
    expect(s.hour).toBe(0);
  });

  it("preserves naturalLanguage input", () => {
    const input = "every weekday at 9am";
    const s = requireSchedule(input);
    expect(s.naturalLanguage).toBe(input);
  });

  it("returns null for unrecognized input", () => {
    expect(parseSchedule("never")).toBeNull();
    expect(parseSchedule("")).toBeNull();
    expect(parseSchedule("at 9")).toBeNull();
  });

  it('parses "every weekday at 14:30"', () => {
    const s = requireSchedule("every weekday at 14:30");
    expect(s.days).toEqual([1, 2, 3, 4, 5]);
    expect(s.hour).toBe(14);
    expect(s.minute).toBe(30);
  });

  it("returns null for unparseable input", () => {
    expect(parseSchedule("sometime next week")).toBeNull();
  });

  it('parses bare "Monday at 9am" (one-shot, no "every")', () => {
    const s = requireSchedule("Monday at 9am");
    expect(s).not.toBeNull();
    expect(s.days).toEqual([1]);
    expect(s.hour).toBe(9);
    expect(s.minute).toBe(0);
    expect(s.naturalLanguage).toBe("Monday at 9am");
  });

  it('parses bare "Friday at 2:30pm" (one-shot)', () => {
    const s = requireSchedule("Friday at 2:30pm");
    expect(s.days).toEqual([5]);
    expect(s.hour).toBe(14);
    expect(s.minute).toBe(30);
  });

  // Ordinal schedule tests
  it('parses "every first Monday at 8:00am" as weekly Monday', () => {
    const s = requireSchedule("every first Monday at 8:00am");
    expect(s).not.toBeNull();
    expect(s.days).toEqual([1]);
    expect(s.hour).toBe(8);
    expect(s.minute).toBe(0);
  });

  it('parses "every second Wednesday at 10am" as weekly Wednesday', () => {
    const s = requireSchedule("every second Wednesday at 10am");
    expect(s).not.toBeNull();
    expect(s.days).toEqual([3]);
    expect(s.hour).toBe(10);
    expect(s.minute).toBe(0);
  });

  it('parses "every 2nd Wednesday at 10am" (numeric ordinal)', () => {
    const s = requireSchedule("every 2nd Wednesday at 10am");
    expect(s).not.toBeNull();
    expect(s.days).toEqual([3]);
    expect(s.hour).toBe(10);
  });

  it('parses "every 1st Friday at 3pm" (numeric ordinal)', () => {
    const s = requireSchedule("every 1st Friday at 3pm");
    expect(s).not.toBeNull();
    expect(s.days).toEqual([5]);
    expect(s.hour).toBe(15);
  });

  it('parses "every last Thursday at 4pm"', () => {
    const s = requireSchedule("every last Thursday at 4pm");
    expect(s).not.toBeNull();
    expect(s.days).toEqual([4]);
    expect(s.hour).toBe(16);
  });

  it('parses "every fifth Tuesday at 9am"', () => {
    const s = requireSchedule("every fifth Tuesday at 9am");
    expect(s).not.toBeNull();
    expect(s.days).toEqual([2]);
    expect(s.hour).toBe(9);
  });

  it('rejects "every first banana at 8am" (invalid day name)', () => {
    expect(parseSchedule("every first banana at 8am")).toBeNull();
  });

  it('rejects "every 21st Monday at 9am" (impossible ordinal)', () => {
    expect(parseSchedule("every 21st Monday at 9am")).toBeNull();
  });

  it('rejects "every 99th Monday at 9am" (impossible ordinal)', () => {
    expect(parseSchedule("every 99th Monday at 9am")).toBeNull();
  });

  // --- New patterns ---
  it('parses "daily at 8am"', () => {
    const s = requireSchedule("daily at 8am");
    expect(s).not.toBeNull();
    expect(s.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(s.hour).toBe(8);
    expect(s.minute).toBe(0);
  });

  it('parses "weekdays at 9:30am"', () => {
    const s = requireSchedule("weekdays at 9:30am");
    expect(s).not.toBeNull();
    expect(s.days).toEqual([1, 2, 3, 4, 5]);
    expect(s.hour).toBe(9);
    expect(s.minute).toBe(30);
  });

  it('parses "weekends at 10am"', () => {
    const s = requireSchedule("weekends at 10am");
    expect(s).not.toBeNull();
    expect(s.days).toEqual([0, 6]);
    expect(s.hour).toBe(10);
  });

  it('parses "at 8am every weekday" (reversed order)', () => {
    const s = requireSchedule("at 8am every weekday");
    expect(s).not.toBeNull();
    expect(s.days).toEqual([1, 2, 3, 4, 5]);
    expect(s.hour).toBe(8);
  });

  it('parses "at 3pm every day" (reversed order)', () => {
    const s = requireSchedule("at 3pm every day");
    expect(s).not.toBeNull();
    expect(s.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(s.hour).toBe(15);
  });

  it('parses "at 10:30am every monday" (reversed with day)', () => {
    const s = requireSchedule("at 10:30am every monday");
    expect(s).not.toBeNull();
    expect(s.days).toEqual([1]);
    expect(s.hour).toBe(10);
    expect(s.minute).toBe(30);
  });

  it('parses "Mondays at 8am" (plural day name)', () => {
    const s = requireSchedule("Mondays at 8am");
    expect(s).not.toBeNull();
    expect(s.days).toEqual([1]);
    expect(s.hour).toBe(8);
  });

  it('parses "every Fridays at 4pm" (plural with every)', () => {
    const s = requireSchedule("every Fridays at 4pm");
    expect(s).not.toBeNull();
    expect(s.days).toEqual([5]);
    expect(s.hour).toBe(16);
  });

  // --- Time validation ---
  it("rejects hour > 23 (24:00)", () => {
    expect(parseSchedule("every day at 24:00")).toBeNull();
  });

  it("rejects minute > 59 (9:99)", () => {
    expect(parseSchedule("every day at 9:99")).toBeNull();
  });

  it("rejects 13pm (invalid am/pm)", () => {
    expect(parseSchedule("every day at 13pm")).toBeNull();
  });

  it("rejects 13am (invalid am/pm)", () => {
    expect(parseSchedule("every day at 13am")).toBeNull();
  });

  it("rejects 0am (invalid 12-hour clock)", () => {
    expect(parseSchedule("every day at 0am")).toBeNull();
  });

  it("rejects 0pm (invalid 12-hour clock)", () => {
    expect(parseSchedule("every day at 0pm")).toBeNull();
  });

  // --- Anchoring ---
  it("rejects trailing text after a valid pattern", () => {
    expect(parseSchedule("every weekday at 8am except holidays")).toBeNull();
  });

  it("rejects leading text before a valid pattern", () => {
    expect(parseSchedule("please run every weekday at 8am")).toBeNull();
  });

  it("rejects partial-invalid multi-day patterns", () => {
    expect(parseSchedule("every monday and banana at 9am")).toBeNull();
  });

  it('parses valid multi-day "every monday and wednesday at 9am"', () => {
    const s = requireSchedule("every monday and wednesday at 9am");
    expect(s).not.toBeNull();
    expect(s.days).toEqual([1, 3]);
    expect(s.hour).toBe(9);
  });

  // --- Interval patterns ---
  it('parses "every hour"', () => {
    const s = requireSchedule("every hour");
    expect(s).not.toBeNull();
    expect(s.kind).toBe("interval");
    expect(s.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const interval = asInterval(s);
    expect(interval.intervalMinutes).toBe(60);
    expect(interval.anchor).toEqual({ hour: 0, minute: 0 });
  });

  it('parses "hourly"', () => {
    const s = requireSchedule("hourly");
    expect(asInterval(s).intervalMinutes).toBe(60);
  });

  it('parses "every 30 minutes"', () => {
    const s = requireSchedule("every 30 minutes");
    expect(asInterval(s).intervalMinutes).toBe(30);
  });

  it('parses "every 2 hours"', () => {
    const s = requireSchedule("every 2 hours");
    expect(asInterval(s).intervalMinutes).toBe(120);
  });

  it('parses "every 15 minutes"', () => {
    const s = requireSchedule("every 15 minutes");
    expect(asInterval(s).intervalMinutes).toBe(15);
  });

  it('parses "every hour at :15"', () => {
    const s = requireSchedule("every hour at :15");
    const interval = asInterval(s);
    expect(interval.intervalMinutes).toBe(60);
    expect(interval.anchor).toEqual({ hour: 0, minute: 15 });
  });

  it('parses "every 2 hours at :30"', () => {
    const s = requireSchedule("every 2 hours at :30");
    const interval = asInterval(s);
    expect(interval.intervalMinutes).toBe(120);
    expect(interval.anchor).toEqual({ hour: 0, minute: 30 });
  });

  it('parses "every hour during weekdays"', () => {
    const s = requireSchedule("every hour during weekdays");
    expect(s.kind).toBe("interval");
    expect(s.days).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses "every 30 minutes on weekdays"', () => {
    const s = requireSchedule("every 30 minutes on weekdays");
    expect(s.kind).toBe("interval");
    expect(s.days).toEqual([1, 2, 3, 4, 5]);
    expect(asInterval(s).intervalMinutes).toBe(30);
  });

  it("preserves naturalLanguage for interval", () => {
    const input = "Every Hour At :15";
    const s = requireSchedule(input);
    expect(s.naturalLanguage).toBe(input);
  });

  it("sets compat hour/minute from anchor for interval", () => {
    const s = requireSchedule("every hour at :15");
    expect(s.hour).toBe(0);
    expect(s.minute).toBe(15);
  });

  it('parses "every hour at :15 during weekdays" (anchor + day scope)', () => {
    const s = requireSchedule("every hour at :15 during weekdays");
    expect(s).not.toBeNull();
    expect(s.kind).toBe("interval");
    expect(s.days).toEqual([1, 2, 3, 4, 5]);
    const interval = asInterval(s);
    expect(interval.intervalMinutes).toBe(60);
    expect(interval.anchor).toEqual({ hour: 0, minute: 15 });
  });

  // --- Interval rejections ---
  it("rejects every 0 minutes", () => {
    expect(parseSchedule("every 0 minutes")).toBeNull();
  });

  it("rejects every 7 minutes (non-divisor of 1440)", () => {
    expect(parseSchedule("every 7 minutes")).toBeNull();
  });

  it("rejects every 1441 minutes", () => {
    expect(parseSchedule("every 1441 minutes")).toBeNull();
  });

  it("rejects every hour at :60", () => {
    expect(parseSchedule("every hour at :60")).toBeNull();
  });

  it("rejects every hour please (trailing junk)", () => {
    expect(parseSchedule("every hour please")).toBeNull();
  });

  it('parses "every 1 minute"', () => {
    const s = requireSchedule("every 1 minute");
    expect(asInterval(s).intervalMinutes).toBe(1);
  });

  it('parses "every 720 minutes" (12 hours)', () => {
    const s = requireSchedule("every 720 minutes");
    expect(asInterval(s).intervalMinutes).toBe(720);
  });

  // --- Multi-time patterns ---
  it('parses "every day at 10am, 2pm, and 6pm"', () => {
    const s = requireSchedule("every day at 10am, 2pm, and 6pm");
    expect(s).not.toBeNull();
    const multi = asMulti(s);
    expect(multi.times).toHaveLength(3);
    expect(multi.times[0]).toEqual({ hour: 10, minute: 0 });
    expect(multi.times[1]).toEqual({ hour: 14, minute: 0 });
    expect(multi.times[2]).toEqual({ hour: 18, minute: 0 });
    expect(s.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('parses "weekdays at 9am and 5pm"', () => {
    const s = requireSchedule("weekdays at 9am and 5pm");
    expect(s.kind).toBe("multi");
    expect(s.days).toEqual([1, 2, 3, 4, 5]);
    const multi = asMulti(s);
    expect(multi.times).toHaveLength(2);
    expect(multi.times[0]).toEqual({ hour: 9, minute: 0 });
    expect(multi.times[1]).toEqual({ hour: 17, minute: 0 });
  });

  it('parses "daily at 8am, 12pm, 4pm, 8pm"', () => {
    const s = requireSchedule("daily at 8am, 12pm, 4pm, 8pm");
    const multi = asMulti(s);
    expect(multi.times).toHaveLength(4);
    expect(multi.times.map((t) => t.hour)).toEqual([8, 12, 16, 20]);
  });

  it('parses "every monday and wednesday at 9am, 2pm"', () => {
    const s = requireSchedule("every monday and wednesday at 9am, 2pm");
    expect(s.kind).toBe("multi");
    expect(s.days).toEqual([1, 3]);
    const multi = asMulti(s);
    expect(multi.times).toHaveLength(2);
  });

  it("multi-time sets compat hour/minute from first time", () => {
    const s = requireSchedule("every day at 10am, 2pm, 6pm");
    expect(s.hour).toBe(10);
    expect(s.minute).toBe(0);
  });

  it("multi-time sorts times chronologically", () => {
    const s = requireSchedule("every day at 6pm, 10am, 2pm");
    const multi = asMulti(s);
    expect(multi.times[0]).toEqual({ hour: 10, minute: 0 });
    expect(multi.times[1]).toEqual({ hour: 14, minute: 0 });
    expect(multi.times[2]).toEqual({ hour: 18, minute: 0 });
  });

  it("single time in comma pattern falls back to single schedule", () => {
    // "every day at 9am" has no comma — handled by existing single pattern
    const s = requireSchedule("every day at 9am");
    expect(s.kind).toBe("single");
  });

  it("rejects multi-time with invalid time", () => {
    expect(parseSchedule("every day at 10am, 25pm")).toBeNull();
  });

  // --- Multi-time: 24h format ---
  it('parses "every day at 14:00, 18:00" (24h multi-time)', () => {
    const s = requireSchedule("every day at 14:00, 18:00");
    expect(s).not.toBeNull();
    const multi = asMulti(s);
    expect(multi.times).toHaveLength(2);
    expect(multi.times[0]).toEqual({ hour: 14, minute: 0 });
    expect(multi.times[1]).toEqual({ hour: 18, minute: 0 });
  });

  it('parses "weekdays at 8:30, 12:00, 17:30" (24h with minutes)', () => {
    const s = requireSchedule("weekdays at 8:30, 12:00, 17:30");
    expect(s).not.toBeNull();
    const multi = asMulti(s);
    expect(multi.times).toHaveLength(3);
    expect(multi.times[0]).toEqual({ hour: 8, minute: 30 });
    expect(multi.times[1]).toEqual({ hour: 12, minute: 0 });
    expect(multi.times[2]).toEqual({ hour: 17, minute: 30 });
  });

  // --- Multi-time: midnight boundary ---
  it('parses "every day at 12am, 9am" (midnight in multi-time)', () => {
    const s = requireSchedule("every day at 12am, 9am");
    expect(s).not.toBeNull();
    const multi = asMulti(s);
    expect(multi.times).toHaveLength(2);
    expect(multi.times[0]).toEqual({ hour: 0, minute: 0 });
    expect(multi.times[1]).toEqual({ hour: 9, minute: 0 });
  });

  it('parses "every day at 0:00, 12:00" (midnight + noon 24h)', () => {
    const s = requireSchedule("every day at 0:00, 12:00");
    expect(s).not.toBeNull();
    const multi = asMulti(s);
    expect(multi.times[0]).toEqual({ hour: 0, minute: 0 });
    expect(multi.times[1]).toEqual({ hour: 12, minute: 0 });
  });

  // --- Multi-time: deduplication ---
  it("deduplicates repeated times in multi-time", () => {
    const s = requireSchedule("every day at 9am, 9am, 2pm");
    expect(s).not.toBeNull();
    const multi = asMulti(s);
    expect(multi.times).toHaveLength(2);
    expect(multi.times[0]).toEqual({ hour: 9, minute: 0 });
    expect(multi.times[1]).toEqual({ hour: 14, minute: 0 });
  });

  it("all-duplicate times collapse to single schedule", () => {
    const s = requireSchedule("every day at 9am, 9am");
    // Two identical times → deduped to 1 → falls back to single
    expect(s).not.toBeNull();
    const single = asSingle(s);
    expect(single.time).toEqual({ hour: 9, minute: 0 });
  });

  // --- Multi-time: malformed separator rejection ---
  it("rejects space-separated times (no comma/and)", () => {
    expect(parseSchedule("every day at 10am 2pm")).toBeNull();
  });

  it("rejects empty token from malformed separator", () => {
    expect(parseSchedule("every day at 10am,,2pm")).toBeNull();
  });

  it('parses "every day at 12pm, 6pm" (noon in multi-time)', () => {
    const s = requireSchedule("every day at 12pm, 6pm");
    expect(s).not.toBeNull();
    const multi = asMulti(s);
    expect(multi.times[0]).toEqual({ hour: 12, minute: 0 });
    expect(multi.times[1]).toEqual({ hour: 18, minute: 0 });
  });

  it('accepts "every day at 10am, and 2pm" (Oxford comma without trailing item)', () => {
    const s = requireSchedule("every day at 10am, and 2pm");
    expect(s).not.toBeNull();
    const multi = asMulti(s);
    expect(multi.times).toHaveLength(2);
    expect(multi.times[0]).toEqual({ hour: 10, minute: 0 });
    expect(multi.times[1]).toEqual({ hour: 14, minute: 0 });
  });

  // Pin the exact strings shown in AutomationFormView's schedule-format tooltip.
  describe("tooltip examples (AutomationFormView)", () => {
    it('parses "every weekday at 9am" (once-a-day granularity)', () => {
      const s = requireSchedule("every weekday at 9am");
      expect(s.kind).toBe("single");
      expect(s.days).toEqual([1, 2, 3, 4, 5]);
      expect(s.hour).toBe(9);
      expect(s.minute).toBe(0);
    });

    it('parses "every day at 9am, 12pm, and 5pm" (several-times-a-day granularity)', () => {
      const s = requireSchedule("every day at 9am, 12pm, and 5pm");
      expect(s.kind).toBe("multi");
      expect(s.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
      const multi = asMulti(s);
      expect(multi.times).toEqual([
        { hour: 9, minute: 0 },
        { hour: 12, minute: 0 },
        { hour: 17, minute: 0 },
      ]);
    });

    it('parses "every 30 minutes during weekdays" (sub-hourly granularity)', () => {
      const s = requireSchedule("every 30 minutes during weekdays");
      expect(s.kind).toBe("interval");
      expect(s.days).toEqual([1, 2, 3, 4, 5]);
      const interval = asInterval(s);
      expect(interval.intervalMinutes).toBe(30);
    });

    it('parses "Monday at 9am" (one-shot specific-weekday example)', () => {
      const s = requireSchedule("Monday at 9am");
      expect(s.kind).toBe("single");
      expect(s.days).toEqual([1]);
      expect(s.hour).toBe(9);
      expect(s.minute).toBe(0);
    });

    it('parses "Friday at 2:30pm" (one-shot weekday + minutes example)', () => {
      const s = requireSchedule("Friday at 2:30pm");
      expect(s.kind).toBe("single");
      expect(s.days).toEqual([5]);
      expect(s.hour).toBe(14);
      expect(s.minute).toBe(30);
    });
  });
});

// ---------------------------------------------------------------------------
// formatScheduleNL — inverse pair with parseSchedule for single-time schedules
// ---------------------------------------------------------------------------
describe("formatScheduleNL", () => {
  it("formats common day sets", () => {
    expect(formatScheduleNL([0, 1, 2, 3, 4, 5, 6], 9, 0)).toBe("every day at 9am");
    expect(formatScheduleNL([], 9, 0)).toBe("every day at 9am"); // empty alias
    expect(formatScheduleNL([1, 2, 3, 4, 5], 9, 0)).toBe("weekdays at 9am");
    expect(formatScheduleNL([0, 6], 10, 30)).toBe("weekends at 10:30am");
    expect(formatScheduleNL([1], 14, 0)).toBe("every monday at 2pm");
    // Two days: no Oxford comma. Three+: Oxford comma per parseSchedule's
    // accepted shapes.
    expect(formatScheduleNL([1, 3], 8, 0)).toBe("every monday and wednesday at 8am");
    expect(formatScheduleNL([1, 3, 5], 8, 0)).toBe("every monday, wednesday, and friday at 8am");
    // Duplicate days collapse. If the Set is ever dropped, this prevents
    // `"every monday, monday, and wednesday at 8am"` from being emitted
    // (parseSchedule would reject it, silently breaking the round-trip).
    expect(formatScheduleNL([1, 1, 3], 8, 0)).toBe("every monday and wednesday at 8am");
  });

  it("handles 12am / 12pm edge cases", () => {
    expect(formatScheduleNL([...ALL_DAYS], 0, 0)).toBe("every day at 12am");
    expect(formatScheduleNL([...ALL_DAYS], 12, 0)).toBe("every day at 12pm");
    expect(formatScheduleNL([...ALL_DAYS], 13, 5)).toBe("every day at 1:05pm");
  });

  it("round-trips through parseSchedule for common cases", () => {
    const cases: Array<{ days: number[]; hour: number; minute: number; expectDays?: number[] }> = [
      { days: [...ALL_DAYS], hour: 9, minute: 0 },
      // Empty days aliases to "every day" — parseSchedule returns all 7 back.
      { days: [], hour: 9, minute: 0, expectDays: [...ALL_DAYS] },
      { days: [...WEEKDAYS], hour: 9, minute: 0 },
      { days: [...WEEKENDS], hour: 10, minute: 30 },
      { days: [1], hour: 14, minute: 0 },
      { days: [1, 3], hour: 8, minute: 0 }, // two-day, no-Oxford-comma form
      { days: [1, 3, 5], hour: 8, minute: 15 },
    ];
    for (const c of cases) {
      const nl = formatScheduleNL(c.days, c.hour, c.minute);
      const parsed = parseSchedule(nl);
      expect(parsed, `parse(${nl})`).not.toBeNull();
      expect(parsed!.hour, `hour for ${nl}`).toBe(c.hour);
      expect(parsed!.minute, `minute for ${nl}`).toBe(c.minute);
      const numAsc = (a: number, b: number) => a - b;
      const expected = c.expectDays ?? c.days;
      expect([...parsed!.days].sort(numAsc), `days for ${nl}`).toEqual([...expected].sort(numAsc));
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeSchedule
// ---------------------------------------------------------------------------
describe("normalizeSchedule", () => {
  it("normalizes legacy flat schedule to kind:single", () => {
    const result = normalizeSchedule({
      naturalLanguage: "daily at 9am",
      days: [1, 2, 3],
      hour: 9,
      minute: 0,
    });
    const single = asSingle(result);
    expect(single.time).toEqual({ hour: 9, minute: 0 });
    expect(result.hour).toBe(9);
    expect(result.minute).toBe(0);
  });

  it("preserves existing single schedule", () => {
    const result = normalizeSchedule({
      kind: "single",
      naturalLanguage: "x",
      days: [1],
      time: { hour: 8, minute: 30 },
      hour: 8,
      minute: 30,
    });
    expect(asSingle(result).time).toEqual({ hour: 8, minute: 30 });
  });

  it("preserves existing interval schedule", () => {
    const result = normalizeSchedule({
      kind: "interval",
      naturalLanguage: "every hour",
      days: [0, 1, 2, 3, 4, 5, 6],
      intervalMinutes: 60,
      anchor: { hour: 0, minute: 15 },
      hour: 0,
      minute: 15,
    });
    const interval = asInterval(result);
    expect(interval.intervalMinutes).toBe(60);
    expect(interval.anchor).toEqual({ hour: 0, minute: 15 });
  });

  it("falls back to single when kind is absent even if intervalMinutes is present", () => {
    const result = normalizeSchedule({
      naturalLanguage: "every hour",
      days: [0, 1, 2, 3, 4, 5, 6],
      intervalMinutes: 60,
      anchor: { hour: 0, minute: 0 },
      hour: 0,
      minute: 0,
    });
    // Without kind field, falls to single — normalizeSchedule checks kind === "interval" explicitly
    // This is intentional: ambiguous data is treated as single for safety
    expect(result.kind).toBe("single");
  });

  it("handles missing fields gracefully", () => {
    const result = normalizeSchedule({});
    expect(result.kind).toBe("single");
    expect(result.days).toEqual([]);
    expect(result.hour).toBe(0);
    expect(result.minute).toBe(0);
  });

  it("sets compat hour/minute from interval anchor", () => {
    const result = normalizeSchedule({
      kind: "interval",
      naturalLanguage: "",
      days: [],
      intervalMinutes: 60,
      anchor: { hour: 0, minute: 15 },
      hour: 99,
      minute: 99,
    });
    expect(result.hour).toBe(0);
    expect(result.minute).toBe(15);
  });

  it("falls back to single when intervalMinutes does not divide 1440", () => {
    const result = normalizeSchedule({
      kind: "interval",
      naturalLanguage: "",
      days: [1, 2, 3],
      intervalMinutes: 7,
      anchor: { hour: 0, minute: 0 },
      hour: 9,
      minute: 0,
    });
    expect(result.kind).toBe("single");
  });

  it("preserves existing multi schedule", () => {
    const result = normalizeSchedule({
      kind: "multi",
      naturalLanguage: "every day at 9am, 2pm",
      days: [0, 1, 2, 3, 4, 5, 6],
      times: [
        { hour: 9, minute: 0 },
        { hour: 14, minute: 0 },
      ],
      hour: 9,
      minute: 0,
    });
    const multi = asMulti(result);
    expect(multi.times).toHaveLength(2);
    expect(multi.times[0]).toEqual({ hour: 9, minute: 0 });
    expect(multi.times[1]).toEqual({ hour: 14, minute: 0 });
  });

  it("normalizeSchedule sorts unsorted multi times", () => {
    const result = normalizeSchedule({
      kind: "multi",
      naturalLanguage: "",
      days: [1],
      times: [
        { hour: 18, minute: 0 },
        { hour: 9, minute: 0 },
        { hour: 14, minute: 0 },
      ],
      hour: 18,
      minute: 0,
    });
    const multi = asMulti(result);
    expect(multi.times[0]).toEqual({ hour: 9, minute: 0 });
    expect(multi.times[1]).toEqual({ hour: 14, minute: 0 });
    expect(multi.times[2]).toEqual({ hour: 18, minute: 0 });
  });

  it("normalizeSchedule deduplicates multi times", () => {
    const result = normalizeSchedule({
      kind: "multi",
      naturalLanguage: "",
      days: [1],
      times: [
        { hour: 9, minute: 0 },
        { hour: 9, minute: 0 },
        { hour: 14, minute: 0 },
      ],
      hour: 9,
      minute: 0,
    });
    const multi = asMulti(result);
    expect(multi.times).toHaveLength(2);
  });

  it("normalizeSchedule sets compat hour/minute from first multi time", () => {
    const result = normalizeSchedule({
      kind: "multi",
      naturalLanguage: "",
      days: [1, 2],
      times: [
        { hour: 10, minute: 30 },
        { hour: 14, minute: 0 },
      ],
      hour: 99,
      minute: 99,
    });
    expect(result.hour).toBe(10);
    expect(result.minute).toBe(30);
  });

  it("normalizeSchedule falls back to single when multi times are all invalid", () => {
    const result = normalizeSchedule({
      kind: "multi",
      naturalLanguage: "",
      days: [1],
      times: [
        { hour: 25, minute: 0 },
        { hour: -1, minute: 0 },
      ],
      hour: 9,
      minute: 0,
    });
    expect(result.kind).toBe("single");
  });

  it("normalizeSchedule filters invalid times from multi", () => {
    const result = normalizeSchedule({
      kind: "multi",
      naturalLanguage: "",
      days: [1],
      times: [
        { hour: 9, minute: 0 },
        { hour: 25, minute: 0 },
        { hour: 14, minute: 0 },
      ],
      hour: 0,
      minute: 0,
    });
    const multi = asMulti(result);
    expect(multi.times).toHaveLength(2);
    expect(multi.times[0]).toEqual({ hour: 9, minute: 0 });
    expect(multi.times[1]).toEqual({ hour: 14, minute: 0 });
  });

  it("normalizeSchedule does not mutate input times array", () => {
    const inputTimes = [
      { hour: 18, minute: 0 },
      { hour: 9, minute: 0 },
    ];
    const inputTimesCopy = [...inputTimes.map((t) => ({ ...t }))];
    normalizeSchedule({
      kind: "multi",
      naturalLanguage: "",
      days: [1],
      times: inputTimes,
      hour: 0,
      minute: 0,
    });
    expect(inputTimes).toEqual(inputTimesCopy);
  });

  it("normalizeSchedule rejects times entries missing hour or minute", () => {
    const result = normalizeSchedule({
      kind: "multi",
      naturalLanguage: "",
      days: [1],
      times: [{ hour: 9 }, { minute: 30 }, {}],
      hour: 5,
      minute: 0,
    });
    // All entries lack both hour AND minute as numbers → falls to single
    expect(result.kind).toBe("single");
  });

  it("normalizeSchedule keeps valid entries and drops malformed ones", () => {
    const result = normalizeSchedule({
      kind: "multi",
      naturalLanguage: "",
      days: [1],
      times: [{ hour: 9, minute: 0 }, {}, { hour: 14, minute: 0 }],
      hour: 0,
      minute: 0,
    });
    const multi = asMulti(result);
    expect(multi.times).toHaveLength(2);
    expect(multi.times[0]).toEqual({ hour: 9, minute: 0 });
    expect(multi.times[1]).toEqual({ hour: 14, minute: 0 });
  });

  it("normalizeSchedule collapses dedup-to-one multi into single", () => {
    const result = normalizeSchedule({
      kind: "multi",
      naturalLanguage: "",
      days: [1, 2, 3],
      times: [
        { hour: 9, minute: 0 },
        { hour: 9, minute: 0 },
      ],
      hour: 0,
      minute: 0,
    });
    const single = asSingle(result);
    expect(single.time).toEqual({ hour: 9, minute: 0 });
  });
});

// ---------------------------------------------------------------------------
// AutomationManager lifecycle
// ---------------------------------------------------------------------------

describe("resolveOneOffSchedule", () => {
  const NOW = new Date(2026, 9, 26, 9, 15, 30);
  const MINUTES_PER_DAY = 24 * 60;

  const scheduleOf = (result: ReturnType<typeof resolveOneOffSchedule>): string => {
    if (!result.ok) throw new Error(result.error);
    return result.schedule;
  };

  it.each([
    [
      "a delay in minutes, rounded up to the next minute",
      { runInMinutes: 45 },
      "every monday at 10:01am",
    ],
    ["a delay of one day", { runInMinutes: MINUTES_PER_DAY }, "every tuesday at 9:16am"],
    [
      "an exact local instant",
      { runAt: new Date(2026, 9, 27, 14, 30, 0).toISOString() },
      "every tuesday at 2:30pm",
    ],
  ])("resolves %s", (_name, input, expected) => {
    const schedule = scheduleOf(resolveOneOffSchedule(input, NOW));
    expect(schedule).toBe(expected);
    expect(parseSchedule(schedule)).not.toBeNull();
  });

  it.each([
    ["both fields", { runAt: NOW.toISOString(), runInMinutes: 5 }, ONE_OFF_ERRORS.BOTH],
    ["an unparseable runAt", { runAt: "tomorrow morning" }, ONE_OFF_ERRORS.INVALID_RUN_AT],
    ["an empty input", {}, ONE_OFF_ERRORS.INVALID_RUN_AT],
    ["a zero delay", { runInMinutes: 0 }, ONE_OFF_ERRORS.INVALID_MINUTES],
    ["a negative delay", { runInMinutes: -5 }, ONE_OFF_ERRORS.INVALID_MINUTES],
    ["a non-finite delay", { runInMinutes: Number.NaN }, ONE_OFF_ERRORS.INVALID_MINUTES],
    [
      "a runAt in the past",
      { runAt: new Date(2026, 9, 26, 8, 0, 0).toISOString() },
      ONE_OFF_ERRORS.IN_THE_PAST,
    ],
    [
      "a runAt in the current minute",
      { runAt: new Date(2026, 9, 26, 9, 15, 10).toISOString() },
      ONE_OFF_ERRORS.IN_THE_PAST,
    ],
    ["a delay of eight days", { runInMinutes: 8 * MINUTES_PER_DAY }, ONE_OFF_ERRORS.TOO_FAR],
  ])("refuses %s", (_name, input, error) => {
    expect(resolveOneOffSchedule(input, NOW)).toEqual({ ok: false, error });
  });

  it("accepts the longest wait and refuses one minute more", () => {
    const longest = new Date(NOW.getTime() + MAX_ONE_OFF_AHEAD_MS - 30_000);
    expect(resolveOneOffSchedule({ runAt: longest.toISOString() }, NOW).ok).toBe(true);
    const beyond = new Date(NOW.getTime() + MAX_ONE_OFF_AHEAD_MS + 60_000);
    expect(resolveOneOffSchedule({ runAt: beyond.toISOString() }, NOW)).toEqual({
      ok: false,
      error: ONE_OFF_ERRORS.TOO_FAR,
    });
  });
});

describe("resolveOneOffInstant", () => {
  const NOW = new Date(2026, 9, 26, 9, 15, 30);
  const MINUTES_PER_DAY = 24 * 60;
  const MS_PER_MINUTE = 60_000;
  const DAYS_AHEAD = 30;

  it("keeps the exact runAt instant with no rounding", () => {
    const runAt = new Date(2026, 9, 26, 9, 15, 45, 123);
    expect(resolveOneOffInstant({ runAt: runAt.toISOString() }, NOW)).toEqual({
      ok: true,
      instant: runAt,
    });
  });

  it("adds a delay in minutes to now", () => {
    expect(resolveOneOffInstant({ runInMinutes: 45 }, NOW)).toEqual({
      ok: true,
      instant: new Date(NOW.getTime() + 45 * MS_PER_MINUTE),
    });
  });

  it("accepts a wait longer than the weekday-and-time limit", () => {
    const result = resolveOneOffInstant({ runInMinutes: DAYS_AHEAD * MINUTES_PER_DAY }, NOW);
    expect(result.ok).toBe(true);
  });

  it.each([
    ["both fields", { runAt: NOW.toISOString(), runInMinutes: 5 }, ONE_OFF_ERRORS.BOTH],
    ["an unparseable runAt", { runAt: "tomorrow morning" }, ONE_OFF_ERRORS.INVALID_RUN_AT],
    ["an empty input", {}, ONE_OFF_ERRORS.INVALID_RUN_AT],
    ["a zero delay", { runInMinutes: 0 }, ONE_OFF_ERRORS.INVALID_MINUTES],
    [
      "a runAt in the past",
      { runAt: new Date(2026, 9, 26, 8, 0, 0).toISOString() },
      ONE_OFF_ERRORS.IN_THE_PAST,
    ],
    ["a runAt equal to now", { runAt: NOW.toISOString() }, ONE_OFF_ERRORS.IN_THE_PAST],
  ])("refuses %s", (_name, input, error) => {
    expect(resolveOneOffInstant(input, NOW)).toEqual({ ok: false, error });
  });
});
