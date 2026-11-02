import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

import {
  clampUsedPercent,
  type RuntimeAccountUsage,
  type RuntimeUsageWindow,
  type RuntimeUsageWindowKind,
} from "../../../common/runtime-account-usage";

/** The slice of the SDK's experimental `get_usage` response this adapter reads. */
export interface ClaudeUsageResponse {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: Record<string, unknown> | null;
}

const NAMED_WINDOWS: ReadonlyArray<readonly [string, RuntimeUsageWindowKind]> = [
  ["five_hour", "five_hour"],
  ["seven_day", "weekly"],
  ["seven_day_opus", "weekly_opus"],
  ["seven_day_sonnet", "weekly_sonnet"],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resetMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function fetchedWindow(
  kind: RuntimeUsageWindowKind,
  raw: unknown,
  now: number,
  label?: string,
): RuntimeUsageWindow | null {
  if (!isRecord(raw)) return null;
  const utilization = raw["utilization"];
  if (typeof utilization !== "number") return null;
  const resetsAt = resetMs(raw["resets_at"]);
  return {
    kind,
    ...(label ? { label } : {}),
    usedPercent: clampUsedPercent(utilization),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    source: "fetch",
    fetchedAt: now,
  };
}

/** Null when the response carries no plan rate limits (API key, fetch failure). */
export function claudeUsageFromResponse(
  response: ClaudeUsageResponse,
  now: number = Date.now(),
): RuntimeAccountUsage | null {
  const limits = response.rate_limits;
  if (!isRecord(limits)) return null;
  const windows: RuntimeUsageWindow[] = [];
  for (const [field, kind] of NAMED_WINDOWS) {
    const window = fetchedWindow(kind, limits[field], now);
    if (window) windows.push(window);
  }
  const scoped = limits["model_scoped"];
  const namedLabels = new Set(["opus", "sonnet"]);
  for (const entry of Array.isArray(scoped) ? scoped : []) {
    if (!isRecord(entry)) continue;
    const label = entry["display_name"];
    if (typeof label !== "string" || namedLabels.has(label.toLowerCase())) continue;
    const window = fetchedWindow("other", entry, now, label);
    if (window) windows.push(window);
  }
  const plan = response.subscription_type;
  return {
    available: true,
    ...(typeof plan === "string" && plan ? { plan: plan.toLowerCase() } : {}),
    windows,
    fetchedAt: now,
  };
}

const EVENT_WINDOW_KINDS: Partial<Record<string, RuntimeUsageWindowKind>> = {
  five_hour: "five_hour",
  seven_day: "weekly",
  seven_day_opus: "weekly_opus",
  seven_day_sonnet: "weekly_sonnet",
};

/** The SDK reports `utilization` as a 0-1 fraction (the `unified-*-utilization` header) and `resetsAt` in unix seconds. */
export function claudeWindowFromRateLimitEvent(
  info: SDKRateLimitInfo,
  now: number = Date.now(),
): RuntimeUsageWindow | null {
  const kind = info.rateLimitType ? EVENT_WINDOW_KINDS[info.rateLimitType] : undefined;
  if (!kind) return null;
  const fraction = info.utilization ?? (info.status === "rejected" ? 1 : undefined);
  if (fraction === undefined) return null;
  return {
    kind,
    usedPercent: clampUsedPercent(fraction * 100),
    ...(info.resetsAt !== undefined ? { resetsAt: info.resetsAt * 1000 } : {}),
    source: "event",
    fetchedAt: now,
  };
}

/** Latest per-turn rate-limit snapshot per Claude config dir, used when a usage read fails. */
export class ClaudeRateLimitEventCache {
  private readonly windows = new Map<string, Map<RuntimeUsageWindowKind, RuntimeUsageWindow>>();

  record(configDir: string, info: SDKRateLimitInfo, now: number = Date.now()): void {
    const window = claudeWindowFromRateLimitEvent(info, now);
    if (!window) return;
    const byKind = this.windows.get(configDir) ?? new Map();
    byKind.set(window.kind, window);
    this.windows.set(configDir, byKind);
  }

  read(configDir: string, now: number = Date.now()): RuntimeUsageWindow[] {
    const byKind = this.windows.get(configDir);
    if (!byKind) return [];
    return [...byKind.values()].filter(
      (window) => window.resetsAt === undefined || window.resetsAt > now,
    );
  }
}

export const claudeRateLimitEvents = new ClaudeRateLimitEventCache();

const AUTH_FAILURE =
  /\b(401|unauthori[sz]ed|authenticat|not logged in|log in|sign in|login|oauth)/i;

export function isClaudeAuthFailure(error: unknown): boolean {
  return AUTH_FAILURE.test(error instanceof Error ? error.message : String(error));
}
