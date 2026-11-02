import * as path from "node:path";

import {
  COMMAND_CENTER_REDACTION_VERSION,
  COMMAND_CENTER_SCHEMA_VERSION,
  type CommandCenterAppendResult,
  type CommandCenterEvent,
  type CommandCenterEventInput,
} from "../../common/command-center-contract";
import type { CommandCenterSnapshot } from "../../common/command-center-contract";
import {
  createEmptyCommandCenterSnapshot,
  markCommandCenterDegraded,
  reduceCommandCenterEvent,
  replayCommandCenterEvents,
} from "../../common/command-center-reducer";
import { createLogger } from "../../common/marshal-logger";
import { getAppDataDir } from "../app-paths";
import {
  appendCommandCenterEventLine,
  type CommandCenterEventLogTailReader,
  readCommandCenterEventLines,
  repairCommandCenterEventLog,
} from "./event-log";

const log = createLogger("CommandCenterRepository");
const RECOVERY_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 60_000] as const;

export interface CommandCenterRepositoryOptions {
  rootDir?: string;
  maxEventLogBytes?: number;
  eventLogTailReader?: CommandCenterEventLogTailReader;
  eventLogAppender?: typeof appendCommandCenterEventLine;
  recoveryRetryDelaysMs?: readonly number[];
}

export class CommandCenterRepository {
  private writeChain: Promise<void> = Promise.resolve();
  private nextSeq = 0;
  private snapshot: CommandCenterSnapshot = createEmptyCommandCenterSnapshot();
  private eventLogWritable = true;
  private recoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryRetryIndex = 0;
  private recoveryRetriesExhausted = false;

  constructor(private readonly options: CommandCenterRepositoryOptions = {}) {}

  get rootDir(): string {
    return this.options.rootDir ?? path.join(getAppDataDir(), "marshal-command-center");
  }

  get eventLogPath(): string {
    return path.join(this.rootDir, "events.ndjson.enc");
  }

  getSnapshot(): CommandCenterSnapshot {
    return this.snapshot;
  }

  rebuild(): CommandCenterSnapshot {
    let maxSeq = -1;
    const replayEvents: CommandCenterEvent[] = [];

    // These events reconstruct durable state, including unfinished todos and
    // goal history. A time window silently erases that state on restart. The
    // event-log reader already bounds the amount of data read at startup.
    const readResult = readCommandCenterEventLines(this.eventLogPath, {
      maxBytes: this.options.maxEventLogBytes,
      readTail: this.options.eventLogTailReader,
    });
    for (const entry of readResult.entries) {
      maxSeq = Math.max(maxSeq, entry.globalSeq);
      if (!entry.event) continue;
      replayEvents.push(entry.event);
    }
    let snapshot = replayCommandCenterEvents(replayEvents);
    this.nextSeq = maxSeq + 1;
    const boundedTailHasNoIntactFrame = readResult.droppedPrefix && readResult.entries.length === 0;
    this.eventLogWritable =
      readResult.readErrorCode === undefined &&
      readResult.unavailableEncryptedLineCount === 0 &&
      !boundedTailHasNoIntactFrame;
    snapshot = {
      ...snapshot,
      replay: {
        ...snapshot.replay,
        lastDurableSeq: maxSeq,
        skippedEvents:
          snapshot.replay.skippedEvents +
          readResult.discardedLineCount +
          readResult.unsupportedLineCount +
          (readResult.droppedPrefix ? 1 : 0) +
          (readResult.readErrorCode ? 1 : 0) +
          readResult.unavailableEncryptedLineCount,
      },
    };
    if (readResult.readErrorCode) {
      log.error("Failed to read Command Center event log", {
        code: readResult.readErrorCode,
      });
      snapshot = markCommandCenterDegraded(
        snapshot,
        `Command Center event log read failed (${readResult.readErrorCode})`,
      );
    } else if (readResult.unavailableEncryptedLineCount > 0) {
      log.warn(
        "Retained encrypted Command Center event lines because the encryption key is unavailable",
      );
      snapshot = markCommandCenterDegraded(
        snapshot,
        "Command Center event log encryption key is unavailable",
      );
    } else if (boundedTailHasNoIntactFrame) {
      log.error("Command Center event log tail contained no intact frame; retained source file");
      snapshot = markCommandCenterDegraded(
        snapshot,
        "Command Center event log tail contained no intact frame",
      );
    } else if (
      readResult.discardedLineCount > 0 ||
      readResult.droppedPrefix ||
      readResult.unterminatedFinalLine
    ) {
      try {
        repairCommandCenterEventLog(this.eventLogPath, readResult);
      } catch (error) {
        log.error("Failed to repair Command Center event log:", error);
        const message = error instanceof Error ? error.message : String(error);
        snapshot = markCommandCenterDegraded(snapshot, `Event log repair failed: ${message}`);
        this.eventLogWritable = false;
      }
    }
    this.snapshot = snapshot;
    if (this.eventLogWritable) {
      this.clearRecoveryRetry();
    } else {
      this.scheduleRecoveryRetry();
    }
    return this.snapshot;
  }

  append(input: CommandCenterEventInput): Promise<CommandCenterAppendResult> {
    const run = this.writeChain.then(() => {
      if (!this.eventLogWritable) {
        this.scheduleRecoveryRetry();
        throw new Error("Command Center event log is unavailable; recovery is pending");
      }
      const event: CommandCenterEvent = {
        ...input,
        schemaVersion: COMMAND_CENTER_SCHEMA_VERSION,
        redactionVersion: COMMAND_CENTER_REDACTION_VERSION,
        globalSeq: this.nextSeq,
        ts: input.ts ?? Date.now(),
      };
      try {
        (this.options.eventLogAppender ?? appendCommandCenterEventLine)(this.eventLogPath, event);
      } catch (error) {
        this.eventLogWritable = false;
        const code = persistenceErrorCode(error);
        const message = `Command Center event log append failed (${code}); recovery is pending`;
        this.snapshot = markCommandCenterDegraded(this.snapshot, message);
        this.scheduleRecoveryRetry();
        throw Object.assign(new Error(message, { cause: error }), { code });
      }
      this.nextSeq++;
      this.snapshot = reduceCommandCenterEvent(this.snapshot, event);
      return { event, snapshot: this.snapshot };
    });

    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  private scheduleRecoveryRetry(): void {
    if (this.recoveryRetryTimer) return;
    const delays = this.options.recoveryRetryDelaysMs ?? RECOVERY_RETRY_DELAYS_MS;
    if (delays.length === 0) return;
    const delayMs = delays[this.recoveryRetryIndex];
    if (delayMs === undefined) {
      if (!this.recoveryRetriesExhausted) {
        this.recoveryRetriesExhausted = true;
        log.error("Command Center event-log recovery retries exhausted");
      }
      return;
    }
    this.recoveryRetryIndex++;
    this.recoveryRetryTimer = setTimeout(() => {
      this.recoveryRetryTimer = null;
      try {
        this.rebuild();
      } catch (error) {
        const code = persistenceErrorCode(error);
        this.eventLogWritable = false;
        this.snapshot = markCommandCenterDegraded(
          this.snapshot,
          `Command Center event-log recovery failed (${code})`,
        );
        log.error("Command Center event-log recovery failed", { code });
        this.scheduleRecoveryRetry();
      }
    }, delayMs);
  }

  private clearRecoveryRetry(): void {
    if (this.recoveryRetryTimer) {
      clearTimeout(this.recoveryRetryTimer);
      this.recoveryRetryTimer = null;
    }
    this.recoveryRetryIndex = 0;
    this.recoveryRetriesExhausted = false;
  }
}

function persistenceErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name : "UNKNOWN";
}
