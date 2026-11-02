import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeAccountsView } from "../common/marshal-ipc-contract";
import type { RuntimeAccountUsage } from "../common/runtime-account-usage";
import {
  RuntimeAccountsKeepAlive,
  type RuntimeAccountsKeepAliveSource,
} from "./runtime-accounts-keepalive";

const account = (id: string) => ({
  id,
  label: id,
  isOriginal: id === "default",
  isDefault: id === "default",
  targetKey: id === "default" ? "claude" : `claude@${id}`,
});

const RUNTIMES: RuntimeAccountsView[] = [
  {
    runtimeId: "claude",
    displayName: "Claude Agent",
    authMethods: [],
    accounts: [account("default"), account("work"), account("old")],
  },
  { runtimeId: "cursor", displayName: "Cursor", authMethods: [], accounts: [account("default")] },
];

const OK: RuntimeAccountUsage = { available: true, windows: [], fetchedAt: 1 };

function source(overrides: Partial<RuntimeAccountsKeepAliveSource> = {}) {
  const getUsage = vi.fn<RuntimeAccountsKeepAliveSource["getUsage"]>(async () => OK);
  const base: RuntimeAccountsKeepAliveSource = {
    list: () => RUNTIMES,
    getUsage,
    lastKnownUsage: () => undefined,
    ...overrides,
  };
  return { base, getUsage };
}

describe("RuntimeAccountsKeepAlive", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("touches every account one at a time with a forced read", async () => {
    let active = 0;
    let overlapped = false;
    const { base, getUsage } = source({
      getUsage: vi.fn<RuntimeAccountsKeepAliveSource["getUsage"]>(async () => {
        active += 1;
        overlapped ||= active > 1;
        await Promise.resolve();
        active -= 1;
        return OK;
      }),
    });

    await new RuntimeAccountsKeepAlive(base).runOnce();

    expect(overlapped).toBe(false);
    expect(vi.mocked(base.getUsage).mock.calls.map((call) => `${call[0]}/${call[1]}`)).toEqual([
      "claude/default",
      "claude/work",
      "claude/old",
      "cursor/default",
    ]);
    expect(vi.mocked(base.getUsage).mock.calls.every((call) => call[2]?.force === true)).toBe(true);
    expect(getUsage).not.toHaveBeenCalled();
  });

  it("skips accounts whose last read was signed out or not applicable", async () => {
    const { base } = source({
      lastKnownUsage: (_runtime, accountId) =>
        accountId === "old"
          ? { available: false, reason: "signed_out", fetchedAt: 1 }
          : accountId === "default"
            ? { available: false, reason: "not_applicable", fetchedAt: 1 }
            : { available: false, reason: "auth_expired", fetchedAt: 1 },
    });

    await new RuntimeAccountsKeepAlive(base).runOnce();

    expect(vi.mocked(base.getUsage).mock.calls.map((call) => call[1])).toEqual(["work"]);
  });

  it("keeps going after one account's read throws", async () => {
    const { base } = source({
      getUsage: vi.fn<RuntimeAccountsKeepAliveSource["getUsage"]>(async (_runtime, accountId) => {
        if (accountId === "work") throw new Error("boom");
        return OK;
      }),
    });

    await new RuntimeAccountsKeepAlive(base).runOnce();

    expect(base.getUsage).toHaveBeenCalledTimes(4);
  });

  it("runs after a jittered startup delay, then on the interval, until stopped", async () => {
    const { base } = source({ list: () => RUNTIMES.slice(0, 1) });
    const keepAlive = new RuntimeAccountsKeepAlive(base, {
      startupDelayMs: 1_000,
      intervalMs: 10_000,
      random: () => 0.5,
    });

    keepAlive.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(base.getUsage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(base.getUsage).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(base.getUsage).toHaveBeenCalledTimes(6);

    keepAlive.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(base.getUsage).toHaveBeenCalledTimes(6);
  });
});
