import type { RuntimeUsageWindow, RuntimeUsageWindowKind } from "@common/runtime-account-usage";

const WINDOW_ORDER: Record<RuntimeUsageWindowKind, number> = {
  five_hour: 0,
  weekly: 1,
  weekly_opus: 2,
  weekly_sonnet: 3,
  other: 4,
};

const WINDOW_LABELS: Record<Exclude<RuntimeUsageWindowKind, "other">, string> = {
  five_hour: "5-hour",
  weekly: "Weekly",
  weekly_opus: "Opus weekly",
  weekly_sonnet: "Sonnet weekly",
};

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export function usageWindowLabel(window: RuntimeUsageWindow): string {
  if (window.kind !== "other") return WINDOW_LABELS[window.kind];
  return window.label ? `${window.label} limit` : "Other limit";
}

/** "resets in 2h 15m" within a day, otherwise the reset weekday and time. */
export function formatUsageReset(resetsAt: number | undefined, now: number): string | null {
  if (resetsAt === undefined) return null;
  const remaining = resetsAt - now;
  if (remaining <= 0) return "resetting now";
  if (remaining >= DAY_MS) {
    return `resets ${new Date(resetsAt).toLocaleString(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  const minutes = Math.max(1, Math.round(remaining / MINUTE_MS));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `resets in ${hours}h ${minutes % 60}m` : `resets in ${minutes}m`;
}

export function sortUsageWindows(windows: RuntimeUsageWindow[]): RuntimeUsageWindow[] {
  return [...windows].sort((left, right) => WINDOW_ORDER[left.kind] - WINDOW_ORDER[right.kind]);
}
