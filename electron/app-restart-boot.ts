import { createLogger } from "../common/marshal-logger";
import { resolvePendingRestartsOnBootSync } from "./app-restart-ledger";

const log = createLogger("AppRestartBoot");

/** System-notice payload appended to the requesting session's transcript. */
export interface RestartBootNotice {
  id: string;
  content: string;
  timestamp: string;
}

/** Wake message enqueued to the durable agent-message outbox. Deterministic
 *  messageId/idempotencyKey so a crash between enqueue and delivery cannot
 *  produce a duplicate wake on the next boot. */
export interface RestartWakeMessage {
  messageId: string;
  idempotencyKey: string;
  source: string;
  sourceLabel: string;
  target: string;
  kind: "app-restart";
  deliveryMode: "queue";
  content: string;
}

export interface AppRestartBootDeps {
  ledgerDir: string;
  /** Append a system message to the session transcript (and emit it to any
   *  open view). Returns false when deduped/rejected. */
  appendSystemNotice: (sessionId: string, notice: RestartBootNotice) => boolean;
  /** Durable outbox enqueue — delivery runs a real turn in the target session
   *  once dispatch resumes, which is what re-engages the requester. */
  enqueueWakeMessage: (input: RestartWakeMessage) => Promise<unknown>;
  onLifecycleEvent: (event: string, details: Record<string, unknown>) => void;
}

/**
 * Boot-time continuity for agent-requested restarts. For every ledger entry
 * that was pending when the app went down: mark it completed, append a
 * visible system notice to the requesting session, and enqueue a durable
 * wake message so the session actively resumes instead of sitting idle until
 * a human re-engages it (the requester's original turn died with the old
 * process). Notice and wake are independent best-effort paths — one failing
 * must not take the other down.
 */
export async function surfaceCompletedRestartsOnBoot(
  deps: AppRestartBootDeps,
): Promise<{ completed: number; wakesEnqueued: number }> {
  const entries = resolvePendingRestartsOnBootSync(deps.ledgerDir);
  let wakesEnqueued = 0;
  for (const entry of entries) {
    deps.onLifecycleEvent("app.restart.completed", {
      requesterSessionId: entry.requesterSessionId,
      ledgerEntryId: entry.id,
      force: entry.force,
    });
    const timestamp = entry.completedAt ?? new Date().toISOString();
    try {
      deps.appendSystemNotice(entry.requesterSessionId, {
        id: `app-restart:${entry.id}`,
        content:
          `Marshal restarted and reloaded at this session's request ` +
          `(reason: ${entry.reason}). Sessions were restored; the turn that ` +
          `requested the restart ended with the old process.`,
        timestamp,
      });
    } catch (error) {
      log.warn("Failed to append restart notice:", error);
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- entries are rare (usually one) and ordering keeps the ledger sequence readable
      await deps.enqueueWakeMessage({
        messageId: `app-restart-wake:${entry.id}`,
        idempotencyKey: `app-restart-wake:${entry.id}`,
        source: "app-restart",
        sourceLabel: "Marshal restart",
        target: entry.requesterSessionId,
        kind: "app-restart",
        deliveryMode: "queue",
        content:
          `The Marshal app restart you requested (reason: ${entry.reason}) has ` +
          `completed — the app relaunched and sessions were restored. Your ` +
          `previous turn ended with the old process. Review where you left ` +
          `off and continue your work.`,
      });
      wakesEnqueued += 1;
    } catch (error) {
      log.warn("Failed to enqueue restart wake message:", error);
    }
  }
  return { completed: entries.length, wakesEnqueued };
}
