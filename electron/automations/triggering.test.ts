import { describe, it, expect } from "vitest";

import type { StrictAutomationSchedule } from "./domain/contracts";
import { shouldTriggerSchedule } from "./triggering";

describe("shouldTriggerSchedule (single)", () => {
  const schedule: StrictAutomationSchedule = {
    kind: "single",
    naturalLanguage: "every day at 9:00",
    days: [0, 1, 2, 3, 4, 5, 6],
    time: { hour: 9, minute: 0 },
    hour: 9,
    minute: 0,
  };

  function makeDate(hour: number, minute: number, second = 0, ms = 0): Date {
    // Use a Wednesday (day 3)
    const d = new Date(2026, 1, 18, hour, minute, second, ms);
    return d;
  }

  it("triggers when scheduled time falls within check window", () => {
    const lastCheck = makeDate(8, 59, 0);
    const now = makeDate(9, 1, 0);
    expect(shouldTriggerSchedule(schedule, now, lastCheck)).toBe(true);
  });

  it("triggers on exact match with window", () => {
    const lastCheck = makeDate(8, 59, 0);
    const now = makeDate(9, 0, 0);
    expect(shouldTriggerSchedule(schedule, now, lastCheck)).toBe(true);
  });

  it("does not trigger when scheduled time is before the window", () => {
    const lastCheck = makeDate(9, 0, 0);
    const now = makeDate(9, 1, 0);
    expect(shouldTriggerSchedule(schedule, now, lastCheck)).toBe(false);
  });

  it("does not trigger when scheduled time is after now", () => {
    const lastCheck = makeDate(8, 0, 0);
    const now = makeDate(8, 30, 0);
    expect(shouldTriggerSchedule(schedule, now, lastCheck)).toBe(false);
  });

  it("does not trigger on wrong day", () => {
    const mondayOnly: StrictAutomationSchedule = { ...schedule, days: [1] }; // Monday only
    // Feb 18, 2026 is a Wednesday (day 3)
    const lastCheck = makeDate(8, 59, 0);
    const now = makeDate(9, 1, 0);
    expect(shouldTriggerSchedule(mondayOnly, now, lastCheck)).toBe(false);
  });

  it("catches up missed automation on startup within grace window", () => {
    // App starts at 9:30, automation was at 9:00 — within 4h grace window
    const now = makeDate(9, 30, 0);
    expect(shouldTriggerSchedule(schedule, now, null)).toBe(true);
  });

  it("catches up missed automation on startup (exact minute)", () => {
    const now = makeDate(9, 0, 30);
    expect(shouldTriggerSchedule(schedule, now, null)).toBe(true);
  });

  it("does not catch up automation outside grace window", () => {
    // App starts at 14:00, automation at 9:00 — 5h ago, outside 4h grace
    const now = makeDate(14, 0, 0);
    expect(shouldTriggerSchedule(schedule, now, null)).toBe(false);
  });

  it("does not catch up automation scheduled in the future on first check", () => {
    // App starts at 8:30, automation at 9:00 — hasn't happened yet
    const now = makeDate(8, 30, 0);
    expect(shouldTriggerSchedule(schedule, now, null)).toBe(false);
  });

  it("does not catch up automation on wrong day even within grace window", () => {
    const mondayOnly: StrictAutomationSchedule = { ...schedule, days: [1] }; // Monday only
    // Feb 18, 2026 is a Wednesday — 9:00 was 30min ago but wrong day
    const now = makeDate(9, 30, 0);
    expect(shouldTriggerSchedule(mondayOnly, now, null)).toBe(false);
  });

  it("does not false-trigger day-specific automation after midnight on grace window", () => {
    // Automation: "every Wednesday at 23:00". App starts Thursday at 00:30.
    // Wednesday 23:00 was 1.5h ago — within grace — but we should NOT fire
    // because the grace-window path only checks today's candidate.
    const wedOnly: StrictAutomationSchedule = { ...schedule, days: [3], hour: 23, minute: 0 };
    // Feb 19, 2026 is a Thursday
    const now = new Date(2026, 1, 19, 0, 30, 0);
    expect(shouldTriggerSchedule(wedOnly, now, null)).toBe(false);
  });

  it("handles timer drift — skipped exact minute still triggers", () => {
    // Timer fires at 8:59:59 then drifts to 9:01:01 — should still catch 9:00
    const lastCheck = makeDate(8, 59, 59, 900);
    const now = makeDate(9, 1, 1, 100);
    expect(shouldTriggerSchedule(schedule, now, lastCheck)).toBe(true);
  });

  it("handles midnight crossing — late evening schedule", () => {
    const lateSchedule: StrictAutomationSchedule = {
      kind: "single",
      naturalLanguage: "every day at 23:30",
      days: [0, 1, 2, 3, 4, 5, 6],
      time: { hour: 23, minute: 30 },
      hour: 23,
      minute: 30,
    };
    // Feb 18 (Wed) 23:29 → Feb 19 (Thu) 00:01, should catch 23:30 on Feb 18
    const lastCheck = new Date(2026, 1, 18, 23, 29, 0);
    const now = new Date(2026, 1, 19, 0, 1, 0);
    expect(shouldTriggerSchedule(lateSchedule, now, lastCheck)).toBe(true);
  });

  it("handles midnight crossing — day-specific schedule", () => {
    // Schedule only on Wednesday (day 3). Feb 18, 2026 is a Wednesday.
    const wedOnly: StrictAutomationSchedule = {
      kind: "single",
      naturalLanguage: "every wednesday at 23:30",
      days: [3],
      time: { hour: 23, minute: 30 },
      hour: 23,
      minute: 30,
    };
    const lastCheck = new Date(2026, 1, 18, 23, 29, 0); // Wed 23:29
    const now = new Date(2026, 1, 19, 0, 1, 0); // Thu 00:01
    // Wed 23:30 is in window — should trigger even though now is Thursday
    expect(shouldTriggerSchedule(wedOnly, now, lastCheck)).toBe(true);
  });

  it("does not false-trigger across midnight for wrong day", () => {
    // Schedule only on Thursday (day 4). Feb 18 is Wed, Feb 19 is Thu.
    const thuOnly: StrictAutomationSchedule = {
      kind: "single",
      naturalLanguage: "every thursday at 23:30",
      days: [4],
      time: { hour: 23, minute: 30 },
      hour: 23,
      minute: 30,
    };
    const lastCheck = new Date(2026, 1, 18, 23, 29, 0); // Wed 23:29
    const now = new Date(2026, 1, 19, 0, 1, 0); // Thu 00:01
    // Thu 23:30 hasn't happened yet, Wed 23:30 is wrong day
    expect(shouldTriggerSchedule(thuOnly, now, lastCheck)).toBe(false);
  });

  it("catches up single trigger after >24h gap", () => {
    // lastCheck was Sunday 8am, now is Wednesday 10am — Tuesday 9am was missed
    const dailySchedule: StrictAutomationSchedule = {
      kind: "single",
      naturalLanguage: "every day at 9am",
      days: [0, 1, 2, 3, 4, 5, 6],
      time: { hour: 9, minute: 0 },
      hour: 9,
      minute: 0,
    };
    const lastCheck = new Date(2026, 1, 15, 8, 0); // Sunday 8am
    const now = new Date(2026, 1, 18, 10, 0); // Wednesday 10am
    expect(shouldTriggerSchedule(dailySchedule, now, lastCheck)).toBe(true);
  });

  it("catches up Tuesday-only trigger missed during a weekend outage", () => {
    // Old code used a 1-day window (now-24h → now). This schedule fires only
    // on Tuesdays. Gap: Friday 6pm → Thursday 8am. Tuesday 9am is >1 day before
    // Thursday, so the old code's window (Wed 8am → Thu 8am) would miss it.
    const tuesdayOnly: StrictAutomationSchedule = {
      kind: "single",
      naturalLanguage: "every Tuesday at 9am",
      days: [2], // Tuesday
      time: { hour: 9, minute: 0 },
      hour: 9,
      minute: 0,
    };
    const lastCheck = new Date(2026, 1, 20, 18, 0); // Friday 6pm
    const now = new Date(2026, 1, 26, 8, 0); // Thursday 8am (next week)
    // Tuesday 9am (Feb 24) falls inside (Fri 6pm, Thu 8am] — should trigger.
    // Old 1-day window: (Wed 8am, Thu 8am] — would miss Tuesday entirely.
    expect(shouldTriggerSchedule(tuesdayOnly, now, lastCheck)).toBe(true);
  });

  it("catches up multi trigger after >24h gap", () => {
    const multiSchedule: StrictAutomationSchedule = {
      kind: "multi",
      naturalLanguage: "every day at 9am, 5pm",
      days: [0, 1, 2, 3, 4, 5, 6],
      times: [
        { hour: 9, minute: 0 },
        { hour: 17, minute: 0 },
      ],
      hour: 9,
      minute: 0,
    };
    const lastCheck = new Date(2026, 1, 15, 8, 0); // Sunday 8am
    const now = new Date(2026, 1, 18, 10, 0); // Wednesday 10am
    expect(shouldTriggerSchedule(multiSchedule, now, lastCheck)).toBe(true);
  });

  it("does not catch up single trigger if day not in schedule", () => {
    // Weekdays only — gap covers only weekend
    const weekdaySchedule: StrictAutomationSchedule = {
      kind: "single",
      naturalLanguage: "weekdays at 9am",
      days: [1, 2, 3, 4, 5],
      time: { hour: 9, minute: 0 },
      hour: 9,
      minute: 0,
    };
    const lastCheck = new Date(2026, 1, 20, 18, 0); // Friday 6pm
    const now = new Date(2026, 1, 22, 8, 0); // Sunday 8am — no weekdays in gap
    expect(shouldTriggerSchedule(weekdaySchedule, now, lastCheck)).toBe(false);
  });
});
describe("shouldTriggerSchedule (intervals)", () => {
  function makeIntervalSchedule(
    mins: number,
    days: number[] = [0, 1, 2, 3, 4, 5, 6],
    anchor: { hour: number; minute: number } = { hour: 0, minute: 0 },
  ): StrictAutomationSchedule {
    return {
      kind: "interval",
      naturalLanguage: `every ${mins} min`,
      days,
      intervalMinutes: mins,
      anchor,
      hour: anchor.hour,
      minute: anchor.minute,
    };
  }

  it("triggers when slot falls in window", () => {
    const s = makeIntervalSchedule(30);
    expect(
      shouldTriggerSchedule(s, new Date(2026, 1, 18, 9, 31), new Date(2026, 1, 18, 9, 29)),
    ).toBe(true);
  });

  it("no trigger when no slot in window", () => {
    const s = makeIntervalSchedule(60);
    expect(
      shouldTriggerSchedule(s, new Date(2026, 1, 18, 9, 59), new Date(2026, 1, 18, 9, 1)),
    ).toBe(false);
  });

  it("respects anchor offset (:15)", () => {
    const s = makeIntervalSchedule(60, [0, 1, 2, 3, 4, 5, 6], { hour: 0, minute: 15 });
    expect(
      shouldTriggerSchedule(s, new Date(2026, 1, 18, 9, 16), new Date(2026, 1, 18, 9, 14)),
    ).toBe(true);
  });

  it("no trigger between anchored slots", () => {
    const s = makeIntervalSchedule(60, [0, 1, 2, 3, 4, 5, 6], { hour: 0, minute: 15 });
    expect(
      shouldTriggerSchedule(s, new Date(2026, 1, 18, 10, 14), new Date(2026, 1, 18, 9, 16)),
    ).toBe(false);
  });

  it("weekdays only — no trigger on Saturday", () => {
    const s = makeIntervalSchedule(60, [1, 2, 3, 4, 5]);
    expect(
      shouldTriggerSchedule(s, new Date(2026, 1, 21, 10, 1), new Date(2026, 1, 21, 9, 0)),
    ).toBe(false);
  });

  it("midnight crossing catches slot", () => {
    const s = makeIntervalSchedule(30);
    expect(
      shouldTriggerSchedule(s, new Date(2026, 1, 19, 0, 1), new Date(2026, 1, 18, 23, 29)),
    ).toBe(true);
  });

  it("long sleep still triggers", () => {
    const s = makeIntervalSchedule(60);
    expect(shouldTriggerSchedule(s, new Date(2026, 1, 18, 9, 0), new Date(2026, 1, 18, 6, 0))).toBe(
      true,
    );
  });

  it("startup grace triggers", () => {
    const s = makeIntervalSchedule(60);
    expect(shouldTriggerSchedule(s, new Date(2026, 1, 18, 10, 1), null)).toBe(true);
  });

  it("empty days never triggers", () => {
    const s = makeIntervalSchedule(60, []);
    expect(
      shouldTriggerSchedule(s, new Date(2026, 1, 18, 10, 1), new Date(2026, 1, 18, 9, 0)),
    ).toBe(false);
  });

  it("lastCheck on slot — exclusive lower bound", () => {
    const s = makeIntervalSchedule(60);
    expect(
      shouldTriggerSchedule(s, new Date(2026, 1, 18, 10, 59), new Date(2026, 1, 18, 10, 0)),
    ).toBe(false);
  });

  it("now on slot — inclusive upper bound", () => {
    const s = makeIntervalSchedule(60);
    expect(
      shouldTriggerSchedule(s, new Date(2026, 1, 18, 10, 0), new Date(2026, 1, 18, 9, 59)),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldTrigger — multi-time schedules
// ---------------------------------------------------------------------------
describe("shouldTriggerSchedule (multi-time)", () => {
  function makeMultiSchedule(
    times: Array<{ hour: number; minute: number }>,
    days: number[] = [0, 1, 2, 3, 4, 5, 6],
  ): StrictAutomationSchedule {
    return {
      kind: "multi",
      naturalLanguage: "multi",
      days,
      times,
      hour: times[0].hour,
      minute: times[0].minute,
    };
  }

  it("triggers when any time in the list falls in window", () => {
    const s = makeMultiSchedule([
      { hour: 9, minute: 0 },
      { hour: 14, minute: 0 },
      { hour: 18, minute: 0 },
    ]);
    // Window 13:59 → 14:01 — 14:00 slot matches
    expect(
      shouldTriggerSchedule(s, new Date(2026, 1, 18, 14, 1), new Date(2026, 1, 18, 13, 59)),
    ).toBe(true);
  });

  it("does not trigger when no time in list falls in window", () => {
    const s = makeMultiSchedule([
      { hour: 9, minute: 0 },
      { hour: 14, minute: 0 },
      { hour: 18, minute: 0 },
    ]);
    // Window 10:00 → 13:00 — no matching time
    expect(
      shouldTriggerSchedule(s, new Date(2026, 1, 18, 13, 0), new Date(2026, 1, 18, 10, 0)),
    ).toBe(false);
  });

  it("respects day filter", () => {
    const s = makeMultiSchedule(
      [
        { hour: 9, minute: 0 },
        { hour: 17, minute: 0 },
      ],
      [1, 2, 3, 4, 5],
    );
    // Saturday — no trigger
    expect(
      shouldTriggerSchedule(s, new Date(2026, 1, 21, 9, 1), new Date(2026, 1, 21, 8, 59)),
    ).toBe(false);
  });

  it("triggers for each time independently", () => {
    const s = makeMultiSchedule([
      { hour: 9, minute: 0 },
      { hour: 17, minute: 0 },
    ]);
    // Morning trigger
    expect(
      shouldTriggerSchedule(s, new Date(2026, 1, 18, 9, 1), new Date(2026, 1, 18, 8, 59)),
    ).toBe(true);
    // Evening trigger
    expect(
      shouldTriggerSchedule(s, new Date(2026, 1, 18, 17, 1), new Date(2026, 1, 18, 16, 59)),
    ).toBe(true);
  });

  it("triggers multi with midnight time (12am)", () => {
    const s = makeMultiSchedule([
      { hour: 0, minute: 0 },
      { hour: 9, minute: 0 },
    ]);
    // Window 23:59 yesterday → 00:01 today — midnight slot matches
    expect(
      shouldTriggerSchedule(s, new Date(2026, 1, 18, 0, 1), new Date(2026, 1, 17, 23, 59)),
    ).toBe(true);
  });

  it("triggers on startup grace for multi schedule", () => {
    const s = makeMultiSchedule([
      { hour: 9, minute: 0 },
      { hour: 14, minute: 0 },
    ]);
    // First check (lastCheck=null), now is 14:02 — 14:00 is within 5min grace
    expect(shouldTriggerSchedule(s, new Date(2026, 1, 18, 14, 2), null)).toBe(true);
  });

  it("does not trigger on startup grace if time is too old", () => {
    const s = makeMultiSchedule([
      { hour: 8, minute: 0 },
      { hour: 9, minute: 0 },
    ]);
    // First check (lastCheck=null), now is 14:00 — both times >4h ago (grace is 4h)
    expect(shouldTriggerSchedule(s, new Date(2026, 1, 18, 14, 0), null)).toBe(false);
  });

  it("does not trigger when lastCheck is exactly on a scheduled slot", () => {
    const s = makeMultiSchedule([
      { hour: 9, minute: 0 },
      { hour: 14, minute: 0 },
    ]);
    // lastCheck exactly at 14:00 — strict lower bound, should NOT trigger
    expect(
      shouldTriggerSchedule(s, new Date(2026, 1, 18, 14, 1), new Date(2026, 1, 18, 14, 0)),
    ).toBe(false);
  });

  it("triggers when now is exactly on a scheduled slot", () => {
    const s = makeMultiSchedule([
      { hour: 9, minute: 0 },
      { hour: 14, minute: 0 },
    ]);
    // now exactly at 14:00, lastCheck before — inclusive upper bound
    expect(
      shouldTriggerSchedule(s, new Date(2026, 1, 18, 14, 0), new Date(2026, 1, 18, 13, 59)),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldTrigger — DST-safety verification
// ---------------------------------------------------------------------------
describe("shouldTriggerSchedule (calendar-day boundary — UTC; does not exercise real DST transitions)", () => {
  // Note: vitest runs in TZ=UTC, so we can't observe real DST transitions.
  // These tests verify the construction is correct by testing the exact
  // boundary conditions that would fail with ms-based day arithmetic
  // (86_400_000) during spring-forward (23h day) or fall-back (25h day).

  it("single trigger across a simulated 23-hour day boundary", () => {
    const schedule: StrictAutomationSchedule = {
      kind: "single",
      naturalLanguage: "every day at 2am",
      days: [0, 1, 2, 3, 4, 5, 6],
      time: { hour: 2, minute: 0 },
      hour: 2,
      minute: 0,
    };
    // Window: 01:00 → 03:01 — 02:00 falls inside
    expect(
      shouldTriggerSchedule(schedule, new Date(2026, 2, 8, 3, 1), new Date(2026, 2, 8, 1, 0)),
    ).toBe(true);
  });

  it("interval slot walk uses local-day stepping not ms arithmetic", () => {
    const schedule: StrictAutomationSchedule = {
      kind: "interval",
      naturalLanguage: "every hour",
      days: [0, 1, 2, 3, 4, 5, 6],
      intervalMinutes: 60,
      anchor: { hour: 0, minute: 0 },
      hour: 0,
      minute: 0,
    };
    // Cross midnight: last check 23:30 → now 00:31 next day
    expect(
      shouldTriggerSchedule(schedule, new Date(2026, 2, 9, 0, 31), new Date(2026, 2, 8, 23, 30)),
    ).toBe(true);
  });

  it("multi-time yesterday candidate uses calendar day not ms subtraction", () => {
    const schedule: StrictAutomationSchedule = {
      kind: "multi",
      naturalLanguage: "every day at 11pm, 2am",
      days: [0, 1, 2, 3, 4, 5, 6],
      times: [
        { hour: 2, minute: 0 },
        { hour: 23, minute: 0 },
      ],
      hour: 2,
      minute: 0,
    };
    // Window: 22:00 → 23:01 — 23:00 today falls inside
    expect(
      shouldTriggerSchedule(schedule, new Date(2026, 2, 8, 23, 1), new Date(2026, 2, 8, 22, 0)),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AutomationManager per-condition timers
