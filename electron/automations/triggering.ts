import type { StrictAutomationSchedule, IntervalSchedule, TimeOfDay } from "./domain/contracts";

/** On the very first schedule check after startup (lastCheck === null), trigger
 *  automations whose scheduled time is within this window in the past. */
export const FIRST_CHECK_GRACE_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Start of local calendar day (midnight) */
export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/** Add N calendar days in local time (DST-safe) */
export function addLocalDays(date: Date, count: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count, 0, 0, 0, 0);
}

/** Check if two dates are on the same local calendar day */
export function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Evaluate whether a schedule should trigger between lastCheck and now. */
export function shouldTriggerSchedule(
  schedule: StrictAutomationSchedule,
  now: Date,
  lastCheck: Date | null,
): boolean {
  return findDueScheduleOccurrence(schedule, now, lastCheck) !== null;
}

/** Return the latest schedule occurrence in the check window, if any. */
export function findDueScheduleOccurrence(
  schedule: StrictAutomationSchedule,
  now: Date,
  lastCheck: Date | null,
): Date | null {
  if (schedule.days.length === 0) return null;

  if (schedule.kind === "interval") {
    return findDueIntervalOccurrence(schedule, now, lastCheck);
  }

  if (schedule.kind === "multi") {
    return findDueMultiTimeOccurrence(schedule.times, schedule.days, now, lastCheck);
  }

  const time = schedule.time ?? { hour: schedule.hour, minute: schedule.minute };
  return findDueSingleTimeOccurrence(time, schedule.days, now, lastCheck);
}

/** Check if a single time-of-day trigger fell in the check window.
 *  Returns on the first matching day — a multi-day outage triggers one catch-up
 *  run, not one per missed day. This is intentional: automations should recover
 *  quickly on startup, not replay every missed occurrence. */
export function shouldTriggerSingleTime(
  time: TimeOfDay,
  days: number[],
  now: Date,
  lastCheck: Date | null,
): boolean {
  return findDueSingleTimeOccurrence(time, days, now, lastCheck) !== null;
}

function findDueSingleTimeOccurrence(
  time: TimeOfDay,
  days: readonly number[],
  now: Date,
  lastCheck: Date | null,
): Date | null {
  const windowStartMs =
    lastCheck === null ? now.getTime() - FIRST_CHECK_GRACE_MS : lastCheck.getTime();

  if (windowStartMs >= now.getTime()) return null;

  const startDay = startOfLocalDay(lastCheck ?? new Date(windowStartMs));
  const endDay = startOfLocalDay(now);

  for (let day = endDay; day.getTime() >= startDay.getTime(); day = addLocalDays(day, -1)) {
    if (lastCheck === null && !sameLocalDay(day, now)) continue;
    if (!days.includes(day.getDay())) continue;

    const scheduled = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      time.hour,
      time.minute,
      0,
      0,
    );
    const scheduledMs = scheduled.getTime();
    if (scheduledMs > windowStartMs && scheduledMs <= now.getTime()) {
      return scheduled;
    }
  }
  return null;
}

/** Interval trigger: check if any interval slot fell in (windowStart, now]. */
export function shouldTriggerInterval(
  schedule: IntervalSchedule,
  now: Date,
  lastCheck: Date | null,
): boolean {
  return findDueIntervalOccurrence(schedule, now, lastCheck) !== null;
}

function findDueIntervalOccurrence(
  schedule: IntervalSchedule,
  now: Date,
  lastCheck: Date | null,
): Date | null {
  const anchorMinutes = schedule.anchor.hour * 60 + schedule.anchor.minute;
  const windowStartMs =
    lastCheck === null ? now.getTime() - FIRST_CHECK_GRACE_MS : lastCheck.getTime();

  if (windowStartMs >= now.getTime()) return null;

  const startDay = startOfLocalDay(lastCheck ?? new Date(windowStartMs));
  const endDay = startOfLocalDay(now);

  for (let day = endDay; day.getTime() >= startDay.getTime(); day = addLocalDays(day, -1)) {
    if (lastCheck === null && !sameLocalDay(day, now)) continue;
    if (!schedule.days.includes(day.getDay())) continue;

    const latestSlotMin = Math.floor((1439 - anchorMinutes) / schedule.intervalMinutes);
    for (let slotIdx = latestSlotMin; slotIdx >= 0; slotIdx--) {
      const slotMin = anchorMinutes + slotIdx * schedule.intervalMinutes;
      const slot = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, slotMin, 0, 0);
      const slotMs = slot.getTime();
      if (slotMs > windowStartMs && slotMs <= now.getTime()) {
        return slot;
      }
    }
  }
  return null;
}

function findDueMultiTimeOccurrence(
  times: readonly TimeOfDay[],
  days: readonly number[],
  now: Date,
  lastCheck: Date | null,
): Date | null {
  const sortedTimes = [...times].sort((a, b) => b.hour * 60 + b.minute - (a.hour * 60 + a.minute));
  const windowStartMs =
    lastCheck === null ? now.getTime() - FIRST_CHECK_GRACE_MS : lastCheck.getTime();
  if (windowStartMs >= now.getTime()) return null;

  const startDay = startOfLocalDay(lastCheck ?? new Date(windowStartMs));
  const endDay = startOfLocalDay(now);
  for (let day = endDay; day.getTime() >= startDay.getTime(); day = addLocalDays(day, -1)) {
    if (lastCheck === null && !sameLocalDay(day, now)) continue;
    if (!days.includes(day.getDay())) continue;
    for (const time of sortedTimes) {
      const scheduled = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        time.hour,
        time.minute,
        0,
        0,
      );
      const scheduledMs = scheduled.getTime();
      if (scheduledMs > windowStartMs && scheduledMs <= now.getTime()) return scheduled;
    }
  }
  return null;
}
