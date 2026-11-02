import type { RuntimeAccountsView } from "../common/marshal-ipc-contract";
import { createLogger } from "../common/marshal-logger";
import type { RuntimeAccountUsage } from "../common/runtime-account-usage";

const log = createLogger("RuntimeAccountsKeepAlive");

/**
 * Runtime CLIs refresh an OAuth token only when the account is used, and a refresh token can
 * lapse while its account sits idle. Reading each account's usage on this cadence uses it.
 */
const KEEP_ALIVE_INTERVAL_MS = 45 * 60_000;
const STARTUP_DELAY_MS = 60_000;
const JITTER_RATIO = 0.25;

/** Usage results after which touching the account again cannot refresh anything. */
const NOTHING_TO_KEEP_ALIVE = new Set<string>(["signed_out", "not_applicable"]);

export interface RuntimeAccountsKeepAliveSource {
  list(): RuntimeAccountsView[];
  getUsage(
    runtimeId: string,
    accountId: string,
    options?: { force?: boolean },
  ): Promise<RuntimeAccountUsage>;
  lastKnownUsage(runtimeId: string, accountId: string): RuntimeAccountUsage | undefined;
}

export interface RuntimeAccountsKeepAliveOptions {
  intervalMs?: number;
  startupDelayMs?: number;
  random?: () => number;
}

/**
 * Touches every signed-in runtime account on a schedule, one account at a time, so each
 * runtime refreshes its own login. Only metadata is logged.
 */
export class RuntimeAccountsKeepAlive {
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private stopped = false;
  private running: Promise<void> | undefined;
  private readonly intervalMs: number;
  private readonly startupDelayMs: number;
  private readonly random: () => number;

  constructor(
    private readonly source: RuntimeAccountsKeepAliveSource,
    options: RuntimeAccountsKeepAliveOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? KEEP_ALIVE_INTERVAL_MS;
    this.startupDelayMs = options.startupDelayMs ?? STARTUP_DELAY_MS;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.schedule(this.startupDelayMs);
  }

  stop(): void {
    this.started = false;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One pass over every account; resolves when it finishes. Passes never overlap. */
  runOnce(): Promise<void> {
    this.running ??= this.touchAccounts().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private schedule(baseMs: number): void {
    const jitter = 1 + (this.random() * 2 - 1) * JITTER_RATIO;
    this.timer = setTimeout(
      () => {
        void this.runOnce().finally(() => {
          if (!this.stopped) this.schedule(this.intervalMs);
        });
      },
      Math.max(0, Math.round(baseMs * jitter)),
    );
    this.timer.unref();
  }

  private async touchAccounts(): Promise<void> {
    let runtimes: RuntimeAccountsView[];
    try {
      runtimes = this.source.list();
    } catch (error) {
      log.warn("Account list unavailable:", error instanceof Error ? error.name : "unknown");
      return;
    }
    for (const runtime of runtimes) {
      for (const account of runtime.accounts) {
        if (this.stopped) return;
        const target = `${runtime.runtimeId}/${account.id}`;
        const known = this.source.lastKnownUsage(runtime.runtimeId, account.id);
        if (known && !known.available && NOTHING_TO_KEEP_ALIVE.has(known.reason)) continue;
        try {
          // eslint-disable-next-line no-await-in-loop -- accounts are touched one at a time on purpose
          const usage = await this.source.getUsage(runtime.runtimeId, account.id, { force: true });
          if (usage.available)
            log.info(`Kept ${target} signed in (${usage.windows.length} windows)`);
          else log.warn(`Account ${target} unavailable: ${usage.reason}`);
        } catch (error) {
          log.warn(
            `Keep-alive failed for ${target}:`,
            error instanceof Error ? error.name : "unknown",
          );
        }
      }
    }
  }
}
