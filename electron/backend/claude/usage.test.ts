import type { Query, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import { testDouble } from "../../testing/harness/test-double";
import { ClaudeRuntimeClient } from "./client";
import { ClaudeProcessRegistry } from "./process-registry";
import type { ClaudeSdkFacade } from "./sdk-facade";
import {
  ClaudeRateLimitEventCache,
  claudeUsageFromResponse,
  claudeWindowFromRateLimitEvent,
  isClaudeAuthFailure,
  type ClaudeUsageResponse,
} from "./usage";

const NOW = Date.parse("2026-10-18T08:00:00Z");

function limits(rateLimits: ClaudeUsageResponse["rate_limits"], plan = "max"): ClaudeUsageResponse {
  return { subscription_type: plan, rate_limits_available: true, rate_limits: rateLimits };
}

describe("claudeUsageFromResponse", () => {
  it("maps the plan windows, reset times, and the plan label", () => {
    const usage = claudeUsageFromResponse(
      limits({
        five_hour: { utilization: 9, resets_at: "2026-10-18T11:50:00+00:00" },
        seven_day: { utilization: 22.25, resets_at: "2026-10-20T11:00:00+00:00" },
        seven_day_opus: { utilization: 40, resets_at: null },
        seven_day_sonnet: null,
        seven_day_oauth_apps: { utilization: 1, resets_at: null },
        model_scoped: [
          { display_name: "Fable", utilization: 3, resets_at: "2026-10-22T04:00:00+00:00" },
          { display_name: "Opus", utilization: 40, resets_at: null },
        ],
      }),
      NOW,
    );

    expect(usage).toEqual({
      available: true,
      plan: "max",
      fetchedAt: NOW,
      windows: [
        {
          kind: "five_hour",
          usedPercent: 9,
          resetsAt: Date.parse("2026-10-18T11:50:00Z"),
          source: "fetch",
          fetchedAt: NOW,
        },
        {
          kind: "weekly",
          usedPercent: 22.3,
          resetsAt: Date.parse("2026-10-20T11:00:00Z"),
          source: "fetch",
          fetchedAt: NOW,
        },
        { kind: "weekly_opus", usedPercent: 40, source: "fetch", fetchedAt: NOW },
        {
          kind: "other",
          label: "Fable",
          usedPercent: 3,
          resetsAt: Date.parse("2026-10-22T04:00:00Z"),
          source: "fetch",
          fetchedAt: NOW,
        },
      ],
    });
  });

  it("skips windows without a utilization and clamps out-of-range values", () => {
    const usage = claudeUsageFromResponse(
      limits({
        five_hour: { utilization: null, resets_at: null },
        seven_day: { utilization: 140, resets_at: "not a date" },
      }),
      NOW,
    );
    expect(usage).toMatchObject({
      available: true,
      windows: [{ kind: "weekly", usedPercent: 100 }],
    });
    expect(usage?.available && usage.windows[0]?.resetsAt).toBeUndefined();
  });

  it("returns null when the response carries no plan rate limits", () => {
    expect(claudeUsageFromResponse(limits(null), NOW)).toBeNull();
    expect(claudeUsageFromResponse({ rate_limits_available: false }, NOW)).toBeNull();
  });
});

describe("per-turn rate_limit_event snapshots", () => {
  const info = (value: Partial<SDKRateLimitInfo>): SDKRateLimitInfo => ({
    status: "allowed",
    ...value,
  });

  it("converts the 0-1 utilization fraction and unix-second reset", () => {
    expect(
      claudeWindowFromRateLimitEvent(
        info({ rateLimitType: "seven_day_sonnet", utilization: 0.375, resetsAt: 1_792_000_000 }),
        NOW,
      ),
    ).toEqual({
      kind: "weekly_sonnet",
      usedPercent: 37.5,
      resetsAt: 1_792_000_000_000,
      source: "event",
      fetchedAt: NOW,
    });
  });

  it("treats a rejected event without utilization as exhausted and ignores unmapped limits", () => {
    expect(
      claudeWindowFromRateLimitEvent(info({ status: "rejected", rateLimitType: "five_hour" }), NOW),
    ).toMatchObject({ kind: "five_hour", usedPercent: 100 });
    expect(
      claudeWindowFromRateLimitEvent(info({ rateLimitType: "overage", utilization: 0.5 }), NOW),
    ).toBeNull();
    expect(claudeWindowFromRateLimitEvent(info({ rateLimitType: "five_hour" }), NOW)).toBeNull();
  });

  it("keeps the newest window per kind per config dir and drops windows that already reset", () => {
    const cache = new ClaudeRateLimitEventCache();
    const future = NOW / 1000 + 3600;
    cache.record(
      "/a",
      info({ rateLimitType: "five_hour", utilization: 0.1, resetsAt: future }),
      NOW,
    );
    cache.record(
      "/a",
      info({ rateLimitType: "five_hour", utilization: 0.2, resetsAt: future }),
      NOW,
    );
    cache.record(
      "/a",
      info({ rateLimitType: "seven_day", utilization: 0.5, resetsAt: NOW / 1000 - 5 }),
      NOW,
    );
    cache.record(
      "/b",
      info({ rateLimitType: "five_hour", utilization: 0.9, resetsAt: future }),
      NOW,
    );

    expect(cache.read("/a", NOW)).toEqual([
      expect.objectContaining({ kind: "five_hour", usedPercent: 20 }),
    ]);
    expect(cache.read("/b", NOW)).toHaveLength(1);
    expect(cache.read("/missing", NOW)).toEqual([]);
  });
});

describe("isClaudeAuthFailure", () => {
  it("recognizes authentication failures only", () => {
    expect(isClaudeAuthFailure(new Error("Request failed with status code 401"))).toBe(true);
    expect(isClaudeAuthFailure(new Error("OAuth token has expired"))).toBe(true);
    expect(isClaudeAuthFailure(new Error("socket hang up"))).toBe(false);
  });
});

function clientWithUsage(
  usage: () => Promise<unknown>,
  configuration: { env?: Record<string, string>; configDir?: string } = {},
) {
  const close = vi.fn<Query["close"]>();
  const query = testDouble<Query>({
    close,
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
  });
  const sdkQuery = vi.fn<ClaudeSdkFacade["query"]>(() => query);
  const client = new ClaudeRuntimeClient(
    testDouble<ClaudeSdkFacade>({ query: sdkQuery }),
    {
      workspaceDir: "/workspace",
      env: configuration.env ?? {},
      configDir: configuration.configDir ?? "/accounts/work",
    },
    new ClaudeProcessRegistry(),
  );
  return { client, sdkQuery, close };
}

describe("ClaudeRuntimeClient.getUsage", () => {
  it("reads plan usage through a no-turn control query and closes it", async () => {
    const { client, sdkQuery, close } = clientWithUsage(async () =>
      limits({ five_hour: { utilization: 12, resets_at: null } }, "team"),
    );

    await expect(client.getUsage()).resolves.toMatchObject({
      available: true,
      plan: "team",
      windows: [{ kind: "five_hour", usedPercent: 12, source: "fetch" }],
    });
    const options = sdkQuery.mock.calls[0]?.[0].options;
    expect(options).toMatchObject({ persistSession: false, tools: [] });
    expect(options?.env?.CLAUDE_CONFIG_DIR).toBe("/accounts/work");
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports API-key accounts as not applicable without starting a query", async () => {
    const { client, sdkQuery } = clientWithUsage(vi.fn(), { env: { ANTHROPIC_API_KEY: "key" } });

    await expect(client.getUsage()).resolves.toMatchObject({
      available: false,
      reason: "not_applicable",
    });
    expect(sdkQuery).not.toHaveBeenCalled();
  });

  it("reports an authentication failure as auth_expired", async () => {
    const { client, close } = clientWithUsage(async () => {
      throw new Error("Request failed with status code 401");
    });

    await expect(client.getUsage()).resolves.toMatchObject({
      available: false,
      reason: "auth_expired",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("falls back to the last per-turn snapshot when plan limits cannot be fetched", async () => {
    const { claudeRateLimitEvents } = await import("./usage");
    claudeRateLimitEvents.record("/accounts/work", {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.5,
      resetsAt: Date.now() / 1000 + 600,
    });
    const { client } = clientWithUsage(async () => limits(null, "max"));

    await expect(client.getUsage()).resolves.toMatchObject({
      available: true,
      plan: "max",
      windows: [{ kind: "five_hour", usedPercent: 50, source: "event" }],
    });
  });

  it("reports a failed fetch with no snapshot as an error, not as zero usage", async () => {
    const { client } = clientWithUsage(
      async () => {
        throw new Error("socket hang up");
      },
      { configDir: "/accounts/no-snapshot" },
    );

    await expect(client.getUsage()).resolves.toMatchObject({ available: false, reason: "error" });
  });
});
