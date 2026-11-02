import { createLogger } from "../../../../common/marshal-logger";

const log = createLogger("ConditionSupervisor");

export interface ConditionSupervisorDeps {
  cronRemove: (params: { id: string }) => Promise<unknown>;
}

export interface IConditionSupervisor {
  registerWatcher(reg: { cronId: string }): void;
  unregisterWatcher(cronId: string): void;
  handleSpawnFromCron(cronId: string): Promise<void>;
}

// Belt-and-braces for watchers: the watcher's agent is supposed to call
// cron.remove(self) after sessions_spawn, but models occasionally forget.
// On observing the spawn, m calls cron.remove from the owner side; the
// watcher's own call becomes redundant (cron.remove is idempotent).
export class ConditionSupervisor implements IConditionSupervisor {
  private deps: ConditionSupervisorDeps;
  private known = new Set<string>();
  private alreadyRemoved = new Set<string>();

  constructor(deps: ConditionSupervisorDeps) {
    this.deps = deps;
  }

  registerWatcher(reg: { cronId: string }): void {
    this.known.add(reg.cronId);
  }

  unregisterWatcher(cronId: string): void {
    this.known.delete(cronId);
    this.alreadyRemoved.delete(cronId);
  }

  async handleSpawnFromCron(cronId: string): Promise<void> {
    if (!this.known.has(cronId)) return;
    if (this.alreadyRemoved.has(cronId)) return;

    this.alreadyRemoved.add(cronId);
    try {
      await this.deps.cronRemove({ id: cronId });
      log.info(`Watcher ${cronId} removed by supervisor (sessions_spawn observed)`);
    } catch (err) {
      // Watcher's self-remove may still succeed, or reconcile-on-reconnect catches it.
      log.warn(
        `Supervisor cron.remove failed for ${cronId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// marshal cron-run convention: `agent:<agentId>:cron:<cronId>:run:<uuid>`.
export function parseCronIdFromParentSessionKey(
  parentSessionKey: string | undefined,
): string | null {
  if (!parentSessionKey) return null;
  const match = parentSessionKey.match(/:cron:([^:]+):run:/);
  return match?.[1] ?? null;
}
