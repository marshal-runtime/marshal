import * as fs from "node:fs";
import * as path from "node:path";

import {
  classifyCommandCenterEvent,
  type CommandCenterEvent,
} from "../../common/command-center-contract";
import { createLogger } from "../../common/marshal-logger";
import { secureAtomicWriteFileSync, secureMkdirSync } from "../platform-security";
import { decryptLineWithKey, encryptLineWithKey, loadOrCreateKey } from "../safe-storage-file";

const log = createLogger("CommandCenterEventLog");
export const COMMAND_CENTER_EVENT_LOG_MAX_BYTES = 8 * 1024 * 1024;

export interface CommandCenterEventLogEntry {
  readonly encodedLine: string;
  readonly globalSeq: number;
  readonly ts: number;
  readonly event?: CommandCenterEvent;
}

export interface ReadCommandCenterEventLogResult {
  readonly entries: CommandCenterEventLogEntry[];
  readonly discardedLineCount: number;
  readonly unsupportedLineCount: number;
  readonly unavailableEncryptedLineCount: number;
  readonly droppedPrefix: boolean;
  readonly unterminatedFinalLine: boolean;
  readonly sourceBytes: number;
  readonly readErrorCode?: string;
}

export interface CommandCenterEventLogTail {
  readonly raw: string;
  readonly droppedPrefix: boolean;
  readonly sourceBytes: number;
}

export type CommandCenterEventLogTailReader = (
  filePath: string,
  maxBytes: number,
) => CommandCenterEventLogTail;

export function appendCommandCenterEventLine(filePath: string, event: CommandCenterEvent): void {
  const key = loadOrCreateKey();
  const encoded = encryptLineWithKey(key, JSON.stringify(event));
  secureMkdirSync(path.dirname(filePath), 0o700);
  const separator = needsLineSeparator(filePath) ? "\n" : "";
  fs.appendFileSync(filePath, `${separator}${encoded}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best effort */
  }
}

export function readCommandCenterEventLines(
  filePath: string,
  options: {
    maxBytes?: number;
    readTail?: CommandCenterEventLogTailReader;
  } = {},
): ReadCommandCenterEventLogResult {
  let tail: CommandCenterEventLogTail;
  try {
    tail = (options.readTail ?? readBoundedTail)(
      filePath,
      options.maxBytes ?? COMMAND_CENTER_EVENT_LOG_MAX_BYTES,
    );
  } catch (error) {
    if (isMissingFileError(error)) return emptyReadResult();
    return {
      ...emptyReadResult(),
      readErrorCode: persistenceErrorCode(error),
    };
  }
  const { raw, droppedPrefix, sourceBytes } = tail;
  if (raw.length === 0) {
    return {
      ...emptyReadResult(),
      droppedPrefix,
      sourceBytes,
    };
  }
  let key: Buffer | null;
  try {
    key = loadOrCreateKey();
  } catch (error) {
    return {
      ...emptyReadResult(),
      droppedPrefix,
      sourceBytes,
      readErrorCode: persistenceErrorCode(error),
    };
  }
  const entries: CommandCenterEventLogEntry[] = [];
  let discardedLineCount = 0;
  let unsupportedLineCount = 0;
  let unavailableEncryptedLineCount = 0;
  let cursor = 0;
  while (cursor < raw.length) {
    const newline = raw.indexOf("\n", cursor);
    const end = newline === -1 ? raw.length : newline;
    const rawLine = raw.slice(cursor, end);
    cursor = newline === -1 ? raw.length : newline + 1;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) {
      discardedLineCount++;
      continue;
    }
    let plaintext: string;
    try {
      plaintext = decryptLineWithKey(key, line);
    } catch {
      if (key === null) {
        unavailableEncryptedLineCount++;
      } else {
        discardedLineCount++;
      }
      continue;
    }
    try {
      // SF-4: the parsed value is accepted only after the exhaustive event validator below.
      const parsed = JSON.parse(plaintext) as unknown;
      const classification = classifyCommandCenterEvent(parsed);
      switch (classification.kind) {
        case "supported":
          entries.push({
            event: classification.event,
            globalSeq: classification.event.globalSeq,
            ts: classification.event.ts,
            encodedLine: line,
          });
          break;
        case "unsupported":
          unsupportedLineCount++;
          entries.push({
            globalSeq: classification.globalSeq,
            ts: classification.ts,
            encodedLine: line,
          });
          break;
        case "invalid":
          discardedLineCount++;
          break;
      }
    } catch {
      discardedLineCount++;
    }
  }
  return {
    entries,
    discardedLineCount,
    unsupportedLineCount,
    unavailableEncryptedLineCount,
    droppedPrefix,
    unterminatedFinalLine: !raw.endsWith("\n"),
    sourceBytes,
  };
}

export function repairCommandCenterEventLog(
  filePath: string,
  result: ReadCommandCenterEventLogResult,
): void {
  replaceCommandCenterEventLines(
    filePath,
    result.entries.map((entry) => entry.encodedLine),
  );
  if (result.discardedLineCount > 0) {
    log.warn(
      `Repaired Command Center event log by removing ${result.discardedLineCount} unreadable or invalid line(s)`,
    );
  }
  if (result.droppedPrefix) {
    log.info("Compacted Command Center event log to its bounded recent tail", {
      sourceBytes: result.sourceBytes,
      retainedLines: result.entries.length,
    });
  }
  if (result.unterminatedFinalLine) {
    log.info("Normalized unterminated final Command Center event frame");
  }
}

export function replaceCommandCenterEventLines(
  filePath: string,
  encodedLines: readonly string[],
): void {
  const content = encodedLines.length > 0 ? `${encodedLines.join("\n")}\n` : "";
  secureAtomicWriteFileSync(filePath, content, {
    encoding: "utf-8",
    mode: 0o600,
    directoryMode: 0o700,
  });
}

function emptyReadResult(): ReadCommandCenterEventLogResult {
  return {
    entries: [],
    discardedLineCount: 0,
    unsupportedLineCount: 0,
    unavailableEncryptedLineCount: 0,
    droppedPrefix: false,
    unterminatedFinalLine: false,
    sourceBytes: 0,
  };
}

function readBoundedTail(filePath: string, maxBytes: number): CommandCenterEventLogTail {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Command Center event-log read limit must be a positive integer");
  }
  const sourceBytes = fs.statSync(filePath).size;
  if (sourceBytes === 0) return { raw: "", droppedPrefix: false, sourceBytes };

  const start = Math.max(0, sourceBytes - maxBytes);
  const length = sourceBytes - start;
  const file = fs.openSync(filePath, "r");
  try {
    let previousByte = 0x0a;
    if (start > 0) {
      const prefix = Buffer.allocUnsafe(1);
      if (fs.readSync(file, prefix, 0, 1, start - 1) === 1) previousByte = prefix[0];
    }

    const bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const read = fs.readSync(file, bytes, offset, length - offset, start + offset);
      if (read === 0) break;
      offset += read;
    }
    let raw = bytes.subarray(0, offset).toString("utf-8");
    if (start > 0 && previousByte !== 0x0a) {
      const firstNewline = raw.indexOf("\n");
      raw = firstNewline === -1 ? "" : raw.slice(firstNewline + 1);
    }
    return { raw, droppedPrefix: start > 0, sourceBytes };
  } finally {
    fs.closeSync(file);
  }
}

function needsLineSeparator(filePath: string): boolean {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
  if (size === 0) return false;

  const file = fs.openSync(filePath, "r");
  try {
    const lastByte = Buffer.allocUnsafe(1);
    return fs.readSync(file, lastByte, 0, 1, size - 1) === 1 && lastByte[0] !== 0x0a;
  } finally {
    fs.closeSync(file);
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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
