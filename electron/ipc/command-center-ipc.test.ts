import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandCenterActivityDetailStore } from "../command-center/activity-detail-store";
import { appendCommandCenterEventLine } from "../command-center/event-log";
import { CommandCenterManager } from "../command-center/manager";
import { CommandCenterPrivacyNormalizer } from "../command-center/privacy-normalizer";
import { CommandCenterRepository } from "../command-center/repository";
import { _test as safeStorageTest } from "../safe-storage-file";
import { testDouble } from "../testing/harness";
import { registerCommandCenterHandlers, type CommandCenterIpcDeps } from "./command-center-ipc";

const runtime = vi.hoisted(() => ({ appDataDir: "" }));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    isReady: () => true,
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf-8"),
    decryptString: (value: Buffer) => value.toString("utf-8"),
  },
}));

vi.mock("../app-paths", () => ({
  getAppDataDir: () => runtime.appDataDir,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC handler capture mirrors the established workflows-ipc test pattern
type Handler = (...args: any[]) => any;

let tmpRoot: string;

beforeEach(() => {
  vi.useFakeTimers();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "command-center-ipc-"));
  runtime.appDataDir = path.join(tmpRoot, "app-data");
  safeStorageTest.resetCachedKey();
  safeStorageTest.resetKeyWasReset();
});

afterEach(() => {
  vi.useRealTimers();
  safeStorageTest.resetCachedKey();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("command-center persistence failures", () => {
  it("returns IPC failure, blocks writes until replay, and recovers automatically", async () => {
    let failAppend = true;
    const eventLogAppender = vi.fn<typeof appendCommandCenterEventLine>((filePath, event) => {
      if (failAppend) {
        throw Object.assign(new Error("access denied"), { code: "EACCES" });
      }
      appendCommandCenterEventLine(filePath, event);
    });
    const repository = new CommandCenterRepository({
      rootDir: path.join(tmpRoot, "repo"),
      eventLogAppender,
      recoveryRetryDelaysMs: [100],
    });
    const manager = new CommandCenterManager(
      repository,
      new CommandCenterPrivacyNormalizer(path.join(tmpRoot, "salt.enc")),
      new CommandCenterActivityDetailStore(path.join(tmpRoot, "details.enc")),
    );
    const handlers = new Map<string, Handler>();
    const ipcHandle = vi.fn<(channel: string, handler: Handler) => void>((channel, handler) => {
      handlers.set(channel, handler);
    });
    registerCommandCenterHandlers({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic IPC contracts cannot be represented by one capture function
      ipcHandle: ipcHandle as unknown as CommandCenterIpcDeps["ipcHandle"],
      getWindow: () => null,
      sessionManager: testDouble<CommandCenterIpcDeps["sessionManager"]>({}),
      commandCenterManager: manager,
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    manager.refresh();
    const upsert = handlers.get("command-center:upsertTodo");
    if (!upsert) throw new Error("Missing command-center:upsertTodo handler");
    const todo = { todoId: "todo-1", title: "Persist me", status: "pending" };

    const failed = await upsert({}, todo);
    failAppend = false;
    const blocked = await upsert({}, todo);

    expect(failed).toEqual({
      success: false,
      error: "Command Center event log append failed (EACCES); recovery is pending",
    });
    expect(blocked).toEqual({
      success: false,
      error: "Command Center event log is unavailable; recovery is pending",
    });
    expect(eventLogAppender).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    const recovered = await upsert({}, todo);

    expect(recovered).toMatchObject({
      success: true,
      snapshot: { replay: { status: "ok" }, todos: [{ title: "Persist me" }] },
    });
    expect(eventLogAppender).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(repository.eventLogPath, "utf-8").trim()).not.toBe("");
  });
});

describe("command-center session activity", () => {
  it("returns only the purpose-specific session tree gathered by SessionManager", async () => {
    const sessions = [
      {
        id: "root",
        name: "Root",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        hasUnread: false,
        isActive: false,
      },
      {
        id: "child",
        name: "Child",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        hasUnread: false,
        isActive: false,
        parentSessionId: "root",
      },
    ];
    const activity = {
      rootSessionId: "root",
      sessionIds: ["root", "child"],
      safeSessionIds: ["safe-root", "safe-child"],
      fileChanges: [],
      sources: [],
    };
    const listSessionActivityTree = vi
      .fn<CommandCenterIpcDeps["sessionManager"]["listSessionActivityTree"]>()
      .mockResolvedValue(sessions);
    const handlers = new Map<string, Handler>();
    const ipcHandle = vi.fn<(channel: string, handler: Handler) => void>((channel, handler) => {
      handlers.set(channel, handler);
    });
    const commandCenterManager = testDouble<CommandCenterManager>({
      attachBroadcaster: vi.fn<CommandCenterManager["attachBroadcaster"]>(),
      getSessionActivity: vi
        .fn<CommandCenterManager["getSessionActivity"]>()
        .mockReturnValue(activity),
    });
    registerCommandCenterHandlers({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic IPC contracts cannot be represented by one capture function
      ipcHandle: ipcHandle as unknown as CommandCenterIpcDeps["ipcHandle"],
      getWindow: () => null,
      sessionManager: testDouble<CommandCenterIpcDeps["sessionManager"]>({
        listSessionActivityTree,
      }),
      commandCenterManager,
    });
    const handler = handlers.get("command-center:getSessionActivity");
    if (!handler) throw new Error("Missing command-center:getSessionActivity handler");

    await expect(handler({}, "root")).resolves.toEqual({
      success: true,
      activity,
      sessions,
    });
    expect(listSessionActivityTree).toHaveBeenCalledWith("root");
    expect(commandCenterManager.getSessionActivity).toHaveBeenCalledWith("root", sessions);
  });
});

describe("command-center:openSession", () => {
  const MARSHAL_ID = "marshal-session-1";
  const BACKEND_ID = "backend-transcript-1";

  const register = () => {
    const handlers = new Map<string, Handler>();
    const ipcHandle = vi.fn<(channel: string, handler: Handler) => void>((channel, handler) => {
      handlers.set(channel, handler);
    });
    const send = vi.fn<(channel: string, sessionId: string) => void>();
    const switchSession = vi
      .fn<CommandCenterIpcDeps["sessionManager"]["switchSession"]>()
      .mockResolvedValue(testDouble({ id: MARSHAL_ID }));
    registerCommandCenterHandlers({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic IPC contracts cannot be represented by one capture function
      ipcHandle: ipcHandle as unknown as CommandCenterIpcDeps["ipcHandle"],
      getWindow: () => testDouble({ webContents: testDouble({ send }) }),
      sessionManager: testDouble<CommandCenterIpcDeps["sessionManager"]>({
        listSessions: vi
          .fn<CommandCenterIpcDeps["sessionManager"]["listSessions"]>()
          .mockResolvedValue([testDouble({ id: MARSHAL_ID, backendId: BACKEND_ID })]),
        switchSession,
      }),
      commandCenterManager: testDouble<CommandCenterManager>({
        attachBroadcaster: vi.fn<CommandCenterManager["attachBroadcaster"]>(),
        resolveSessionId: vi.fn<CommandCenterManager["resolveSessionId"]>().mockReturnValue(null),
      }),
    });
    const handler = handlers.get("command-center:openSession");
    if (!handler) throw new Error("Missing command-center:openSession handler");
    return { handler, send, switchSession };
  };

  it.each([
    ["a Marshal session id", MARSHAL_ID],
    ["a runtime backend id", BACKEND_ID],
  ])("switches to the session named by %s", async (_label, reference) => {
    const { handler, send, switchSession } = register();

    await expect(handler({}, reference)).resolves.toEqual({ success: true });
    expect(switchSession).toHaveBeenCalledWith(MARSHAL_ID);
    expect(send).toHaveBeenCalledWith("sessions:switch-to", MARSHAL_ID);
  });

  it("reports an unknown reference without switching", async () => {
    const { handler, switchSession } = register();

    await expect(handler({}, "unknown")).resolves.toEqual({
      success: false,
      error: "Session not found",
    });
    expect(switchSession).not.toHaveBeenCalled();
  });
});
