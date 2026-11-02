// electron/workflows/event-log.ts
//
// Per-run append-only event log. Each line is independently encrypted
// (via `encryptLineWithKey`), so a partial write only loses the in-progress
// line on read. Spec: c-persist §4.
//
// The log appends are serialised by a single per-instance write queue —
// concurrent `append()` calls are placed in FIFO order so events never
// interleave on disk.

import * as fs from "node:fs";
import * as path from "node:path";

import { createLogger } from "../../common/marshal-logger";
import type { WorkflowEvent } from "../../common/workflows-contract";
import { decryptLineWithKey, encryptLineWithKey, loadOrCreateKey } from "../safe-storage-file";

const log = createLogger("WorkflowEventLog");

/**
 * Append a single event line to `filePath` (encrypted-per-line + `\n`).
 * Uses sync I/O because per-event durability is part of the engine's
 * step-completion contract — `engine.runStep` awaits this before
 * resolving the caller's promise.
 */
export function appendEventLine(filePath: string, event: WorkflowEvent): void {
  const key = loadOrCreateKey();
  const payload = JSON.stringify(event);
  const encoded = encryptLineWithKey(key, payload);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  // `appendFileSync` opens with O_APPEND on POSIX; on Windows the run-time
  // performs an atomic append. Single short writes survive SIGKILL with
  // at-most one truncated line (skipped by the reader).
  fs.appendFileSync(filePath, `${encoded}\n`, { mode: 0o600 });
}

/**
 * Stream events from an encrypted ndjson file in order. Skips and logs
 * any line that fails to decrypt (partial-write recovery per c-persist
 * §10). Returns an empty iterator if the file does not exist.
 */
export function* readEventLines(filePath: string): IterableIterator<WorkflowEvent> {
  if (!fs.existsSync(filePath)) return;
  const key = loadOrCreateKey();
  const raw = fs.readFileSync(filePath, "utf-8");
  if (raw.length === 0) return;
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    try {
      const plaintext = decryptLineWithKey(key, line);
      const parsed = JSON.parse(plaintext) as unknown;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- writers only produce WorkflowEvent payloads; per-line reads are best-effort
      yield parsed as WorkflowEvent;
    } catch (err) {
      log.warn(`Skipping unreadable event line ${i} in ${filePath}:`, err);
      continue;
    }
  }
}

export type EventListener = (event: WorkflowEvent) => void;

/**
 * Writer-side facade. Owns the next-seq counter, performs writes through
 * a per-instance serialised queue, and broadcasts every persisted event
 * to subscribed listeners (IPC bridge, in-memory snapshot reducer).
 */
export class EventLog {
  private writeChain: Promise<void> = Promise.resolve();
  private nextSeq: number;
  private readonly listeners = new Set<EventListener>();

  constructor(
    private readonly filePath: string,
    initialNextSeq: number = 0,
  ) {
    this.nextSeq = initialNextSeq;
  }

  /** The next-seq value to be persisted (useful for `RunRecord.nextEventSeq`). */
  getNextSeq(): number {
    return this.nextSeq;
  }

  /** Subscribe to live event broadcasts. Returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Append a typed event. The caller provides everything except `seq`/`ts`
   * — the log assigns both monotonically.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- E preserves the discriminated event variant through `partial`
  append<E extends Omit<WorkflowEvent, "seq" | "ts">>(partial: E): Promise<WorkflowEvent> {
    return new Promise<WorkflowEvent>((resolve, reject) => {
      this.writeChain = this.writeChain
        .then(() => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial provides the variant tag; assembly preserves the union shape
          const event = {
            seq: this.nextSeq,
            ts: Date.now(),
            ...partial,
          } as WorkflowEvent;
          this.nextSeq++;
          appendEventLine(this.filePath, event);
          // Broadcast after persistence — listeners see only durable events.
          for (const l of this.listeners) {
            try {
              l(event);
            } catch (err) {
              log.warn("Event listener threw:", err);
            }
          }
          resolve(event);
        })
        .catch((err) => {
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }
}
