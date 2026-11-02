// electron/workflows/memo-store.ts
//
// In-memory store of step results keyed by the engine's derived stepKey
// (c-runtime §5.1). Hydrated from the event log on reattach.

import type { WorkflowEvent } from "../../common/workflows-contract";

export interface MemoEntry {
  readonly result: unknown;
  readonly completedAt: number;
}

export class MemoStore {
  private readonly entries = new Map<string, MemoEntry>();

  get(key: string): MemoEntry | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: MemoEntry): void {
    this.entries.set(key, entry);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Replace the in-memory map with entries derived from a replayed event log. */
  hydrateFromEvents(events: Iterable<WorkflowEvent>): void {
    this.entries.clear();
    for (const e of events) {
      if (e.type === "step.completed") {
        this.entries.set(e.payload.stepKey, {
          result: e.payload.result,
          completedAt: e.ts,
        });
      }
    }
  }

  /** Drop memos at or after `stepKeyPrefix`. Used by `retryFromStep`. */
  invalidateFromStep(stepKey: string): void {
    for (const key of Array.from(this.entries.keys())) {
      if (key === stepKey || key.startsWith(`${stepKey}/`)) {
        this.entries.delete(key);
      }
    }
  }

  size(): number {
    return this.entries.size;
  }
}
