import type { SessionHydrationEvent } from "@/types/electron";

export interface HydrationSnapshot {
  isHydrating: boolean;
}

export const IDLE: HydrationSnapshot = { isHydrating: false };
export const HYDRATING: HydrationSnapshot = { isHydrating: true };

type Listener = () => void;

class HydrationStateStore {
  private readonly states = new Map<string, HydrationSnapshot>();
  private readonly listeners = new Set<Listener>();
  private ipcCleanup: (() => void) | null = null;
  private initializationCleanup: (() => void) | null = null;

  initialize(): () => void {
    if (this.initializationCleanup) return this.initializationCleanup;
    if (!window.sessionsAPI?.onHydrationChanged) return () => {};

    this.ipcCleanup = window.sessionsAPI.onHydrationChanged((event) => this.record(event));
    this.initializationCleanup = () => this.reset();
    return this.initializationCleanup;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot(sessionId: string | null): HydrationSnapshot {
    return sessionId ? (this.states.get(sessionId) ?? IDLE) : IDLE;
  }

  reset(): void {
    this.ipcCleanup?.();
    this.ipcCleanup = null;
    this.initializationCleanup = null;
    this.states.clear();
    this.listeners.clear();
  }

  private record(event: SessionHydrationEvent): void {
    this.states.set(event.sessionId, event.state === "started" ? HYDRATING : IDLE);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Store invariants do not depend on subscriber correctness. */
      }
    }
  }
}

export const hydrationStore = new HydrationStateStore();
