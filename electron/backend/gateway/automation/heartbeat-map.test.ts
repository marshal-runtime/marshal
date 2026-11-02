import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  activeHoursToSchedule,
  everyStringToIntervalMinutes,
  intervalMinutesToEveryString,
  mapHeartbeatPatchToMarshalPatch,
  mapLastHeartbeatToStatus,
  mapMarshalHeartbeatToSettings,
  scheduleToActiveHours,
} from "./heartbeat-map";

describe("intervalMinutesToEveryString", () => {
  it("maps 15 → '15m'", () => {
    expect(intervalMinutesToEveryString(15)).toBe("15m");
  });
  it("maps 30 → '30m'", () => {
    expect(intervalMinutesToEveryString(30)).toBe("30m");
  });
  it("maps 60 → '1h'", () => {
    expect(intervalMinutesToEveryString(60)).toBe("1h");
  });
  it("maps 120 → '2h'", () => {
    expect(intervalMinutesToEveryString(120)).toBe("2h");
  });
});

describe("everyStringToIntervalMinutes", () => {
  it("round-trips '15m' → 15", () => {
    expect(everyStringToIntervalMinutes("15m")).toBe(15);
  });
  it("round-trips '30m' → 30", () => {
    expect(everyStringToIntervalMinutes("30m")).toBe(30);
  });
  it("round-trips '1h' → 60", () => {
    expect(everyStringToIntervalMinutes("1h")).toBe(60);
  });
  it("round-trips '2h' → 120", () => {
    expect(everyStringToIntervalMinutes("2h")).toBe(120);
  });
  it("rounds unknown values to nearest valid: '45m' → 30", () => {
    expect(everyStringToIntervalMinutes("45m")).toBe(30);
  });
  it("rounds unknown values to nearest valid: '90m' → 60", () => {
    expect(everyStringToIntervalMinutes("90m")).toBe(60);
  });
  it("rounds unknown values to nearest valid: '180m' → 120", () => {
    expect(everyStringToIntervalMinutes("180m")).toBe(120);
  });
  it("parses hour-unit input via the 'h' branch: '3h' → 120 (nearest valid)", () => {
    // 3h = 180m → nearest valid is 120 (closer to 180 than 60).
    expect(everyStringToIntervalMinutes("3h")).toBe(120);
  });
  it("parses hour-unit input via the 'h' branch: '1h' → 60 (exact)", () => {
    expect(everyStringToIntervalMinutes("1h")).toBe(60);
  });
  it("falls back to 60 on unparseable input", () => {
    expect(everyStringToIntervalMinutes("garbage")).toBe(60);
  });
  it("falls back to 60 on missing unit", () => {
    expect(everyStringToIntervalMinutes("30")).toBe(60);
  });
});

describe("scheduleToActiveHours", () => {
  it("returns activeHours with workStart/workEnd when schedule is 'work-hours'", () => {
    const result = scheduleToActiveHours({
      schedule: "work-hours",
      workStartHour: 9,
      workEndHour: 17,
    });
    expect(result).toEqual({ start: "09:00", end: "17:00" });
  });

  it("falls back to defaults (9-17) when start/end hours are absent", () => {
    // Pin the safety-net path: a settings literal with no hours should still
    // produce a usable activeHours rather than NaN-padded strings.
    expect(
      scheduleToActiveHours({
        schedule: "work-hours",
        workStartHour: undefined,
        workEndHour: undefined,
      }),
    ).toEqual({ start: "09:00", end: "17:00" });
  });
  it("returns undefined when schedule is 'always'", () => {
    const result = scheduleToActiveHours({
      schedule: "always",
      workStartHour: 9,
      workEndHour: 17,
    });
    expect(result).toBeUndefined();
  });

  it("zero-pads single-digit hours", () => {
    const result = scheduleToActiveHours({
      schedule: "work-hours",
      workStartHour: 6,
      workEndHour: 24,
    });
    expect(result).toEqual({ start: "06:00", end: "24:00" });
  });
});

describe("activeHoursToSchedule", () => {
  it("returns 'work-hours' when activeHours is set", () => {
    expect(activeHoursToSchedule({ start: "09:00", end: "17:00" })).toBe("work-hours");
  });
  it("returns 'always' when activeHours is undefined", () => {
    expect(activeHoursToSchedule(undefined)).toBe("always");
  });
});

describe("mapMarshalHeartbeatToSettings", () => {
  it("maps a fully-populated marshal subtree to HeartbeatSettings", () => {
    const subtree = {
      every: "1h",
      activeHours: { start: "09:00", end: "17:00" },
      prompt: "Check on automations",
    };
    expect(mapMarshalHeartbeatToSettings(subtree)).toEqual({
      enabled: true,
      intervalMinutes: 60,
      schedule: "work-hours",
      prompt: "Check on automations",
      workDays: [1, 2, 3, 4, 5],
      workStartHour: 9,
      workEndHour: 17,
    });
  });

  it("missing fields use safe defaults", () => {
    expect(mapMarshalHeartbeatToSettings({})).toEqual({
      enabled: true,
      intervalMinutes: 60,
      schedule: "always",
      prompt: "",
      workDays: [1, 2, 3, 4, 5],
      workStartHour: 9,
      workEndHour: 17,
    });
  });

  it("returns minimal settings on invalid subtree", () => {
    expect(mapMarshalHeartbeatToSettings(null)).toMatchObject({
      enabled: false,
      intervalMinutes: 60,
    });
  });
});

describe("mapHeartbeatPatchToMarshalPatch", () => {
  it("maps intervalMinutes patch to { every }", () => {
    expect(mapHeartbeatPatchToMarshalPatch({ intervalMinutes: 30 })).toEqual({
      every: "30m",
    });
  });
  it("maps schedule + workStartHour + workEndHour to activeHours", () => {
    expect(
      mapHeartbeatPatchToMarshalPatch({
        schedule: "work-hours",
        workStartHour: 9,
        workEndHour: 17,
      }),
    ).toEqual({ activeHours: { start: "09:00", end: "17:00" } });
  });
  it("maps schedule: 'always' to activeHours: null (clears it via merge-patch)", () => {
    expect(mapHeartbeatPatchToMarshalPatch({ schedule: "always" })).toEqual({
      activeHours: null,
    });
  });
  it("maps prompt 1:1", () => {
    expect(mapHeartbeatPatchToMarshalPatch({ prompt: "hi" })).toEqual({
      prompt: "hi",
    });
  });
  it("returns empty patch when only `enabled` is in input (handled separately via set-heartbeats)", () => {
    expect(mapHeartbeatPatchToMarshalPatch({ enabled: true })).toEqual({});
  });
  it("returns empty patch when no recognizable fields", () => {
    expect(mapHeartbeatPatchToMarshalPatch({})).toEqual({});
  });

  // Regression: a single-field hour patch (only workStartHour, no workEndHour
  // and no schedule) used to synthesize `activeHours` with the missing side
  // defaulted to m's hardcoded 9/17. Combined with marshal's whole-object
  // replace semantics for `activeHours`, that silently overwrote the server's
  // existing other-side value. The renderer now sends both hours together;
  // the mapper must NOT fabricate the missing side from a default. See
  // HeartbeatPanel.handleWorkHourChange for the renderer-side fix.
  it("does not fabricate activeHours from a single-field hour patch", () => {
    expect(mapHeartbeatPatchToMarshalPatch({ workStartHour: 10 })).not.toHaveProperty(
      "activeHours",
    );
    expect(mapHeartbeatPatchToMarshalPatch({ workEndHour: 20 })).not.toHaveProperty("activeHours");
  });

  it("ignores unrecognized keys in a malformed patch (no extra fields leak through)", () => {
    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- intentional malformed input for the unknown-key guard
    const out = mapHeartbeatPatchToMarshalPatch({
      bogus: "value",
      intervalMinutes: 30,
    } as unknown as Parameters<typeof mapHeartbeatPatchToMarshalPatch>[0]);
    expect(out).toEqual({ every: "30m" });
    expect(out).not.toHaveProperty("bogus");
  });
});

describe("mapLastHeartbeatToStatus", () => {
  // Pin the 30s recency window against a deterministic clock so the
  // `Date.now() - ts < 30000` assertion is immune to slow CI scheduling.
  // (Without fake timers a CI runner that paused for >25s between the test
  // setup and the mapper call would silently flip the assertion.)
  const FIXED_NOW = new Date("2026-01-01T12:00:00.000Z").getTime();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("running: true when event is recent (< 30s) and status is 'sent'", () => {
    const tsRecent = FIXED_NOW - 5000;
    const result = mapLastHeartbeatToStatus({ ts: tsRecent, status: "sent" });
    expect(result.running).toBe(true);
    expect(result.lastRun).toBe(new Date(tsRecent).toISOString());
  });

  it("running: false when event is older than 30s", () => {
    const tsOld = FIXED_NOW - 60000;
    const result = mapLastHeartbeatToStatus({ ts: tsOld, status: "sent" });
    expect(result.running).toBe(false);
  });

  it("enabled: false on 'skipped' with reason 'disabled'", () => {
    const result = mapLastHeartbeatToStatus({
      ts: Date.now(),
      status: "skipped",
      reason: "disabled",
    });
    expect(result.enabled).toBe(false);
  });

  it("enabled: true on 'sent'", () => {
    const result = mapLastHeartbeatToStatus({ ts: Date.now(), status: "sent" });
    expect(result.enabled).toBe(true);
  });

  it("returns running:false, lastRun:null on null event", () => {
    expect(mapLastHeartbeatToStatus(null)).toEqual({
      enabled: false,
      lastRun: null,
      nextRun: null,
      running: false,
    });
  });
});
