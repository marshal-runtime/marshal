/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from "fs";

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { GoalState } from "../common/goal-contract";
import type { IBackendProvider } from "./backend/types";
import type { PersistedSession } from "./session-store";
import type { IGoalSessionsEngine, IGoalSessionsManager } from "./sessions";
import { SessionTestAccess, createTestBackend, testDouble } from "./testing/harness";

const m = await vi.hoisted(async () => await import("./test-helpers/session-test-mocks"));
const workspaceStoreMock = vi.hoisted(() => {
  const getWorkspaceRegistry = vi.fn<
    () => Record<string, { origin: "user-added"; externalPath?: string }>
  >(() => ({}));
  return {
    getWorkspaceRegistry,
    getWorkspaceRoot: vi.fn<(name: string, workspaceDir: string) => string>(
      (name, workspaceDir) => `${workspaceDir}/${name}`,
    ),
    getActiveWorkspaceRoot: vi.fn<(workspaceDir: string) => string>(
      (workspaceDir) => `${workspaceDir}/Scratchpad`,
    ),
    resolveRegisteredWorkspace: vi.fn<
      (
        name: string,
        workspaceDir: string,
      ) =>
        | {
            name: string;
            path: string;
            origin: "scratchpad" | "user-added";
            identity: {
              version: 1;
              device: string;
              inode: string;
              birthtimeNs: string;
            };
            external: boolean;
          }
        | undefined
    >((name, workspaceDir) => {
      if (name === "Scratchpad") {
        return {
          name,
          path: `${workspaceDir}/Scratchpad`,
          origin: "scratchpad",
          identity: { version: 1, device: "1", inode: "1", birthtimeNs: "1" },
          external: false,
        };
      }
      const entry = getWorkspaceRegistry()[name];
      if (!entry) return undefined;
      return {
        name,
        path: entry.externalPath ?? `${workspaceDir}/${name}`,
        origin: "user-added",
        identity: { version: 1, device: "1", inode: "2", birthtimeNs: "3" },
        external: !!entry.externalPath,
      };
    }),
    listRegisteredWorkspaces: vi.fn<() => never[]>(() => []),
    registerExistingWorkspace: vi.fn<() => void>(),
    registerManagedWorkspace: vi.fn<() => void>(),
    validateWorkspaceName: vi.fn<(name: string) => string | null>(() => null),
    loadWorkspaceStore: vi.fn<
      () => { activeWorkspace: string; workspaces: Record<string, unknown> }
    >(() => ({ activeWorkspace: "Scratchpad", workspaces: {} })),
  };
});
vi.mock("fs", m.fsFactory);
vi.mock("child_process", m.childProcessFactory);
vi.mock("electron", m.electronFactory);
vi.mock("@github/copilot-sdk", m.copilotSdkFactory);
vi.mock("./skills", m.skillsFactory);
vi.mock("./cli-path", m.cliPathFactory);
vi.mock("./safe-storage-file");
vi.mock("./session-archive", () => ({
  ReadOnlySessionArchive: class {
    dispose(): void {}
    loadMessages(): never[] {
      return [];
    }
    loadMessagesTail() {
      return { messages: [], total: 0, hasMore: false };
    }
    countMessages(): number {
      return 0;
    }
    loadMetadata(): null {
      return null;
    }
  },
}));
vi.mock("./workspace-store", () => workspaceStoreMock);

const mockedFs = vi.mocked(fs);
async function beginTestBackgroundTool(mgr: any, args: any) {
  const claimedAtMs = Date.now();
  const claimResult = await mgr.claimBackgroundToolDispatch({
    ownerSessionId: args.sessionId,
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    requestedAtMs: claimedAtMs,
    idempotencyKey: `test:${args.sessionId}:${args.toolCallId}`,
  });
  if (claimResult.kind !== "claimed") throw new Error("Expected background tool claim");
  return await mgr.beginBackgroundToolInvocation({
    ...args,
    claim: claimResult.claim,
    startedAtMs: claimedAtMs,
  });
}

async function attachTestBackgroundProcess(mgr: any, handle: string, process: any) {
  return await mgr.attachBackgroundToolProcess(handle, {
    ...process,
    ownerSessionId: mgr.inspectRunningTool(handle).tool?.sessionId,
    spawnedAtMs: Date.now(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  workspaceStoreMock.getWorkspaceRegistry.mockReturnValue({});
  mockedFs.existsSync.mockReturnValue(false);
  mockedFs.readdirSync.mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sampleMessages = [
  { id: "m1", role: "user", content: "Hello", timestamp: "2026-01-01T00:00:01Z" },
  { id: "m2", role: "assistant", content: "Hi!", timestamp: "2026-01-01T00:00:02Z" },
];

function makeSessionJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "s1",
    name: "Test",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    hasUnread: false,
    isActive: true,
    messages: [],
    backendOrigin: "copilot",
    ...overrides,
  });
}

function makeIndexJson(
  sessions: Record<string, unknown>[] = [],
  activeSessionId: string | null = null,
) {
  return JSON.stringify({
    sessions: sessions.map((session) => ({ backendOrigin: "copilot", ...session })),
    activeSessionId,
  });
}

function mockSessionStore(
  sessions: Record<string, unknown>[],
  activeSessionId: string | null = null,
  sessionOverrides: Record<string, Record<string, unknown>> = {},
): void {
  const indexJson = makeIndexJson(sessions, activeSessionId);
  mockedFs.existsSync.mockImplementation(
    (filePath) => !String(filePath).endsWith("session-store.db"),
  );
  mockedFs.readFileSync.mockImplementation((filePath) => {
    const value = String(filePath);
    if (value.includes("sessions-index")) return indexJson;
    const sessionId = value.match(/([^\\/]+)\.json$/)?.[1] ?? "s1";
    const metadata = sessions.find((session) => session.id === sessionId) ?? {};
    return makeSessionJson({ ...metadata, id: sessionId, ...sessionOverrides[sessionId] });
  });
}

function mockSdkSession(sessionId = "sdk-123") {
  return {
    sessionId,
    on: vi.fn<() => void>(),
    send: vi.fn<() => Promise<string>>(),
    destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    disconnect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

/** Create a SessionManager with a mock client that supports create, resume, and delete. */
async function createTestManager() {
  mockedFs.existsSync.mockReturnValue(false);
  const { SessionManager } = await import("./sessions");
  const mgr = new SessionManager("/test/workspace", await createTestBackend());
  const access = new SessionTestAccess(mgr);

  const sdkSession = mockSdkSession();
  const mockCreateSession = vi
    .fn<(...args: any[]) => Promise<typeof sdkSession>>()
    .mockResolvedValue(sdkSession);
  const mockResumeSession = vi
    .fn<(...args: any[]) => Promise<typeof sdkSession>>()
    .mockResolvedValue(sdkSession);
  const mockDeleteSession = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);

  access.client = {
    createSession: mockCreateSession,
    resumeSession: mockResumeSession,
    deleteSession: mockDeleteSession,
  };

  return { mgr, access, sdkSession, mockCreateSession, mockResumeSession, mockDeleteSession };
}

// ---------------------------------------------------------------------------
// getSdkSessionId
// ---------------------------------------------------------------------------

describe("getSdkSessionId", () => {
  it("returns ID from in-memory cache first", async () => {
    const { access } = await createTestManager();
    access.sdkSessionIds.set("s1", "sdk-mem");

    const result = access.getSdkSessionId("s1");
    expect(result).toBe("sdk-mem");
  });

  it("falls back to disk when memory cache is empty", async () => {
    const { access } = await createTestManager();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(makeSessionJson({ sdkSessionId: "sdk-disk" }));

    const result = access.getSdkSessionId("s1");
    expect(result).toBe("sdk-disk");
  });

  it("populates memory cache on disk hit", async () => {
    const { access } = await createTestManager();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(makeSessionJson({ sdkSessionId: "sdk-disk" }));

    access.getSdkSessionId("s1");
    expect(access.sdkSessionIds.get("s1")).toBe("sdk-disk");
  });

  it("returns undefined when ID is not in memory or disk", async () => {
    const { access } = await createTestManager();
    mockedFs.existsSync.mockReturnValue(false);

    const result = access.getSdkSessionId("s1");
    expect(result).toBeUndefined();
  });

  it("prefers memory over disk", async () => {
    const { access } = await createTestManager();
    access.sdkSessionIds.set("s1", "sdk-mem");
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(makeSessionJson({ sdkSessionId: "sdk-disk" }));

    const result = access.getSdkSessionId("s1");
    expect(result).toBe("sdk-mem");
  });
});

// ---------------------------------------------------------------------------
// persistBackendId
// ---------------------------------------------------------------------------

describe("persistBackendId", () => {
  it("writes to both memory and disk", async () => {
    const { access } = await createTestManager();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(makeSessionJson());

    access.persistBackendId("s1", "sdk-new");

    // Memory
    expect(access.sdkSessionIds.get("s1")).toBe("sdk-new");

    // Disk — find the writeFileSync call that wrote the session header file.
    // Loading a legacy session auto-migrates it to chunked-v1 (one header write),
    // then persistBackendId saves again with the new id — so assert on the LAST
    // `s1.json` (header) write, which reflects the post-update state.
    const writeCalls = mockedFs.writeFileSync.mock.calls;
    const sessionWrites = writeCalls.filter(([p]) => String(p).includes("s1.json"));
    expect(sessionWrites.length).toBeGreaterThan(0);
    const sessionWrite = sessionWrites[sessionWrites.length - 1];
    const raw = sessionWrite[1];
    if (typeof raw !== "string") throw new Error("expected session JSON payload to be a string");
    const written = JSON.parse(raw);
    expect(written.backendId).toBe("sdk-new");
  });

  it("handles missing session file gracefully", async () => {
    const { access } = await createTestManager();
    mockedFs.existsSync.mockReturnValue(false);

    // Should not throw
    access.persistBackendId("s1", "sdk-new");

    // Memory still updated
    expect(access.sdkSessionIds.get("s1")).toBe("sdk-new");
    // No disk write for session file (only index/dir writes may happen)
    const sessionWrite = mockedFs.writeFileSync.mock.calls.find(([p]) =>
      String(p).includes("s1.json"),
    );
    expect(sessionWrite).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pauseSession — keeps SDK ID
// ---------------------------------------------------------------------------

describe("pauseSession", () => {
  it("removes from activeSessions but keeps sdkSessionIds", async () => {
    const { mgr, access, sdkSession } = await createTestManager();
    // Set up active session state — both backend activeSessions and manager sessionHandles
    access.activeSessions.set("s1", sdkSession);
    access.sessionHandles.set("s1", { sessionId: "s1", backendId: "sdk-123" });
    access.sdkSessionIds.set("s1", "sdk-123");
    // Mock index for the isActive update
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      makeIndexJson([{ id: "s1", name: "Test", isActive: true }], "s1"),
    );

    await mgr.pauseSession("s1");

    expect(access.activeSessions.has("s1")).toBe(false);
    expect(access.sdkSessionIds.get("s1")).toBe("sdk-123");
    expect(sdkSession.disconnect).toHaveBeenCalled();
  });

  it("cleans up turnAccumulators on pause", async () => {
    const { mgr, access, sdkSession } = await createTestManager();
    access.activeSessions.set("s1", sdkSession);
    access.sessionHandles.set("s1", { sessionId: "s1", backendId: "sdk-123" });
    access.sdkSessionIds.set("s1", "sdk-123");
    // Populate caches that should be cleaned
    access.turnAccumulators.set("s1", { chunks: [] });
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      makeIndexJson([{ id: "s1", name: "Test", isActive: true }], "s1"),
    );

    await mgr.pauseSession("s1");

    expect(access.turnAccumulators.has("s1")).toBe(false);
  });

  it("cleans local state and emits idle when backend disconnect fails", async () => {
    const { mgr, access } = await createTestManager();
    access.sessionHandles.set("s1", { sessionId: "s1", backendId: "sdk-123" });
    access.busyTracker.setBusy("s1");
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      makeIndexJson([{ id: "s1", name: "Test", isActive: true }], "s1"),
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    const backend = access.backend as IBackendProvider;
    vi.spyOn(backend.sessions, "disconnect").mockRejectedValue(new Error("disconnect hung"));
    const emitSpy = vi.spyOn(access.viewEmission, "emitEvent");
    const updateViewSpy = vi.spyOn(access.viewEmission, "updateView");

    await mgr.pauseSession("s1");

    expect(access.sessionHandles.has("s1")).toBe(false);
    expect(access.busyTracker.isBusy("s1")).toBe(false);
    expect(emitSpy).toHaveBeenCalledWith("s1", { type: "turn:idle" });
    expect(updateViewSpy).toHaveBeenCalledWith("s1", { type: "turn:idle" });
  });

  it.each(["pause", "delete"] as const)(
    "%s keeps exact process ownership inspectable when cancellation rejects",
    async (operation) => {
      const { mgr, access, sdkSession } = await createTestManager();
      access.activeSessions.set("s1", sdkSession);
      access.sessionHandles.set("s1", { sessionId: "s1", backendId: "sdk-123" });
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation((path) =>
        String(path).includes("sessions-index")
          ? makeIndexJson([{ id: "s1", name: "Test", isActive: true }], "s1")
          : makeSessionJson({ id: "s1" }),
      );
      let rejectCancellation!: (reason?: unknown) => void;
      const cancel = vi.fn<() => Promise<void>>(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectCancellation = reject;
          }),
      );
      await beginTestBackgroundTool(mgr, {
        sessionId: "s1",
        toolCallId: "shell-1",
        toolName: "execute-shell",
        cancellationScope: "none",
      });
      await attachTestBackgroundProcess(mgr, "s1:shell-1", {
        rootPid: 4242,
        cancellationScope: "process-tree",
        cancel,
      });

      const teardown =
        operation === "pause" ? mgr.pauseSession("s1") : mgr.deleteSession("s1").then(() => {});
      let teardownSettled = false;
      void teardown.then(() => {
        teardownSettled = true;
      });
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(teardownSettled).toBe(false);
      rejectCancellation(new Error("kill failed"));
      await teardown;

      expect(mgr.inspectRunningTool("s1:shell-1").tool).toMatchObject({
        status: "running",
        backgrounded: true,
        process: { rootPid: 4242 },
      });

      await mgr.completeBackgroundToolInvocation("s1:shell-1", {
        success: true,
        result: "late exit",
      });
      expect(mgr.inspectRunningTool("s1:shell-1").success).toBe(false);
    },
  );

  it("coalesces concurrent automatic pause transitions", async () => {
    const { access } = await createTestManager();
    access.sessionHandles.set("s1", { sessionId: "s1", backendId: "sdk-123" });
    const backend = access.backend as IBackendProvider; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    let finishDisconnect!: () => void;
    const disconnect = vi.spyOn(backend.sessions, "disconnect").mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          finishDisconnect = resolve;
        }),
    );

    const first = access.pauseSessionIfEligible("s1", () => true);
    const second = access.pauseSessionIfEligible("s1", () => true);
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    expect(first).toBe(second);
    finishDisconnect();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("makes a follow-up send wait for a reserved pause and resume afterward", async () => {
    const { mgr, access, sdkSession, mockResumeSession } = await createTestManager();
    access.activeSessions.set("s1", sdkSession);
    access.sessionHandles.set("s1", { sessionId: "s1", backendId: "sdk-123" });
    access.sdkSessionIds.set("s1", "sdk-123");
    access.currentSessionId = "other";
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((path) =>
      String(path).includes("sessions-index")
        ? makeIndexJson([
            { id: "s1", name: "Test", isActive: true, updatedAt: "2026-01-01T00:00:00Z" },
          ])
        : makeSessionJson({
            id: "s1",
            backendId: "sdk-123",
            messages: [sampleMessages[0]],
          }),
    );
    const backend = access.backend as IBackendProvider; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    let finishDisconnect!: () => void;
    vi.spyOn(backend.sessions, "disconnect").mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          finishDisconnect = resolve;
        }),
    );
    const send = vi.spyOn(backend.sessions, "send").mockResolvedValue(undefined);

    const pause = access.pauseSessionIfEligible("s1", () => true);
    await vi.waitFor(() => expect(access.sessionPauseTransitions.has("s1")).toBe(true));
    const followUp = mgr.sendMessage("s1", "follow up", undefined, { noSwitch: true });
    expect(send).not.toHaveBeenCalled();
    finishDisconnect();

    await expect(pause).resolves.toBe(true);
    await followUp;
    expect(mockResumeSession).toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("reapIdleSessions", () => {
  it("starts the periodic reaper once after client initialization and stops it once", async () => {
    const { mgr, access } = await createTestManager();
    const backend = access.backend as IBackendProvider; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    vi.spyOn(backend, "isReady").mockReturnValue(true);
    vi.spyOn(backend.sessions, "subscribeToRemoteEvents").mockResolvedValue(() => {});
    vi.spyOn(backend, "destroy").mockResolvedValue(undefined);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    try {
      await mgr.initClient();
      const timer = access.idleReapTimer;
      await mgr.initClient();

      expect(timer).not.toBeNull();
      expect(access.idleReapTimer).toBe(timer);
      expect(setIntervalSpy).toHaveBeenCalledOnce();

      await mgr.gracefulStop();
      expect(access.idleReapTimer).toBeNull();
      expect(clearIntervalSpy).toHaveBeenCalledOnce();
      access.stopIdleSessionReaper();
      expect(clearIntervalSpy).toHaveBeenCalledOnce();
    } finally {
      access.stopIdleSessionReaper();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("pauses long-idle sessions but spares fresh, busy, and foreground ones", async () => {
    const { mgr, access } = await createTestManager();
    const now = Date.parse("2026-06-01T12:00:00Z");
    const stale = "2026-06-01T09:00:00Z"; // 3h old → past the 2h reap window
    const recent = "2026-06-01T11:40:00Z"; // 20m old → spared

    const idleOld = mockSdkSession("sdk-idle-old");
    const freshSession = mockSdkSession("sdk-fresh");
    const busyOld = mockSdkSession("sdk-busy-old");
    const foreground = mockSdkSession("sdk-fg");
    const entries: Array<[string, ReturnType<typeof mockSdkSession>]> = [
      ["idle-old", idleOld],
      ["fresh", freshSession],
      ["busy-old", busyOld],
      ["fg", foreground],
    ];
    for (const [id, session] of entries) {
      access.activeSessions.set(id, session);
      access.sessionHandles.set(id, { sessionId: id, backendId: session.sessionId });
    }
    access.busyTracker.setBusy("busy-old");
    access.currentSessionId = "fg";
    mockSessionStore([
      { id: "idle-old", name: "IdleOld", isActive: true, updatedAt: stale },
      { id: "fresh", name: "Fresh", isActive: true, updatedAt: recent },
      { id: "busy-old", name: "BusyOld", isActive: true, updatedAt: stale },
      { id: "fg", name: "Foreground", isActive: true, updatedAt: stale },
    ]);

    const reaped = await mgr.reapIdleSessions(now);

    expect(reaped).toBe(1);
    expect(idleOld.disconnect).toHaveBeenCalled();
    expect(freshSession.disconnect).not.toHaveBeenCalled();
    expect(busyOld.disconnect).not.toHaveBeenCalled();
    expect(foreground.disconnect).not.toHaveBeenCalled();
    expect(access.sessionHandles.has("idle-old")).toBe(false);
    expect(access.sessionHandles.has("fresh")).toBe(true);
  });

  it("spares a stale session with a running background task from the idle reaper", async () => {
    const { mgr, access } = await createTestManager();
    const now = Date.parse("2026-06-01T12:00:00Z");
    const stale = "2026-06-01T09:00:00Z"; // 3h old → past the 2h reap window

    const withBgTask = mockSdkSession("sdk-bg-task");
    access.activeSessions.set("bg-task", withBgTask);
    access.sessionHandles.set("bg-task", { sessionId: "bg-task", backendId: withBgTask.sessionId });
    mockSessionStore([{ id: "bg-task", name: "BgTask", isActive: true, updatedAt: stale }]);

    access.backgroundTasks.handleBackendEvent(
      { type: "background-task-update", taskId: "task-1", status: "started" },
      "bg-task",
    );
    expect(access.backgroundTasks.hasRunning("bg-task")).toBe(true);

    const reapedWhileRunning = await mgr.reapIdleSessions(now);
    expect(reapedWhileRunning).toBe(0);
    expect(withBgTask.disconnect).not.toHaveBeenCalled();
    expect(access.sessionHandles.has("bg-task")).toBe(true);

    // The task settles — nothing tracks it as running any more, so the
    // session becomes reapable again like any other idle session (nothing
    // leaks forever). Exercised at the BackgroundTaskManager level directly
    // since the surrounding reap pipeline has an unrelated pre-existing flake
    // in this suite (reproduces on origin/main without this change, in the
    // sibling "pauses long-idle sessions..." test).
    access.backgroundTasks.handleBackendEvent(
      { type: "background-task-update", taskId: "task-1", status: "completed" },
      "bg-task",
    );
    expect(access.backgroundTasks.hasRunning("bg-task")).toBe(false);
  });
});

describe("tryWakeSessionForBackgroundTask", () => {
  async function completeOneBackgroundTask(access: SessionTestAccess, sessionId: string) {
    access.backgroundTasks.handleBackendEvent(
      { type: "background-task-update", taskId: "task-1", status: "started" },
      sessionId,
    );
    access.backgroundTasks.handleBackendEvent(
      {
        type: "background-task-update",
        taskId: "task-1",
        status: "completed",
        summary: "CI checks passed",
        outputFile: "/tmp/marshal-task-task-1-output.txt",
      },
      sessionId,
    );
  }

  it("delivers a hidden control turn so an idle session actually resumes, not just a human notification", async () => {
    const { mgr, access } = await createTestManager();
    vi.spyOn(mgr, "isSessionBusy").mockReturnValue(false);
    const sendAndCollectSpy = vi
      .spyOn(mgr, "sendAndCollect")
      .mockResolvedValue({ kind: "ok", text: "resumed" });

    await completeOneBackgroundTask(access, "s1");
    await access.tryWakeSessionForBackgroundTask("s1");

    expect(sendAndCollectSpy).toHaveBeenCalledTimes(1);
    const [prompt, , , targetSessionId, , options] = sendAndCollectSpy.mock.calls[0];
    expect(targetSessionId).toBe("s1");
    expect(prompt).toContain("task-1");
    expect(prompt).toContain("CI checks passed");
    expect(prompt).toContain("/tmp/marshal-task-task-1-output.txt");
    expect(options?.internalControl).toMatchObject({ kind: "background-task", side: "request" });
    // Draining on delivery means a second attempt with nothing new pending is a no-op.
    expect(access.backgroundTasks.hasPendingWake("s1")).toBe(false);
  });

  it("wakes on a failed background task too, with its status in the control message", async () => {
    const { mgr, access } = await createTestManager();
    vi.spyOn(mgr, "isSessionBusy").mockReturnValue(false);
    const sendAndCollectSpy = vi
      .spyOn(mgr, "sendAndCollect")
      .mockResolvedValue({ kind: "ok", text: "resumed" });

    access.backgroundTasks.handleBackendEvent(
      { type: "background-task-update", taskId: "task-1", status: "started" },
      "s1",
    );
    access.backgroundTasks.handleBackendEvent(
      {
        type: "background-task-update",
        taskId: "task-1",
        status: "failed",
        summary: 'Background command "sleep 5 && exit 1" failed (exit code 1)',
        outputFile: "/tmp/marshal-task-task-1-output.txt",
      },
      "s1",
    );
    await access.tryWakeSessionForBackgroundTask("s1");

    expect(sendAndCollectSpy).toHaveBeenCalledTimes(1);
    const [prompt] = sendAndCollectSpy.mock.calls[0];
    expect(prompt).toContain("task-1: failed");
    expect(prompt).toContain('Background command "sleep 5 && exit 1" failed (exit code 1)');
    expect(access.backgroundTasks.hasPendingWake("s1")).toBe(false);
  });

  it("wakes on a stopped background task too, with its status in the control message", async () => {
    const { mgr, access } = await createTestManager();
    vi.spyOn(mgr, "isSessionBusy").mockReturnValue(false);
    const sendAndCollectSpy = vi
      .spyOn(mgr, "sendAndCollect")
      .mockResolvedValue({ kind: "ok", text: "resumed" });

    access.backgroundTasks.handleBackendEvent(
      { type: "background-task-update", taskId: "task-1", status: "started" },
      "s1",
    );
    access.backgroundTasks.handleBackendEvent(
      { type: "background-task-update", taskId: "task-1", status: "stopped" },
      "s1",
    );
    await access.tryWakeSessionForBackgroundTask("s1");

    expect(sendAndCollectSpy).toHaveBeenCalledTimes(1);
    const [prompt] = sendAndCollectSpy.mock.calls[0];
    expect(prompt).toContain("task-1: stopped");
    expect(access.backgroundTasks.hasPendingWake("s1")).toBe(false);
  });

  it("skips its own wake when the runtime already auto-continued for this completion", async () => {
    // Claude's own CLI submits its own `<task-notification>`-framed
    // continuation for a finished backgrounded task independent of anything
    // Marshal sends (electron/backend/claude/hooks.ts flags this via
    // RuntimeUserPromptSubmittedHookInput.isBackgroundTaskAutoContinuation,
    // electron/backend/local/session.ts turns it into this BackendEvent).
    // Sending our own wake too would race it into a second, redundant turn
    // for the same completion — see manual-bg-wake-repro.test.ts.
    const { mgr, access } = await createTestManager();
    vi.spyOn(mgr, "isSessionBusy").mockReturnValue(false);
    const sendAndCollectSpy = vi
      .spyOn(mgr, "sendAndCollect")
      .mockResolvedValue({ kind: "ok", text: "resumed" });

    access.backgroundTasks.handleBackendEvent(
      { type: "background-task-update", taskId: "task-1", status: "started" },
      "s1",
    );
    access.backgroundTasks.handleBackendEvent(
      { type: "background-task-update", taskId: "task-1", status: "completed" },
      "s1",
    );
    access.backgroundTasks.handleBackendEvent(
      { type: "background-task-auto-continuation-observed" },
      "s1",
    );
    await access.tryWakeSessionForBackgroundTask("s1");

    expect(sendAndCollectSpy).not.toHaveBeenCalled();
    expect(access.backgroundTasks.hasPendingWake("s1")).toBe(false);
  });

  it("still sends its own wake when no runtime auto-continuation was observed", async () => {
    const { mgr, access } = await createTestManager();
    vi.spyOn(mgr, "isSessionBusy").mockReturnValue(false);
    const sendAndCollectSpy = vi
      .spyOn(mgr, "sendAndCollect")
      .mockResolvedValue({ kind: "ok", text: "resumed" });

    access.backgroundTasks.handleBackendEvent(
      { type: "background-task-update", taskId: "task-1", status: "started" },
      "s1",
    );
    access.backgroundTasks.handleBackendEvent(
      { type: "background-task-update", taskId: "task-1", status: "completed" },
      "s1",
    );
    await access.tryWakeSessionForBackgroundTask("s1");

    expect(sendAndCollectSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves the completion queued while the session is busy, then delivers it once idle", async () => {
    const { mgr, access } = await createTestManager();
    let busy = true;
    vi.spyOn(mgr, "isSessionBusy").mockImplementation(() => busy);
    const sendAndCollectSpy = vi
      .spyOn(mgr, "sendAndCollect")
      .mockResolvedValue({ kind: "ok", text: "resumed" });

    await completeOneBackgroundTask(access, "s1");
    await access.tryWakeSessionForBackgroundTask("s1");
    expect(sendAndCollectSpy).not.toHaveBeenCalled();
    expect(access.backgroundTasks.hasPendingWake("s1")).toBe(true);

    busy = false;
    await access.tryWakeSessionForBackgroundTask("s1");
    expect(sendAndCollectSpy).toHaveBeenCalledTimes(1);
  });

  it("defers to GoalEngine for a goal-owned session instead of sending its own control turn", async () => {
    const { mgr, access } = await createTestManager();
    vi.spyOn(mgr, "isSessionBusy").mockReturnValue(false);
    mgr.setGoalIntegration(
      testDouble<IGoalSessionsManager>({
        getGoal: () => testDouble<GoalState>({}),
      }),
      testDouble<IGoalSessionsEngine>({}),
    );
    const sendAndCollectSpy = vi.spyOn(mgr, "sendAndCollect");

    await completeOneBackgroundTask(access, "s1");
    await access.tryWakeSessionForBackgroundTask("s1");

    expect(sendAndCollectSpy).not.toHaveBeenCalled();
    // Still drained (not left to leak forever) — GoalEngine owns this session's
    // continuation and is expected to observe the completion its own way.
    expect(access.backgroundTasks.hasPendingWake("s1")).toBe(false);
  });

  it("wakes on a completed host-tool background completion, naming the tool and result preview", async () => {
    // Mirrors the SDK-task wake shape above but for a host MCP/self tool
    // Marshal itself detached to the background (tool-backgrounding.ts) —
    // see BackgroundTaskManager.recordHostToolCompletion and
    // SessionManager.wakeForHostToolCompletionIfBackgrounded.
    const { mgr, access } = await createTestManager();
    vi.spyOn(mgr, "isSessionBusy").mockReturnValue(false);
    const sendAndCollectSpy = vi
      .spyOn(mgr, "sendAndCollect")
      .mockResolvedValue({ kind: "ok", text: "resumed" });

    access.backgroundTasks.recordHostToolCompletion({
      sessionId: "s1",
      handle: "s1:tool-1",
      toolName: "runtimeExecuteTypeScript",
      status: "completed",
      summary: "42",
    });
    await access.tryWakeSessionForBackgroundTask("s1");

    expect(sendAndCollectSpy).toHaveBeenCalledTimes(1);
    const [prompt] = sendAndCollectSpy.mock.calls[0];
    expect(prompt).toContain("tool runtimeExecuteTypeScript (handle s1:tool-1): completed");
    expect(prompt).toContain("result preview: 42");
    expect(access.backgroundTasks.hasPendingWake("s1")).toBe(false);
  });
});

describe("completeBackgroundToolInvocation host-tool wake", () => {
  it("wakes the owning session exactly once when a detached host tool call completes", async () => {
    const { mgr, access } = await createTestManager();
    vi.spyOn(mgr, "isSessionBusy").mockReturnValue(false);
    const sendAndCollectSpy = vi
      .spyOn(mgr, "sendAndCollect")
      .mockResolvedValue({ kind: "ok", text: "resumed" });

    await beginTestBackgroundTool(mgr, {
      sessionId: "s1",
      toolCallId: "tool-1",
      toolName: "runtimeExecuteTypeScript",
    });
    // Detachment is what marks the invocation `backgrounded: true` — the
    // condition wakeForHostToolCompletionIfBackgrounded gates on. A tool
    // whose result comes back before the detach race fires never sets this
    // and must not queue a wake (its result already flows back into the
    // still-open turn).
    await mgr.detachBackgroundToolInvocation("s1:tool-1");
    await mgr.completeBackgroundToolInvocation("s1:tool-1", {
      success: true,
      result: "done",
    });

    await vi.waitFor(() => expect(sendAndCollectSpy).toHaveBeenCalledTimes(1));
    const [prompt] = sendAndCollectSpy.mock.calls[0];
    expect(prompt).toContain("tool runtimeExecuteTypeScript (handle s1:tool-1): completed");
    expect(access.backgroundTasks.hasPendingWake("s1")).toBe(false);
  });

  it("never wakes for a host tool call that completes without ever being detached to the background", async () => {
    const { mgr, access } = await createTestManager();
    vi.spyOn(mgr, "isSessionBusy").mockReturnValue(false);
    const sendAndCollectSpy = vi
      .spyOn(mgr, "sendAndCollect")
      .mockResolvedValue({ kind: "ok", text: "resumed" });

    await beginTestBackgroundTool(mgr, {
      sessionId: "s1",
      toolCallId: "tool-2",
      toolName: "runtimeExecuteTypeScript",
    });
    await mgr.completeBackgroundToolInvocation("s1:tool-2", {
      success: true,
      result: "done fast",
    });

    expect(access.backgroundTasks.hasPendingWake("s1")).toBe(false);
    await access.tryWakeSessionForBackgroundTask("s1");
    expect(sendAndCollectSpy).not.toHaveBeenCalled();
  });
});

describe("gracefulStop", () => {
  it("awaits the store drain after backend teardown and before final cleanup", async () => {
    const { mgr, access } = await createTestManager();
    const backend = access.backend as IBackendProvider; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    vi.spyOn(backend, "isReady").mockReturnValue(true);
    const destroy = vi.spyOn(backend, "destroy").mockResolvedValue(undefined);
    const store = access.store;
    if (!store.flushPendingWrites) throw new Error("Local store drain is unavailable");

    let finishDrain!: () => void;
    const flushPendingWrites = vi.spyOn(store, "flushPendingWrites").mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          finishDrain = resolve;
        }),
    );
    access.sessionHandles.set("pending-cleanup", {
      sessionId: "pending-cleanup",
      backendId: "sdk-pending-cleanup",
    });

    const stop = mgr.gracefulStop();
    await vi.waitFor(() => expect(flushPendingWrites).toHaveBeenCalledOnce());

    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy.mock.invocationCallOrder[0]).toBeLessThan(
      flushPendingWrites.mock.invocationCallOrder[0],
    );
    expect(access.sessionHandles.has("pending-cleanup")).toBe(true);

    finishDrain();
    await stop;

    expect(access.sessionHandles.has("pending-cleanup")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// notifyParentOfStuckSubagent — parent re-trigger hook on stuck force-pause
// ---------------------------------------------------------------------------

describe("notifyParentOfStuckSubagent", () => {
  it("messages the parent when a subagent stalls", async () => {
    const { access } = await createTestManager();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      makeSessionJson({ name: "Worker", parentSessionId: "parent-1" }),
    );
    const sendSpy = vi
      .spyOn(access.spyTarget, "sendMessageToParent")
      .mockResolvedValue({ success: true, status: "sent" });

    await access.notifyParentOfStuckSubagent("s1");

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const arg = sendSpy.mock.calls[0][0];
    expect(arg.sessionId).toBe("s1");
    expect(arg.deliveryMode).toBe("queue");
    expect(arg.message).toMatch(/stalled|auto-paused|re-trigger/i);
  });

  it("is a no-op for top-level sessions without a parent", async () => {
    const { access } = await createTestManager();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(makeSessionJson({ name: "Top" }));
    const sendSpy = vi.spyOn(access.spyTarget, "sendMessageToParent");

    await access.notifyParentOfStuckSubagent("s1");

    expect(sendSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deleteSession — calls client.deleteSession
// ---------------------------------------------------------------------------

describe("deleteSession", () => {
  it("destroys the backend session on delete", async () => {
    const { mgr, access, sdkSession } = await createTestManager();
    access.activeSessions.set("s1", sdkSession);
    access.sessionHandles.set("s1", { sessionId: "s1", backendId: "sdk-123" });
    access.sdkSessionIds.set("s1", "sdk-123");
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return makeIndexJson([{ id: "s1", name: "Test" }], "s1");
      }
      return makeSessionJson({ sdkSessionId: "sdk-123" });
    });

    await mgr.deleteSession("s1");

    expect(sdkSession.destroy).toHaveBeenCalled();
    expect(access.sdkSessionIds.has("s1")).toBe(false);
  });

  it("still deletes session if backend destroy fails", async () => {
    const { mgr, access, sdkSession } = await createTestManager();
    access.activeSessions.set("s1", sdkSession);
    access.sessionHandles.set("s1", { sessionId: "s1", backendId: "sdk-123" });
    access.sdkSessionIds.set("s1", "sdk-123");
    sdkSession.destroy.mockRejectedValue(new Error("SDK cleanup failed"));
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return makeIndexJson([{ id: "s1", name: "Test" }], "s1");
      }
      return makeSessionJson({ sdkSessionId: "sdk-123" });
    });

    // Should not throw
    await mgr.deleteSession("s1");

    // Session still removed from M's data
    expect(mockedFs.unlinkSync).toHaveBeenCalled();
    expect(access.sdkSessionIds.has("s1")).toBe(false);
  });

  it("skips backend destroy when no session handle exists", async () => {
    const { mgr, sdkSession } = await createTestManager();
    // No sessionHandle set — only disk data
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return makeIndexJson([{ id: "s1", name: "Test" }], "s1");
      }
      return makeSessionJson({ sdkSessionId: "sdk-from-disk" });
    });

    await mgr.deleteSession("s1");

    // No backend session was active, so destroy should not be called
    expect(sdkSession.destroy).not.toHaveBeenCalled();
    // Session file still cleaned up
    expect(mockedFs.unlinkSync).toHaveBeenCalled();
  });

  it("emits sessions-list change after deletion and suppresses when flagged", async () => {
    // Combined positive + negative pin: a single deleteSession() emits once,
    // a suppressed deleteSession() does NOT emit. Asserting both in the same
    // listener proves the emit is wired AND that suppressChangeEvent works
    // (the bare not.toHaveBeenCalled() would pass even on pre-PR code where
    // emitSessionsListChanged was never wired).
    const { mgr } = await createTestManager();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return makeIndexJson(
          [
            { id: "s1", name: "One" },
            { id: "s2", name: "Two" },
          ],
          "s1",
        );
      }
      return makeSessionJson({ sdkSessionId: "sdk-from-disk" });
    });

    const listener = vi.fn<() => void>();
    const unsubscribe = mgr.addSessionsListListener(listener);

    await mgr.deleteSession("s1", { cause: "user-ipc" });
    expect(listener).toHaveBeenCalledTimes(1);

    await mgr.deleteSession("s2", { suppressChangeEvent: true, cause: "purge-expired" });
    expect(listener).toHaveBeenCalledTimes(1); // unchanged: suppressed

    unsubscribe();
  });

  it("isSessionActive reports liveness from sessionHandles + pendingSessionCreations", async () => {
    const { mgr, access } = await createTestManager();
    expect(mgr.isSessionActive("nope")).toBe(false);

    // sessionHandles arm
    access.sessionHandles.set("live-1", { sessionId: "live-1", backendId: "sdk-1" });
    expect(mgr.isSessionActive("live-1")).toBe(true);
    access.sessionHandles.delete("live-1");
    expect(mgr.isSessionActive("live-1")).toBe(false);

    // pendingSessionCreations arm — guards multi-window race where the user
    // activates a session while the LLM tries to delete it. Without this
    // check, a deleteSession runs and the pending creation later inserts a
    // ghost handle for an index-less id.
    access.pendingSessionCreations.set("pending-1", Promise.resolve());
    expect(mgr.isSessionActive("pending-1")).toBe(true);
    access.pendingSessionCreations.delete("pending-1");
    expect(mgr.isSessionActive("pending-1")).toBe(false);
  });

  it("fires registered delete hooks after deleteSession with the event payload", async () => {
    const { mgr } = await createTestManager();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return makeIndexJson([{ id: "s1", name: "Test" }], "s1");
      }
      return makeSessionJson({ sdkSessionId: "sdk-from-disk" });
    });

    const hook = vi.fn<(event: { sessionId: string; cause: string }) => void>();
    const unsubscribe = mgr.registerDeleteHook(hook);

    await mgr.deleteSession("s1", { cause: "user-ipc" });

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({ sessionId: "s1", cause: "user-ipc" });
    unsubscribe();
  });

  it("delete hook isolation: a throwing hook does not block siblings or the delete itself", async () => {
    const { mgr } = await createTestManager();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return makeIndexJson([{ id: "s1", name: "Test" }], "s1");
      }
      return makeSessionJson({ sdkSessionId: "sdk-from-disk" });
    });

    const throwing = vi.fn<(event: { sessionId: string; cause: string }) => void>(() => {
      throw new Error("hook crashed");
    });
    const sibling = vi.fn<(event: { sessionId: string; cause: string }) => void>();
    mgr.registerDeleteHook(throwing);
    mgr.registerDeleteHook(sibling);

    // Should not throw — SessionManager catches per-hook errors.
    await mgr.deleteSession("s1", { cause: "self-tool" });

    expect(throwing).toHaveBeenCalledWith({ sessionId: "s1", cause: "self-tool" });
    expect(sibling).toHaveBeenCalledWith({ sessionId: "s1", cause: "self-tool" });
  });

  it("registerDeleteHook unsubscribe removes the hook", async () => {
    const { mgr } = await createTestManager();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return makeIndexJson([{ id: "s1", name: "Test" }], "s1");
      }
      return makeSessionJson({ sdkSessionId: "sdk-from-disk" });
    });

    const hook = vi.fn<(event: { sessionId: string; cause: string }) => void>();
    const unsubscribe = mgr.registerDeleteHook(hook);
    unsubscribe();

    await mgr.deleteSession("s1", { cause: "user-ipc" });

    expect(hook).not.toHaveBeenCalled();
  });

  it("concurrent deleteSession for the same id is coalesced — hook fires once", async () => {
    // Regression for the double-fire race: two concurrent deleteSession(id)
    // calls (e.g. user-IPC racing deleteSession, or two windows) used to
    // both pass through and double-fire notifySessionDeleted hooks plus
    // double-emit sessions-list change. pendingDeletes coalesces them so the
    // observable side effects happen exactly once.
    const { mgr } = await createTestManager();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return makeIndexJson([{ id: "s1", name: "Test" }], "s1");
      }
      return makeSessionJson({ sdkSessionId: "sdk-from-disk" });
    });

    const hook = vi.fn<(event: { sessionId: string; cause: string }) => void>();
    mgr.registerDeleteHook(hook);

    const [r1, r2] = await Promise.all([
      mgr.deleteSession("s1", { cause: "user-ipc" }),
      mgr.deleteSession("s1", { cause: "self-tool" }),
    ]);

    // Both callers receive the same resolved newActiveId.
    expect(r1).toBe(r2);
    // Hook fires exactly once — second caller piggybacks on the first delete
    // rather than running a second teardown.
    expect(hook).toHaveBeenCalledTimes(1);
    // The cause label belongs to whichever call won the race (the first one),
    // which is "user-ipc" here. The second caller's "self-tool" cause is
    // intentionally dropped — coalesced deletes share one observable event.
    expect(hook).toHaveBeenCalledWith({ sessionId: "s1", cause: "user-ipc" });

    // After completion, the map is cleaned up so a subsequent delete runs fresh.
    hook.mockClear();
    await mgr.deleteSession("s1", { cause: "user-ipc" });
    // s1 no longer exists in the index, but the hook still fires for the
    // teardown attempt (matches existing behavior — deleteSession does not
    // short-circuit on missing index entry).
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("fires the delete hook from purgeExpiredSessions with cause=purge-expired", async () => {
    const { mgr } = await createTestManager();
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return makeIndexJson([{ id: "expired-1", name: "Old", updatedAt: old }], "expired-1");
      }
      return makeSessionJson({ sdkSessionId: "sdk-from-disk" });
    });

    const hook = vi.fn<(event: { sessionId: string; cause: string }) => void>();
    mgr.registerDeleteHook(hook);

    await mgr.purgeExpiredSessions(90);

    expect(hook).toHaveBeenCalledWith({ sessionId: "expired-1", cause: "purge-expired" });
  });

  it("fires the delete hook from deleteSessionsByWorkspace with cause=workspace-bulk", async () => {
    const { mgr } = await createTestManager();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return makeIndexJson(
          [{ id: "ws-1", name: "Workspace chat", source: "workspace", workspaceName: "myws" }],
          "ws-1",
        );
      }
      return makeSessionJson({ sdkSessionId: "sdk-from-disk" });
    });

    const hook = vi.fn<(event: { sessionId: string; cause: string }) => void>();
    mgr.registerDeleteHook(hook);

    await mgr.deleteSessionsByWorkspace("myws");

    expect(hook).toHaveBeenCalledWith({ sessionId: "ws-1", cause: "workspace-bulk" });
  });

  it("purgeExpiredSessions emits sessions-list change ONCE for N expired sessions", async () => {
    // Regression pin for R2: without `suppressChangeEvent: true` per-iteration
    // + a single trailing emit, a 50-session purge at startup would fire 50
    // sequential IPC refetches. The single-session test above does not catch
    // the bug because 1 == 1 either way.
    const { mgr } = await createTestManager();
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return makeIndexJson(
          [
            { id: "old-1", name: "A", updatedAt: old },
            { id: "old-2", name: "B", updatedAt: old },
            { id: "old-3", name: "C", updatedAt: old },
          ],
          "old-1",
        );
      }
      return makeSessionJson({ sdkSessionId: "sdk-from-disk" });
    });

    const listener = vi.fn<() => void>();
    mgr.addSessionsListListener(listener);

    await mgr.purgeExpiredSessions(90);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("deleteSessionsByWorkspace emits sessions-list change ONCE for N matching sessions", async () => {
    // Regression pin for R2: same shape as the purge test above. A workspace
    // teardown deleting 10 sessions must not emit 10 IPC refetches.
    const { mgr } = await createTestManager();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return makeIndexJson(
          [
            { id: "w-1", name: "A", source: "workspace", workspaceName: "myws" },
            { id: "w-2", name: "B", source: "workspace", workspaceName: "myws" },
            { id: "w-3", name: "C", source: "workspace", workspaceName: "myws" },
          ],
          "w-1",
        );
      }
      return makeSessionJson({ sdkSessionId: "sdk-from-disk" });
    });

    const listener = vi.fn<() => void>();
    mgr.addSessionsListListener(listener);

    await mgr.deleteSessionsByWorkspace("myws");

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Regression pin: auto memory extraction was removed. No session-
// boundary path should ever call backend.infer() as a side effect. A future
// contributor adding extraction back would silently re-introduce the toast
// + inference cost the issue eliminated.
// ---------------------------------------------------------------------------

describe("session boundaries do not trigger backend.infer", () => {
  it("switchSession does not call backend.infer", async () => {
    const { mgr, access } = await createTestManager();
    access.currentSessionId = "s1";
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return makeIndexJson(
          [
            { id: "s1", name: "Old" },
            { id: "s2", name: "New" },
          ],
          "s1",
        );
      }
      return makeSessionJson();
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    const backend = access.backend as IBackendProvider;
    const inferSpy = vi.spyOn(backend, "infer").mockResolvedValue("");

    await mgr.switchSession("s2");

    expect(inferSpy).not.toHaveBeenCalled();
  });

  it("deleteSession does not call backend.infer", async () => {
    const { mgr, access } = await createTestManager();
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return makeIndexJson([{ id: "s1", name: "Test" }], "s1");
      }
      return makeSessionJson({ sdkSessionId: "sdk-123" });
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    const backend = access.backend as IBackendProvider;
    const inferSpy = vi.spyOn(backend, "infer").mockResolvedValue("");

    await mgr.deleteSession("s1");

    expect(inferSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createSDKSession resume path
// ---------------------------------------------------------------------------

describe("createSDKSession resume path", () => {
  it("singleflights concurrent starts for the same logical session", async () => {
    const { access, mockCreateSession, sdkSession } = await createTestManager();
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    mockCreateSession.mockImplementationOnce(async () => {
      await createGate;
      return sdkSession;
    });

    const first = access.createBackendSession("same", true);
    const second = access.createBackendSession("same", true);

    expect(second).toBe(first);
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledTimes(1));
    releaseCreate();
    await Promise.all([first, second]);

    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(access.sessionHandles.has("same")).toBe(true);
  });

  it("calls resumeSession when isNew=false and SDK ID exists", async () => {
    const { access, mockResumeSession, mockCreateSession } = await createTestManager();
    access.sdkSessionIds.set("s1", "sdk-123");
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(makeSessionJson({ messages: sampleMessages }));

    await access.createSDKSession("s1", false);

    expect(mockResumeSession).toHaveBeenCalledWith("sdk-123", expect.any(Object));
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("rebuilds instead of resuming a checkpoint that contains legacy readiness turns", async () => {
    const { access, mockResumeSession, mockCreateSession } = await createTestManager();
    access.sdkSessionIds.set("s1", "sdk-legacy-readiness");
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      makeSessionJson({
        messages: [
          {
            id: "work",
            role: "user",
            content: "Keep the actual work.",
            timestamp: "2026-07-25T08:00:00.000Z",
          },
          {
            id: "legacy-readiness",
            role: "system",
            content:
              'Message from subagent Worker (child-1):\n\nSubagent "Worker" (child-1) is idle and ready for follow-up.',
            timestamp: "2026-07-25T08:01:00.000Z",
            agentMessage: {
              source: "child-1",
              sourceLabel: "Worker",
              sourceSessionSource: "subagent",
              kind: "readiness",
              deliveryMode: "queue",
              sequence: 1,
              readinessGeneration: "legacy:subagent-idle:child-1:2026-07-25T08:01:00.000Z",
            },
          },
          {
            id: "legacy-reply",
            role: "assistant",
            content: "No action needed.",
            timestamp: "2026-07-25T08:01:01.000Z",
            suppressedAgentStatusResponse: true,
          },
        ],
      }),
    );

    await access.createSDKSession("s1", false);

    expect(mockResumeSession).not.toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalledOnce();
    const createConfig = mockCreateSession.mock.calls[0][0];
    const systemMessage =
      typeof createConfig.systemMessage === "string"
        ? createConfig.systemMessage
        : (createConfig.systemMessage?.content ?? "");
    expect(systemMessage).toContain("Keep the actual work.");
    expect(systemMessage).not.toContain("idle and ready for follow-up");
    expect(systemMessage).not.toContain("No action needed.");
  });

  it("passes systemMessage without conversationContext to resumeSession", async () => {
    const { access, mockResumeSession } = await createTestManager();
    access.sdkSessionIds.set("s1", "sdk-123");
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(makeSessionJson({ messages: sampleMessages }));

    await access.createSDKSession("s1", false);

    const resumeConfig = mockResumeSession.mock.calls[0][1];
    expect(resumeConfig.systemMessage).toBeDefined();
    // The system message should NOT contain "Previous Conversation Context"
    const msgContent =
      typeof resumeConfig.systemMessage === "string"
        ? resumeConfig.systemMessage
        : (resumeConfig.systemMessage?.content ?? "");
    expect(msgContent).not.toContain("Previous Conversation Context");
  });

  it.skipIf(process.platform !== "win32")(
    "passes workspace override into resumed workspace session systemMessage",
    async () => {
      const { access, mockResumeSession } = await createTestManager();
      access.sdkSessionIds.set("s1", "sdk-123");
      workspaceStoreMock.getWorkspaceRegistry.mockReturnValue({
        "m-wsl": {
          origin: "user-added",
          externalPath: "\\\\wsl.localhost\\Ubuntu\\home\\chase\\go\\src\\github.com\\m",
        },
      });
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        makeSessionJson({
          source: "workspace",
          workspaceName: "m-wsl",
          workspaceIdentity: {
            version: 1,
            device: "1",
            inode: "2",
            birthtimeNs: "3",
          },
          messages: sampleMessages,
        }),
      );

      await access.createSDKSession("s1", false);

      const resumeConfig = mockResumeSession.mock.calls[0][1];
      const msgContent =
        typeof resumeConfig.systemMessage === "string"
          ? resumeConfig.systemMessage
          : (resumeConfig.systemMessage?.content ?? "");
      expect(msgContent).toContain("## WSL Workspace");
      expect(msgContent).toContain("Linux path `/home/chase/go/src/github.com/m`");
    },
  );

  it("falls back to createSession when resumeSession fails", async () => {
    const { access, mockResumeSession, mockCreateSession, sdkSession } = await createTestManager();
    access.sdkSessionIds.set("s1", "sdk-123");
    mockResumeSession.mockRejectedValue(new Error("Session not found"));
    // createSession needs to work for the fallback
    mockCreateSession.mockResolvedValue(sdkSession);
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return makeIndexJson([{ id: "s1", name: "Test" }], "s1");
      }
      return makeSessionJson({ messages: sampleMessages });
    });

    // Should not throw — falls back gracefully
    await access.createSDKSession("s1", false);

    expect(mockResumeSession).toHaveBeenCalled();
    // Fallback calls createSDKSession(id, true) which uses createSession
    expect(mockCreateSession).toHaveBeenCalled();
  });

  it("skips resume for sessions with no messages (SDK has no checkpoints)", async () => {
    const { access, mockResumeSession, mockCreateSession } = await createTestManager();
    access.sdkSessionIds.set("s1", "sdk-123");
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(makeSessionJson({ messages: [] }));

    await access.createSDKSession("s1", false);

    // Should skip resume and go straight to create
    expect(mockResumeSession).not.toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalled();
  });

  it("falls back to createSession when no SDK ID exists", async () => {
    const { access, mockResumeSession, mockCreateSession } = await createTestManager();
    // No SDK ID in memory or disk
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return makeIndexJson([{ id: "s1", name: "Test" }], "s1");
      }
      return makeSessionJson(); // no sdkSessionId field
    });

    await access.createSDKSession("s1", false);

    expect(mockResumeSession).not.toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalled();
  });

  it("does not restart a healthy runtime after a session start timeout", async () => {
    vi.useFakeTimers();
    try {
      const { access, mockCreateSession } = await createTestManager();
      mockCreateSession.mockReturnValueOnce(new Promise(() => {}));
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double access
      const backend = access.backend as IBackendProvider;
      vi.spyOn(backend, "isHealthy").mockReturnValue(true);
      const restartSpy = vi.spyOn(backend, "restart").mockResolvedValue(undefined);

      const start = access.createBackendSession("healthy-timeout", true);
      const rejection = start.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(45_000);
      const error = await rejection;

      expect(String(error)).toContain("createSession timed out");
      expect(restartSpy).not.toHaveBeenCalled();
      expect(access.sessionHandles.has("healthy-timeout")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disconnects a late old-epoch completion before retrying on the new runtime", async () => {
    const { access, mockCreateSession } = await createTestManager();
    const staleSession = mockSdkSession("sdk-stale");
    const freshSession = mockSdkSession("sdk-fresh");
    let resolveStale!: (session: typeof staleSession) => void;
    mockCreateSession
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
      )
      .mockResolvedValueOnce(freshSession);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    const backend = access.backend as IBackendProvider;
    vi.spyOn(backend, "restart").mockResolvedValue(undefined);

    const start = access.createBackendSession("late", true);
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledTimes(1));
    await access.restartBackendRuntime();
    resolveStale(staleSession);
    await start;

    expect(staleSession.disconnect).toHaveBeenCalledOnce();
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
    expect(access.sessionHandles.get("late")).toEqual({
      sessionId: "late",
      backendId: "sdk-fresh",
    });
  });

  it("rejects and destroys a backend start that completes after session deletion", async () => {
    const { mgr, access, mockCreateSession } = await createTestManager();
    const lateSession = mockSdkSession("sdk-deleted-late");
    let resolveLate!: (session: typeof lateSession) => void;
    mockCreateSession.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLate = resolve;
      }),
    );
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((path) =>
      String(path).includes("sessions-index")
        ? makeIndexJson(
            [{ id: "deleted-late", name: "Deleting", backendOrigin: "copilot" }],
            "deleted-late",
          )
        : makeSessionJson({ id: "deleted-late" }),
    );
    vi.spyOn(access.store, "loadSessionData").mockReturnValue({
      id: "deleted-late",
      name: "Deleting",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      backendOrigin: "copilot",
      messages: [],
    } satisfies PersistedSession);
    vi.spyOn(access.store, "loadSessionHeader").mockReturnValue(null);

    const start = access.createBackendSession("deleted-late", true);
    await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
    await mgr.deleteSession("deleted-late", { cause: "user-ipc" });
    resolveLate(lateSession);

    await expect(start).rejects.toThrow(/changed while the session was starting/);
    expect(lateSession.destroy).toHaveBeenCalledOnce();
    expect(access.sessionHandles.has("deleted-late")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// forceKill
// ---------------------------------------------------------------------------

describe("SessionManager.forceKill", () => {
  it("still calls backend.forceKill when the CLI is not ready so auxiliary children are reaped", async () => {
    const { mgr, access } = await createTestManager();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    const backend = access.backend as IBackendProvider;
    // Clear the mock client so backend is not ready
    access.client = null;
    expect(backend.isReady()).toBe(false);
    const spy = vi.spyOn(backend, "forceKill");
    mgr.forceKill();
    expect(spy).toHaveBeenCalledOnce();
  });

  it("calls backend.forceKill when backend is ready", async () => {
    const { mgr, access } = await createTestManager();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    const backend = access.backend as IBackendProvider;
    // createTestManager already sets a mock client → backend is ready
    expect(backend.isReady()).toBe(true);
    const spy = vi.spyOn(backend, "forceKill");
    mgr.forceKill();
    expect(spy).toHaveBeenCalledOnce();
  });
});
