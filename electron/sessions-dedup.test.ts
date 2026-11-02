/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const m = await vi.hoisted(async () => await import("./test-helpers/session-test-mocks"));
vi.mock("fs", m.fsFactory);
vi.mock("./session-archive", m.sessionArchiveFactory);
vi.mock("child_process", m.childProcessFactory);
vi.mock("electron", m.electronFactory);
vi.mock("@github/copilot-sdk", m.copilotSdkFactory);
vi.mock("./skills", m.skillsFactory);
vi.mock("./cli-path", m.cliPathFactory);
vi.mock("./safe-storage-file");

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn<typeof globalThis.fetch>() }));
vi.mock("./marshal-net-fetch", () => ({
  getNetFetch: () => mockFetch,
}));

import * as fs from "fs";

import { DEFAULT_SESSION_NAME } from "../common/marshal-ipc-contract";
import type { SessionMetadata } from "../common/marshal-ipc-contract";
import { createTestBackend, SessionTestAccess } from "./testing/harness";

const mockedFs = vi.mocked(fs);

// Warm the module cache so the first test doesn't absorb the cold-start import cost.
beforeAll(async () => {
  await import("./sessions");
}, 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockedFs.existsSync.mockReturnValue(false);
  mockedFs.readdirSync.mockReturnValue([]);
});

type SessionData = {
  id: string;
  name: string;
  messages: unknown[];
  source?: string;
  workspaceName?: string;
};

/**
 * Set up an in-memory disk store. indexSessions is the initial index;
 * sessionDataMap maps id -> session data. writeFileSync updates the in-memory store.
 */
function mockSessionFiles(
  indexSessions: Partial<SessionMetadata>[],
  sessionDataMap: Record<string, SessionData & Pick<SessionMetadata, "backendOrigin">>,
): void {
  let indexOnDisk = JSON.stringify({ sessions: indexSessions, activeSessionId: null });
  const sessionFiles = new Map<string, string>(
    Object.entries(sessionDataMap).map(([id, data]) => [id, JSON.stringify(data)]),
  );

  mockedFs.existsSync.mockImplementation((p: any) => {
    const path = String(p);
    if (path.includes("index.json")) return true;
    return [...sessionFiles.keys()].some((id) => path.includes(`${id}.json`));
  });
  mockedFs.readFileSync.mockImplementation((p: any) => {
    const path = String(p);
    if (path.includes("index.json")) return indexOnDisk;
    for (const [id, content] of sessionFiles) {
      if (path.includes(id)) return content;
    }
    return "{}";
  });
  mockedFs.writeFileSync.mockImplementation((p: any, data: any) => {
    const path = String(p);
    if (path.includes("index.json")) {
      indexOnDisk = String(data);
    } else {
      // Extract session id from path like /.../<id>.json
      const match = path.match(/([^/\\]+)\.json$/);
      if (match) sessionFiles.set(match[1], String(data));
    }
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SessionManager.findAndReuseEmpty", () => {
  it("reuses an empty non-workspace session and calls switchSession", async () => {
    mockSessionFiles(
      [
        {
          id: "sess-1",
          name: DEFAULT_SESSION_NAME,
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: false,
          backendOrigin: "copilot",
        },
      ],
      { "sess-1": { id: "sess-1", name: DEFAULT_SESSION_NAME, messages: [] } },
    );

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
    const switchSpy = vi.spyOn(mgr, "switchSession");

    const result = await mgr.findAndReuseEmpty();

    expect(result).not.toBeNull();
    expect(result!.id).toBe("sess-1");
    expect(switchSpy).toHaveBeenCalledWith("sess-1");
  }, 15_000);

  it("returns a reusable empty session before the memory refresh or backend resume settles", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const metadata: SessionMetadata = {
      id: "sess-fast-reuse",
      name: DEFAULT_SESSION_NAME,
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      backendOrigin: "copilot",
    };
    const persisted = { ...metadata, messages: [] };
    const { messages: _messages, ...header } = persisted;
    const index = { sessions: [metadata], activeSessionId: null };
    vi.spyOn(access.store, "loadIndex").mockReturnValue(index);
    vi.spyOn(access.store, "loadSessionHeader").mockReturnValue({
      ...header,
      messageCount: 0,
    });
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(persisted);
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => undefined);
    vi.spyOn(access.store, "withIndexLock").mockImplementation(async (fn) => fn(index));
    const memoryRefresh = deferred();
    const initializeSessionStart = vi.fn<() => Promise<void>>(() => memoryRefresh.promise);
    const createBackendSession = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    access.setSelfToolDepsForTest({
      memoryManager: {
        initializeSessionStart,
      },
    });
    access.replaceCreateBackendSession(createBackendSession);

    let settled = false;
    const reuse = mgr.findAndReuseEmpty().then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(initializeSessionStart).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(settled).toBe(true));

    const result = await reuse;
    expect(result?.id).toBe("sess-fast-reuse");
    expect(createBackendSession).not.toHaveBeenCalled();
    expect(access.pendingSessionCreations.has("sess-fast-reuse")).toBe(true);

    memoryRefresh.resolve();
    await vi.waitFor(() => expect(createBackendSession).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(access.pendingSessionCreations.has("sess-fast-reuse")).toBe(false),
    );
  }, 15_000);

  it("does not reuse a workspace-bound main chat for a General new chat", async () => {
    mockSessionFiles(
      [
        {
          id: "sess-bound",
          name: DEFAULT_SESSION_NAME,
          source: "user",
          workspaceName: "Scratchpad",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: false,
          backendOrigin: "copilot",
        },
      ],
      {
        "sess-bound": {
          id: "sess-bound",
          name: DEFAULT_SESSION_NAME,
          messages: [],
          source: "user",
          workspaceName: "Scratchpad",
        },
      },
    );

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const switchSpy = vi.spyOn(mgr, "switchSession");

    const result = await mgr.findAndReuseEmpty("user");

    expect(result).toBeNull();
    expect(switchSpy).not.toHaveBeenCalled();
  }, 15_000);

  it("returns null when no empty session exists", async () => {
    mockSessionFiles([], {});

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const result = await mgr.findAndReuseEmpty();

    expect(result).toBeNull();
  }, 15_000);

  it("returns null when session has messages", async () => {
    mockSessionFiles(
      [
        {
          id: "sess-2",
          name: DEFAULT_SESSION_NAME,
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: false,
          backendOrigin: "copilot",
        },
      ],
      {
        "sess-2": {
          id: "sess-2",
          name: DEFAULT_SESSION_NAME,
          messages: [{ id: "m1", role: "user", content: "Hello" }],
        },
      },
    );

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const result = await mgr.findAndReuseEmpty();

    expect(result).toBeNull();
  }, 15_000);

  it("does not reuse a busy empty user session", async () => {
    mockSessionFiles(
      [
        {
          id: "sess-busy",
          name: DEFAULT_SESSION_NAME,
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: false,
          backendOrigin: "copilot",
        },
      ],
      { "sess-busy": { id: "sess-busy", name: DEFAULT_SESSION_NAME, messages: [] } },
    );

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    vi.spyOn(mgr, "isSessionBusy").mockImplementation((id) => id === "sess-busy");
    const switchSpy = vi.spyOn(mgr, "switchSession");

    const result = await mgr.findAndReuseEmpty();

    expect(result).toBeNull();
    expect(switchSpy).not.toHaveBeenCalled();
  }, 15_000);

  it("ignores automation sessions", async () => {
    mockSessionFiles(
      [
        {
          id: "sess-wf",
          name: DEFAULT_SESSION_NAME,
          source: "automation",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: false,
          backendOrigin: "copilot",
        },
      ],
      {
        "sess-wf": {
          id: "sess-wf",
          name: DEFAULT_SESSION_NAME,
          messages: [],
          source: "automation",
        },
      },
    );

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const result = await mgr.findAndReuseEmpty();

    expect(result).toBeNull();
  }, 15_000);

  it("reuses empty workspace session when activeSessionId is provided", async () => {
    mockSessionFiles(
      [
        {
          id: "sess-ws",
          name: DEFAULT_SESSION_NAME,
          source: "workspace",
          workspaceName: "my-project",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: false,
          backendOrigin: "copilot",
        },
      ],
      {
        "sess-ws": {
          id: "sess-ws",
          name: DEFAULT_SESSION_NAME,
          messages: [],
          source: "workspace",
          workspaceName: "my-project",
          backendOrigin: "copilot",
        },
      },
    );

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion

    const result = await mgr.findAndReuseEmpty("workspace", "sess-ws", "my-project");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("sess-ws");
  }, 15_000);

  it("does not reuse a busy empty workspace session", async () => {
    mockSessionFiles(
      [
        {
          id: "sess-ws-busy",
          name: DEFAULT_SESSION_NAME,
          source: "workspace",
          workspaceName: "my-project",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: false,
          backendOrigin: "copilot",
        },
      ],
      {
        "sess-ws-busy": {
          id: "sess-ws-busy",
          name: DEFAULT_SESSION_NAME,
          messages: [],
          source: "workspace",
          workspaceName: "my-project",
        },
      },
    );

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    vi.spyOn(mgr, "isSessionBusy").mockImplementation((id) => id === "sess-ws-busy");
    const switchSpy = vi.spyOn(mgr, "switchSession");

    const result = await mgr.findAndReuseEmpty("workspace", "sess-ws-busy");

    expect(result).toBeNull();
    expect(switchSpy).not.toHaveBeenCalled();
  }, 15_000);

  it("does not reuse workspace session for different workspace", async () => {
    mockSessionFiles(
      [
        {
          id: "sess-ws2",
          name: DEFAULT_SESSION_NAME,
          source: "workspace",
          workspaceName: "other-project",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: false,
          backendOrigin: "copilot",
        },
      ],
      {
        "sess-ws2": {
          id: "sess-ws2",
          name: DEFAULT_SESSION_NAME,
          messages: [],
          source: "workspace",
          workspaceName: "other-project",
        },
      },
    );

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const result = await mgr.findAndReuseEmpty("workspace", "sess-ws2", "my-project");

    expect(result).toBeNull();
  }, 15_000);

  it("workspace returns null without activeSessionId (first click)", async () => {
    mockSessionFiles(
      [
        {
          id: "sess-auto",
          name: DEFAULT_SESSION_NAME,
          source: "workspace",
          workspaceName: "my-project",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: false,
          backendOrigin: "copilot",
        },
      ],
      {
        "sess-auto": {
          id: "sess-auto",
          name: DEFAULT_SESSION_NAME,
          messages: [],
          source: "workspace",
          workspaceName: "my-project",
        },
      },
    );

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const result = await mgr.findAndReuseEmpty("workspace");

    expect(result).toBeNull();
  }, 15_000);

  it("skips session when loadSessionData returns null (corrupt file)", async () => {
    mockSessionFiles(
      [
        {
          id: "sess-corrupt",
          name: DEFAULT_SESSION_NAME,
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: false,
          backendOrigin: "copilot",
        },
      ],
      {}, // No session data on disk
    );

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const result = await mgr.findAndReuseEmpty();

    expect(result).toBeNull();
  }, 15_000);

  it("returns null when switchSession fails (session vanished)", async () => {
    mockSessionFiles(
      [
        {
          id: "sess-vanished",
          name: DEFAULT_SESSION_NAME,
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: false,
          backendOrigin: "copilot",
        },
      ],
      { "sess-vanished": { id: "sess-vanished", name: DEFAULT_SESSION_NAME, messages: [] } },
    );

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
    vi.spyOn(mgr, "switchSession").mockResolvedValue({ kind: "notFound" });

    const result = await mgr.findAndReuseEmpty();

    expect(result).toBeNull();
  }, 15_000);
});
