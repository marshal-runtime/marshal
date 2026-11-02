/** Compact a raw token count for inline display: "850", "4.2K", "12M".
 *  No "tokens" suffix — callers add it where needed. */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const rounded = Math.round(n);
  if (rounded < 1000) return `${rounded}`;
  if (rounded < 1_000_000) return `${stripTrailingZero(rounded / 1000)}K`;
  return `${stripTrailingZero(rounded / 1_000_000)}M`;
}

function stripTrailingZero(value: number): string {
  // One decimal place, dropping a trailing ".0" (e.g. 12.0 → "12", 4.2 → "4.2").
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

/** Human-friendly, coarse duration: "30 seconds", "45 minutes", "1 hour",
 *  "about 2 hours", "about 3 days". Coarser units (hours/days) gain an
 *  "about" qualifier except the exact singular ("1 hour", "1 day"). */
export function humanizeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 seconds";

  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return `${seconds} ${plural(seconds, "second")}`;
  }
  if (ms < 3_600_000) {
    const minutes = Math.round(ms / 60_000);
    return `${minutes} ${plural(minutes, "minute")}`;
  }
  if (ms < 86_400_000) {
    const hours = Math.round(ms / 3_600_000);
    return hours === 1 ? "1 hour" : `about ${hours} hours`;
  }
  const days = Math.round(ms / 86_400_000);
  return days === 1 ? "1 day" : `about ${days} days`;
}

function plural(n: number, unit: string): string {
  return n === 1 ? unit : `${unit}s`;
}

/** Total active elapsed time in ms — accumulated activeMs plus the live tail
 *  of the current pursuit run while status is "pursuing". */
export function formatElapsed(goal: {
  lifecycle: string;
  activeMs: number;
  startedPursuingAt: string | null;
}): number {
  const live =
    goal.lifecycle === "pursuing" && goal.startedPursuingAt
      ? Math.max(0, Date.now() - Date.parse(goal.startedPursuingAt))
      : 0;
  return goal.activeMs + live;
}

/** Compact "Hh Mm" / "Mm Ss" / "Ss" elapsed for the inline widget row. */
export function formatCompactElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Truncate a goal objective for the collapsed widget row. */
export function truncateObjective(s: string, max = 60): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max).trimEnd()}\u2026`;
}
