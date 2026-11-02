import { createLogger } from "../../common/marshal-logger";
const log = createLogger("StrictAutomationSchedule");
import type {
  StrictAutomationSchedule,
  IntervalSchedule,
  MultiSchedule,
  SingleSchedule,
  TimeOfDay,
} from "./domain/contracts";

export const SCHEDULE_FORMAT_HINT =
  'Use a format like "every weekday at 9am", "daily at 8:30am", "every day at 9am, 2pm, and 6pm", "every 30 minutes", or "every hour at :15".';

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export const WEEKDAYS = [1, 2, 3, 4, 5] as const;
export const WEEKENDS = [0, 6] as const;

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Humanize a (days, hour, minute) schedule into a string `parseSchedule` accepts.
 *  Inverse pair with `parseSchedule` for single-time schedules — used so a cron
 *  expression round-tripping through the gateway doesn't surface to the user as
 *  raw `0 9 * * 1-5`. Tested at the round-trip boundary in schedule.test.ts. */
export function formatScheduleNL(days: readonly number[], hour: number, minute: number): string {
  const time = formatTime(hour, minute);
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 0 || sorted.length === 7) return `every day at ${time}`;
  if (arraysEqual(sorted, [...WEEKDAYS])) return `weekdays at ${time}`;
  if (arraysEqual(sorted, [...WEEKENDS])) return `weekends at ${time}`;
  if (sorted.length === 1) return `every ${DAY_NAMES[sorted[0]]} at ${time}`;
  const names = sorted.map((d) => DAY_NAMES[d]);
  const last = names.pop()!;
  // No Oxford comma for two-item lists: "monday and wednesday" reads more
  // naturally than "monday, and wednesday". The 3+ form keeps the Oxford
  // comma since `parseSchedule` accepts both shapes.
  if (names.length === 1) return `every ${names[0]} and ${last} at ${time}`;
  return `every ${names.join(", ")}, and ${last} at ${time}`;
}

function formatTime(hour: number, minute: number): string {
  const period = hour < 12 ? "am" : "pm";
  const display = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return minute === 0
    ? `${display}${period}`
    : `${display}:${String(minute).padStart(2, "0")}${period}`;
}

function arraysEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Runtime-checked wrapper around parseSchedule — throws instead of returning null.
 *  Useful in test code that constructs schedules from known-valid strings. */
export function requireSchedule(input: string): StrictAutomationSchedule {
  const schedule = parseSchedule(input);
  if (!schedule) throw new Error(`Could not parse schedule: "${input}"`);
  return schedule;
}

export function parseSchedule(input: string): StrictAutomationSchedule | null {
  const lower = input.toLowerCase().trim();

  // Shared time pattern: "HH:MM am/pm" with optional space before am/pm
  const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm)?`;

  /** Build a single (once-daily) schedule */
  function single(days: number[], time: { hour: number; minute: number }): SingleSchedule {
    return {
      kind: "single",
      naturalLanguage: input,
      days,
      time,
      hour: time.hour,
      minute: time.minute,
    };
  }

  /** Build an interval schedule */
  function interval(
    days: number[],
    intervalMinutes: number,
    anchor: TimeOfDay = { hour: 0, minute: 0 },
  ): IntervalSchedule {
    return {
      kind: "interval",
      naturalLanguage: input,
      days,
      intervalMinutes,
      anchor,
      hour: anchor.hour,
      minute: anchor.minute,
    };
  }

  /** Build a multi-time schedule (sorts and deduplicates) */
  function multi(days: number[], times: { hour: number; minute: number }[]): MultiSchedule | null {
    if (times.length === 0) return null;
    const sorted = [...times].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
    const deduped = sorted.filter(
      (t, i) => i === 0 || t.hour !== sorted[i - 1].hour || t.minute !== sorted[i - 1].minute,
    );
    if (deduped.length < 2) return null; // collapsed to single after dedup
    return {
      kind: "multi",
      naturalLanguage: input,
      days,
      times: deduped,
      hour: deduped[0].hour,
      minute: deduped[0].minute,
    };
  }

  // --- "every day" / "daily" ---
  let match = lower.match(new RegExp(String.raw`^(?:every\s+day|daily)\s+at\s+${TIME}$`));
  if (match) {
    const time = parseTime(match[1], match[2], match[3]);
    if (!time) return null;
    return single([...ALL_DAYS], time);
  }

  // --- "every weekday" / "weekdays" ---
  match = lower.match(new RegExp(String.raw`^(?:every\s+)?weekdays?\s+at\s+${TIME}$`));
  if (match) {
    const time = parseTime(match[1], match[2], match[3]);
    if (!time) return null;
    return single([...WEEKDAYS], time);
  }

  // --- "every weekend" / "weekends" ---
  match = lower.match(new RegExp(String.raw`^(?:every\s+)?weekends?\s+at\s+${TIME}$`));
  if (match) {
    const time = parseTime(match[1], match[2], match[3]);
    if (!time) return null;
    return single([...WEEKENDS], time);
  }

  // --- Day name map (singular + plural) ---
  const dayNames: Record<string, number> = {
    sunday: 0,
    sundays: 0,
    sun: 0,
    monday: 1,
    mondays: 1,
    mon: 1,
    tuesday: 2,
    tuesdays: 2,
    tue: 2,
    tues: 2,
    wednesday: 3,
    wednesdays: 3,
    wed: 3,
    thursday: 4,
    thursdays: 4,
    thu: 4,
    thur: 4,
    thurs: 4,
    friday: 5,
    fridays: 5,
    fri: 5,
    saturday: 6,
    saturdays: 6,
    sat: 6,
  };

  // --- Ordinal: "every first Monday at 8:00am" / "every 2nd Wednesday at 10am" ---
  const ordinalMatch = lower.match(
    new RegExp(
      String.raw`^every\s+(?:first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th|\d+(?:st|nd|rd|th))\s+(\w+)\s+at\s+${TIME}$`,
    ),
  );
  if (ordinalMatch && dayNames[ordinalMatch[1]] !== undefined) {
    const ordinalText = ordinalMatch[0].match(/(\d+)(?:st|nd|rd|th)/);
    if (ordinalText && parseInt(ordinalText[1], 10) > 5) {
      return null;
    }
    log.info(
      `[Automations] Ordinal schedule "${input}" treated as weekly on ${ordinalMatch[1]} (monthly not yet supported)`,
    );
    const time = parseTime(ordinalMatch[2], ordinalMatch[3], ordinalMatch[4]);
    if (!time) return null;
    return single([dayNames[ordinalMatch[1]]], time);
  }

  // --- "every <day> at HH:MM" (single day) ---
  match = lower.match(new RegExp(String.raw`^every\s+(\w+)\s+at\s+${TIME}$`));
  if (match && dayNames[match[1]] !== undefined) {
    const time = parseTime(match[2], match[3], match[4]);
    if (!time) return null;
    return single([dayNames[match[1]]], time);
  }

  // --- "every <day> and <day> at HH:MM" or "every <day>, <day>, and <day> at HH:MM" ---
  match = lower.match(new RegExp(String.raw`^every\s+(.+?)\s+at\s+${TIME}$`));
  if (match) {
    const daysPart = match[1].replace(/\s+and\s+/g, ",").replace(/,\s*/g, ",");
    const tokens = daysPart
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    const days = tokens.map((d) => dayNames[d]).filter((d) => d !== undefined);
    // Require ALL tokens to be valid day names — reject partial matches like "monday and banana"
    if (days.length > 0 && days.length === tokens.length) {
      const time = parseTime(match[2], match[3], match[4]);
      if (!time) return null;
      return single(days, time);
    }
  }

  // --- Reversed: "at HH:MM every <pattern>" ---
  match = lower.match(
    new RegExp(String.raw`^at\s+${TIME}\s+(?:every\s+)?(day|daily|weekdays?|weekends?|\w+)$`),
  );
  if (match) {
    const time = parseTime(match[1], match[2], match[3]);
    if (!time) return null;
    const pattern = match[4];
    if (pattern === "day" || pattern === "daily") {
      return single([...ALL_DAYS], time);
    }
    if (pattern === "weekday" || pattern === "weekdays") {
      return single([...WEEKDAYS], time);
    }
    if (pattern === "weekend" || pattern === "weekends") {
      return single([...WEEKENDS], time);
    }
    if (dayNames[pattern] !== undefined) {
      return single([dayNames[pattern]], time);
    }
  }

  // --- Bare "<day> at HH:MM" (one-shot, no "every") ---
  match = lower.match(new RegExp(String.raw`^(\w+)\s+at\s+${TIME}$`));
  if (match && dayNames[match[1]] !== undefined) {
    const time = parseTime(match[2], match[3], match[4]);
    if (!time) return null;
    return single([dayNames[match[1]]], time);
  }

  // --- Multi-time: "every day at 10am, 2pm, and 6pm" ---
  // Split on " at " — left is day scope, right is comma-separated time list
  const multiTimeMatch = lower.match(/^(.+?)\s+at\s+(.+(?:,|\s+and\s+).+)$/);
  if (multiTimeMatch) {
    // Parse day scope from left side
    const dayScope = multiTimeMatch[1].trim();
    let days: number[] = [];
    if (/^(?:every\s+day|daily)$/.test(dayScope)) days = [...ALL_DAYS];
    else if (/^(?:every\s+)?weekdays?$/.test(dayScope)) days = [...WEEKDAYS];
    else if (/^(?:every\s+)?weekends?$/.test(dayScope)) days = [...WEEKENDS];
    else {
      // Try parsing as day names: "every monday and wednesday"
      const dayPart = dayScope
        .replace(/^every\s+/, "")
        .replace(/\s+and\s+/g, ",")
        .replace(/,\s*/g, ",");
      const tokens = dayPart
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean);
      const parsed = tokens.map((d) => dayNames[d]).filter((d) => d !== undefined);
      if (parsed.length > 0 && parsed.length === tokens.length) days = parsed;
    }

    if (days.length > 0) {
      // Parse comma-separated times from right side
      // Handle Oxford comma: ", and " → "," before plain " and " → ","
      const timeParts = multiTimeMatch[2]
        .replace(/,\s+and\s+/g, ",")
        .replace(/\s+and\s+/g, ",")
        .replace(/,\s*/g, ",")
        .split(",");
      const times: { hour: number; minute: number }[] = [];
      let valid = true;
      for (const part of timeParts) {
        const trimmed = part.trim();
        if (!trimmed) {
          valid = false;
          break;
        }
        const timeMatch = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
        if (!timeMatch) {
          valid = false;
          break;
        }
        const parsedTime = parseTime(timeMatch[1], timeMatch[2], timeMatch[3]);
        if (!parsedTime) {
          valid = false;
          break;
        }
        times.push(parsedTime);
      }
      if (valid && times.length > 1) {
        const multiResult = multi(days, times);
        if (multiResult) return multiResult;
        return single(days, times[0]); // all times identical after dedup
      }
      if (valid && times.length === 1) return single(days, times[0]);
    }
  }

  // --- Interval patterns ---
  // Order matters: "at :MM" patterns before bare "every hour" to avoid false matches

  /** Validate interval: must be a positive integer that divides 1440 evenly */
  function validInterval(minutes: number): boolean {
    return Number.isInteger(minutes) && minutes > 0 && minutes <= 1440 && 1440 % minutes === 0;
  }

  /** Parse day scope suffix like "during weekdays" / "on weekdays".
   *  Returns null if the suffix is unrecognized (caller should reject). */
  function parseDayScope(suffix: string | undefined): number[] | null {
    if (!suffix) return [...ALL_DAYS];
    const trimmedSuffix = suffix.trim();
    if (/^(?:during|on)\s+weekdays?$/.test(trimmedSuffix)) return [...WEEKDAYS];
    if (/^(?:during|on)\s+weekends?$/.test(trimmedSuffix)) return [...WEEKENDS];
    return null; // unrecognized suffix
  }

  // "every hour at :15" / "every N hours at :MM" (with optional day scope)
  match = lower.match(/^every\s+(?:(\d+)\s+)?hours?\s+at\s+:(\d{2})(?:\s+(.+))?$/);
  if (match) {
    const hoursCount = match[1] ? parseInt(match[1], 10) : 1;
    const mins = hoursCount * 60;
    if (!validInterval(mins)) return null;
    const anchorMin = parseInt(match[2], 10);
    if (anchorMin < 0 || anchorMin > 59) return null;
    const days = parseDayScope(match[3]);
    if (match[3] && !days) return null;
    return interval(days ?? [...ALL_DAYS], mins, { hour: 0, minute: anchorMin });
  }

  // "every hour" / "hourly" (with optional day scope)
  match = lower.match(/^(?:every\s+hour|hourly)(?:\s+(.+))?$/);
  if (match) {
    const days = parseDayScope(match[1]);
    if (match[1] && !days) return null;
    return interval(days ?? [...ALL_DAYS], 60);
  }

  // "every N minutes" (with optional day scope)
  match = lower.match(/^every\s+(\d+)\s+minutes?(?:\s+(.+))?$/);
  if (match) {
    const mins = parseInt(match[1], 10);
    if (!validInterval(mins)) return null;
    const days = parseDayScope(match[2]);
    if (match[2] && !days) return null;
    return interval(days ?? [...ALL_DAYS], mins);
  }

  // "every N hours" (with optional day scope)
  match = lower.match(/^every\s+(\d+)\s+hours?(?:\s+(.+))?$/);
  if (match) {
    const mins = parseInt(match[1], 10) * 60;
    if (!validInterval(mins)) return null;
    const days = parseDayScope(match[2]);
    if (match[2] && !days) return null;
    return interval(days ?? [...ALL_DAYS], mins);
  }

  return null;
}

function parseTime(
  hourStr: string,
  minuteStr?: string,
  ampm?: string,
): { hour: number; minute: number } | null {
  let hour = parseInt(hourStr, 10);
  const minute = minuteStr ? parseInt(minuteStr, 10) : 0;
  // 12-hour clock: valid range is 1-12 when am/pm is specified
  if (ampm && (hour < 1 || hour > 12)) return null;
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function generateId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

/** Normalize a raw/legacy schedule object into the discriminated union format.
 *  Handles both old `{days, hour, minute}` and new `{kind, ...}` shapes.
 *  Returns a valid StrictAutomationSchedule or falls back to a safe single schedule. */
export function normalizeSchedule(input: unknown): StrictAutomationSchedule {
  const raw = isRecord(input) ? input : {};
  const naturalLanguage = typeof raw.naturalLanguage === "string" ? raw.naturalLanguage : "";
  const days = Array.isArray(raw.days)
    ? raw.days.filter(
        (d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6,
      )
    : [];
  const hour = typeof raw.hour === "number" ? raw.hour : 0;
  const minute = typeof raw.minute === "number" ? raw.minute : 0;

  // Already an interval schedule (validate intervalMinutes divides 1440)
  if (
    raw.kind === "interval" &&
    typeof raw.intervalMinutes === "number" &&
    Number.isInteger(raw.intervalMinutes) &&
    raw.intervalMinutes > 0 &&
    raw.intervalMinutes <= 1440 &&
    1440 % raw.intervalMinutes === 0
  ) {
    const anchorRaw = isRecord(raw.anchor) ? raw.anchor : {};
    const anchor = {
      hour: typeof anchorRaw.hour === "number" ? anchorRaw.hour : 0,
      minute: typeof anchorRaw.minute === "number" ? anchorRaw.minute : 0,
    };
    return {
      kind: "interval",
      naturalLanguage,
      days,
      intervalMinutes: raw.intervalMinutes,
      anchor,
      hour: anchor.hour,
      minute: anchor.minute,
    };
  }

  // Multi-time schedule
  if (raw.kind === "multi" && Array.isArray(raw.times)) {
    const times: TimeOfDay[] = [];
    for (const entry of raw.times) {
      if (!isRecord(entry)) continue;
      if (typeof entry.hour !== "number" || typeof entry.minute !== "number") continue;
      const entryHour = entry.hour;
      const entryMinute = entry.minute;
      if (entryHour < 0 || entryHour > 23 || entryMinute < 0 || entryMinute > 59) continue;
      times.push({ hour: entryHour, minute: entryMinute });
    }
    if (times.length > 0) {
      const sorted = [...times].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
      const deduped = sorted.filter(
        (t, i) => i === 0 || t.hour !== sorted[i - 1].hour || t.minute !== sorted[i - 1].minute,
      );
      if (deduped.length >= 2) {
        return {
          kind: "multi",
          naturalLanguage,
          days,
          times: deduped,
          hour: deduped[0].hour,
          minute: deduped[0].minute,
        };
      }
      // Dedup collapsed to single time
      return {
        kind: "single",
        naturalLanguage,
        days,
        time: deduped[0],
        hour: deduped[0].hour,
        minute: deduped[0].minute,
      };
    }
  }

  // Single schedule (explicit or legacy)
  const timeRaw = isRecord(raw.time) ? raw.time : null;
  const time = timeRaw
    ? {
        hour: typeof timeRaw.hour === "number" ? timeRaw.hour : hour,
        minute: typeof timeRaw.minute === "number" ? timeRaw.minute : minute,
      }
    : { hour, minute };
  return { kind: "single", naturalLanguage, days, time, hour: time.hour, minute: time.minute };
}

/** Type guard for plain objects from JSON.parse */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Mutating migration for raw JSON before Zod validation.
 *  Adds `kind` and `time` fields so discriminatedUnion can match. */
export function migrateScheduleInPlace(raw: Record<string, unknown>): void {
  if (raw.kind === "single" || raw.kind === "interval" || raw.kind === "multi") return;
  const normalized = normalizeSchedule(raw);
  Object.assign(raw, normalized);
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_WEEK = 7 * 24 * 60;

/** The longest wait of a one-off run: a weekday-and-time schedule repeats after one week. */
export const MAX_ONE_OFF_AHEAD_MS = (MINUTES_PER_WEEK - 1) * MS_PER_MINUTE;

export const ONE_OFF_ERRORS = {
  BOTH: 'Give either "runAt" or "runInMinutes", not both.',
  INVALID_RUN_AT: '"runAt" must be an ISO 8601 date and time, such as 2026-10-26T09:30:00+02:00.',
  INVALID_MINUTES: '"runInMinutes" must be a positive number.',
  IN_THE_PAST: "The run time is not in the future.",
  TOO_FAR:
    "A one-off run can be at most 7 days ahead. For a later date, create the automation nearer to it.",
} as const;

/** The input of a one-off run time: an exact moment or a delay from now. */
export interface OneOffInput {
  runAt?: string;
  runInMinutes?: number;
}

/** A schedule string for the one-off run, or the reason that the input is refused. */
export type OneOffScheduleResult = { ok: true; schedule: string } | { ok: false; error: string };

/** The exact future moment of a one-off run time, or the reason that the input is refused. */
export type OneOffInstantResult = { ok: true; instant: Date } | { ok: false; error: string };

export function resolveOneOffInstant(input: OneOffInput, now: Date): OneOffInstantResult {
  if (input.runAt !== undefined && input.runInMinutes !== undefined) {
    return { ok: false, error: ONE_OFF_ERRORS.BOTH };
  }
  const requested = requestedInstant(input, now);
  if ("error" in requested) return { ok: false, error: requested.error };
  if (requested.instant.getTime() <= now.getTime())
    return { ok: false, error: ONE_OFF_ERRORS.IN_THE_PAST };
  return { ok: true, instant: requested.instant };
}

/** Turns a one-off run time into the weekday-and-time schedule that parseSchedule accepts, rounded up to the next minute. */
export function resolveOneOffSchedule(input: OneOffInput, now: Date): OneOffScheduleResult {
  const resolved = resolveOneOffInstant(input, now);
  if (!resolved.ok) return resolved;
  const occurrence = new Date(
    Math.ceil(resolved.instant.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE,
  );
  if (occurrence.getTime() - now.getTime() > MAX_ONE_OFF_AHEAD_MS) {
    return { ok: false, error: ONE_OFF_ERRORS.TOO_FAR };
  }
  return {
    ok: true,
    schedule: formatScheduleNL(
      [occurrence.getDay()],
      occurrence.getHours(),
      occurrence.getMinutes(),
    ),
  };
}

function requestedInstant(input: OneOffInput, now: Date): { instant: Date } | { error: string } {
  if (input.runInMinutes !== undefined) {
    return Number.isFinite(input.runInMinutes) && input.runInMinutes > 0
      ? { instant: new Date(now.getTime() + input.runInMinutes * MS_PER_MINUTE) }
      : { error: ONE_OFF_ERRORS.INVALID_MINUTES };
  }
  const instant = new Date(input.runAt ?? "");
  return Number.isNaN(instant.getTime()) ? { error: ONE_OFF_ERRORS.INVALID_RUN_AT } : { instant };
}
