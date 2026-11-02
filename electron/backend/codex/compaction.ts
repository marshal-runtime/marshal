import type { CodexNotification } from "./jsonl-rpc";
import { isRecord } from "./protocol";

export const CODEX_COMPACTION_TIMEOUT_MS = 10 * 60_000;

interface PendingCompaction {
  turnId: string | null;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Manual compaction (`thread/compact/start`) runs as its own app-server turn:
 * `turn/started`, an `item/*:contextCompaction` pair, then `turn/completed`
 * (verified against codex-cli 0.146.0-alpha.10.1; `thread/compacted` is not
 * emitted). The request only acknowledges the start, so completion is the
 * compaction turn's `turn/completed`.
 */
export class CodexCompactionTracker {
  private pending: PendingCompaction | null = null;

  get active(): boolean {
    return this.pending !== null;
  }

  begin(timeoutMs = CODEX_COMPACTION_TIMEOUT_MS): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error("Codex context compaction timed out"));
      }, timeoutMs);
      this.pending = { turnId: null, resolve, reject, timer };
    });
  }

  /** Abandon the wait without settling it (the start request itself failed). */
  cancel(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending = null;
  }

  fail(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.reject(error);
  }

  onNotification(notification: CodexNotification): void {
    const pending = this.pending;
    if (!pending) return;
    const params = notification.params;
    if (!isRecord(params) || !isRecord(params["turn"])) return;
    const turn = params["turn"];
    const turnId = typeof turn["id"] === "string" ? turn["id"] : null;
    if (notification.method === "turn/started") {
      pending.turnId ??= turnId;
      return;
    }
    if (notification.method !== "turn/completed" || turnId === null || turnId !== pending.turnId) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending = null;
    if (turn["status"] === "failed") {
      const error = isRecord(turn["error"]) ? turn["error"] : undefined;
      const message = typeof error?.["message"] === "string" ? error["message"] : undefined;
      pending.reject(new Error(message ?? "Codex context compaction failed"));
    } else if (turn["status"] === "interrupted") {
      pending.reject(new Error("Codex context compaction was interrupted"));
    } else {
      pending.resolve();
    }
  }
}
