export type RuntimeUsageWindowKind =
  | "five_hour"
  | "weekly"
  | "weekly_opus"
  | "weekly_sonnet"
  | "other";

export interface RuntimeUsageWindow {
  kind: RuntimeUsageWindowKind;
  /** Display name for `other` windows, e.g. a model-scoped weekly limit. */
  label?: string;
  /** Share of the window already used, 0-100. */
  usedPercent: number;
  /** Epoch ms when the window resets; absent when the runtime does not report it. */
  resetsAt?: number;
  /** `fetch` came from an explicit usage read; `event` from a rate-limit notice during a turn. */
  source: "fetch" | "event";
  /** Epoch ms when this window was read. */
  fetchedAt: number;
}

export type RuntimeAccountUsageUnavailableReason =
  /** API key, cloud provider, or a runtime that reports no plan usage. */
  | "not_applicable"
  | "signed_out"
  /** Signed in on paper but the login can no longer be used; signing in again fixes it. */
  | "auth_expired"
  | "error";

export type RuntimeAccountUsage =
  | {
      available: true;
      /** Plan name as the runtime reports it, lower-case: `max`, `pro`, `team`, `plus`. */
      plan?: string;
      windows: RuntimeUsageWindow[];
      fetchedAt: number;
    }
  | {
      available: false;
      reason: RuntimeAccountUsageUnavailableReason;
      message?: string;
      fetchedAt: number;
    };

export function unavailableUsage(
  reason: RuntimeAccountUsageUnavailableReason,
  message?: string,
  fetchedAt: number = Date.now(),
): RuntimeAccountUsage {
  return { available: false, reason, ...(message ? { message } : {}), fetchedAt };
}

export function clampUsedPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}
