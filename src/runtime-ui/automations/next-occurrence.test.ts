import { describe, it, expect, vi, afterEach } from "vitest";

import { getNextOccurrence } from "./next-occurrence";

describe("getNextOccurrence", () => {
  afterEach(() => vi.useRealTimers());

  it("returns later-today occurrence for single schedule", () => {
    vi.useFakeTimers({ now: new Date("2026-04-22T08:00:00") });
    const result = getNextOccurrence({
      kind: "single",
      naturalLanguage: "every day at 9am",
      days: [0, 1, 2, 3, 4, 5, 6],
      time: { hour: 9, minute: 0 },
      hour: 9,
      minute: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.getHours()).toBe(9);
    expect(result!.getMinutes()).toBe(0);
  });

  it("rolls to next allowed day when today's time has passed", () => {
    vi.useFakeTimers({ now: new Date("2026-04-22T10:00:00") }); // Wed 10am
    const result = getNextOccurrence({
      kind: "single",
      naturalLanguage: "every day at 9am",
      days: [0, 1, 2, 3, 4, 5, 6],
      time: { hour: 9, minute: 0 },
      hour: 9,
      minute: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.getDate()).toBe(23); // next day
  });

  it("uses legacy hour/minute when time is absent", () => {
    vi.useFakeTimers({ now: new Date("2026-04-22T08:00:00") });
    const result = getNextOccurrence({
      naturalLanguage: "every day at 9am",
      days: [0, 1, 2, 3, 4, 5, 6],
      hour: 9,
      minute: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.getHours()).toBe(9);
  });

  it("returns next interval slot for interval schedule", () => {
    vi.useFakeTimers({ now: new Date("2026-04-22T09:15:00") }); // 09:15
    const result = getNextOccurrence({
      kind: "interval",
      naturalLanguage: "every 30 minutes",
      days: [0, 1, 2, 3, 4, 5, 6],
      intervalMinutes: 30,
      anchor: { hour: 0, minute: 0 },
      hour: 0,
      minute: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.getHours()).toBe(9);
    expect(result!.getMinutes()).toBe(30);
  });

  it("interval respects anchor offset", () => {
    vi.useFakeTimers({ now: new Date("2026-04-22T09:16:00") }); // 09:16
    const result = getNextOccurrence({
      kind: "interval",
      naturalLanguage: "every hour at :15",
      days: [0, 1, 2, 3, 4, 5, 6],
      intervalMinutes: 60,
      anchor: { hour: 0, minute: 15 },
      hour: 0,
      minute: 15,
    });
    expect(result).not.toBeNull();
    expect(result!.getHours()).toBe(10);
    expect(result!.getMinutes()).toBe(15);
  });

  it("interval rolls to next allowed day", () => {
    vi.useFakeTimers({ now: new Date("2026-04-25T23:50:00") }); // Sat 23:50
    const result = getNextOccurrence({
      kind: "interval",
      naturalLanguage: "every hour during weekdays",
      days: [1, 2, 3, 4, 5],
      intervalMinutes: 60,
      anchor: { hour: 0, minute: 0 },
      hour: 0,
      minute: 0,
    });
    expect(result).not.toBeNull();
    // Should be Monday
    expect(result!.getDay()).toBe(1);
  });

  it("returns null for empty days", () => {
    const result = getNextOccurrence({
      kind: "single",
      naturalLanguage: "",
      days: [],
      time: { hour: 9, minute: 0 },
      hour: 9,
      minute: 0,
    });
    expect(result).toBeNull();
  });

  it("multi-time returns next matching time today", () => {
    vi.useFakeTimers({ now: new Date("2026-04-22T10:30:00") });
    const result = getNextOccurrence({
      kind: "multi",
      naturalLanguage: "every day at 9am, 2pm, 6pm",
      days: [0, 1, 2, 3, 4, 5, 6],
      times: [
        { hour: 9, minute: 0 },
        { hour: 14, minute: 0 },
        { hour: 18, minute: 0 },
      ],
      hour: 9,
      minute: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.getHours()).toBe(14);
    expect(result!.getMinutes()).toBe(0);
  });

  it("multi-time rolls to next day when all times passed", () => {
    vi.useFakeTimers({ now: new Date("2026-04-22T19:00:00") }); // past 6pm
    const result = getNextOccurrence({
      kind: "multi",
      naturalLanguage: "every day at 9am, 2pm, 6pm",
      days: [0, 1, 2, 3, 4, 5, 6],
      times: [
        { hour: 9, minute: 0 },
        { hour: 14, minute: 0 },
        { hour: 18, minute: 0 },
      ],
      hour: 9,
      minute: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.getDate()).toBe(23); // next day
    expect(result!.getHours()).toBe(9);
  });

  it("multi-time with midnight picks earliest future time", () => {
    vi.useFakeTimers({ now: new Date("2026-04-22T00:01:00") }); // just past midnight
    const result = getNextOccurrence({
      kind: "multi",
      naturalLanguage: "every day at 12am, 9am",
      days: [0, 1, 2, 3, 4, 5, 6],
      times: [
        { hour: 0, minute: 0 },
        { hour: 9, minute: 0 },
      ],
      hour: 0,
      minute: 0,
    });
    expect(result).not.toBeNull();
    // midnight already passed, so next is 9am today
    expect(result!.getHours()).toBe(9);
    expect(result!.getDate()).toBe(22);
  });

  it("multi-time respects day filter (weekdays only on Saturday)", () => {
    vi.useFakeTimers({ now: new Date("2026-04-25T10:00:00") }); // Saturday
    const result = getNextOccurrence({
      kind: "multi",
      naturalLanguage: "weekdays at 9am, 5pm",
      days: [1, 2, 3, 4, 5], // weekdays only
      times: [
        { hour: 9, minute: 0 },
        { hour: 17, minute: 0 },
      ],
      hour: 9,
      minute: 0,
    });
    expect(result).not.toBeNull();
    // Should skip Saturday + Sunday → Monday
    expect(result!.getDay()).toBe(1); // Monday
    expect(result!.getHours()).toBe(9);
  });
});
