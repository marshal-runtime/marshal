import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_RESTART_DELAY_MS,
  createAppRestartExecutor,
  type AppRestartExecutorDeps,
} from "./app-restart-executor";
import type { RestartGuardSession } from "./app-restart-guard";
import { readRestartLedgerEntries } from "./app-restart-ledger";

function makeDeps(overrides: Partial<AppRestartExecutorDeps> = {}): {
  deps: AppRestartExecutorDeps;
  relaunch: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
} {
  const relaunch = vi.fn<() => void>();
  const quit = vi.fn<() => void>();
  const deps: AppRestartExecutorDeps = {
    app: { relaunch, quit },
    listSessions: () => [],
    ledgerDir: overrides.ledgerDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "restart-exec-")),
    onImminentRestart: () => {},
    ...overrides,
  };
  return { deps, relaunch, quit };
}

describe("createAppRestartExecutor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects an empty reason without touching the app", async () => {
    const { deps, relaunch, quit } = makeDeps();
    const executor = createAppRestartExecutor(deps);
    const result = await executor.requestRestart({
      requesterSessionId: "req",
      reason: "   ",
      force: false,
    });
    expect(result.status).toBe("invalid");
    expect(relaunch).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(readRestartLedgerEntries(deps.ledgerDir)).toHaveLength(0);
  });

  it("rejects an out-of-bounds delayMs", async () => {
    const { deps, relaunch } = makeDeps();
    const executor = createAppRestartExecutor(deps);
    const results = await Promise.all(
      [-1, MAX_RESTART_DELAY_MS + 1, Number.NaN].map((delayMs) =>
        executor.requestRestart({
          requesterSessionId: "req",
          reason: "valid reason",
          force: false,
          delayMs,
        }),
      ),
    );
    expect(results.map((result) => result.status)).toEqual(["invalid", "invalid", "invalid"]);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("refuses when unrelated sessions are busy and records the refusal", async () => {
    const sessions: RestartGuardSession[] = [
      { sessionId: "req", busy: true },
      { sessionId: "other", busy: true, label: "mobile lane" },
    ];
    const { deps, relaunch, quit } = makeDeps({ listSessions: () => sessions });
    const executor = createAppRestartExecutor(deps);
    const result = await executor.requestRestart({
      requesterSessionId: "req",
      reason: "reload runtime packs",
      force: false,
    });
    expect(result).toMatchObject({
      status: "refused",
      busySessions: [{ sessionId: "other", label: "mobile lane" }],
    });
    expect(relaunch).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();

    const ledger = readRestartLedgerEntries(deps.ledgerDir);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      status: "refused",
      requesterSessionId: "req",
      busySessionIds: ["other"],
    });
  });

  it("schedules relaunch+quit after the grace delay and writes the pending ledger entry first", async () => {
    const events: string[] = [];
    const { deps } = makeDeps({
      onImminentRestart: (entry) => events.push(`notify:${entry.reason}`),
    });
    deps.app = {
      relaunch: () => events.push("relaunch"),
      quit: () => events.push("quit"),
    };
    const executor = createAppRestartExecutor(deps);
    const result = await executor.requestRestart({
      requesterSessionId: "req",
      reason: "reload runtime packs",
      force: false,
      delayMs: 500,
    });
    expect(result).toMatchObject({ status: "scheduled", delayMs: 500 });

    // Ledger entry is written synchronously at grant time, before the exit.
    const ledger = readRestartLedgerEntries(deps.ledgerDir);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ status: "pending", reason: "reload runtime packs" });

    // Nothing happens until the grace delay elapses.
    expect(events).toEqual(["notify:reload runtime packs"]);
    vi.advanceTimersByTime(499);
    expect(events).toEqual(["notify:reload runtime packs"]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual(["notify:reload runtime packs", "relaunch", "quit"]);
  });

  it("applies the default grace delay when delayMs is omitted", async () => {
    const { deps, relaunch, quit } = makeDeps();
    const executor = createAppRestartExecutor(deps);
    const result = await executor.requestRestart({
      requesterSessionId: "req",
      reason: "default delay",
      force: false,
    });
    expect(result).toMatchObject({ status: "scheduled", delayMs: expect.any(Number) });
    vi.runAllTimers();
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("force restarts despite busy sessions and records what was overridden", async () => {
    const sessions: RestartGuardSession[] = [
      { sessionId: "req", busy: true },
      { sessionId: "other", busy: true },
    ];
    const { deps, relaunch } = makeDeps({ listSessions: () => sessions });
    const executor = createAppRestartExecutor(deps);
    const result = await executor.requestRestart({
      requesterSessionId: "req",
      reason: "urgent fix",
      force: true,
      delayMs: 0,
    });
    expect(result).toMatchObject({
      status: "scheduled",
      overriddenBusySessions: [{ sessionId: "other" }],
    });
    vi.advanceTimersByTime(0);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("refuses a second request while one restart is already scheduled", async () => {
    const { deps, relaunch } = makeDeps();
    const executor = createAppRestartExecutor(deps);
    const first = await executor.requestRestart({
      requesterSessionId: "req",
      reason: "first",
      force: false,
    });
    expect(first.status).toBe("scheduled");
    const second = await executor.requestRestart({
      requesterSessionId: "req-2",
      reason: "second",
      force: true,
    });
    expect(second.status).toBe("already-scheduled");
    // Only one ledger pending entry and eventually one relaunch.
    expect(
      readRestartLedgerEntries(deps.ledgerDir).filter((e) => e.status === "pending"),
    ).toHaveLength(1);
    vi.runAllTimers();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});
