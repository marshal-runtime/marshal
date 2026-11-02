// src/features/workflows/format.ts
//
// Tiny display helpers shared across the Workflows tab. Kept dep-free so
// they can be reused from snapshot fixtures and tests without dragging
// React into a test environment.

import type {
  StepStatus,
  WorkflowRunStatus,
  ExecutionUnitStatus,
} from "@common/workflows-contract";

const TWO_DIGIT = (n: number): string => n.toString().padStart(2, "0");

/** Compact "1h 12m" / "47m" / "3s" — like incident's `formatRunDuration`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

/** Short relative time — "now", "2m ago", "1h ago", "3d ago", or YYYY-MM-DD. */
export function formatRelative(when: number | null | undefined, now = Date.now()): string {
  if (when == null || !Number.isFinite(when)) return "—";
  const delta = now - when;
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 86_400_000 * 7) return `${Math.floor(delta / 86_400_000)}d ago`;
  const d = new Date(when);
  return `${d.getFullYear()}-${TWO_DIGIT(d.getMonth() + 1)}-${TWO_DIGIT(d.getDate())}`;
}

export const RUN_STATUS_LABEL: Readonly<Record<WorkflowRunStatus, string>> = {
  pending: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  crashed: "Crashed",
};

export const RUN_STATUS_GLYPH: Readonly<Record<WorkflowRunStatus, string>> = {
  pending: "○",
  running: "●",
  succeeded: "✓",
  failed: "✗",
  cancelled: "■",
  crashed: "✗",
};

export const STEP_STATUS_GLYPH: Readonly<Record<StepStatus, string>> = {
  pending: "○",
  running: "●",
  succeeded: "✓",
  failed: "✗",
  skipped: "↷",
  "skipped-replay": "↷",
};

export const UNIT_STATUS_GLYPH: Readonly<Record<ExecutionUnitStatus, string>> = {
  queued: "○",
  running: "●",
  succeeded: "✓",
  failed: "✗",
  cancelled: "■",
};
