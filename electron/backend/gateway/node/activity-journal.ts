import { randomUUID } from "crypto";

import type { NodeActivityEntry } from "../../../../common/marshal-ipc-contract";
import { createLogger } from "../../../../common/marshal-logger";

const log = createLogger("GatewayNodeActivityJournal");

export const GATEWAY_NODE_ACTIVITY_CAPACITY = 100;
const PREVIEW_MAX_CHARS = 240;
export type GatewayNodeActivityRecord = Omit<NodeActivityEntry, "id" | "timestamp">;

type Subscriber = (entry: NodeActivityEntry) => void;

export class GatewayNodeActivityJournal {
  private readonly entries: NodeActivityEntry[] = [];
  private readonly subscribers = new Set<Subscriber>();

  push(record: GatewayNodeActivityRecord): NodeActivityEntry {
    const entry: NodeActivityEntry = {
      ...record,
      id: randomUUID(),
      timestamp: Date.now(),
      ...(record.paramsPreview !== undefined
        ? { paramsPreview: truncatePreview(record.paramsPreview) }
        : {}),
      ...(record.resultPreview !== undefined
        ? { resultPreview: truncatePreview(record.resultPreview) }
        : {}),
    };
    this.entries.push(entry);
    if (this.entries.length > GATEWAY_NODE_ACTIVITY_CAPACITY) {
      this.entries.shift();
    }
    for (const sub of this.subscribers) {
      try {
        sub(entry);
      } catch (err) {
        log.warn("subscriber threw:", err);
      }
    }
    return entry;
  }

  getAll(): NodeActivityEntry[] {
    return this.entries.slice();
  }

  subscribe(callback: Subscriber): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  clear(): void {
    this.entries.length = 0;
  }
}

function truncatePreview(input: string): string {
  if (input.length <= PREVIEW_MAX_CHARS) return input;
  return input.slice(0, PREVIEW_MAX_CHARS) + "…";
}
