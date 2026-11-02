import { createLogger } from "../common/marshal-logger";
import { evaluateRestartGuard, type RestartGuardSession } from "./app-restart-guard";
import {
  recordPendingRestartSync,
  recordRestartRefusalSync,
  type RestartLedgerEntry,
} from "./app-restart-ledger";

const log = createLogger("AppRestartExecutor");

/** Grace delay bounds — long enough for the granting turn's result to flush,
 *  short enough that "restart" means now, not "sometime later". */
export const DEFAULT_RESTART_DELAY_MS = 2_000;
export const MAX_RESTART_DELAY_MS = 30_000;
export const MAX_RESTART_REASON_LENGTH = 2_000;

/** The two Electron app methods the executor is allowed to touch, injected so
 *  tests never reach the real app. quit() (not exit(0)) so the before-quit
 *  flush — settings, memory, audit, sessions, runtime disposal — runs. */
export interface RestartAppPort {
  relaunch(): void;
  quit(): void;
}

export interface AppRestartExecutorDeps {
  app: RestartAppPort;
  /** Snapshot of known sessions with busy state + lineage for the guard. */
  listSessions: () => RestartGuardSession[] | Promise<RestartGuardSession[]>;
  /** Directory holding the restart ledger (app data dir in production). */
  ledgerDir: string;
  /** Called synchronously once a restart is granted, before the grace delay
   *  starts — the host's chance to log / notify the imminent restart. */
  onImminentRestart: (entry: RestartLedgerEntry) => void;
}

export interface AppRestartRequest {
  requesterSessionId: string;
  reason: string;
  force: boolean;
  delayMs?: number;
}

export interface BusySessionRef {
  sessionId: string;
  label?: string;
}

export type AppRestartOutcome =
  | { status: "invalid"; message: string }
  | { status: "refused"; busySessions: BusySessionRef[]; message: string }
  | { status: "already-scheduled"; message: string }
  | {
      status: "scheduled";
      delayMs: number;
      ledgerEntryId?: string;
      overriddenBusySessions: BusySessionRef[];
      message: string;
    };

export interface AppRestartExecutor {
  requestRestart(request: AppRestartRequest): Promise<AppRestartOutcome>;
}

function toBusyRef(session: RestartGuardSession): BusySessionRef {
  return { sessionId: session.sessionId, label: session.label };
}

/**
 * Host-side orchestrator for agent-requested app restarts: validates input,
 * runs the busy-session guard, writes the durable ledger record for every
 * outcome (refused or pending), then schedules relaunch+quit after a short
 * grace delay so the granting tool result can still reach the requester.
 */
export function createAppRestartExecutor(deps: AppRestartExecutorDeps): AppRestartExecutor {
  let scheduled = false;

  return {
    async requestRestart(request: AppRestartRequest): Promise<AppRestartOutcome> {
      const reason = request.reason?.trim();
      if (!reason) {
        return { status: "invalid", message: "A non-empty reason is required." };
      }
      if (reason.length > MAX_RESTART_REASON_LENGTH) {
        return {
          status: "invalid",
          message: `reason must be at most ${MAX_RESTART_REASON_LENGTH} characters.`,
        };
      }
      if (request.delayMs !== undefined) {
        if (
          !Number.isFinite(request.delayMs) ||
          request.delayMs < 0 ||
          request.delayMs > MAX_RESTART_DELAY_MS
        ) {
          return {
            status: "invalid",
            message: `delayMs must be between 0 and ${MAX_RESTART_DELAY_MS}.`,
          };
        }
      }
      if (scheduled) {
        return {
          status: "already-scheduled",
          message: "A restart is already scheduled; the app is about to go down.",
        };
      }

      const guard = evaluateRestartGuard({
        requesterSessionId: request.requesterSessionId,
        force: request.force,
        sessions: await deps.listSessions(),
      });
      if (scheduled) {
        // A concurrent request won the race while the session snapshot was
        // loading — never double-relaunch.
        return {
          status: "already-scheduled",
          message: "A restart is already scheduled; the app is about to go down.",
        };
      }
      const busyRefs = guard.blockingSessions.map(toBusyRef);

      if (!guard.allowed) {
        recordRestartRefusalSync(deps.ledgerDir, {
          requesterSessionId: request.requesterSessionId,
          reason,
          force: request.force,
          busySessionIds: busyRefs.map((ref) => ref.sessionId),
        });
        log.warn(
          `Restart refused for session ${request.requesterSessionId}: ${busyRefs.length} busy session(s) outside requester lineage`,
        );
        return {
          status: "refused",
          busySessions: busyRefs,
          message:
            "Refused: other agent sessions are busy. Coordinate with them or retry with force: true.",
        };
      }

      const delayMs = request.delayMs ?? DEFAULT_RESTART_DELAY_MS;
      const entry = recordPendingRestartSync(deps.ledgerDir, {
        requesterSessionId: request.requesterSessionId,
        reason,
        force: request.force,
      });
      scheduled = true;
      log.info(
        `Restart granted for session ${request.requesterSessionId} (force=${request.force}, delayMs=${delayMs})`,
      );
      if (entry) deps.onImminentRestart(entry);

      const timer = setTimeout(() => {
        deps.app.relaunch();
        deps.app.quit();
      }, delayMs);
      // Don't let the grace timer keep a dying event loop alive in tests or
      // in an already-quitting app.
      timer.unref?.();

      return {
        status: "scheduled",
        delayMs,
        ledgerEntryId: entry?.id,
        overriddenBusySessions: busyRefs,
        message: `Restart scheduled in ${delayMs}ms. The app will relaunch and restore sessions.`,
      };
    },
  };
}
