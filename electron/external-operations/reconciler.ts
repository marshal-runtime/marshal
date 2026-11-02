import { createLogger } from "../../common/marshal-logger";
import type { ExternalOperationRegistry } from "./registry";
import { isExternalOperationTerminalState } from "./types";

const log = createLogger("ExternalOperationReconciler");
const DEFAULT_RECONCILE_INTERVAL_MS = 5_000;

export interface ExternalOperationReconcilerOptions {
  intervalMs?: number;
  now?: () => number;
}

export class ExternalOperationReconciler {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly subscriptions = new Map<string, () => void>();

  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopping = false;
  private reconciling: Promise<void> | null = null;

  constructor(
    private readonly registry: ExternalOperationRegistry,
    options: ExternalOperationReconcilerOptions = {},
  ) {
    this.intervalMs = Math.max(
      100,
      Math.floor(options.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS),
    );
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.stopping) throw new Error("External-operation reconciler is stopping");
    this.running = true;
    try {
      await this.registry.start();
      this.refreshSubscriptions();
      await this.reconcileNow(true);
      this.schedule();
    } catch (error) {
      this.running = false;
      this.clearSubscriptions();
      throw error;
    }
  }

  async reconcileNow(force = false): Promise<void> {
    if (!this.running || this.stopping) return;
    if (this.reconciling) return await this.reconciling;
    const flight = this.reconcileDue(force).finally(() => {
      if (this.reconciling === flight) this.reconciling = null;
    });
    this.reconciling = flight;
    await flight;
  }

  async reconcileStartup(): Promise<void> {
    if (!this.running) {
      await this.start();
      return;
    }
    await this.reconcileNow(true);
  }

  async recoverAfterRuntimeReset(options?: {
    adapterIds?: readonly string[];
    reason?: string;
  }): Promise<void> {
    if (this.stopping) return;
    this.clearTimer();
    this.clearSubscriptions();
    await this.registry.recoverAfterRuntimeReset(options);
    if (!this.running || this.stopping) return;
    this.refreshSubscriptions();
    this.schedule();
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (!this.running) {
      await this.registry.shutdown();
      this.stopping = false;
      return;
    }
    this.running = false;
    this.clearTimer();
    this.clearSubscriptions();
    await this.reconciling;
    await this.registry.shutdown();
    this.clearSubscriptions();
    this.stopping = false;
  }

  private async reconcileDue(force: boolean): Promise<void> {
    if (this.stopping) return;
    const now = this.now();
    const due = this.registry
      .list({ includeTerminal: true })
      .filter((operation) => {
        if (
          isExternalOperationTerminalState(operation.state)
        ) {
          return operation.notification.state === "pending";
        }
        if (force || operation.state === "unknown" || operation.state === "cancelling") {
          return true;
        }
        if (!operation.watcher.nextCheckAt) return true;
        return Date.parse(operation.watcher.nextCheckAt) <= now;
      });
    await Promise.all(
      due.map(async (operation) => {
        if (this.stopping) return;
        try {
          await this.registry.reconcile(operation.operationId);
        } catch {
          log
            .with({ operationId: operation.operationId })
            .warn("External-operation reconciliation failed");
        }
      }),
    );
    if (!this.stopping) this.refreshSubscriptions();
  }

  private refreshSubscriptions(): void {
    if (this.stopping || !this.running) return;
    const visible = new Set<string>();
    for (const operation of this.registry.list({ includeTerminal: true })) {
      if (isExternalOperationTerminalState(operation.state)) continue;
      if (operation.watcher.strategy === "poll") continue;
      visible.add(operation.operationId);
      if (operation.state === "unknown" || operation.state === "cancelling") {
        this.subscriptions.get(operation.operationId)?.();
        this.subscriptions.delete(operation.operationId);
        continue;
      }
      if (this.subscriptions.has(operation.operationId)) continue;
      const unsubscribe = this.registry.subscribeToProvider(operation.operationId);
      if (unsubscribe) this.subscriptions.set(operation.operationId, unsubscribe);
    }
    for (const [operationId, unsubscribe] of this.subscriptions) {
      if (visible.has(operationId)) continue;
      unsubscribe();
      this.subscriptions.delete(operationId);
    }
  }

  private schedule(): void {
    if (!this.running || this.stopping || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reconcileNow()
        .catch(() => log.warn("External-operation reconciliation pass failed"))
        .finally(() => {
          if (!this.stopping) this.schedule();
        });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private clearSubscriptions(): void {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
  }
}
