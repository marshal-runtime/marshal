import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COMMAND_CENTER_REDACTION_VERSION,
  COMMAND_CENTER_SCHEMA_VERSION,
  type CommandCenterEventInput,
} from "../../common/command-center-contract";
import {
  _test as safeStorageTest,
  encryptLineWithKey,
  loadOrCreateKey,
} from "../safe-storage-file";
import { CommandCenterActivityDetailStore } from "./activity-detail-store";
import {
  COMMAND_CENTER_EVENT_LOG_MAX_BYTES,
  type CommandCenterEventLogTailReader,
} from "./event-log";
import { CommandCenterManager } from "./manager";
import { CommandCenterPrivacyNormalizer } from "./privacy-normalizer";
import { CommandCenterRepository } from "./repository";

const runtime = vi.hoisted(() => ({ appDataDir: "", encryptionAvailable: true }));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    isReady: () => true,
  },
  safeStorage: {
    isEncryptionAvailable: () => runtime.encryptionAvailable,
    encryptString: (value: string) => Buffer.from(value, "utf-8"),
    decryptString: (value: Buffer) => value.toString("utf-8"),
  },
}));

vi.mock("../app-paths", () => ({
  getAppDataDir: () => runtime.appDataDir,
}));

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "command-center-repository-"));
  runtime.appDataDir = path.join(tmpRoot, "app-data");
  runtime.encryptionAvailable = true;
  safeStorageTest.resetCachedKey();
  safeStorageTest.resetKeyWasReset();
});

afterEach(() => {
  vi.useRealTimers();
  safeStorageTest.resetCachedKey();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function todoInput(
  id: string,
  title: string,
  ts = Date.now(),
): Extract<CommandCenterEventInput, { type: "todo.upsert" }> {
  return {
    schemaVersion: COMMAND_CENTER_SCHEMA_VERSION,
    redactionVersion: COMMAND_CENTER_REDACTION_VERSION,
    type: "todo.upsert",
    todoId: id,
    title,
    status: "pending",
    ts,
  };
}

function readEncodedLines(filePath: string): string[] {
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function tamperEncryptedLine(line: string): string {
  const bytes = Buffer.from(line, "base64");
  bytes[bytes.length - 1] ^= 0x01;
  return bytes.toString("base64");
}

function requireKey(): Buffer {
  const key = loadOrCreateKey();
  if (!key) throw new Error("Expected encryption key in Command Center repository test");
  return key;
}

describe("CommandCenterRepository persistence recovery", () => {
  it("hydrates old progress and descendant activity from disk in a cold manager", async () => {
    const rootDir = path.join(tmpRoot, "cold-manager");
    const saltPath = path.join(rootDir, "salt.enc");
    const detailsPath = path.join(rootDir, "activity.enc");
    const repository = new CommandCenterRepository({ rootDir });
    const normalizer = new CommandCenterPrivacyNormalizer(saltPath);
    const details = new CommandCenterActivityDetailStore(detailsPath);
    await repository.append({
      ...todoInput("persisted-todo", "Resume this goal", Date.now() - 72 * 60 * 60 * 1000),
      sessionId: normalizer.safeId("session", "root"),
      goalId: "persisted-goal",
    });
    details.recordToolResult({
      sessionId: "child",
      toolCallId: "edit",
      toolName: "apply_patch",
      args: {
        patch: "*** Begin Patch\n*** Update File: src/restored.ts\n@@\n-old\n+new\n*** End Patch",
      },
      result: { success: true },
    });
    details.recordToolResult({
      sessionId: "child",
      toolCallId: "source",
      toolName: "get_pull_request",
      args: { pullRequestId: 7 },
      result: { success: true },
    });
    await details.flush();
    const restarted = new CommandCenterManager(
      new CommandCenterRepository({ rootDir }),
      new CommandCenterPrivacyNormalizer(saltPath),
      new CommandCenterActivityDetailStore(detailsPath),
    );
    restarted.refresh();
    const sessions = ["root", "child"].map((id) => ({
      id,
      name: id,
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      ...(id === "child" ? { parentSessionId: "root", source: "subagent" as const } : {}),
    }));
    const restored = restarted.getSessionActivity("root", sessions);
    expect(restored.sessionIds).toEqual(["root", "child"]);
    expect(restored.fileChanges).toEqual([
      expect.objectContaining({ sessionId: "child", path: "src/restored.ts" }),
    ]);
    expect(restored.sources).toEqual([
      expect.objectContaining({ sessionId: "child", kind: "pr", label: "Pull request 7" }),
    ]);
    expect(restarted.getSnapshot().todos).toEqual([
      expect.objectContaining({
        title: "Resume this goal",
        sessionId: restored.safeSessionIds[0],
        goalId: "persisted-goal",
      }),
    ]);
  });

  it("repairs mixed valid, unreadable, and invalid lines once without losing valid events", async () => {
    const repository = new CommandCenterRepository({ rootDir: path.join(tmpRoot, "repo") });
    await repository.append(todoInput("todo-1", "First"));
    await repository.append(todoInput("todo-2", "Second"));
    const validLines = readEncodedLines(repository.eventLogPath);
    const invalidEventLine = encryptLineWithKey(
      requireKey(),
      JSON.stringify({
        schemaVersion: COMMAND_CENTER_SCHEMA_VERSION,
        redactionVersion: COMMAND_CENTER_REDACTION_VERSION,
        globalSeq: 99,
        ts: Date.now(),
        type: "todo.upsert",
        todoId: "missing-title",
        status: "pending",
      }),
    );
    fs.writeFileSync(
      repository.eventLogPath,
      [validLines[0], tamperEncryptedLine(validLines[0]), invalidEventLine, validLines[1], ""].join(
        "\n",
      ),
      { encoding: "utf-8", mode: 0o600 },
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const rebuilt = repository.rebuild();

    expect(rebuilt.todos.map((todo) => todo.title).sort()).toEqual(["First", "Second"]);
    expect(rebuilt.replay).toMatchObject({
      status: "ok",
      lastDurableSeq: 1,
      skippedEvents: 2,
    });
    expect(readEncodedLines(repository.eventLogPath)).toEqual(validLines);
    expect(fs.readdirSync(repository.rootDir).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(warning).toHaveBeenCalledTimes(1);

    safeStorageTest.resetCachedKey();
    warning.mockClear();
    const restarted = new CommandCenterRepository({ rootDir: repository.rootDir });
    const rebuiltAgain = restarted.rebuild();

    expect(rebuiltAgain.todos.map((todo) => todo.title).sort()).toEqual(["First", "Second"]);
    expect(rebuiltAgain.replay.skippedEvents).toBe(0);
    expect(warning).not.toHaveBeenCalled();
    const appended = await restarted.append(todoInput("todo-3", "Third"));
    expect(appended.event?.globalSeq).toBe(2);
  });

  it("repairs an all-corrupt log to an empty valid file and restarts sequencing at zero", async () => {
    const repository = new CommandCenterRepository({ rootDir: path.join(tmpRoot, "repo") });
    await repository.append(todoInput("todo-1", "First"));
    await repository.append(todoInput("todo-2", "Second"));
    const corruptLines = readEncodedLines(repository.eventLogPath).map(tamperEncryptedLine);
    fs.writeFileSync(repository.eventLogPath, `${corruptLines.join("\n")}\n`, {
      encoding: "utf-8",
      mode: 0o666,
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const rebuilt = repository.rebuild();

    expect(rebuilt.todos).toEqual([]);
    expect(rebuilt.replay).toMatchObject({ lastDurableSeq: -1, skippedEvents: 2 });
    expect(fs.readFileSync(repository.eventLogPath, "utf-8")).toBe("");
    const repairedMode = fs.statSync(repository.eventLogPath).mode & 0o777;
    expect(process.platform === "win32" || repairedMode === 0o600).toBe(true);

    const appended = await repository.append(todoInput("todo-3", "Recovered"));
    expect(appended.event?.globalSeq).toBe(0);
    expect(new CommandCenterRepository({ rootDir: repository.rootDir }).rebuild().todos).toEqual([
      expect.objectContaining({ title: "Recovered" }),
    ]);
  });

  it("restores old todos and goal history after restart and continues sequencing", async () => {
    const repository = new CommandCenterRepository({ rootDir: path.join(tmpRoot, "repo") });
    await repository.append(todoInput("old", "Old", Date.now() - 48 * 60 * 60 * 1000));

    const restarted = new CommandCenterRepository({ rootDir: repository.rootDir });
    const rebuilt = restarted.rebuild();
    const appended = await restarted.append(todoInput("current", "Current"));

    expect(rebuilt.todos).toEqual([expect.objectContaining({ id: "old", title: "Old" })]);
    expect(rebuilt.replay.lastDurableSeq).toBe(0);
    expect(appended.event?.globalSeq).toBe(1);
  });

  it("replays old todo updates and deletions instead of reviving stale progress", async () => {
    const repository = new CommandCenterRepository({ rootDir: path.join(tmpRoot, "repo") });
    const old = Date.now() - 72 * 60 * 60 * 1000;
    await repository.append({ ...todoInput("done", "Completed goal", old), goalId: "goal-old" });
    await repository.append({
      ...todoInput("done", "Completed goal", old + 1),
      status: "done",
      goalId: "goal-old",
    });
    await repository.append(todoInput("removed", "Removed", old));
    await repository.append({
      schemaVersion: COMMAND_CENTER_SCHEMA_VERSION,
      redactionVersion: COMMAND_CENTER_REDACTION_VERSION,
      type: "todo.delete",
      todoId: "removed",
      ts: old + 1,
    });
    await repository.append({ ...todoInput("pending", "Current goal"), goalId: "goal-current" });

    const rebuilt = new CommandCenterRepository({ rootDir: repository.rootDir }).rebuild();

    expect(rebuilt.todos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "done", status: "done", goalId: "goal-old" }),
        expect.objectContaining({ id: "pending", status: "pending", goalId: "goal-current" }),
      ]),
    );
    expect(rebuilt.todos).toHaveLength(2);
  });

  it("normalizes an unterminated valid frame and separates the next append", async () => {
    const rootDir = path.join(tmpRoot, "repo");
    const repository = new CommandCenterRepository({ rootDir });
    await repository.append(todoInput("todo-1", "First"));
    const firstLine = readEncodedLines(repository.eventLogPath)[0];
    fs.writeFileSync(repository.eventLogPath, firstLine, "utf-8");

    const restarted = new CommandCenterRepository({ rootDir });
    expect(restarted.rebuild().todos).toEqual([expect.objectContaining({ title: "First" })]);
    expect(fs.readFileSync(repository.eventLogPath, "utf-8")).toBe(`${firstLine}\n`);

    fs.writeFileSync(repository.eventLogPath, firstLine, "utf-8");
    expect((await restarted.append(todoInput("todo-2", "Second"))).event?.globalSeq).toBe(1);
    expect(readEncodedLines(repository.eventLogPath)).toHaveLength(2);
    const appendedRaw = fs.readFileSync(repository.eventLogPath, "utf-8");
    expect(appendedRaw.startsWith(`${firstLine}\n`)).toBe(true);
    expect(appendedRaw.endsWith("\n")).toBe(true);
    expect(
      new CommandCenterRepository({ rootDir })
        .rebuild()
        .todos.map((todo) => todo.title)
        .sort(),
    ).toEqual(["First", "Second"]);
  });

  it("degrades on event-log read errors and recovers automatically before accepting writes", async () => {
    vi.useFakeTimers();
    const rootDir = path.join(tmpRoot, "repo");
    const repository = new CommandCenterRepository({ rootDir });
    await repository.append(todoInput("todo-1", "First"));
    const raw = fs.readFileSync(repository.eventLogPath, "utf-8");
    let failRead = true;
    const eventLogTailReader: CommandCenterEventLogTailReader = () => {
      if (failRead) {
        throw Object.assign(new Error("sharing violation"), { code: "EACCES" });
      }
      return {
        raw,
        droppedPrefix: false,
        sourceBytes: Buffer.byteLength(raw),
      };
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const recovering = new CommandCenterRepository({
      rootDir,
      eventLogTailReader,
      recoveryRetryDelaysMs: [100],
    });

    const degraded = recovering.rebuild();

    expect(degraded.replay.status).toBe("degraded");
    expect(degraded.replay.degradedReason).toContain("EACCES");
    await expect(recovering.append(todoInput("todo-2", "Blocked"))).rejects.toThrow(
      "recovery is pending",
    );
    expect(fs.readFileSync(repository.eventLogPath, "utf-8")).toBe(raw);

    failRead = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(recovering.getSnapshot().todos).toEqual([expect.objectContaining({ title: "First" })]);
    expect((await recovering.append(todoInput("todo-2", "Second"))).event?.globalSeq).toBe(1);
  });

  it("bounds automatic event-log recovery attempts", async () => {
    vi.useFakeTimers();
    let readAttempts = 0;
    const repository = new CommandCenterRepository({
      rootDir: path.join(tmpRoot, "bounded-recovery"),
      eventLogTailReader: () => {
        readAttempts++;
        throw Object.assign(new Error("sharing violation"), { code: "EACCES" });
      },
      recoveryRetryDelaysMs: [10, 20],
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    repository.rebuild();
    await vi.advanceTimersByTimeAsync(30);

    expect(readAttempts).toBe(3);
    expect(repository.getSnapshot().replay.status).toBe("degraded");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(readAttempts).toBe(3);
  });

  it("bounds startup reads and atomically compacts an oversized log to intact recent frames", async () => {
    const rootDir = path.join(tmpRoot, "repo");
    const repository = new CommandCenterRepository({ rootDir });
    await repository.append(todoInput("todo-1", "First"));
    await repository.append(todoInput("todo-2", "Second"));
    await repository.append(todoInput("todo-3", "Third"));
    const lines = readEncodedLines(repository.eventLogPath);
    const maxEventLogBytes = Buffer.byteLength(`${lines[1]}\n${lines[2]}\n`);

    const bounded = new CommandCenterRepository({ rootDir, maxEventLogBytes });
    const rebuilt = bounded.rebuild();

    expect(rebuilt.todos.map((todo) => todo.title).sort()).toEqual(["Second", "Third"]);
    expect(rebuilt.replay).toMatchObject({ lastDurableSeq: 2, skippedEvents: 1 });
    expect(readEncodedLines(repository.eventLogPath)).toEqual(lines.slice(1));
    expect(fs.statSync(repository.eventLogPath).size).toBeLessThanOrEqual(maxEventLogBytes);
    expect((await bounded.append(todoInput("todo-4", "Fourth"))).event?.globalSeq).toBe(3);
  });

  it("replays 20k bounded-tail frames with one sort per snapshot collection", () => {
    const key = requireKey();
    const now = Date.now();
    const encodedLines = Array.from({ length: 20_000 }, (_, index) =>
      encryptLineWithKey(
        key,
        JSON.stringify({
          schemaVersion: COMMAND_CENTER_SCHEMA_VERSION,
          redactionVersion: COMMAND_CENTER_REDACTION_VERSION,
          globalSeq: index,
          ts: now + index,
          type: "todo.upsert",
          todoId: `todo-${index}`,
          title: "T",
          status: "pending",
        }),
      ),
    );
    const raw = `${encodedLines.join("\n")}\n`;
    const sourceBytes = Buffer.byteLength(raw);
    expect(sourceBytes).toBeLessThanOrEqual(COMMAND_CENTER_EVENT_LOG_MAX_BYTES);
    const repository = new CommandCenterRepository({
      rootDir: path.join(tmpRoot, "large-replay"),
      eventLogTailReader: () => ({ raw, droppedPrefix: false, sourceBytes }),
      recoveryRetryDelaysMs: [],
    });
    const sort = vi.spyOn(Array.prototype, "sort");

    const rebuilt = repository.rebuild();
    const sortCalls = sort.mock.calls.length;
    sort.mockRestore();

    expect(sortCalls).toBe(8);
    expect(rebuilt.todos).toHaveLength(20_000);
    expect(rebuilt.todos[0]).toMatchObject({ id: "todo-19999", updatedAt: now + 19_999 });
    expect(rebuilt.replay.lastDurableSeq).toBe(19_999);
  });

  it("retains an oversized source when the bounded tail has no intact frame", async () => {
    const rootDir = path.join(tmpRoot, "repo");
    const repository = new CommandCenterRepository({ rootDir });
    await repository.append(todoInput("todo-1", "First"));
    fs.appendFileSync(repository.eventLogPath, `${"x".repeat(2048)}\n`);
    const before = fs.readFileSync(repository.eventLogPath);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const bounded = new CommandCenterRepository({
      rootDir,
      maxEventLogBytes: 256,
      recoveryRetryDelaysMs: [],
    });
    const rebuilt = bounded.rebuild();

    expect(rebuilt.replay.status).toBe("degraded");
    expect(fs.readFileSync(repository.eventLogPath)).toEqual(before);
    await expect(bounded.append(todoInput("todo-2", "Blocked"))).rejects.toThrow(
      "recovery is pending",
    );
    expect(fs.readFileSync(repository.eventLogPath)).toEqual(before);
  });

  it("retains intact newer-schema and additive frames while excluding them from replay", async () => {
    const repository = new CommandCenterRepository({ rootDir: path.join(tmpRoot, "repo") });
    await repository.append(todoInput("todo-1", "First"));
    const validLine = readEncodedLines(repository.eventLogPath)[0];
    const key = requireKey();
    const newerSchemaLine = encryptLineWithKey(
      key,
      JSON.stringify({
        schemaVersion: 2,
        redactionVersion: 1,
        globalSeq: 10,
        ts: Date.now(),
        type: "todo.upsert",
        futurePayload: { title: "Future" },
      }),
    );
    const additiveLine = encryptLineWithKey(
      key,
      JSON.stringify({
        schemaVersion: COMMAND_CENTER_SCHEMA_VERSION,
        redactionVersion: COMMAND_CENTER_REDACTION_VERSION,
        globalSeq: 11,
        ts: Date.now(),
        type: "todo.upsert",
        todoId: "future-todo",
        title: "Additive",
        status: "pending",
        futureField: true,
      }),
    );
    const corruptLine = tamperEncryptedLine(validLine);
    fs.writeFileSync(
      repository.eventLogPath,
      `${validLine}\n${newerSchemaLine}\n${additiveLine}\n${corruptLine}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const rebuilt = repository.rebuild();

    expect(rebuilt.todos).toEqual([expect.objectContaining({ title: "First" })]);
    expect(rebuilt.replay).toMatchObject({ lastDurableSeq: 11, skippedEvents: 3 });
    expect(readEncodedLines(repository.eventLogPath)).toEqual([
      validLine,
      newerSchemaLine,
      additiveLine,
    ]);
    expect((await repository.append(todoInput("todo-2", "Second"))).event?.globalSeq).toBe(12);

    const restarted = new CommandCenterRepository({ rootDir: repository.rootDir });
    const replayed = restarted.rebuild();
    expect(replayed.todos.map((todo) => todo.title).sort()).toEqual(["First", "Second"]);
    expect(readEncodedLines(repository.eventLogPath)).toEqual([
      validLine,
      newerSchemaLine,
      additiveLine,
      expect.any(String),
    ]);
  });

  it("retains encrypted lines and blocks appends while the encryption key is unavailable", async () => {
    const rootDir = path.join(tmpRoot, "repo");
    const repository = new CommandCenterRepository({ rootDir });
    await repository.append(todoInput("todo-1", "First"));
    const before = fs.readFileSync(repository.eventLogPath, "utf-8");

    safeStorageTest.resetCachedKey();
    runtime.encryptionAvailable = false;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const unavailable = new CommandCenterRepository({ rootDir, recoveryRetryDelaysMs: [] });
    const degraded = unavailable.rebuild();

    expect(degraded.replay.status).toBe("degraded");
    expect(fs.readFileSync(repository.eventLogPath, "utf-8")).toBe(before);
    await expect(unavailable.append(todoInput("todo-2", "Blocked"))).rejects.toThrow(
      "recovery is pending",
    );
    expect(fs.readFileSync(repository.eventLogPath, "utf-8")).toBe(before);

    safeStorageTest.resetCachedKey();
    runtime.encryptionAvailable = true;
    const recovered = new CommandCenterRepository({ rootDir });
    expect(recovered.rebuild().todos).toEqual([expect.objectContaining({ title: "First" })]);
    expect((await recovered.append(todoInput("todo-2", "Second"))).event?.globalSeq).toBe(1);
  });
});
