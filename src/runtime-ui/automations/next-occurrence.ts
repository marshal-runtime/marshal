import type { AutomationSchedule } from "@/types/electron";

export function getNextOccurrence(schedule: AutomationSchedule): Date | null {
  if (!schedule.days.length) return null;
  const now = new Date();

  if (schedule.kind === "interval" && schedule.intervalMinutes && schedule.anchor) {
    const anchorMin = schedule.anchor.hour * 60 + schedule.anchor.minute;
    for (let ahead = 0; ahead <= 7; ahead++) {
      const day = new Date(now);
      day.setDate(now.getDate() + ahead);
      if (!schedule.days.includes(day.getDay())) continue;
      for (let slotMin = anchorMin; slotMin < 1440; slotMin += schedule.intervalMinutes) {
        const candidate = new Date(
          day.getFullYear(),
          day.getMonth(),
          day.getDate(),
          0,
          slotMin,
          0,
          0,
        );
        if (candidate > now) return candidate;
      }
    }
    return null;
  }

  if (schedule.kind === "multi" && schedule.times && schedule.times.length > 0) {
    for (let ahead = 0; ahead <= 7; ahead++) {
      const day = new Date(now);
      day.setDate(now.getDate() + ahead);
      if (!schedule.days.includes(day.getDay())) continue;
      for (const time of schedule.times) {
        const candidate = new Date(day);
        candidate.setHours(time.hour, time.minute, 0, 0);
        if (candidate > now) return candidate;
      }
    }
    return null;
  }

  const hour = schedule.time?.hour ?? schedule.hour;
  const minute = schedule.time?.minute ?? schedule.minute;
  for (let ahead = 0; ahead <= 7; ahead++) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + ahead);
    candidate.setHours(hour, minute, 0, 0);
    if (schedule.days.includes(candidate.getDay()) && candidate > now) {
      return candidate;
    }
  }
  return null;
}
