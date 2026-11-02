/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, onTestFinished } from "vitest";

import type { MSettings } from "../common/marshal-ipc-contract";
import {
  AgentMessageDeliveryControlError,
  type AgentMessageOutbox,
  type AgentMessageOutboxPersistence,
  type AgentMessageRecord,
} from "./agent-message-outbox";
import type { IBackendProvider } from "./backend/types";
import { STUCK_TIMEOUT_MS } from "./session-view-builder";
import {
  SessionTestAccess,
  createTestBackend,
  expectZodSuccess,
  parseWrittenJson,
} from "./testing/harness";
import { testDouble } from "./testing/harness/test-double";

const m = await vi.hoisted(async () => await import("./test-helpers/session-test-mocks"));
vi.mock("fs", m.fsFactory);
vi.mock("./session-archive", m.sessionArchiveFactory);
vi.mock("child_process", m.childProcessFactory);
vi.mock("electron", m.electronFactory);
vi.mock("@github/copilot-sdk", m.copilotSdkFactory);
vi.mock("./skills", m.skillsFactory);
vi.mock("./backend/local/repository-customizations", m.repositoryCustomizationsFactory);
vi.mock("./cli-path", m.cliPathFactory);
vi.mock("./safe-storage-file");

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn<typeof globalThis.fetch>() }));
vi.mock("./marshal-net-fetch", () => ({
  getNetFetch: () => mockFetch,
}));

import * as fs from "fs";
import * as nodePath from "path";

import {
  DEFAULT_SESSION_NAME,
  type CustomMcpServer,
  type GoalState,
  type SessionHydrationEvent,
  type SessionMetadata,
  type StoredSession,
  type WorkspaceInstanceIdentity,
} from "../common/marshal-ipc-contract";
import { DEFAULT_MODEL } from "./model-manager";
import { resolveSessionMcpScope } from "./session-mcp-scope";
import type { PersistedSession, SessionHeader } from "./session-store";
import { SUBAGENT_DELEGATION_GUIDANCE } from "./system-message";
import * as workspaceStore from "./workspace-store";

const mockedFs = vi.mocked(fs);
const testAgentMessageOutboxes = new Set<AgentMessageOutbox>();

async function beginTestBackgroundTool(mgr: any, args: any) {
  const requestedAtMs = Date.now();
  const claimResult = await mgr.claimBackgroundToolDispatch({
    ownerSessionId: args.sessionId,
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    requestedAtMs,
    idempotencyKey: `test:${args.sessionId}:${args.toolCallId}`,
  });
  if (claimResult.kind !== "claimed") throw new Error("Expected background tool claim");
  return await mgr.beginBackgroundToolInvocation({
    ...args,
    claim: claimResult.claim,
    startedAtMs: args.startedAtMs ?? requestedAtMs,
  });
}

function workspaceDirectoryStat(inode = 2n): fs.BigIntStats {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- focused filesystem identity test double
  return {
    isDirectory: () => true,
    dev: 1n,
    ino: inode,
    birthtimeNs: 3n,
  } as fs.BigIntStats;
}

class TestAgentMessagePersistence implements AgentMessageOutboxPersistence {
  private content: string | null = null;

  async load(): Promise<string | null> {
    return this.content;
  }

  async save(content: string): Promise<void> {
    this.content = content;
  }
}

async function attachTestAgentMessageOutbox(
  manager: import("./sessions").SessionManager,
  options?: { pauseDispatch?: boolean },
): Promise<AgentMessageOutbox> {
  const { AgentMessageOutbox } = await import("./agent-message-outbox");
  const outbox = new AgentMessageOutbox({
    persistence: new TestAgentMessagePersistence(),
    retryDelayMs: 1,
    deliver: (message, context) => manager.deliverAgentMessage(message, context),
  });
  manager.setAgentMessageOutbox(outbox);
  await outbox.start(options);
  testAgentMessageOutboxes.add(outbox);
  return outbox;
}

function expectDurablyAccepted(result: unknown): void {
  expect(result).toEqual(
    expect.objectContaining({
      success: true,
      accepted: true,
      messageId: expect.any(String),
      deliveryState: "accepted",
      status: "accepted",
    }),
  );
}

function deferredPromise<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, resolve, reject };
}

function mockCurrentRuntimeIndex(
  access: SessionTestAccess,
  sessions: readonly PersistedSession[],
): void {
  vi.spyOn(access.store, "loadIndex").mockReturnValue(
    testDouble({
      sessions: [...sessions],
      activeSessionId: null,
    }),
  );
}

// Warm the module cache so the first test doesn't absorb the cold-start import cost.
// sessions.ts has a heavy dependency tree that can exceed the 15s test timeout on CI.
beforeAll(async () => {
  await import("./sessions");
}, 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockedFs.existsSync.mockReturnValue(false);
  mockedFs.readdirSync.mockReturnValue([]);
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([...testAgentMessageOutboxes].map((outbox) => outbox.shutdown()));
  testAgentMessageOutboxes.clear();
});

describe("SessionManager", () => {
  it("stops only the extension's active message and preserves a newer human turn", async () => {
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", await createTestBackend());
    const session = testDouble<PersistedSession>({
      id: "s1",
      messages: [{ id: "extension-request", role: "user", content: "Inspect", timestamp: "now" }],
    });
    vi.spyOn(manager, "getSession").mockReturnValue(session);
    vi.spyOn(manager, "isSessionBusy").mockReturnValue(true);
    const cancel = vi.spyOn(manager, "cancelTurn").mockResolvedValue();
    expect(await manager.cancelOwnedTurn("s1", "extension-request")).toBe(true);
    session.messages.push({ id: "human-request", role: "user", content: "Wait", timestamp: "now" });
    expect(await manager.cancelOwnedTurn("s1", "extension-request")).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("requires the latest actual native user message and a busy turn for an automation fence", async () => {
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", await createTestBackend());
    const session = testDouble<PersistedSession>({
      id: "coordinator",
      messages: [
        { id: "automation-step", role: "user", content: "Wake", timestamp: "now" },
        { id: "assistant", role: "assistant", content: "Inspecting", timestamp: "now" },
      ],
    });
    vi.spyOn(manager, "getSession").mockReturnValue(session);
    const busy = vi.spyOn(manager, "isSessionBusy").mockReturnValue(true);
    expect(manager.isActiveTurnMessage("coordinator", "automation-step")).toBe(true);
    session.messages.push({
      id: "human-turn",
      role: "user",
      content: "Different request",
      timestamp: "now",
    });
    expect(manager.isActiveTurnMessage("coordinator", "automation-step")).toBe(false);
    busy.mockReturnValue(false);
    expect(manager.isActiveTurnMessage("coordinator", "human-turn")).toBe(false);
  });
  describe("constructor", () => {
    it("creates workspace directory if it does not exist", async () => {
      mockedFs.existsSync.mockReturnValue(false);
      mockedFs.mkdirSync.mockReturnValue(undefined);

      const { SessionManager } = await import("./sessions");
      void new SessionManager("/test/workspace", await createTestBackend());

      // Should create both sessions dir and workspace dir (owner-only rwx)
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith("/test/workspace", {
        recursive: true,
        mode: 0o700 /* owner-only rwx */,
      });
    }, 15_000);

    it("does not create workspace directory if it already exists", async () => {
      mockedFs.existsSync.mockImplementation((p) => {
        return String(p) === "/test/workspace";
      });
      mockedFs.mkdirSync.mockReturnValue(undefined);

      const { SessionManager } = await import("./sessions");
      void new SessionManager("/test/workspace", await createTestBackend());

      // mkdirSync should be called for sessions dir but NOT for workspace dir
      const mkdirCalls = mockedFs.mkdirSync.mock.calls.map((c) => String(c[0]));
      expect(mkdirCalls).not.toContain("/test/workspace");
    }, 15_000);
  });

  it("keeps long-running backgrounded tool entries when listing running tools", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const now = Date.now();
    const cancelStaleTool = vi.fn<() => void>();
    access.runningTools.set("sess-1:old-tool", {
      sessionId: "sess-1",
      toolCallId: "old-tool",
      toolName: "grep",
      startedAtMs: now - 31 * 60 * 1000,
      status: "running",
      backgrounded: true,
      cancel: cancelStaleTool,
      cancellationScope: "tool",
    });
    access.runningTools.set("sess-1:fresh-tool", {
      sessionId: "sess-1",
      toolCallId: "fresh-tool",
      toolName: "view",
      startedAtMs: now,
      status: "running",
      backgrounded: false,
      cancellationScope: "turn",
    });

    const tools = mgr.listRunningTools("sess-1");

    expect(tools.map((tool) => tool.toolCallId)).toEqual(["old-tool", "fresh-tool"]);
    expect(tools[0]?.longRunning).toBe(true);
    expect(tools[1]?.longRunning).toBe(false);
    expect(cancelStaleTool).not.toHaveBeenCalled();
    expect(access.runningTools.has("sess-1:old-tool")).toBe(true);
  });

  it("attaches exact spawned process ownership to a running tool handle", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const cancelOwnedProcess = vi.fn<() => void>();
    const beforeAttachment = await beginTestBackgroundTool(mgr, {
      sessionId: "sess-1",
      toolCallId: "shell-1",
      toolName: "execute-shell",
      cancellationScope: "none",
    });

    expect(beforeAttachment.invocation).toMatchObject({
      cancellable: false,
      cancellationScope: "none",
    });
    const cancelTurn = vi.spyOn(mgr, "cancelTurn");
    await expect(mgr.cancelRunningTool("sess-1:shell-1")).resolves.toMatchObject({
      success: false,
      cancellationScope: "none",
    });
    expect(cancelTurn).not.toHaveBeenCalled();

    const tool = await mgr.attachBackgroundToolProcess("sess-1:shell-1", {
      ownerSessionId: "sess-1",
      rootPid: 4242,
      spawnedAtMs: Date.now(),
      cancellationScope: "process-tree",
      cancel: cancelOwnedProcess,
    });

    expect(tool).toMatchObject({
      handle: "sess-1:shell-1",
      cancellable: true,
      cancellationScope: "process-tree",
      process: {
        rootPid: 4242,
        identitySource: "spawned-child",
        cancellationScope: "process-tree",
      },
    });
    const cancellation = await mgr.cancelRunningTool("sess-1:shell-1");
    expect(cancellation).toMatchObject({ success: true, cancellationScope: "process-tree" });
    expect(cancelOwnedProcess).toHaveBeenCalledOnce();
  });

  it("does not invoke a stale process callback after the tool completes", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const cancelOwnedProcess = vi.fn<() => void>();
    await beginTestBackgroundTool(mgr, {
      sessionId: "sess-1",
      toolCallId: "shell-1",
      toolName: "execute-shell",
    });
    await mgr.attachBackgroundToolProcess("sess-1:shell-1", {
      ownerSessionId: "sess-1",
      rootPid: 4242,
      spawnedAtMs: Date.now(),
      cancellationScope: "process-tree",
      cancel: cancelOwnedProcess,
    });
    await mgr.completeBackgroundToolInvocation("sess-1:shell-1", { success: true });

    const cancellation = await mgr.cancelRunningTool("sess-1:shell-1");

    expect(cancellation).toMatchObject({
      success: false,
      error: "Background tool cancellation token not found",
    });
    expect(cancelOwnedProcess).not.toHaveBeenCalled();
  });

  it("keeps process cancellation terminal when completion arrives later", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    await beginTestBackgroundTool(mgr, {
      sessionId: "sess-1",
      toolCallId: "shell-1",
      toolName: "execute-shell",
    });
    await mgr.attachBackgroundToolProcess("sess-1:shell-1", {
      ownerSessionId: "sess-1",
      rootPid: 4242,
      spawnedAtMs: Date.now(),
      cancellationScope: "process-group",
      cancel: () => {},
    });

    await mgr.cancelRunningTool("sess-1:shell-1");
    await mgr.completeBackgroundToolInvocation("sess-1:shell-1", {
      success: true,
      result: { cancelled: true },
    });

    expect(mgr.inspectRunningTool("sess-1:shell-1").tool).toMatchObject({
      status: "cancelled",
      cancellable: false,
      cancellationScope: "none",
    });
  });

  it("preserves detached process ownership across backend result and idle events", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const cancelOwnedProcess = vi.fn<() => void>();
    await beginTestBackgroundTool(mgr, {
      sessionId: "sess-1",
      toolCallId: "shell-detached",
      toolName: "execute-shell",
      cancellationScope: "none",
    });
    await mgr.attachBackgroundToolProcess("sess-1:shell-detached", {
      ownerSessionId: "sess-1",
      rootPid: 4343,
      spawnedAtMs: Date.now(),
      cancellationScope: "process-tree",
      cancel: cancelOwnedProcess,
    });
    await mgr.detachBackgroundToolInvocation("sess-1:shell-detached");
    access.subscribeToBackendEvents("sess-1");

    for (const listener of access.getCopilotBackendSessionSubscribers("sess-1")) {
      listener({
        type: "tool-result",
        toolCallId: "shell-detached",
        result: "backgrounded",
        success: true,
      });
      listener({ type: "idle" });
    }

    expect(mgr.inspectRunningTool("sess-1:shell-detached").tool).toMatchObject({
      status: "running",
      backgrounded: true,
      process: { rootPid: 4343 },
    });
    await expect(mgr.cancelRunningTool("sess-1:shell-detached")).resolves.toMatchObject({
      success: true,
      cancellationScope: "process-tree",
    });
    expect(cancelOwnedProcess).toHaveBeenCalledOnce();

    await mgr.completeBackgroundToolInvocation("sess-1:shell-detached", {
      success: true,
      result: "late result",
    });
    expect(mgr.inspectRunningTool("sess-1:shell-detached").tool).toMatchObject({
      status: "cancelled",
      result: "late result",
      cancellable: false,
    });
  });

  it("cancels exact owned processes before clearing all running tools", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const cancelOwnedProcess = vi.fn<() => void>();
    await beginTestBackgroundTool(mgr, {
      sessionId: "sess-1",
      toolCallId: "shell-1",
      toolName: "execute-shell",
      cancellationScope: "none",
    });
    await mgr.attachBackgroundToolProcess("sess-1:shell-1", {
      ownerSessionId: "sess-1",
      rootPid: 4242,
      spawnedAtMs: Date.now(),
      cancellationScope: "process-tree",
      cancel: cancelOwnedProcess,
    });

    await access.clearAllRunningTools();

    expect(cancelOwnedProcess).toHaveBeenCalledOnce();
    expect(mgr.listRunningTools()).toEqual([]);
  });

  it("uses repoPath-scoped subagent sessions as repo-local context roots", async () => {
    const repoPath = nodePath.join(nodePath.parse(process.cwd()).root, "external", "repo");
    const session = {
      id: "sub-1",
      name: "Repo subagent",
      createdAt: "2026-06-12T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:00.000Z",
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: true,
      source: "subagent",
      repoPath,
      workspaceIdentity: { version: 1, device: "1", inode: "2", birthtimeNs: "3" },
      repositoryAgent: {
        name: "repo-agent",
        path: ".github/agents/repo-agent.agent.md",
      },
      messages: [],
    } satisfies PersistedSession;
    mockedFs.existsSync.mockImplementation((p) => {
      const value = String(p);
      return value === "/test/workspace" || value === repoPath || value.endsWith("sub-1.json");
    });
    mockedFs.realpathSync.mockImplementation((p) => String(p));
    mockedFs.statSync.mockReturnValue(workspaceDirectoryStat());
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const value = String(p);
      if (value.endsWith("sessions-index.json")) {
        return JSON.stringify({ sessions: [session], activeSessionId: "sub-1" });
      }
      if (value.endsWith("sub-1.json")) return JSON.stringify(session);
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    expect(mgr.getWorkspaceRootForSession("sub-1")).toBe(repoPath);

    mockedFs.statSync.mockReturnValue(workspaceDirectoryStat(99n));
    expect(mgr.getWorkspaceRootForSession("sub-1")).toBeUndefined();
  });

  it("uses repoPath-scoped workflow agents in maintenance attribution", async () => {
    const repoPath = nodePath.join(nodePath.parse(process.cwd()).root, "external", "workflow-repo");
    const session = {
      id: "workflow-agent-1",
      name: "Workflow worker",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: true,
      source: "workflow-agent",
      repoPath,
      workspaceIdentity: { version: 1, device: "1", inode: "2", birthtimeNs: "3" },
      messages: [],
    } satisfies PersistedSession;
    mockedFs.existsSync.mockImplementation((p) => {
      const value = String(p);
      return (
        value === "/test/workspace" ||
        value === repoPath ||
        value.endsWith("sessions-index.json") ||
        value.endsWith("workflow-agent-1.json")
      );
    });
    mockedFs.realpathSync.mockImplementation((p) => String(p));
    mockedFs.statSync.mockReturnValue(workspaceDirectoryStat());
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const value = String(p);
      if (value.endsWith("sessions-index.json")) {
        return JSON.stringify({ sessions: [session] });
      }
      if (value.endsWith("workflow-agent-1.json")) return JSON.stringify(session);
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    expect(mgr.getWorkspaceRootForSession("workflow-agent-1")).toBe(repoPath);
  });
});

describe("SessionManager.generateTitle", () => {
  it("generates a title from conversation messages", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "sess-1", name: DEFAULT_SESSION_NAME, updatedAt: "", backendOrigin: "copilot" },
          ],
        });
      }
      if (path.includes("sess-1")) {
        return JSON.stringify({
          id: "sess-1",
          name: DEFAULT_SESSION_NAME,
          backendOrigin: "copilot" as const,
          messages: [
            { id: "1", role: "user", content: "Check my emails" },
            { id: "2", role: "assistant", content: "You have 3 unread emails." },
            { id: "3", role: "user", content: "Read the first one" },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    const backend = access.backend as IBackendProvider;
    const inferSpy = vi.spyOn(backend, "infer").mockResolvedValue("Email Triage Help");

    const title = await mgr.generateTitle("sess-1");
    expect(title).toBe("Email Triage Help");
    expect(inferSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining("no more than 3-4 words"),
        userMessage: "Check my emails",
      }),
    );
    // Callsites no longer pass `model` — they rely on the backend's default.
    expect(inferSpy.mock.calls[0][0].model).toBeUndefined();
  });

  it("generates a title with a single message", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [{ id: "sess-2", name: DEFAULT_SESSION_NAME, backendOrigin: "copilot" }],
        });
      }
      if (path.includes("sess-2")) {
        return JSON.stringify({
          id: "sess-2",
          name: DEFAULT_SESSION_NAME,
          backendOrigin: "copilot" as const,
          messages: [{ id: "1", role: "user", content: "Hi there" }],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    vi.spyOn(access.backend as IBackendProvider, "infer").mockResolvedValue("Quick Greeting");

    const title = await mgr.generateTitle("sess-2");
    expect(title).toBe("Quick Greeting");
  });

  it("returns null and destroys session when sendAndWait rejects", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [{ id: "sess-err", name: DEFAULT_SESSION_NAME, backendOrigin: "copilot" }],
        });
      }
      if (path.includes("sess-err")) {
        return JSON.stringify({
          id: "sess-err",
          name: DEFAULT_SESSION_NAME,
          backendOrigin: "copilot" as const,
          messages: [{ id: "1", role: "user", content: "Hello" }],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const mockDestroy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const mockSendAndWait = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockRejectedValue(new Error("Execution timed out"));
    const access = new SessionTestAccess(mgr);
    access.client = {
      createSession: vi
        .fn<() => Promise<{ sendAndWait: typeof mockSendAndWait; destroy: typeof mockDestroy }>>()
        .mockResolvedValue({ sendAndWait: mockSendAndWait, destroy: mockDestroy }),
    };

    const title = await mgr.generateTitle("sess-err");
    expect(title).toBe("Hello");
    expect(mockDestroy).toHaveBeenCalled(); // session cleaned up
  });

  it("returns existing name for manually renamed sessions", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [{ id: "sess-3", name: "My Custom Name", backendOrigin: "copilot" }],
        });
      }
      if (path.includes("sess-3")) {
        return JSON.stringify({
          id: "sess-3",
          name: "My Custom Name",
          backendOrigin: "copilot" as const,
          messages: [
            { id: "1", role: "user", content: "Hello" },
            { id: "2", role: "assistant", content: "Hi" },
            { id: "3", role: "user", content: "Bye" },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    const inferSpy = vi.spyOn(access.backend as IBackendProvider, "infer");

    const title = await mgr.generateTitle("sess-3");
    expect(title).toBe("My Custom Name");
    expect(inferSpy).not.toHaveBeenCalled();
    inferSpy.mockRestore();
  });

  it("overwrites quick-titled session (name === aiGeneratedTitle)", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            {
              id: "sess-qt",
              name: "tell me about something interesting",
              backendOrigin: "copilot",
            },
          ],
        });
      }
      if (path.includes("sess-qt")) {
        return JSON.stringify({
          id: "sess-qt",
          name: "tell me about something interesting",
          backendOrigin: "copilot" as const,
          aiGeneratedTitle: "tell me about something interesting",
          messages: [
            { id: "1", role: "user", content: "tell me about something interesting please" },
            { id: "2", role: "assistant", content: "Sure, here is something interesting" },
            { id: "3", role: "user", content: "more details" },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);

    const inferSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double access
      .spyOn(access.backend as IBackendProvider, "infer")
      .mockResolvedValue("Interesting Facts");

    const title = await mgr.generateTitle("sess-qt");
    expect(title).toBe("Interesting Facts");
    expect(inferSpy).toHaveBeenCalled();
  });

  it("strips quotes and trailing punctuation from generated title", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [{ id: "sess-4", name: DEFAULT_SESSION_NAME, backendOrigin: "copilot" }],
        });
      }
      if (path.includes("sess-4")) {
        return JSON.stringify({
          id: "sess-4",
          name: DEFAULT_SESSION_NAME,
          backendOrigin: "copilot" as const,
          messages: [
            { id: "1", role: "user", content: "tell me about something interesting please" },
            { id: "2", role: "assistant", content: "Sure, here is something interesting" },
            { id: "3", role: "user", content: "more details" },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    vi.spyOn(access.backend as IBackendProvider, "infer").mockResolvedValue('"Email Triage Help."');

    const title = await mgr.generateTitle("sess-4");
    expect(title).toBe("Email Triage Help");
  });
});

describe("SessionManager.deleteAllSessions", () => {
  it("deletes all session files and clears index", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "s1", name: "S1", backendOrigin: "copilot" },
            { id: "s2", name: "S2", backendOrigin: "copilot" },
          ],
          activeSessionId: "s1",
        });
      }
      const id = path.includes("s1") ? "s1" : "s2";
      return JSON.stringify({
        id,
        name: id.toUpperCase(),
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        backendOrigin: "copilot" as const,
        isActive: false,
        messages: [],
      });
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(null);
    vi.spyOn(access.store, "loadSessionHeader").mockReturnValue(null);
    const deleteHook = vi.fn<() => void>();
    mgr.registerDeleteHook(deleteHook);

    await mgr.deleteAllSessions();

    // Should delete both session files
    expect(mockedFs.unlinkSync).toHaveBeenCalledTimes(2);
    // Should save empty index
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extracting mock call data
    const savedIndex = JSON.parse(mockedFs.writeFileSync.mock.calls.at(-1)?.[1] as string);
    expect(savedIndex.sessions).toEqual([]);
    expect(savedIndex.activeSessionId).toBeNull();
    expect(deleteHook).toHaveBeenCalledTimes(2);
  });

  it("persists before-delete retirement intent before a failing session-file removal", async () => {
    const record: PersistedSession = {
      id: "relay-delete-crash",
      name: "Relay delete crash",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      messages: [],
    };
    const index = { sessions: [record], activeSessionId: record.id };
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    vi.spyOn(access.store, "loadIndex").mockImplementation(() => index);
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(record);
    vi.spyOn(access.store, "loadSessionHeader").mockReturnValue(null);
    const mutateIndex = vi.spyOn(access.store, "withIndexLock");
    vi.spyOn(access.store, "deleteSessionData").mockImplementation(() => {
      throw new Error("simulated crash before session file removal");
    });
    let retirementPersisted = false;
    const deleted = vi.fn<() => void>();
    manager.registerBeforeDeleteHook(() => {
      retirementPersisted = true;
    });
    manager.registerDeleteHook(deleted);

    await expect(manager.deleteSession(record.id)).rejects.toThrow(
      "simulated crash before session file removal",
    );

    expect(retirementPersisted).toBe(true);
    expect(mutateIndex).not.toHaveBeenCalled();
    expect(index.sessions).toEqual([record]);
    expect(deleted).not.toHaveBeenCalled();
  });

  it("preserves workflow groups when clearing user chats", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "chat", name: "Chat", backendOrigin: "copilot" },
            {
              id: "workflow-host",
              name: "Workflow: Power Query",
              source: "workflow-run",
              backendOrigin: "gateway",
            },
            {
              id: "workflow-child",
              name: "Collect failures",
              source: "subagent",
              parentSessionId: "workflow-host",
              backendOrigin: "gateway",
            },
          ],
          activeSessionId: "chat",
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const deleteSession = vi.spyOn(mgr, "deleteSession").mockResolvedValue(null);

    const firstDelete = mgr.deleteAllSessionsPreservingWorkflowGroups();
    const secondDelete = mgr.deleteAllSessionsPreservingWorkflowGroups();
    await Promise.all([firstDelete, secondDelete]);

    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledWith("chat", {
      suppressChangeEvent: true,
      cause: "user-ipc",
      deferIndexMutation: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extracting mock call data
    const savedIndex = JSON.parse(mockedFs.writeFileSync.mock.calls.at(-1)?.[1] as string);
    expect(savedIndex.sessions.map((session: { id: string }) => session.id)).toEqual([
      "workflow-host",
      "workflow-child",
    ]);
  });

  it("deletes only the selected runtime partition", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: unknown) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "copilot", name: "Copilot", runtimeId: "copilot", backendOrigin: "copilot" },
            { id: "codex", name: "Codex", runtimeId: "codex", backendOrigin: "copilot" },
          ],
          activeSessionId: "copilot",
        });
      }
      return "{}";
    });
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(null);
    vi.spyOn(access.store, "loadSessionHeader").mockReturnValue(null);

    await manager.deleteAllSessions();

    const savedIndex = parseWrittenJson(mockedFs.writeFileSync.mock.calls.at(-1)?.[1]);
    expect(savedIndex.sessions).toEqual([
      expect.objectContaining({ id: "codex", runtimeId: "codex" }),
    ]);
  });
});

describe("SessionManager.cancelTurn", () => {
  it("cancels an active goal-control turn without mutating goal ownership", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const backend = access.backend as IBackendProvider; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    const syntheticIdle = { type: "turn:idle" };
    const goalManager = { pause: vi.fn<() => void>() };
    const goalEngine = { stop: vi.fn<() => void>() };
    mgr.setGoalIntegration(
      testDouble<Parameters<typeof mgr.setGoalIntegration>[0]>(goalManager),
      testDouble<Parameters<typeof mgr.setGoalIntegration>[1]>(goalEngine),
    );

    access.busyTracker.setBusy("s1");
    access.activeInternalControlTurns.set("s1", {
      kind: "goal-continuation",
      exchangeId: "goal-continuation:goal-1:1",
      side: "response",
    });
    const abortGate = deferredPromise<void>();
    const abortSpy = vi.spyOn(backend.sessions, "abort").mockImplementation(async () => {
      await abortGate.promise;
      return {};
    });
    const emitSpy = vi.spyOn(access.viewEmission, "emitEvent");
    const updateViewSpy = vi.spyOn(access.viewEmission, "updateView");
    const refreshSpy = vi.spyOn(mgr, "refreshSessionDedup");

    const cancellation = mgr.cancelTurn("s1");
    let settled = false;
    void cancellation.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(abortSpy).toHaveBeenCalledExactlyOnceWith("s1"));
    expect(settled).toBe(false);
    abortGate.resolve(undefined);
    await expect(cancellation).resolves.toBeUndefined();

    expect(goalManager.pause).not.toHaveBeenCalled();
    expect(goalEngine.stop).not.toHaveBeenCalled();
    expect(abortSpy).toHaveBeenCalledExactlyOnceWith("s1");
    expect(emitSpy).toHaveBeenCalledWith("s1", syntheticIdle);
    expect(updateViewSpy).toHaveBeenCalledWith("s1", syntheticIdle);
    expect(mgr.isSessionBusy("s1")).toBe(false);
    expect(access.activeInternalControlTurns.has("s1")).toBe(false);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("pauses autonomous pursuit before a user Stop cancels the active turn", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const backend = access.backend as IBackendProvider; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    let goalStatus: "pursuing" | "paused" = "pursuing";
    const goalManager = {
      getGoal: vi.fn<() => { status: "pursuing" | "paused" }>(() => ({ status: goalStatus })),
      pause: vi.fn<() => { status: "paused" }>(() => {
        goalStatus = "paused";
        return { status: goalStatus };
      }),
    };
    const goalEngine = { pause: vi.fn<() => void>() };
    mgr.setGoalIntegration(
      testDouble<Parameters<typeof mgr.setGoalIntegration>[0]>(goalManager),
      testDouble<Parameters<typeof mgr.setGoalIntegration>[1]>(goalEngine),
    );
    access.busyTracker.setBusy("s1");
    access.sessionHandles.set("s1", { sessionId: "s1", backendId: "sdk-s1" });
    const abort = vi.spyOn(backend.sessions, "abort").mockResolvedValue({});

    await mgr.stopSession("s1");
    await mgr.stopSession("s1");

    expect(goalManager.pause).toHaveBeenCalledOnce();
    expect(goalEngine.pause).toHaveBeenCalledTimes(2);
    expect(abort).toHaveBeenCalledOnce();
    expect(goalManager.pause.mock.invocationCallOrder[0]).toBeLessThan(
      abort.mock.invocationCallOrder[0],
    );
  });

  it("cancels queued and late subagent handoffs when the user stops their parent", async () => {
    const parent: PersistedSession = {
      id: "parent-user-stop",
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    const child: PersistedSession = {
      id: "child-user-stop",
      name: "Worker",
      source: "subagent",
      parentSessionId: parent.id,
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [{ id: "work", role: "user", content: "Audit the changes", timestamp: "" }],
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === parent.id) return parent;
      if (sessionId === child.id) return child;
      return null;
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    mockCurrentRuntimeIndex(access, [parent, child]);
    access.sessionHandles.set(parent.id, { sessionId: parent.id, backendId: "sdk-parent" });
    access.busyTracker.setBusy(parent.id);
    const abort = vi.spyOn(backend.sessions, "abort").mockResolvedValue({});
    const send = vi.spyOn(backend.sessions, "send");
    const outbox = await attachTestAgentMessageOutbox(mgr, { pauseDispatch: true });
    const queued = await mgr.sendMessageToParent({
      sessionId: child.id,
      message: "Old audit result",
    });

    await mgr.stopSession(parent.id);
    await mgr.noteSubagentIdle(child, Date.parse("2026-07-25T08:32:00.000Z"), {
      wasBusy: true,
      outcome: "completed",
    });

    expect(outbox.list({ target: parent.id })).toEqual([
      expect.objectContaining({ messageId: queued.messageId, state: "cancelled" }),
    ]);
    expect(parent.messages).toEqual([]);
    const late = await mgr.sendMessageToParent({
      sessionId: child.id,
      message: "Late audit result",
    });
    outbox.resumeAfterRuntimeReset();
    await vi.waitFor(() =>
      expect(outbox.list({ target: parent.id })).toEqual([
        expect.objectContaining({ messageId: queued.messageId, state: "cancelled" }),
        expect.objectContaining({ messageId: late.messageId, state: "cancelled" }),
      ]),
    );
    expect(abort).toHaveBeenCalledExactlyOnceWith(parent.id);
    expect(send).not.toHaveBeenCalled();
  });

  it("fences an in-flight direct Runtime continuation across Stop and later resume", async () => {
    const session: PersistedSession = {
      id: "direct-runtime-user-stop",
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(session);
    mockCurrentRuntimeIndex(access, [session]);
    const send = vi.spyOn(backend.sessions, "send");
    vi.spyOn(backend.sessions, "abort").mockResolvedValue({});
    const epoch = mgr.runtimeContinuationEpoch(session.id, session.id);

    const racingContinuation = mgr.sendRuntimeContinuation(
      session.id,
      session.id,
      "Continue automatically",
      epoch,
    );
    await mgr.stopSession(session.id);

    await expect(racingContinuation).resolves.toEqual({ delivery: "held" });
    mgr.resumeAfterUserStop(session.id);
    await expect(
      mgr.sendRuntimeContinuation(session.id, session.id, "Stale continuation", epoch),
    ).resolves.toEqual({ delivery: "held" });
    expect(send).not.toHaveBeenCalled();
  });

  it("surfaces backend abort rejection after fencing the turn and restoring idle", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const backend = access.backend as IBackendProvider; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    const syntheticIdle = { type: "turn:idle" };

    access.busyTracker.setBusy("s1");
    vi.spyOn(backend.sessions, "abort").mockRejectedValue(new Error("abort wedged"));
    const emitSpy = vi.spyOn(access.viewEmission, "emitEvent");
    const updateViewSpy = vi.spyOn(access.viewEmission, "updateView");
    vi.spyOn(mgr, "refreshSessionDedup").mockResolvedValue(undefined);

    await expect(mgr.cancelTurn("s1")).rejects.toThrow(
      "Cancellation failed. The response was isolated; send again to retry.",
    );

    expect(emitSpy).toHaveBeenCalledWith("s1", syntheticIdle);
    expect(updateViewSpy).toHaveBeenCalledWith("s1", syntheticIdle);
    expect(mgr.isSessionBusy("s1")).toBe(false);
    expect(mgr.getSessionView("s1").view).toMatchObject({
      status: "ready",
      error: null,
      sessionStatus: null,
    });
  });

  it("reconciles a backend already-idle response as a successful cancellation", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const backend = access.backend as IBackendProvider; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test double access

    access.busyTracker.setBusy("s1");
    vi.spyOn(backend.sessions, "abort").mockRejectedValue(new Error("No active turn"));

    await expect(mgr.cancelTurn("s1")).resolves.toBeUndefined();

    expect(mgr.isSessionBusy("s1")).toBe(false);
    expect(mgr.getSessionView("s1").view).toMatchObject({
      status: "ready",
      error: null,
      sessionStatus: null,
    });
  });

  it("bounds a wedged abort, shares the in-flight promise, and quarantines the session runtime", async () => {
    vi.useFakeTimers();
    try {
      const { SessionManager } = await import("./sessions");
      const mgr = new SessionManager("/test/workspace", await createTestBackend());
      const access = new SessionTestAccess(mgr);
      const backend = access.backend as IBackendProvider; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test double access

      access.sessionHandles.set("s1", { sessionId: "s1", backendId: "sdk-s1" });
      access.busyTracker.setBusy("s1");
      const abort = vi
        .spyOn(backend.sessions, "abort")
        .mockImplementation(() => new Promise(() => {}));

      const first = mgr.cancelTurn("s1");
      const second = mgr.cancelTurn("s1");
      expect(second).toBe(first);
      const outcome = first.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(5_000);

      await expect(outcome).resolves.toMatchObject({
        message: "Cancellation timed out. The response was isolated; send again to retry.",
      });
      expect(abort).toHaveBeenCalledExactlyOnceWith("s1");
      expect(access.sessionHandles.has("s1")).toBe(false);
      expect(mgr.isSessionBusy("s1")).toBe(false);
      expect(mgr.getSessionView("s1").view).toMatchObject({
        status: "ready",
        error: null,
        sessionStatus: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences late events from the cancelled runtime after a replacement generation starts", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const backend = access.backend as IBackendProvider; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test double access

    access.sessionHandles.set("s1", { sessionId: "s1", backendId: "sdk-old" });
    access.subscribeToBackendEvents("s1");
    const staleSubscriber = [...access.getCopilotBackendSessionSubscribers("s1")][0];
    if (!staleSubscriber) throw new Error("Expected old backend subscriber");
    access.busyTracker.setBusy("s1");
    vi.spyOn(backend.sessions, "abort").mockResolvedValue({});

    await mgr.cancelTurn("s1");

    access.sessionHandles.set("s1", { sessionId: "s1", backendId: "sdk-new" });
    access.subscribeToBackendEvents("s1");
    const replacementSubscriber = [...access.getCopilotBackendSessionSubscribers("s1")][0];
    if (!replacementSubscriber) throw new Error("Expected replacement backend subscriber");
    const updateViewSpy = vi.spyOn(access.viewEmission, "updateView");
    mgr.markBusy("s1");

    staleSubscriber({ type: "text-delta", text: "late cancelled output" });
    staleSubscriber({ type: "idle" });
    await Promise.resolve();

    expect(updateViewSpy).not.toHaveBeenCalled();
    expect(mgr.isSessionBusy("s1")).toBe(true);

    replacementSubscriber({ type: "text-delta", text: "fresh output" });
    await Promise.resolve();

    expect(updateViewSpy).toHaveBeenCalledWith("s1", {
      type: "turn:text-delta",
      delta: "fresh output",
    });
  });

  it("does not let cancellation split durable acceptance from backend dispatch", async () => {
    const session: PersistedSession = {
      id: "cancel-dispatch-barrier",
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const manager = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(manager);
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(session);
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    access.sessionHandles.set(session.id, {
      sessionId: session.id,
      backendId: "sdk-cancel-dispatch-barrier",
    });
    const barrierStarted = deferredPromise<void>();
    const releaseBarrier = deferredPromise<void>();
    const sendToBackend = vi.spyOn(backend.sessions, "send").mockResolvedValue(undefined);
    const abort = vi.spyOn(backend.sessions, "abort").mockResolvedValue({});
    const viewEvents: import("../common/marshal-ipc-contract").SessionViewEvent[] = [];
    manager.addViewEventListener((_sessionId, event) => viewEvents.push(event));

    const send = manager
      .sendMessage(session.id, "durable handoff", undefined, {
        clientMessageId: "handoff-barrier",
        agentMessage: {
          source: "child",
          sourceLabel: "Worker",
          sourceSessionSource: "subagent",
          kind: "parent",
          deliveryMode: "queue",
          sequence: 1,
        },
        onBackendDispatchStarting: async () => {
          barrierStarted.resolve(undefined);
          await releaseBarrier.promise;
        },
      })
      .catch((error: unknown) => error);
    await barrierStarted.promise;

    const cancellation = manager.cancelTurn(session.id);
    await Promise.resolve();
    expect(abort).not.toHaveBeenCalled();

    releaseBarrier.resolve(undefined);
    await Promise.all([send, cancellation]);

    expect(sendToBackend).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
    expect(sendToBackend.mock.invocationCallOrder[0]).toBeLessThan(
      abort.mock.invocationCallOrder[0],
    );
    expect(viewEvents.some((event) => event.view.error !== null)).toBe(false);
  });

  it("keeps a running child alive when the parent turn is cancelled, then records readiness", async () => {
    const parent: PersistedSession = {
      id: "parent-cancel-scope",
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    const child: PersistedSession = {
      id: "child-cancel-scope",
      name: "Runtime Worker",
      source: "subagent",
      parentSessionId: parent.id,
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "2026-07-25T08:00:00.000Z",
      hasUnread: false,
      isActive: true,
      messages: [{ id: "task", role: "user", content: "Keep working", timestamp: "" }],
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === parent.id) return parent;
      if (sessionId === child.id) return child;
      return null;
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    mockCurrentRuntimeIndex(access, [parent, child]);
    access.sessionHandles.set(parent.id, { sessionId: parent.id, backendId: "sdk-parent" });
    access.sessionHandles.set(child.id, { sessionId: child.id, backendId: "sdk-child" });
    access.busyTracker.setBusy(parent.id);
    access.busyTracker.setBusy(child.id);
    const abort = vi.spyOn(backend.sessions, "abort").mockResolvedValue({});
    const send = vi.spyOn(backend.sessions, "send");
    access.currentSessionId = parent.id;

    await mgr.cancelTurn(parent.id);

    expect(abort).toHaveBeenCalledExactlyOnceWith(parent.id);
    expect(access.busyTracker.isBusy(parent.id)).toBe(false);
    expect(access.busyTracker.isBusy(child.id)).toBe(true);
    expect(access.sessionHandles.has(child.id)).toBe(true);

    await mgr.noteSubagentIdle(child, Date.now(), { wasBusy: true });
    access.busyTracker.setIdle(child.id);

    const readiness = parent.messages.filter(
      (message) => message.agentMessage?.source === child.id,
    );
    expect(readiness).toHaveLength(1);
    expect(readiness[0]?.agentMessage).toMatchObject({
      source: child.id,
      sourceLabel: child.name,
      sourceSessionSource: "subagent",
      kind: "readiness",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a hidden worktree child alive through parent cancellation and delivers once", async () => {
    const worktreePath = nodePath.resolve(
      "C:\\Users\\test\\.marshal\\marshal-worktrees\\hidden-child-12345678",
    );
    const parent: PersistedSession = {
      id: "parent-hidden-worktree-cancel",
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    const child: PersistedSession = {
      id: "hidden-worktree-child",
      name: "Hidden Worktree Worker",
      source: "subagent",
      parentSessionId: parent.id,
      repoPath: worktreePath,
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [{ id: "task", role: "user", content: "Keep working", timestamp: "" }],
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const manager = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(manager);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === parent.id) return parent;
      if (sessionId === child.id) return child;
      return null;
    });
    mockCurrentRuntimeIndex(access, [parent, child]);
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => undefined);
    access.sessionHandles.set(parent.id, { sessionId: parent.id, backendId: "sdk-parent" });
    access.sessionHandles.set(child.id, { sessionId: child.id, backendId: "sdk-child" });
    access.busyTracker.setBusy(parent.id);
    access.busyTracker.setBusy(child.id);
    const abortGate = deferredPromise<void>();
    const abort = vi.spyOn(backend.sessions, "abort").mockImplementation(async () => {
      await abortGate.promise;
      return {};
    });
    vi.spyOn(backend.sessions, "send").mockImplementation(async (sessionId) => {
      if (sessionId !== parent.id) return;
      access.busyTracker.setIdle(parent.id);
      manager.emitEvent(parent.id, { type: "turn:idle" });
    });
    access.replaceCreateBackendSession(async (sessionId) => {
      access.sessionHandles.set(sessionId, {
        sessionId,
        backendId: `sdk-resumed-${sessionId}`,
      });
      access.subscribeToBackendEvents(sessionId);
    });
    const scratchpad = {
      name: "Scratchpad",
      path: nodePath.resolve("/test/workspace/Scratchpad"),
      origin: "scratchpad" as const,
      identity: { version: 1 as const, device: "1", inode: "1", birthtimeNs: "1" },
      external: false,
    };
    const listRegisteredWorkspaces = vi
      .spyOn(workspaceStore, "listRegisteredWorkspaces")
      .mockReturnValue([scratchpad]);
    const explicitIdentity = {
      version: 1 as const,
      device: "1",
      inode: "9",
      birthtimeNs: "3",
    };
    const registerExistingWorkspace = vi
      .spyOn(workspaceStore, "registerExistingWorkspace")
      .mockReturnValue({
        name: "Explicit Worktree",
        path: worktreePath,
        origin: "user-added",
        identity: explicitIdentity,
        external: true,
      });
    const outbox = await attachTestAgentMessageOutbox(manager);

    const cancellation = manager.cancelTurn(parent.id);
    await vi.waitFor(() => expect(abort).toHaveBeenCalledExactlyOnceWith(parent.id));
    expect(manager.listWorkspacesForSelfTools()).toEqual([
      { name: "Scratchpad", path: scratchpad.path },
    ]);
    expect(access.busyTracker.isBusy(child.id)).toBe(true);
    expect(access.sessionHandles.has(child.id)).toBe(true);
    abortGate.resolve(undefined);
    await cancellation;

    const handoff = await manager.sendMessageToParent({
      sessionId: child.id,
      message: "Hidden worktree result",
    });
    expectDurablyAccepted(handoff);
    await vi.waitFor(() =>
      expect(outbox.list({ target: parent.id }).map((message) => message.state)).toEqual([
        "processed",
      ]),
    );

    expect(abort).toHaveBeenCalledExactlyOnceWith(parent.id);
    expect(access.busyTracker.isBusy(child.id)).toBe(true);
    expect(access.sessionHandles.has(child.id)).toBe(true);
    expect(parent.messages.filter((message) => message.id === handoff.messageId)).toHaveLength(1);
    expect(manager.listWorkspacesForSelfTools()).toEqual([
      { name: "Scratchpad", path: scratchpad.path },
    ]);
    expect(registerExistingWorkspace).not.toHaveBeenCalled();

    await expect(
      manager.registerWorkspaceForSelfTools({
        name: "Explicit Worktree",
        path: worktreePath,
      }),
    ).resolves.toMatchObject({
      name: "Explicit Worktree",
      path: worktreePath,
      origin: "user-added",
    });
    listRegisteredWorkspaces.mockReturnValue([
      scratchpad,
      {
        name: "Explicit Worktree",
        path: worktreePath,
        origin: "user-added",
        identity: explicitIdentity,
        external: true,
      },
    ]);

    expect(registerExistingWorkspace).toHaveBeenCalledExactlyOnceWith(
      "Explicit Worktree",
      worktreePath,
      "/test/workspace",
    );
    expect(child.workspaceName).toBeUndefined();
    expect(child.repoPath).toBe(worktreePath);
    expect(manager.listWorkspacesForSelfTools()).toEqual([
      { name: "Scratchpad", path: scratchpad.path },
      { name: "Explicit Worktree", path: worktreePath },
    ]);
  });

  it("drains queued child handoff and review feedback after cancelling only the parent turn", async () => {
    const parent: PersistedSession = {
      id: "parent-cancel-queue",
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    const child: PersistedSession = {
      id: "child-cancel-queue",
      name: "Queue Worker",
      source: "subagent",
      parentSessionId: parent.id,
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [{ id: "task", role: "user", content: "Work", timestamp: "" }],
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === parent.id) return parent;
      if (sessionId === child.id) return child;
      return null;
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    access.sessionHandles.set(parent.id, { sessionId: parent.id, backendId: "sdk-parent" });
    access.busyTracker.setBusy(parent.id);
    const abort = vi.spyOn(backend.sessions, "abort").mockResolvedValue({});
    vi.spyOn(backend.sessions, "send").mockImplementation(async (sessionId) => {
      if (sessionId === parent.id) {
        access.busyTracker.setIdle(parent.id);
        mgr.emitEvent(parent.id, { type: "turn:idle" });
      }
    });
    access.replaceCreateBackendSession(async (sessionId) => {
      access.sessionHandles.set(sessionId, {
        sessionId,
        backendId: `sdk-resumed-${sessionId}`,
      });
      access.subscribeToBackendEvents(sessionId);
    });
    const viewEvents: import("../common/marshal-ipc-contract").SessionViewEvent[] = [];
    mgr.addViewEventListener((_sessionId, event) => viewEvents.push(event));
    const outbox = await attachTestAgentMessageOutbox(mgr);
    const review = await mgr.sendReviewCommentsToSession({
      sessionId: parent.id,
      message: "Queued review feedback",
    });
    const handoff = await mgr.sendMessageToParent({
      sessionId: child.id,
      message: "Queued child handoff",
    });
    expectDurablyAccepted(review);
    expectDurablyAccepted(handoff);

    await mgr.cancelTurn(parent.id);

    await vi.waitFor(() =>
      expect(outbox.list({ target: parent.id }).map((message) => message.state)).toEqual([
        "processed",
        "processed",
      ]),
    );
    expect(abort).toHaveBeenCalledExactlyOnceWith(parent.id);
    expect(parent.messages.filter((message) => message.id === review.messageId)).toHaveLength(1);
    expect(parent.messages.filter((message) => message.id === handoff.messageId)).toHaveLength(1);
    expect(viewEvents.some((event) => event.view.error !== null)).toBe(false);
  });

  it("keeps repeated parent cancellation scoped and does not manufacture child readiness", async () => {
    const parent: PersistedSession = {
      id: "parent-repeat-cancel",
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    const child: PersistedSession = {
      id: "child-repeat-cancel",
      name: "Still Running",
      source: "subagent",
      parentSessionId: parent.id,
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === parent.id) return parent;
      if (sessionId === child.id) return child;
      return null;
    });
    mockCurrentRuntimeIndex(access, [parent, child]);
    access.busyTracker.setBusy(parent.id);
    access.busyTracker.setBusy(child.id);
    const abort = vi.spyOn(backend.sessions, "abort").mockResolvedValue({});
    const outbox = await attachTestAgentMessageOutbox(mgr, { pauseDispatch: true });

    await mgr.cancelTurn(parent.id);
    await mgr.cancelTurn(parent.id);

    expect(abort).toHaveBeenCalledExactlyOnceWith(parent.id);
    expect(access.busyTracker.isBusy(child.id)).toBe(true);
    expect(outbox.list({ target: parent.id })).toEqual([]);
  });

  it("explicit child cancellation aborts only that child and suppresses the synthetic idle notice", async () => {
    vi.useFakeTimers();
    const parent: PersistedSession = {
      id: "parent-explicit-child-cancel",
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    const child: PersistedSession = {
      id: "child-explicit-cancel",
      name: "Cancelled Worker",
      source: "subagent",
      parentSessionId: parent.id,
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "2026-07-25T08:30:00.000Z",
      hasUnread: false,
      isActive: true,
      messages: [{ id: "work", role: "user", content: "Audit the changes", timestamp: "" }],
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === parent.id) return parent;
      if (sessionId === child.id) return child;
      return null;
    });
    mockCurrentRuntimeIndex(access, [parent, child]);
    access.busyTracker.setBusy(parent.id);
    access.busyTracker.setBusy(child.id);
    const abort = vi.spyOn(backend.sessions, "abort").mockResolvedValue({});
    const outbox = await attachTestAgentMessageOutbox(mgr, { pauseDispatch: true });
    const signalResumeTrigger =
      vi.fn<Parameters<typeof mgr.setGoalIntegration>[1]["signalResumeTrigger"]>();
    mgr.setGoalIntegration(
      testDouble<Parameters<typeof mgr.setGoalIntegration>[0]>({}),
      testDouble<Parameters<typeof mgr.setGoalIntegration>[1]>({
        start: vi.fn<() => void>(),
        signalResumeTrigger,
        pause: vi.fn<() => void>(),
        stop: vi.fn<() => void>(),
        isRunning: () => false,
      }),
    );

    await mgr.cancelTurn(child.id);
    await mgr.noteSubagentIdle(child);

    expect(abort).toHaveBeenCalledExactlyOnceWith(child.id);
    expect(access.busyTracker.isBusy(parent.id)).toBe(true);
    expect(access.busyTracker.isBusy(child.id)).toBe(false);
    expect(outbox.list({ target: parent.id })).toEqual([]);
    expect(signalResumeTrigger).not.toHaveBeenCalled();

    child.messages.push({
      id: "follow-up-work",
      role: "user",
      content: "Try a different approach",
      timestamp: "2026-07-25T08:31:00.000Z",
    });
    mgr.markBusy(child.id);
    await mgr.noteSubagentIdle(child, Date.parse("2026-07-25T08:32:00.000Z"), { wasBusy: true });

    expect(parent.messages).toEqual([
      expect.objectContaining({
        id: `subagent-ready:${parent.id}:${child.id}:follow-up-work`,
        agentMessage: expect.objectContaining({
          source: child.id,
          kind: "readiness",
          readinessGeneration: "follow-up-work",
        }),
      }),
    ]);
  });

  it("cancels active host tools before clearing their records", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const backend = access.backend as IBackendProvider; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    const cancel = vi.fn<() => void>();
    const claimedAtMs = Date.now();
    const claimResult = await mgr.claimBackgroundToolDispatch({
      ownerSessionId: "s1",
      toolCallId: "sleep-1",
      toolName: "sleep",
      requestedAtMs: claimedAtMs,
      idempotencyKey: "cancel-turn-sleep-1",
    });
    if (claimResult.kind !== "claimed") throw new Error("Expected background tool claim");
    const invocation: Parameters<typeof mgr.beginBackgroundToolInvocation>[0] = {
      claim: claimResult.claim,
      sessionId: "s1",
      toolCallId: "sleep-1",
      toolName: "sleep",
      startedAtMs: claimedAtMs,
      cancel,
    };
    await mgr.beginBackgroundToolInvocation(invocation);
    vi.spyOn(backend.sessions, "abort").mockResolvedValue({});

    await mgr.cancelTurn("s1");

    expect(cancel).toHaveBeenCalledOnce();
    expect(mgr.listRunningTools("s1")).toEqual([]);
  });

  it("keeps exact process ownership inspectable when cancellation rejects", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const backend = access.backend as IBackendProvider; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    let rejectCancellation!: (reason?: unknown) => void;
    const cancel = vi.fn<() => Promise<void>>(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCancellation = reject;
        }),
    );
    const claimedAtMs = Date.now();
    const claimResult = await mgr.claimBackgroundToolDispatch({
      ownerSessionId: "s1",
      toolCallId: "shell-1",
      toolName: "execute-shell",
      requestedAtMs: claimedAtMs,
      idempotencyKey: "cancel-turn-shell-1",
    });
    if (claimResult.kind !== "claimed") throw new Error("Expected background tool claim");
    const invocation: Parameters<typeof mgr.beginBackgroundToolInvocation>[0] = {
      claim: claimResult.claim,
      sessionId: "s1",
      toolCallId: "shell-1",
      toolName: "execute-shell",
      startedAtMs: claimedAtMs,
      cancellationScope: "none",
    };
    await mgr.beginBackgroundToolInvocation(invocation);
    await mgr.attachBackgroundToolProcess("s1:shell-1", {
      ownerSessionId: "s1",
      rootPid: 4242,
      spawnedAtMs: claimedAtMs,
      cancellationScope: "process-tree",
      cancel,
    });
    vi.spyOn(backend.sessions, "abort").mockResolvedValue({});

    const cancellation = mgr.cancelTurn("s1");
    let cancellationSettled = false;
    void cancellation.then(() => {
      cancellationSettled = true;
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(cancellationSettled).toBe(false);
    rejectCancellation(new Error("taskkill failed"));
    await cancellation;

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
  });
});

describe("SessionManager restored conversation context", () => {
  it("excludes readiness state and suppressed legacy replies from model context", async () => {
    const session: PersistedSession = {
      id: "context-readiness",
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      contextSummary: "BAD: stale readiness summary",
      summaryUpToMessageId: "legacy-reply",
      messages: [
        {
          id: "work",
          role: "user",
          content: "Implement the lifecycle repair.",
          timestamp: "2026-07-25T08:00:00.000Z",
        },
        {
          id: "readiness",
          role: "system",
          content: 'Subagent "Worker" is idle and ready for follow-up.',
          timestamp: "2026-07-25T08:01:00.000Z",
          agentMessage: {
            source: "child-1",
            sourceLabel: "Worker",
            sourceSessionSource: "subagent",
            kind: "readiness",
            deliveryMode: "queue",
            sequence: 0,
            readinessGeneration: "work-1",
          },
        },
        {
          id: "legacy-reply",
          role: "assistant",
          content: "No action needed.",
          timestamp: "2026-07-25T08:01:01.000Z",
          suppressedAgentStatusResponse: true,
        },
        {
          id: "readiness-control",
          role: "user",
          content: "PRIVATE_PARENT_WAKE_PROMPT",
          timestamp: "2026-07-25T08:01:02.000Z",
          internalControl: {
            kind: "subagent-readiness",
            exchangeId: "subagent-readiness:context-readiness:test",
            side: "request",
          },
        },
        {
          id: "readiness-work",
          role: "assistant",
          content: "Integrated the worker result.",
          timestamp: "2026-07-25T08:01:03.000Z",
          internalControl: {
            kind: "subagent-readiness",
            exchangeId: "subagent-readiness:context-readiness:test",
            side: "response",
          },
        },
      ],
    };
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(session);

    const context = await access.buildConversationContext(session.id, session.messages);

    expect(context).toContain("Implement the lifecycle repair.");
    expect(context).not.toContain("idle and ready for follow-up");
    expect(context).not.toContain("No action needed");
    expect(context).not.toContain("PRIVATE_PARENT_WAKE_PROMPT");
    expect(context).toContain("Integrated the worker result.");
    expect(context).not.toContain("BAD: stale readiness summary");
  });
});

describe("SessionManager.steerMessage", () => {
  it("cancels only the current turn, then sends", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const backend = access.backend as IBackendProvider; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test double access
    access.sessionHandles.set("s1", { sessionId: "s1", backendId: "sdk-s1" });
    access.busyTracker.setBusy("s1");
    const calls: string[] = [];
    const abortGate = deferredPromise<void>();
    vi.spyOn(backend.sessions, "abort").mockImplementation(async () => {
      calls.push("cancel");
      await abortGate.promise;
      return {};
    });
    const sendSpy = vi.spyOn(mgr, "sendMessage").mockImplementation(async () => {
      calls.push("send");
    });

    const steering = mgr.steerMessage("s1", "change direction", undefined, {
      clientMessageId: "steer-1",
    });
    await vi.waitFor(() => expect(calls).toEqual(["cancel"]));
    abortGate.resolve(undefined);
    await steering;

    expect(calls).toEqual(["cancel", "send"]);
    expect(access.sessionHandles.get("s1")).toEqual({ sessionId: "s1", backendId: "sdk-s1" });
    expect(sendSpy).toHaveBeenCalledExactlyOnceWith(
      "s1",
      "change direction",
      undefined,
      expect.objectContaining({
        clientMessageId: "steer-1",
        backendPromptContent: expect.stringMatching(
          /^<system_instruction>[\s\S]*change direction$/,
        ),
      }),
    );
  });

  it("sends steering context to the backend without exposing it in the user message", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    const session: PersistedSession = {
      id: "s1",
      name: "Existing chat",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(session);
    access.sessionHandles.set("s1", { sessionId: "s1", backendId: "sdk-s1" });
    access.busyTracker.setBusy("s1");
    vi.spyOn(mgr, "cancelTurn").mockImplementation(async () => {
      access.busyTracker.setIdle("s1");
    });
    const appendMessage = vi.spyOn(mgr, "appendMessage").mockReturnValue(true);
    const send = vi.spyOn(backend.sessions, "send").mockResolvedValue(undefined);

    await mgr.steerMessage("s1", "change direction", undefined, {
      clientMessageId: "steer-1",
    });

    expect(send).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        prompt: expect.stringMatching(/^<system_instruction>[\s\S]*change direction$/),
      }),
      expect.objectContaining({
        idempotencyKey: "steer-1",
        localRunId: "steer-1",
      }),
    );
    expect(appendMessage).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        id: "steer-1",
        role: "user",
        content: "change direction",
      }),
    );
  });
});

describe("SessionManager.listSessions", () => {
  it("lists legacy Teams sessions as user sessions in the sidebar", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "user1", name: "Chat", backendOrigin: "copilot" },
            { id: "teams-active", name: "Teams Bot", source: "teams", backendOrigin: "copilot" },
            {
              id: "teams-old",
              name: "Teams Bot",
              source: "teams-archived",
              backendOrigin: "copilot",
            },
            { id: "user2", name: "Another Chat", backendOrigin: "copilot" },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const sessions = await mgr.listSessions();

    expect(sessions.map((s) => s.id)).toEqual(["user1", "teams-active", "teams-old", "user2"]);
    expect(sessions.find((s) => s.id === "teams-active")?.source).toBe("user");
    expect(sessions.find((s) => s.id === "teams-old")?.source).toBe("user");
  });

  it("marks busy sessions in listed metadata", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "busy", name: "Busy chat", backendOrigin: "copilot" },
            { id: "idle", name: "Idle chat", backendOrigin: "copilot" },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    access.busyTracker.setBusy("busy");

    const sessions = await mgr.listSessions();

    expect(sessions.find((s) => s.id === "busy")?.isBusy).toBe(true);
    expect(sessions.find((s) => s.id === "idle")?.isBusy).toBe(false);
  });

  it("excludes condition check sessions (source=automation, no automationId)", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "user1", name: "Chat", backendOrigin: "copilot" },
            {
              id: "wf1",
              name: "Run automation",
              source: "automation",
              automationId: "wf-abc",
              backendOrigin: "copilot",
            },
            {
              id: "cc1",
              name: "Condition check: My automation",
              source: "automation",
              backendOrigin: "copilot",
            },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const sessions = await mgr.listSessions();

    expect(sessions.map((s) => s.id)).toEqual(["user1", "wf1"]);
  });

  it("includes workflow-run hosts as sidebar anchors while hiding other internal sessions", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "user1", name: "Chat", backendOrigin: "copilot" },
            {
              id: "workflow-host",
              name: "Workflow: Power Query",
              source: "workflow-run",
              backendOrigin: "copilot",
            },
            {
              id: "agent",
              name: "Recent incident pull",
              backendOrigin: "copilot" as const,
              source: "subagent",
              parentSessionId: "workflow-host",
            },
            { id: "feedback", name: "Feedback", source: "feedback", backendOrigin: "copilot" },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const sessions = await mgr.listSessions();
    const sidebarSessions = await mgr.listSessions({ includeWorkflowRuns: true });

    expect(sessions.map((s) => s.id)).toEqual(["user1", "agent"]);
    expect(sidebarSessions.map((s) => s.id)).toEqual(["user1", "workflow-host", "agent"]);
    expect(sidebarSessions.find((session) => session.id === "agent")?.parentSessionId).toBe(
      "workflow-host",
    );
  });

  it("migrates old source='workflow' sessions to source='automation'", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({
          sessions: [
            {
              id: "wf-migrated",
              name: "Run automation",
              backendOrigin: "copilot" as const,
              source: "workflow",
              workflowId: "wf-1",
            },
            {
              id: "cc-hidden",
              name: "Condition check",
              backendOrigin: "copilot" as const,
              source: "workflow",
              // no workflowId → condition-check session, should be hidden
            },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const sessions = await mgr.listSessions();

    // condition-check session (source="workflow", no workflowId) is hidden
    expect(sessions).toHaveLength(1);
    // source migrated from "workflow" to "automation"
    expect(sessions[0].source).toBe("automation");
    // workflowId migrated to automationId
    expect(sessions[0].automationId).toBe("wf-1");
    expect(sessions[0].id).toBe("wf-migrated");
  });

  it("keeps one chat list across runtimes", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "copilot-a", name: "Copilot chat A", backendOrigin: "copilot" },
            { id: "gateway-a", name: "Gateway chat", backendOrigin: "gateway" },
            { id: "legacy", name: "Legacy (no origin)", backendOrigin: "copilot" }, // defaults to copilot
            { id: "copilot-b", name: "Copilot chat B", backendOrigin: "copilot" },
            {
              id: "codex-a",
              name: "Codex chat",
              runtimeId: "codex",
              backendOrigin: "copilot",
            },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend(); // CopilotBackend → origin === "copilot"
    const mgr = new SessionManager("/test/workspace", backend);
    const sessions = await mgr.listSessions();

    expect(sessions.map((s) => s.id).sort()).toEqual([
      "codex-a",
      "copilot-a",
      "copilot-b",
      "gateway-a",
      "legacy",
    ]);
  });

  it("shows copilot and legacy chats while gateway is active", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "copilot-a", name: "Copilot chat", backendOrigin: "copilot" },
            { id: "gateway-a", name: "Gateway chat", backendOrigin: "gateway" },
            { id: "legacy", name: "Legacy (no origin)", backendOrigin: "copilot" }, // defaults to copilot
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    Object.defineProperties(backend, {
      runtimeId: { value: "gateway" },
      origin: { value: "gateway" },
    });
    const mgr = new SessionManager("/test/workspace", backend);
    const sessions = await mgr.listSessions();

    expect(sessions.map((s) => s.id).sort()).toEqual(["copilot-a", "gateway-a", "legacy"]);
  });

  it("does not propagate descendant activity across local runtimes sharing an origin", async () => {
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    vi.spyOn(access.store, "loadIndex").mockReturnValue({
      activeSessionId: null,
      sessions: [
        {
          id: "copilot-parent",
          name: "Parent",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: false,
          runtimeId: "copilot",
          backendOrigin: "copilot",
        },
        {
          id: "codex-child",
          name: "Child",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: false,
          source: "subagent",
          parentSessionId: "copilot-parent",
          runtimeId: "codex",
          backendOrigin: "copilot",
        },
      ],
    });
    access.busyTracker.setBusy("codex-child");

    const sessions = await manager.listSessions();

    expect(sessions.map((session) => session.id).sort()).toEqual(["codex-child", "copilot-parent"]);
    expect(sessions[0].hasRunningSubagent).toBe(false);
  });

  it("does not prewarm an active session owned by another local runtime", async () => {
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    const foreign: PersistedSession = {
      id: "codex-active",
      name: "Codex",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      runtimeId: "codex",
      backendOrigin: "copilot",
      messages: [],
    };
    vi.spyOn(access.store, "loadIndex").mockReturnValue({
      activeSessionId: foreign.id,
      sessions: [foreign],
    });
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(foreign);
    vi.spyOn(manager, "listModels").mockResolvedValue([]);
    const createBackendSession = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    access.setCreateBackendSessionForTest(createBackendSession);

    access.prewarm();
    await Promise.resolve();

    expect(createBackendSession).not.toHaveBeenCalled();
  });

  it("does not let a completed prewarm delete a newer replacement start", async () => {
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    const active: PersistedSession = {
      id: "active",
      name: "Active",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      runtimeId: "copilot",
      backendOrigin: "copilot",
      messages: [],
    };
    vi.spyOn(access.store, "loadIndex").mockReturnValue({
      activeSessionId: active.id,
      sessions: [active],
    });
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(active);
    vi.spyOn(manager, "listModels").mockResolvedValue([]);
    const prewarmReady = deferredPromise<void>();
    access.setCreateBackendSessionForTest(async () => prewarmReady.promise);

    access.prewarm();
    await vi.waitFor(() => expect(access.pendingSessionCreations.has(active.id)).toBe(true));
    const replacement = new Promise<void>(() => {});
    access.pendingSessionCreations.set(active.id, replacement);

    prewarmReady.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(access.pendingSessionCreations.get(active.id)).toBe(replacement);
  });

  it("does not expose direct session reads from another local runtime", async () => {
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    const foreign: PersistedSession = {
      id: "codex-session",
      name: "Codex",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      runtimeId: "codex",
      backendOrigin: "copilot",
      messages: [],
    };
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(foreign);

    expect(manager.getSession(foreign.id)).toBeNull();
    await expect(manager.getSessionAsync(foreign.id)).resolves.toBeNull();
  });

  it("rejects backend startup for another local runtime with the same origin", async () => {
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    const foreign: PersistedSession = {
      id: "codex-session",
      name: "Codex",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      runtimeId: "codex",
      backendOrigin: "copilot",
      messages: [],
    };
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(foreign);
    vi.spyOn(access.store, "loadIndex").mockReturnValue({
      sessions: [foreign],
      activeSessionId: null,
    });

    await expect(access.createBackendSession(foreign.id, false)).rejects.toThrow(
      /belongs to runtime "codex"/,
    );
  });

  it("returns sessions sorted by updatedAt descending (most recent first)", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({
          sessions: [
            {
              id: "old",
              name: "Old Chat",
              updatedAt: "2026-01-01T00:00:00Z",
              backendOrigin: "copilot",
            },
            {
              id: "new",
              name: "New Chat",
              updatedAt: "2026-04-13T12:00:00Z",
              backendOrigin: "copilot",
            },
            {
              id: "mid",
              name: "Mid Chat",
              updatedAt: "2026-03-01T00:00:00Z",
              backendOrigin: "copilot",
            },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const sessions = await mgr.listSessions();

    expect(sessions.map((s) => s.id)).toEqual(["new", "mid", "old"]);
  });

  it("sorts sessions without updatedAt to the bottom", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "empty", name: "Empty", updatedAt: "", backendOrigin: "copilot" },
            {
              id: "recent",
              name: "Recent",
              updatedAt: "2026-04-13T12:00:00Z",
              backendOrigin: "copilot",
            },
            { id: "none", name: "None", backendOrigin: "copilot" },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const sessions = await mgr.listSessions();

    expect(sessions.map((s) => s.id)).toEqual(["recent", "empty", "none"]);
  });

  it("returns bounded newest-first pages and keeps an older selected session visible", async () => {
    const stored = Array.from({ length: 1_005 }, (_, index) => ({
      id: `session-${index}`,
      name: `Session ${index}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 20, 1_005 - index)).toISOString(),
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: false,
    }));
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({ sessions: stored, activeSessionId: "session-1004" });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const firstPage = await mgr.listSessionsPage({ limit: 40 });
    expect(firstPage.sessions).toHaveLength(40);
    expect(firstPage.sessions[0].id).toBe("session-0");
    expect(firstPage.sessions.at(-1)?.id).toBe("session-39");
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBe("session-39");
    expect(firstPage.selectedSession?.id).toBe("session-1004");

    const secondPage = await mgr.listSessionsPage({
      limit: 40,
      beforeSessionId: firstPage.nextCursor,
    });
    expect(secondPage.sessions).toHaveLength(40);
    expect(secondPage.sessions[0].id).toBe("session-40");
    expect(secondPage.sessions.at(-1)?.id).toBe("session-79");
    expect(secondPage.nextCursor).toBe("session-79");
    expect(secondPage.hasMore).toBe(true);
  });

  it("decorates only the related activity tree while retaining user-session descendants", async () => {
    const unrelated = Array.from({ length: 1_000 }, (_, index) => ({
      id: `unrelated-${index}`,
      name: `Unrelated ${index}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: false,
    }));
    const related = [
      {
        id: "activity-root",
        name: "Root",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:03:00.000Z",
        hasUnread: false,
        backendOrigin: "copilot" as const,
        isActive: false,
      },
      {
        id: "user-child",
        name: "User child",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:02:00.000Z",
        hasUnread: false,
        backendOrigin: "copilot" as const,
        isActive: false,
        source: "user" as const,
        parentSessionId: "activity-root",
      },
      {
        id: "agent-grandchild",
        name: "Agent grandchild",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:01:00.000Z",
        hasUnread: false,
        backendOrigin: "copilot" as const,
        isActive: false,
        source: "subagent" as const,
        parentSessionId: "user-child",
      },
    ];
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({ sessions: [...unrelated, ...related] });
      }
      return "{}";
    });

    const backend = await createTestBackend();
    const automationList = vi.spyOn(backend.automation, "listAutomations");
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", backend);

    const sessions = await mgr.listSessionActivityTree("activity-root");

    expect(sessions.map((session) => session.id)).toEqual([
      "activity-root",
      "user-child",
      "agent-grandchild",
    ]);
    expect(automationList).not.toHaveBeenCalled();
  });

  it("resolves automation-source session names via backend.automation.listAutomations join", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "user1", name: "Chat", backendOrigin: "copilot" },
            {
              id: "wf1",
              name: "Automation · abc12345",
              backendOrigin: "copilot" as const,
              source: "automation",
              automationId: "wf-abc",
            },
            { id: "user2", name: "Untouched chat", backendOrigin: "copilot" },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const fakeManager = {
      list: () => [
        {
          id: "wf-abc",
          name: "Morning briefing",
          steps: [],
          schedule: { naturalLanguage: "", days: [], hour: 0, minute: 0 },
        },
      ],
      create: () => ({ id: "x" }),
      update: () => null,
      toggle: () => true,
      delete: () => true,
      getHistory: () => [],
      getAllHistory: () => [],
      getCurrentRun: () => null,
      runNow: () => Promise.resolve(null),
      exportAutomation: () => null,
      importAutomations: () => [],
      getConditionStatus: () => ({ lastCheck: null, nextCheck: null, lastError: null }),
    };
    backend.setAutomationManager(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- structural fake; only `list()` exercised by listSessions
      fakeManager as unknown as Parameters<typeof backend.setAutomationManager>[0],
    );
    const mgr = new SessionManager("/test/workspace", backend);
    const sessions = await mgr.listSessions();

    expect(sessions.find((s) => s.id === "wf1")?.name).toBe("Morning briefing");
    expect(sessions.find((s) => s.id === "user2")?.name).toBe("Untouched chat");
  });

  it("listSessions falls back to stored names when listAutomations fails", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({
          sessions: [
            {
              id: "wf1",
              name: "Stored name",
              source: "automation",
              automationId: "wf-abc",
              backendOrigin: "copilot",
            },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    // No setAutomationManager → listAutomations throws → catch + fall back.
    const mgr = new SessionManager("/test/workspace", backend);
    const sessions = await mgr.listSessions();
    expect(sessions[0]?.name).toBe("Stored name");
  });

  it("listAllSessionIds returns every session including condition checks", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "user1", name: "Chat", backendOrigin: "copilot" },
            {
              id: "wf1",
              name: "Run automation",
              source: "automation",
              automationId: "wf-abc",
              backendOrigin: "copilot",
            },
            {
              id: "cc1",
              name: "Condition check: My automation",
              source: "automation",
              backendOrigin: "copilot",
            },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    expect(mgr.listAllSessionIds()).toEqual(["user1", "wf1", "cc1"]);
  });
});

describe("registered workspace resolution", () => {
  const registeredPath = nodePath.join(
    nodePath.parse(process.cwd()).root,
    "registered",
    "PowerQuery",
  );
  const powerQueryPath =
    process.platform === "win32" ? "Q:\\src\\PowerQuery\\Web" : "/src/PowerQuery/Web";

  function workspaceIdentity(inode: string): WorkspaceInstanceIdentity {
    return {
      version: 1,
      device: "1",
      inode,
      birthtimeNs: "3",
    };
  }

  function registeredWorkspace(
    name: string,
    workspacePath = registeredPath,
    identity = workspaceIdentity("2"),
  ): workspaceStore.ResolvedWorkspace {
    return {
      name,
      path: workspacePath,
      origin: "user-added",
      identity,
      external: true,
    };
  }

  function indexedSession(id: string, overrides: Partial<SessionMetadata> = {}): SessionMetadata {
    return {
      id,
      name: id,
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
      hasUnread: false,
      isActive: false,
      backendOrigin: "copilot",
      ...overrides,
    };
  }

  async function managerWithSessions(sessions: SessionMetadata[]) {
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    vi.spyOn(access.store, "loadIndex").mockReturnValue({
      sessions,
      activeSessionId: null,
    });
    return { manager, access };
  }

  it("resolves a registered workspace name to its normalized path and current label", async () => {
    const workspace = registeredWorkspace("PowerQuery");
    vi.spyOn(workspaceStore, "listRegisteredWorkspaces").mockReturnValue([workspace]);
    const { manager } = await managerWithSessions([
      indexedSession("by-name", { workspaceName: workspace.name }),
    ]);

    const [listed] = await manager.listSessions();

    expect(listed?.registeredWorkspaceKey).toBe(
      workspaceStore.normalizePathForCompare(workspace.path),
    );
    expect(listed?.registeredWorkspaceLabel).toBe(workspace.name);
  });

  it("decorates the legacy Scratchpad key with its product-facing name", async () => {
    const workspace = registeredWorkspace("Scratchpad");
    vi.spyOn(workspaceStore, "listRegisteredWorkspaces").mockReturnValue([workspace]);
    const { manager } = await managerWithSessions([
      indexedSession("default-workspace", { workspaceName: workspace.name }),
    ]);

    const [listed] = await manager.listSessions();

    expect(listed?.registeredWorkspaceLabel).toBe(workspaceStore.DEFAULT_WORKSPACE_DISPLAY_NAME);
  });

  it("keeps the path key stable when the registered workspace is renamed", async () => {
    const identity = workspaceIdentity("20");
    const registry = vi
      .spyOn(workspaceStore, "listRegisteredWorkspaces")
      .mockReturnValue([registeredWorkspace("PowerQuery", registeredPath, identity)]);
    const { manager } = await managerWithSessions([
      indexedSession("rename-stable", {
        workspaceName: "PowerQuery",
        workspaceIdentity: identity,
      }),
    ]);

    const [beforeRename] = await manager.listSessions();
    registry.mockReturnValue([
      registeredWorkspace(
        "PowerQuery",
        nodePath.join(nodePath.parse(process.cwd()).root, "registered", "Replacement"),
        workspaceIdentity("21"),
      ),
      registeredWorkspace("Data Prep", registeredPath, identity),
    ]);
    const [afterRename] = await manager.listSessions();

    expect(afterRename?.registeredWorkspaceKey).toBe(beforeRename?.registeredWorkspaceKey);
    expect(afterRename?.registeredWorkspaceKey).toBe(
      workspaceStore.normalizePathForCompare(registeredPath),
    );
    expect(afterRename?.registeredWorkspaceLabel).toBe("Data Prep");
  });

  it("uses repoPath when a renamed workspace's old name is no longer registered", async () => {
    const registry = vi
      .spyOn(workspaceStore, "listRegisteredWorkspaces")
      .mockReturnValue([registeredWorkspace("PowerQuery")]);
    const { manager } = await managerWithSessions([
      indexedSession("repo-path-rename", {
        workspaceName: "PowerQuery",
        repoPath: registeredPath,
      }),
    ]);
    const [beforeRename] = await manager.listSessions();
    registry.mockReturnValue([
      registeredWorkspace("Data Prep", registeredPath, workspaceIdentity("22")),
    ]);
    const [afterRename] = await manager.listSessions();

    expect(afterRename?.registeredWorkspaceKey).toBe(beforeRename?.registeredWorkspaceKey);
    expect(afterRename?.registeredWorkspaceKey).toBe(
      workspaceStore.normalizePathForCompare(registeredPath),
    );
    expect(afterRename?.registeredWorkspaceLabel).toBe("Data Prep");
  });

  it("prefers an exact registered workspace name over a different repoPath match", async () => {
    const repoMatchedPath = nodePath.join(
      nodePath.parse(process.cwd()).root,
      "registered",
      "DataPrep",
    );
    const namedWorkspace = registeredWorkspace("PowerQuery", registeredPath);
    const repoMatchedWorkspace = registeredWorkspace(
      "Data Prep",
      repoMatchedPath,
      workspaceIdentity("23"),
    );
    vi.spyOn(workspaceStore, "listRegisteredWorkspaces").mockReturnValue([
      namedWorkspace,
      repoMatchedWorkspace,
    ]);
    const { manager } = await managerWithSessions([
      indexedSession("name-before-repo-path", {
        workspaceName: namedWorkspace.name,
        repoPath: repoMatchedWorkspace.path,
      }),
    ]);

    const [listed] = await manager.listSessions();

    expect(listed?.registeredWorkspaceKey).toBe(
      workspaceStore.normalizePathForCompare(namedWorkspace.path),
    );
    expect(listed?.registeredWorkspaceLabel).toBe(namedWorkspace.name);
  });

  it("does not echo an unregistered binding", async () => {
    vi.spyOn(workspaceStore, "listRegisteredWorkspaces").mockReturnValue([
      registeredWorkspace("PowerQuery"),
    ]);
    const { manager } = await managerWithSessions([
      indexedSession("unregistered", { workspaceName: "Deleted Workspace" }),
    ]);

    const [listed] = await manager.listSessions();

    expect(listed?.registeredWorkspaceKey).toBeUndefined();
    expect(listed?.registeredWorkspaceLabel).toBeUndefined();
  });

  it("merges name and literal-path bindings into one registered workspace key", async () => {
    const workspace = registeredWorkspace("PowerQuery", powerQueryPath);
    vi.spyOn(workspaceStore, "listRegisteredWorkspaces").mockReturnValue([workspace]);
    const { manager } = await managerWithSessions([
      indexedSession("by-name", { workspaceName: workspace.name }),
      indexedSession("by-literal-path", { workspaceName: powerQueryPath }),
    ]);

    const listed = await manager.listSessions();
    const byName = listed.find((session) => session.id === "by-name");
    const byLiteralPath = listed.find((session) => session.id === "by-literal-path");

    expect(byName?.registeredWorkspaceKey).toBe(byLiteralPath?.registeredWorkspaceKey);
    expect(byName?.registeredWorkspaceKey).toBe(
      workspaceStore.normalizePathForCompare(powerQueryPath),
    );
    expect(byName?.registeredWorkspaceLabel).toBe("PowerQuery");
    expect(byLiteralPath?.registeredWorkspaceLabel).toBe("PowerQuery");
  });

  it("resolves a legacy absolute-path binding to a registered external workspace", async () => {
    const workspace = registeredWorkspace("PowerQuery");
    vi.spyOn(workspaceStore, "listRegisteredWorkspaces").mockReturnValue([workspace]);
    const { manager } = await managerWithSessions([
      indexedSession("legacy-path", { workspaceName: workspace.path }),
    ]);

    const [listed] = await manager.listSessions();

    expect(listed?.registeredWorkspaceKey).toBe(
      workspaceStore.normalizePathForCompare(workspace.path),
    );
    expect(listed?.registeredWorkspaceLabel).toBe(workspace.name);
  });

  it("resolves a worktree through its origin without matching the throwaway repoPath", async () => {
    const workspace = registeredWorkspace("PowerQuery");
    const worktreePath = nodePath.join(
      nodePath.parse(process.cwd()).root,
      "marshal-worktrees",
      "PowerQuery-deadbeef",
    );
    vi.spyOn(workspaceStore, "listRegisteredWorkspaces").mockReturnValue([
      registeredWorkspace("PowerQuery-deadbeef", worktreePath, workspaceIdentity("40")),
      workspace,
    ]);
    const { manager } = await managerWithSessions([
      indexedSession("worktree", {
        workspaceName: "PowerQuery-deadbeef",
        originWorkspaceName: workspace.name,
        repoPath: worktreePath,
      }),
    ]);

    const [listed] = await manager.listSessions();

    expect(listed?.isWorktreeWorkspace).toBe(true);
    expect(listed?.registeredWorkspaceKey).toBe(
      workspaceStore.normalizePathForCompare(workspace.path),
    );
    expect(listed?.registeredWorkspaceLabel).toBe(workspace.name);
  });

  it("resolves a sibling -worktrees directory to its registered origin path", async () => {
    const workspace = registeredWorkspace("PowerQuery", powerQueryPath);
    const worktreePath = nodePath.join(
      `${powerQueryPath}-worktrees`,
      "users-omerm-desktop-ltd-test-expansion",
    );
    vi.spyOn(workspaceStore, "listRegisteredWorkspaces").mockReturnValue([workspace]);
    const { manager } = await managerWithSessions([
      indexedSession("sibling-dash-worktrees", {
        workspaceName: "PowerQuery-deadbeef",
        repoPath: worktreePath,
      }),
    ]);

    const [listed] = await manager.listSessions();

    expect(listed?.isWorktreeWorkspace).toBe(true);
    expect(listed?.registeredWorkspaceKey).toBe(
      workspaceStore.normalizePathForCompare(powerQueryPath),
    );
    expect(listed?.registeredWorkspaceLabel).toBe("PowerQuery");
  });

  it("resolves a sibling .worktrees directory from a path-shaped workspace name", async () => {
    const workspace = registeredWorkspace("PowerQuery", powerQueryPath);
    const worktreePath = nodePath.join(
      `${powerQueryPath}.worktrees`,
      "copilot-cli-build-deploy-deadbeef",
    );
    vi.spyOn(workspaceStore, "listRegisteredWorkspaces").mockReturnValue([workspace]);
    const { manager } = await managerWithSessions([
      indexedSession("sibling-dot-worktrees", { workspaceName: worktreePath }),
    ]);

    const [listed] = await manager.listSessions();

    expect(listed?.isWorktreeWorkspace).toBe(true);
    expect(listed?.registeredWorkspaceKey).toBe(
      workspaceStore.normalizePathForCompare(powerQueryPath),
    );
    expect(listed?.registeredWorkspaceLabel).toBe("PowerQuery");
  });

  it("does not derive an origin from the managed m-worktrees root", async () => {
    const copilotRoot =
      process.platform === "win32" ? "C:\\Users\\omerm\\.marshal" : "/home/omerm/.marshal";
    const worktreePath = nodePath.join(copilotRoot, "m-worktrees", "PowerQuery-c31f4640");
    vi.spyOn(workspaceStore, "listRegisteredWorkspaces").mockReturnValue([
      registeredWorkspace("PowerQuery", powerQueryPath),
      registeredWorkspace("Unrelated M", nodePath.join(copilotRoot, "m"), workspaceIdentity("50")),
    ]);
    const { manager } = await managerWithSessions([
      indexedSession("managed-worktree-root", {
        workspaceName: "PowerQuery-c31f4640",
        repoPath: worktreePath,
      }),
    ]);

    const [listed] = await manager.listSessions();

    expect(listed?.isWorktreeWorkspace).toBe(true);
    expect(listed?.registeredWorkspaceKey).toBeUndefined();
    expect(listed?.registeredWorkspaceLabel).toBeUndefined();
  });

  it("leaves an unmatched sibling-derived origin unresolved", async () => {
    const unmatchedOrigin =
      process.platform === "win32" ? "Q:\\src\\Unregistered\\Repo" : "/src/Unregistered/Repo";
    const worktreePath = nodePath.join(`${unmatchedOrigin}-worktrees`, "agent-deadbeef");
    vi.spyOn(workspaceStore, "listRegisteredWorkspaces").mockReturnValue([
      registeredWorkspace("PowerQuery", powerQueryPath),
    ]);
    const { manager } = await managerWithSessions([
      indexedSession("unmatched-sibling-origin", {
        workspaceName: "Unregistered-deadbeef",
        repoPath: worktreePath,
      }),
    ]);

    const [listed] = await manager.listSessions();

    expect(listed?.isWorktreeWorkspace).toBe(true);
    expect(listed?.registeredWorkspaceKey).toBeUndefined();
    expect(listed?.registeredWorkspaceLabel).toBeUndefined();
  });

  it("leaves a session with no binding unresolved", async () => {
    vi.spyOn(workspaceStore, "listRegisteredWorkspaces").mockReturnValue([
      registeredWorkspace("PowerQuery"),
    ]);
    const { manager } = await managerWithSessions([indexedSession("general")]);

    const [listed] = await manager.listSessions();

    expect(listed?.registeredWorkspaceKey).toBeUndefined();
    expect(listed?.registeredWorkspaceLabel).toBeUndefined();
  });

  it("reads the registered workspace registry once for multiple sessions", async () => {
    const registry = vi.spyOn(workspaceStore, "listRegisteredWorkspaces").mockReturnValue([]);
    const { manager } = await managerWithSessions([
      indexedSession("one", { workspaceName: "One" }),
      indexedSession("two", { workspaceName: "Two" }),
    ]);

    await manager.listSessions();

    expect(registry).toHaveBeenCalledExactlyOnceWith("/test/workspace");
  });

  it("strips transient resolution fields from a list-to-write index round trip", async () => {
    const workspace = registeredWorkspace("PowerQuery");
    vi.spyOn(workspaceStore, "listRegisteredWorkspaces").mockReturnValue([workspace]);
    const seededRow: SessionMetadata = {
      ...indexedSession("round-trip", { workspaceName: workspace.name }),
      registeredWorkspaceKey: "stale-key",
      registeredWorkspaceLabel: "Stale label",
    };
    let indexOnDisk = JSON.stringify({
      sessions: [seededRow],
      activeSessionId: null,
    });
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) =>
      String(p).endsWith("sessions-index.json") ? indexOnDisk : "{}",
    );
    mockedFs.writeFileSync.mockImplementation((p: any, data: any) => {
      if (String(p).endsWith("sessions-index.json")) indexOnDisk = String(data);
    });
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);

    const [listed] = await manager.listSessions();
    await access.store.withIndexLock(() => undefined);
    const persistedIndex = parseWrittenJson(indexOnDisk);

    expect(listed?.registeredWorkspaceKey).toBe(
      workspaceStore.normalizePathForCompare(workspace.path),
    );
    expect(listed?.registeredWorkspaceLabel).toBe(workspace.name);
    expect(persistedIndex.sessions[0]).not.toHaveProperty("registeredWorkspaceKey");
    expect(persistedIndex.sessions[0]).not.toHaveProperty("registeredWorkspaceLabel");
  });
});

describe("SessionManager.getMcpConfig", () => {
  it("caches MCP config after first call", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue("{}");

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const access = new SessionTestAccess(mgr);
    const config1 = access.getMcpConfig();
    const config2 = access.getMcpConfig();

    expect(config1).toBe(config2); // same reference
    // File System Access is a capability now, not an MCP server.
    expect(config1).not.toHaveProperty("filesystem");
    expect(config1).toHaveProperty("playwright");
  });

  it("includes custom HTTP servers", async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    mgr.mcpStatus.setCustomMcpServers([{ name: "Fluent UI", url: "https://example.com/mcp" }]);
    const access = new SessionTestAccess(mgr);
    const config = access.getMcpConfig();

    expect(config).toHaveProperty("fluent_ui");
    expect(config.fluent_ui.url).toBe("https://example.com/mcp");
    expect(config.fluent_ui.type).toBe("http");
  });

  it("adds Authorization Bearer header when accessToken is present", async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    mgr.mcpStatus.setCustomMcpServers([
      { name: "My MCP", url: "https://example.com/mcp", accessToken: "tok_abc123" },
    ]);
    const access = new SessionTestAccess(mgr);
    const config = access.getMcpConfig();

    expect(config.my_mcp.headers).toEqual({ Authorization: "Bearer tok_abc123" });
  });

  it("omits Authorization header when accessToken is absent", async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    mgr.mcpStatus.setCustomMcpServers([{ name: "My MCP", url: "https://example.com/mcp" }]);
    const access = new SessionTestAccess(mgr);
    const config = access.getMcpConfig();

    expect(config.my_mcp.headers).toBeUndefined();
  });

  it("rebuilds config after setCustomMcpServers invalidates cache", async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const access = new SessionTestAccess(mgr);
    const config1 = access.getMcpConfig();
    expect(config1).not.toHaveProperty("my_mcp");

    mgr.mcpStatus.setCustomMcpServers([{ name: "My MCP", url: "https://example.com/mcp" }]);
    const config2 = access.getMcpConfig();
    expect(config2).toHaveProperty("my_mcp");
  });
});

describe("SessionManager.refreshExpiredTokens", () => {
  it("skips servers without tokenEndpoint or refreshToken", async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    mgr.mcpStatus.setCustomMcpServers([{ name: "Local", url: "http://localhost:3000" }]);
    const access = new SessionTestAccess(mgr);
    // Should not throw
    await expect(access.refreshExpiredTokens()).resolves.toBeUndefined();
  });

  it("skips tokens not near expiry", async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    mockFetch.mockReset();
    mgr.mcpStatus.setCustomMcpServers([
      {
        name: "My MCP",
        url: "https://example.com/mcp",
        tokenEndpoint: "https://auth.example.com/token",
        refreshToken: "refresh_abc",
        accessToken: "old_token",
        tokenExpiry: Date.now() + 10 * 60 * 1000, // expires in 10 min — not near
      },
    ]);

    const access = new SessionTestAccess(mgr);
    await access.refreshExpiredTokens();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refreshes token when within 60s of expiry and updates accessToken", async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "new_token", expires_in: 3600 }),
    } as Response);

    mgr.mcpStatus.setCustomMcpServers([
      {
        name: "My MCP",
        url: "https://example.com/mcp",
        tokenEndpoint: "https://auth.example.com/token",
        refreshToken: "refresh_abc",
        accessToken: "old_token",
        tokenExpiry: Date.now() + 30 * 1000, // expires in 30s — within threshold
      },
    ]);

    const access = new SessionTestAccess(mgr);
    await access.refreshExpiredTokens();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://auth.example.com/token",
      expect.objectContaining({ method: "POST" }),
    );
    const servers = access.customMcpServers;
    expect(servers[0].accessToken).toBe("new_token");
  });

  it("stamps accessTokenOrigin on the server after a successful token refresh", async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "new_token", expires_in: 3600 }),
    } as Response);

    mgr.mcpStatus.setCustomMcpServers([
      {
        name: "My MCP",
        url: "https://example.com/mcp",
        tokenEndpoint: "https://auth.example.com/token",
        refreshToken: "refresh_abc",
        accessToken: "old_token",
        tokenExpiry: Date.now() + 30 * 1000,
      },
    ]);

    const access = new SessionTestAccess(mgr);
    await access.refreshExpiredTokens();

    const servers = access.customMcpServers;
    expect(servers[0].accessToken).toBe("new_token");
    expect(servers[0].accessTokenOrigin).toBe("https://example.com");
  });

  it("clears accessToken when refresh fails", async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
    } as Response);

    mgr.mcpStatus.setCustomMcpServers([
      {
        name: "My MCP",
        url: "https://example.com/mcp",
        tokenEndpoint: "https://auth.example.com/token",
        refreshToken: "expired_refresh",
        accessToken: "old_token",
        tokenExpiry: Date.now() + 30 * 1000,
      },
    ]);

    const access = new SessionTestAccess(mgr);
    await access.refreshExpiredTokens();

    const servers = access.customMcpServers;
    expect(servers[0].accessToken).toBeUndefined();
  });
});

describe("isAuthError", () => {
  it("detects 401 errors", async () => {
    const { isAuthError } = await import("./sessions");
    expect(isAuthError(new Error("HTTP 401 Unauthorized"))).toBe(true);
    expect(isAuthError("Error: 401")).toBe(true);
  });

  it("detects 403 errors", async () => {
    const { isAuthError } = await import("./sessions");
    expect(isAuthError(new Error("403 Forbidden"))).toBe(true);
  });

  it("detects unauthorized/forbidden strings", async () => {
    const { isAuthError } = await import("./sessions");
    expect(isAuthError("not authorized to access")).toBe(true);
    expect(isAuthError("Copilot is not enabled for this user")).toBe(true);
  });

  it("returns false for non-auth errors", async () => {
    const { isAuthError } = await import("./sessions");
    expect(isAuthError(new Error("Network timeout"))).toBe(false);
    expect(isAuthError("ECONNREFUSED")).toBe(false);
    expect(isAuthError(new Error("Session not found"))).toBe(false);
  });
});

describe("SessionManager.searchSessions", () => {
  const makeIndex = (sessions: object[]) => JSON.stringify({ sessions, activeSessionId: null });

  const makeSession = (id: string, name: string, messages: object[]) =>
    JSON.stringify({ id, name, messages });

  it("returns empty array for empty query", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    expect(await mgr.searchSessions("")).toEqual([]);
    expect(await mgr.searchSessions("   ")).toEqual([]);
  });

  it("matches by session name (case-insensitive)", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      makeIndex([
        {
          id: "s1",
          name: "Python Debugging",
          createdAt: "",
          updatedAt: "",
          backendOrigin: "copilot",
        },
      ]),
    );
    vi.mocked(fs.promises.readFile).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- mock return type mismatch
      makeSession("s1", "Python Debugging", [
        { id: "m1", role: "user", content: "How do I debug?" },
      ]) as any,
    );

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const results = await mgr.searchSessions("python");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("s1");
    expect(results[0].name).toBe("Python Debugging");
  });

  it("matches by message content and returns a snippet", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      makeIndex([
        { id: "s1", name: "General Chat", createdAt: "", updatedAt: "", backendOrigin: "copilot" },
      ]),
    );
    vi.mocked(fs.promises.readFile).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- mock return type mismatch
      makeSession("s1", "General Chat", [
        { id: "m1", role: "user", content: "How do I fix a TypeError in JavaScript?" },
      ]) as any,
    );

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const results = await mgr.searchSessions("TypeError");
    expect(results).toHaveLength(1);
    expect(results[0].snippets.length).toBeGreaterThan(0);
    expect(results[0].snippets[0]).toContain("TypeError");
  });

  it("does not return sessions with no matching content", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      makeIndex([
        {
          id: "s1",
          name: "React Components",
          createdAt: "",
          updatedAt: "",
          backendOrigin: "copilot",
        },
      ]),
    );
    vi.mocked(fs.promises.readFile).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- mock return type mismatch
      makeSession("s1", "React Components", [
        { id: "m1", role: "user", content: "Tell me about hooks" },
      ]) as any,
    );

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    expect(await mgr.searchSessions("python")).toHaveLength(0);
  });

  it("ranks name matches above content-only matches", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      makeIndex([
        { id: "s1", name: "General Chat", createdAt: "", updatedAt: "", backendOrigin: "copilot" },
        { id: "s2", name: "Python Guide", createdAt: "", updatedAt: "", backendOrigin: "copilot" },
      ]),
    );
    vi.mocked(fs.promises.readFile).mockImplementation(async (p: any) => {
      if (String(p).includes("s1"))
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- mock return type mismatch
        return makeSession("s1", "General Chat", [
          { id: "m1", role: "user", content: "How do I use python?" },
        ]) as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- mock return type mismatch
      return makeSession("s2", "Python Guide", [
        { id: "m1", role: "user", content: "Welcome to the guide." },
      ]) as any;
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const results = await mgr.searchSessions("python");
    expect(results[0].id).toBe("s2"); // name match scores higher
  });

  it("skips corrupted session files without throwing", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      makeIndex([
        { id: "bad", name: "Corrupted", createdAt: "", updatedAt: "", backendOrigin: "copilot" },
      ]),
    );
    vi.mocked(fs.promises.readFile).mockRejectedValue(new SyntaxError("Unexpected token"));

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    await expect(mgr.searchSessions("anything")).resolves.toEqual([]);
  });

  it("skips sessions whose file contains valid JSON but fails StoredSessionSchema", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      makeIndex([
        {
          id: "s1",
          name: "Schema Failure",
          createdAt: "",
          updatedAt: "",
          backendOrigin: "copilot",
        },
      ]),
    );
    // Valid JSON with messages, but missing required `id` field — fails StoredSessionSchema.
    // Must include messages so the empty-messages guard doesn't mask the schema rejection.
    vi.mocked(fs.promises.readFile).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- mock return type mismatch
      JSON.stringify({
        name: "Schema Failure",
        messages: [{ id: "m1", role: "user", content: "schema test", timestamp: "" }],
      }) as any,
    );

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    await expect(mgr.searchSessions("schema")).resolves.toEqual([]);
  });

  it("respects maxResults limit", async () => {
    const sessions = Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`,
      name: `target session ${i}`,
      backendOrigin: "copilot" as const,
      createdAt: "",
      updatedAt: "",
    }));

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(makeIndex(sessions));
    vi.mocked(fs.promises.readFile).mockImplementation(async (p: any) => {
      const match = String(p).match(/s(\d+)\.json/);
      const id = match ? `s${match[1]}` : "s0";
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- mock return type mismatch
      return makeSession(id, "target session", [
        { id: "m1", role: "user", content: "target content" },
      ]) as any;
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    expect(await mgr.searchSessions("target", 5)).toHaveLength(5);
  });
});

describe("SessionManager.getMcpStatus", () => {
  it("always includes builtin capabilities", async () => {
    mockedFs.existsSync.mockReturnValue(false);

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const status = mgr.getMcpStatus();
    expect(status).toContain("Shell");
    expect(status).toContain("Search Web");
  });
});

describe("SessionManager.createSession – workspace scoping", () => {
  it("persists session data BEFORE creating SDK session so workspace metadata is readable", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) return JSON.stringify({ sessions: [] });
      return "{}";
    });
    vi.spyOn(workspaceStore, "resolveRegisteredWorkspace").mockReturnValue({
      name: "MyWorkspace",
      path: nodePath.resolve("/test/workspace/MyWorkspace"),
      origin: "user-created",
      identity: { version: 1, device: "1", inode: "2", birthtimeNs: "3" },
      external: false,
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    // Track call ordering — mock initClient + createSDKSession to avoid real SDK
    const calls: string[] = [];
    vi.spyOn(mgr, "initClient").mockImplementation(async () => {
      calls.push("initClient");
    });
    // Capture original before spyOn replaces it
    const store = new SessionTestAccess(mgr).store;
    const origSave = store.saveSessionData.bind(store);
    vi.spyOn(store, "saveSessionData").mockImplementation((s: any) => {
      calls.push("saveSessionData");
      return origSave(s);
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
    vi.spyOn(mgr as any, "createBackendSession").mockImplementation(async () => {
      calls.push("createBackendSession");
    });

    await mgr.createSession(undefined, undefined, {
      source: "workspace",
      workspaceName: "MyWorkspace",
    });

    expect(calls).toContain("saveSessionData");
    expect(calls).toContain("createBackendSession");
    expect(calls.indexOf("saveSessionData")).toBeLessThan(calls.indexOf("createBackendSession"));
  });

  it("workspace session data is available when createSDKSession reads it", async () => {
    // In-memory filesystem to verify save-then-read round-trip
    const diskStore = new Map<string, string>();
    mockedFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      return s.includes("index.json") || diskStore.has(s);
    });
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes("index.json")) return JSON.stringify({ sessions: [] });
      if (diskStore.has(s)) return diskStore.get(s)!;
      return "{}";
    });
    mockedFs.writeFileSync.mockImplementation((p: any, data: any) => {
      diskStore.set(String(p), String(data));
    });
    vi.spyOn(workspaceStore, "resolveRegisteredWorkspace").mockReturnValue({
      name: "Connects",
      path: nodePath.resolve("/test/workspace/Connects"),
      origin: "user-created",
      identity: { version: 1, device: "1", inode: "2", birthtimeNs: "3" },
      external: false,
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);

    const access = new SessionTestAccess(mgr);
    let dataReadDuringSDKInit: any = null;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
    vi.spyOn(mgr as any, "createBackendSession").mockImplementation(async (...args: any[]) => {
      // Simulate what createSDKSession does: read session data from disk
      dataReadDuringSDKInit = access.loadSessionData(args[0]);
    });

    await mgr.createSession(undefined, undefined, {
      source: "workspace",
      workspaceName: "Connects",
    });

    expect(dataReadDuringSDKInit).not.toBeNull();
    expect(dataReadDuringSDKInit.source).toBe("workspace");
    expect(dataReadDuringSDKInit.workspaceName).toBe("Connects");
    expect(dataReadDuringSDKInit.workspaceIdentity).toEqual({
      version: 1,
      device: "1",
      inode: "2",
      birthtimeNs: "3",
    });
  });
});

describe("SessionManager.createInteractiveSession", () => {
  it("returns the indexed empty chat before backend startup and queues an immediate send", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const persisted = new Map<string, PersistedSession>();
    const index = { sessions: [] as SessionMetadata[], activeSessionId: null as string | null };
    vi.spyOn(access.store, "loadIndex").mockReturnValue(index);
    vi.spyOn(access.store, "loadSessionData").mockImplementation(
      (sessionId) => persisted.get(sessionId) ?? null,
    );
    vi.spyOn(access.store, "saveSessionData").mockImplementation((session) => {
      persisted.set(session.id, session);
    });
    vi.spyOn(access.store, "withIndexLock").mockImplementation(async (fn) => fn(index));
    const backendReady = deferredPromise<void>();
    const backendSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const createBackendSession = vi.fn<(sessionId: string) => Promise<void>>(async (sessionId) => {
      await backendReady.promise;
      access.activeSessions.set(sessionId, {
        send: backendSend,
        on: vi.fn<() => void>(),
      });
      access.sessionHandles.set(sessionId, {
        sessionId,
        backendId: `backend-${sessionId}`,
      });
    });
    access.replaceCreateBackendSession(createBackendSession);

    const session = await mgr.createInteractiveSession(undefined, undefined, {
      source: "user",
    });

    expect(createBackendSession).toHaveBeenCalledWith(
      session.id,
      true,
      session.model,
      session.soul,
    );
    expect(access.pendingSessionCreations.has(session.id)).toBe(true);
    expect(index.activeSessionId).toBe(session.id);
    expect(index.sessions[0]?.id).toBe(session.id);

    const send = mgr.sendMessage(session.id, "hello");
    await Promise.resolve();
    expect(backendSend).not.toHaveBeenCalled();

    backendReady.resolve();
    await send;

    expect(backendSend).toHaveBeenCalledOnce();
    expect(access.pendingSessionCreations.has(session.id)).toBe(false);
  });

  it("replaces an in-flight backend start with the latest persisted model before first send", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    const persisted = new Map<string, PersistedSession>();
    const index = { sessions: [] as SessionMetadata[], activeSessionId: null as string | null };
    vi.spyOn(access.store, "loadIndex").mockReturnValue(index);
    vi.spyOn(access.store, "loadSessionData").mockImplementation(
      (sessionId) => persisted.get(sessionId) ?? null,
    );
    vi.spyOn(access.store, "saveSessionData").mockImplementation((session) => {
      persisted.set(session.id, session);
    });
    vi.spyOn(access.store, "withIndexLock").mockImplementation(async (fn) => fn(index));
    vi.spyOn(backend.sessions, "destroy").mockResolvedValue(undefined);
    const send = vi.spyOn(backend.sessions, "send").mockResolvedValue(undefined);
    const firstBackendReady = deferredPromise<void>();
    const startedModels: Array<string | undefined> = [];
    access.replaceCreateBackendSession(async (sessionId, _isNew, model) => {
      startedModels.push(model);
      if (startedModels.length === 1) await firstBackendReady.promise;
      access.sessionHandles.set(sessionId, {
        sessionId,
        backendId: `backend-${model ?? "default"}`,
      });
    });

    const session = await mgr.createInteractiveSession("old-model", undefined, {
      source: "user",
    });
    const initialPending = access.pendingSessionCreations.get(session.id);
    const modelChange = mgr.setSessionModel(session.id, "new-model");
    await vi.waitFor(() =>
      expect(access.pendingSessionCreations.get(session.id)).not.toBe(initialPending),
    );

    const firstSend = mgr.sendMessage(session.id, "hello");
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();

    firstBackendReady.resolve();
    await Promise.all([modelChange, firstSend]);

    expect(startedModels).toEqual(["old-model", "new-model"]);
    expect(persisted.get(session.id)?.model).toBe("new-model");
    expect(access.sessionHandles.get(session.id)).toEqual({
      sessionId: session.id,
      backendId: "backend-new-model",
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("keeps a send that started first behind a later model replacement", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    const persisted = new Map<string, PersistedSession>();
    const index = { sessions: [] as SessionMetadata[], activeSessionId: null as string | null };
    vi.spyOn(access.store, "loadIndex").mockReturnValue(index);
    vi.spyOn(access.store, "loadSessionData").mockImplementation(
      (sessionId) => persisted.get(sessionId) ?? null,
    );
    vi.spyOn(access.store, "saveSessionData").mockImplementation((session) => {
      persisted.set(session.id, session);
    });
    vi.spyOn(access.store, "withIndexLock").mockImplementation(async (fn) => fn(index));
    vi.spyOn(backend.sessions, "destroy").mockResolvedValue(undefined);
    const send = vi.spyOn(backend.sessions, "send").mockResolvedValue(undefined);
    const firstBackendReady = deferredPromise<void>();
    const startedModels: Array<string | undefined> = [];
    access.replaceCreateBackendSession(async (sessionId, _isNew, model) => {
      startedModels.push(model);
      if (startedModels.length === 1) await firstBackendReady.promise;
      access.sessionHandles.set(sessionId, {
        sessionId,
        backendId: `backend-${model ?? "default"}`,
      });
    });

    const session = await mgr.createInteractiveSession("old-model", undefined, {
      source: "user",
    });
    const initialPending = access.pendingSessionCreations.get(session.id);
    const sending = mgr.sendMessage(session.id, "hello");
    await Promise.resolve();
    const modelChange = mgr.setSessionModel(session.id, "new-model");
    await vi.waitFor(() =>
      expect(access.pendingSessionCreations.get(session.id)).not.toBe(initialPending),
    );

    firstBackendReady.resolve();
    await Promise.all([modelChange, sending]);

    expect(startedModels).toEqual(["old-model", "new-model"]);
    expect(send).toHaveBeenCalledOnce();
    expect(access.sessionHandles.get(session.id)).toEqual({
      sessionId: session.id,
      backendId: "backend-new-model",
    });
  });

  it("keeps a send that started first behind a later reasoning replacement", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    const persisted = new Map<string, PersistedSession>();
    const index = { sessions: [] as SessionMetadata[], activeSessionId: null as string | null };
    vi.spyOn(access.store, "loadIndex").mockReturnValue(index);
    vi.spyOn(access.store, "loadSessionData").mockImplementation(
      (sessionId) => persisted.get(sessionId) ?? null,
    );
    vi.spyOn(access.store, "saveSessionData").mockImplementation((session) => {
      persisted.set(session.id, session);
    });
    vi.spyOn(access.store, "withIndexLock").mockImplementation(async (fn) => fn(index));
    vi.spyOn(backend.sessions, "destroy").mockResolvedValue(undefined);
    const send = vi.spyOn(backend.sessions, "send").mockResolvedValue(undefined);
    const firstBackendReady = deferredPromise<void>();
    const startedEfforts: Array<string | undefined> = [];
    access.replaceCreateBackendSession(async (sessionId) => {
      startedEfforts.push(persisted.get(sessionId)?.reasoningEffort);
      if (startedEfforts.length === 1) await firstBackendReady.promise;
      access.sessionHandles.set(sessionId, {
        sessionId,
        backendId: `backend-${startedEfforts.at(-1) ?? "default"}`,
      });
    });

    const session = await mgr.createInteractiveSession("gpt-5.6", "default", {
      source: "user",
    });
    const initialPending = access.pendingSessionCreations.get(session.id);
    const sending = mgr.sendMessage(session.id, "hello");
    await Promise.resolve();
    const reasoningChange = mgr.setSessionReasoningEffort(session.id, "high");
    await vi.waitFor(() =>
      expect(access.pendingSessionCreations.get(session.id)).not.toBe(initialPending),
    );

    firstBackendReady.resolve();
    await Promise.all([reasoningChange, sending]);

    expect(startedEfforts).toEqual([undefined, "high"]);
    expect(send).toHaveBeenCalledOnce();
    expect(persisted.get(session.id)?.reasoningEffort).toBe("high");
  });

  it("serializes provider config refresh behind an in-flight backend start", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    const persisted = new Map<string, PersistedSession>();
    const index = { sessions: [] as SessionMetadata[], activeSessionId: null as string | null };
    vi.spyOn(access.store, "loadIndex").mockReturnValue(index);
    vi.spyOn(access.store, "loadSessionData").mockImplementation(
      (sessionId) => persisted.get(sessionId) ?? null,
    );
    vi.spyOn(access.store, "saveSessionData").mockImplementation((session) => {
      persisted.set(session.id, session);
    });
    vi.spyOn(access.store, "withIndexLock").mockImplementation(async (fn) => fn(index));
    vi.spyOn(backend.sessions, "disconnect").mockResolvedValue(undefined);
    const firstBackendReady = deferredPromise<void>();
    let starts = 0;
    access.replaceCreateBackendSession(async (sessionId) => {
      starts += 1;
      if (starts === 1) await firstBackendReady.promise;
      access.sessionHandles.set(sessionId, {
        sessionId,
        backendId: `backend-${starts}`,
      });
    });

    const session = await mgr.createInteractiveSession(undefined, undefined, {
      source: "user",
    });
    const initialPending = access.pendingSessionCreations.get(session.id);
    const refresh = mgr.refreshSession(session.id);
    await vi.waitFor(() =>
      expect(access.pendingSessionCreations.get(session.id)).not.toBe(initialPending),
    );

    firstBackendReady.resolve();
    await refresh;

    expect(starts).toBe(2);
    expect(access.sessionHandles.get(session.id)).toEqual({
      sessionId: session.id,
      backendId: "backend-2",
    });
  });
});

describe("SessionManager.createSubagentSession asynchronous launch", () => {
  async function harness() {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const sendGate = deferredPromise<void>();
    const send = vi.fn<() => Promise<void>>(() => sendGate.promise);
    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    access.replaceCreateBackendSession(async (sessionId) => {
      access.activeSessions.set(sessionId, { send, on: vi.fn<() => void>() });
      access.sessionHandles.set(sessionId, { sessionId, backendId: `sdk-${sessionId}` });
    });
    return { mgr, access, send, sendGate };
  }

  it("returns and indexes the child before backend creation resolves, then launches once", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const persisted = new Map<string, PersistedSession>();
    const index = { sessions: [] as SessionMetadata[], activeSessionId: null as string | null };
    vi.spyOn(access.store, "loadIndex").mockReturnValue(index);
    vi.spyOn(access.store, "loadSessionData").mockImplementation(
      (sessionId) => persisted.get(sessionId) ?? null,
    );
    vi.spyOn(access.store, "saveSessionData").mockImplementation((session) => {
      persisted.set(session.id, session);
    });
    vi.spyOn(access.store, "withIndexLock").mockImplementation(async (fn) => fn(index));
    const backendReady = deferredPromise<void>();
    const send = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    let backendCreationResolved = false;
    const createBackendSession = vi.fn<(sessionId: string) => Promise<void>>(async (sessionId) => {
      await backendReady.promise;
      backendCreationResolved = true;
      access.activeSessions.set(sessionId, { send, on: vi.fn<() => void>() });
      access.sessionHandles.set(sessionId, {
        sessionId,
        backendId: `sdk-${sessionId}`,
      });
    });
    access.replaceCreateBackendSession(createBackendSession);
    let creationSettled = false;

    const creating = mgr
      .createSubagentSession({
        task: "Inspect the nested backend creation path",
        parentSessionId: "parent-1",
      })
      .then((result) => {
        creationSettled = true;
        return result;
      });

    await vi.waitFor(() => expect(creationSettled).toBe(true));
    const result = await creating;
    expect(backendCreationResolved).toBe(false);
    expect(index.sessions[0]?.id).toBe(result.session.id);
    expect(access.pendingSessionCreations.has(result.session.id)).toBe(true);
    expect(send).not.toHaveBeenCalled();

    backendReady.resolve();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());

    expect(createBackendSession).toHaveBeenCalledOnce();
    expect(backendCreationResolved).toBe(true);
    expect(access.pendingSessionCreations.has(result.session.id)).toBe(false);
  });

  it("returns before the initial child send settles", async () => {
    const { mgr, access, send, sendGate } = await harness();

    const result = await mgr.createSubagentSession({
      task: "Inspect the launch path",
      parentSessionId: "parent-1",
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(access.pendingSendDrains.has(result.session.id)).toBe(true);

    sendGate.resolve(undefined);
    await vi.waitFor(() => expect(access.pendingSendDrains.has(result.session.id)).toBe(false));
  });

  it("returns runtime-managed launches after backend acceptance without awaiting the turn", async () => {
    const { mgr, send } = await harness();
    const accepted = deferredPromise<void>();
    const sendToSubagent = vi.spyOn(mgr, "sendMessageToSubagent").mockResolvedValue({
      success: true,
      accepted: true,
      messageId: "launch-message",
    });
    vi.spyOn(mgr, "waitForAgentMessageBackendAccepted").mockImplementation(() => accepted.promise);
    let creationSettled = false;

    const creating = mgr
      .createSubagentSession({
        task: "Execute a runtime-managed assignment",
        parentSessionId: "parent-1",
        suppressInitialTodoInstruction: true,
        returnAfterBackendAcceptance: true,
      })
      .then((result) => {
        creationSettled = true;
        return result;
      });

    await vi.waitFor(() => expect(sendToSubagent).toHaveBeenCalledOnce());
    expect(creationSettled).toBe(false);
    expect(send).not.toHaveBeenCalled();

    accepted.resolve();
    await creating;
    expect(creationSettled).toBe(true);
  });

  it("clears launch-pending and deletes the child when the deferred send rejects", async () => {
    const { mgr, access, sendGate } = await harness();
    const deleteSession = vi.spyOn(mgr, "deleteSession");

    const result = await mgr.createSubagentSession({
      task: "Inspect the failing launch",
      parentSessionId: "parent-1",
    });

    sendGate.reject(new Error("launch dispatch failed"));

    await vi.waitFor(() =>
      expect(deleteSession).toHaveBeenCalledWith(result.session.id, {
        suppressChangeEvent: true,
        cause: "condition-check",
      }),
    );
    await deleteSession.mock.results[0]?.value;
    expect(access.subagentLaunchPending.has(result.session.id)).toBe(false);
    expect(access.sessionHandles.has(result.session.id)).toBe(false);
  });

  it("starts a pursued child goal only after the initial send resolves", async () => {
    const { mgr, sendGate } = await harness();
    const start = vi.fn<() => void>();
    mgr.setGoalIntegration(
      testDouble<Parameters<typeof mgr.setGoalIntegration>[0]>({
        createGoal: () =>
          testDouble<GoalState>({
            id: "child-goal",
            objective: "Complete the child goal",
            status: "pursuing",
          }),
      }),
      testDouble<Parameters<typeof mgr.setGoalIntegration>[1]>({
        start,
        isRunning: () => false,
      }),
    );

    const result = await mgr.createSubagentSession({
      task: "Complete the child goal",
      pursueAsGoal: true,
    });

    expect(start).not.toHaveBeenCalled();

    sendGate.resolve(undefined);
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith(result.session.id));
  });
});

describe("SessionManager.selectRepositoryAgent – HOTFIX2 built-in agent types", () => {
  it("accepts built-in agentName 'general-purpose' with NO workspace (does not throw)", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);

    const result = access.selectRepositoryAgent(undefined, "general-purpose");
    expect(result.selectedAgent).toBeUndefined();
    expect(result.availableAgents).toEqual([]);
  });

  it("accepts every documented built-in agent type with no workspace", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const builtIns = [
      "general-purpose",
      "explore",
      "task",
      "rubber-duck",
      "code-review",
      "configure-copilot",
      "research",
    ];
    for (const name of builtIns) {
      expect(() => access.selectRepositoryAgent(undefined, name)).not.toThrow();
    }
  });

  it("still resolves a repo-scoped agent when workspace + matching repo-local agent are supplied", async () => {
    const { loadGitHubRepositoryAgents } =
      await import("./backend/local/repository-customizations");
    vi.mocked(loadGitHubRepositoryAgents).mockReturnValueOnce([
      {
        name: "oncall-investigator",
        path: ".github/agents/oncall-investigator.agent.md",
        description: "Investigate oncall pages",
        instructions: "",
        identity: {
          version: 1,
          normalizedPath: ".github/agents/oncall-investigator.agent.md",
          declaredName: "oncall-investigator",
          contentDigest: "oncall-investigator-v1",
        },
      },
    ]);

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const result = access.selectRepositoryAgent("/repo/x", "oncall-investigator");
    expect(result.selectedAgent?.name).toBe("oncall-investigator");
  });

  it("uses repoPath to resolve repo-local agents for non-worktree subagents", async () => {
    const { loadGitHubRepositoryAgents } =
      await import("./backend/local/repository-customizations");
    vi.mocked(loadGitHubRepositoryAgents).mockReturnValueOnce([
      {
        name: "DP Engineer",
        path: ".github/agents/dp-engineer.agent.md",
        description: "Build data platform changes",
        instructions: "",
        identity: {
          version: 1,
          normalizedPath: ".github/agents/dp-engineer.agent.md",
          declaredName: "DP Engineer",
          contentDigest: "dp-engineer-v1",
        },
      },
    ]);

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    const send = vi.fn<() => Promise<string>>().mockResolvedValue("accepted");
    access.replaceCreateBackendSession(async (sessionId) => {
      access.activeSessions.set(sessionId, { send, on: vi.fn<() => void>() });
      access.sessionHandles.set(sessionId, { sessionId, backendId: `sdk-${sessionId}` });
    });
    const repoPath = nodePath.resolve("/repo/incident-tools");
    mockedFs.realpathSync.mockImplementation((value) => String(value));
    mockedFs.statSync.mockReturnValue(workspaceDirectoryStat());

    const result = await mgr.createSubagentSession({
      task: "Investigate incident",
      agentName: "DP Engineer",
      repoPath,
      parentSessionId: "parent-1",
    });

    expect(loadGitHubRepositoryAgents).toHaveBeenCalledWith(repoPath);
    expect(result.repositoryAgent?.name).toBe("DP Engineer");
    expect(result.session.workspaceName).toBeUndefined();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(access.sessionHandles.has(result.session.id)).toBe(true);
  });

  it("keeps createWorktree subagents out of the user workspace registry", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    const send = vi.fn<() => Promise<string>>().mockResolvedValue("accepted");
    access.replaceCreateBackendSession(async (sessionId) => {
      access.activeSessions.set(sessionId, { send, on: vi.fn<() => void>() });
      access.sessionHandles.set(sessionId, { sessionId, backendId: `sdk-${sessionId}` });
    });
    const repoPath = nodePath.resolve("C:\\src\\marshal");
    const worktreeRoot = nodePath.resolve("C:\\internal\\marshal-worktrees");
    mockedFs.realpathSync.mockImplementation((value) => String(value));
    mockedFs.statSync.mockReturnValue(workspaceDirectoryStat());
    access.replaceGetWorktreeRoot(() => worktreeRoot);
    access.replaceGit(async (_cwd, args) => (args[0] === "rev-parse" ? repoPath : ""));
    const addWorkspaceEntry = vi.spyOn(workspaceStore, "addWorkspaceEntry");
    vi.spyOn(workspaceStore, "getWorkspaceRegistry").mockReturnValue({
      Scratchpad: { origin: "scratchpad" },
    });
    vi.spyOn(workspaceStore, "listRegisteredWorkspaces").mockReturnValue([
      {
        name: "Scratchpad",
        path: nodePath.resolve("/test/workspace/Scratchpad"),
        origin: "scratchpad",
        identity: { version: 1, device: "1", inode: "1", birthtimeNs: "1" },
        external: false,
      },
    ]);

    const result = await mgr.createSubagentSession({
      task: "Implement the registry repair",
      workspaceName: "Scratchpad",
      repoPath,
      createWorktree: true,
      parentSessionId: "parent-1",
    });

    expect(result.worktree?.path.startsWith(`${worktreeRoot}${nodePath.sep}`)).toBe(true);
    expect(result.session.workspaceName).toBeUndefined();
    expect(result.session.originWorkspaceName).toBe("Scratchpad");
    expect(result.session.repoPath).toBe(result.worktree?.path);
    expect(addWorkspaceEntry).not.toHaveBeenCalled();
    expect(mgr.listWorkspacesForSelfTools()).toEqual([
      { name: "Scratchpad", path: nodePath.resolve("/test/workspace/Scratchpad") },
    ]);
  });

  it("discards the fresh worktree and its zero-commit branch when the launch dispatch fails", async () => {
    const harness = await createFailedLaunchHarness();

    await expect(harness.launch()).rejects.toThrow("createSession timed out after 45000ms");

    expect(harness.gitCall("worktree", "remove")).toEqual([
      "worktree",
      "remove",
      harness.worktreePath,
    ]);
    expect(harness.gitCall("branch", "-D")).toEqual(["branch", "-D", harness.branchName()]);
  });

  it("leaves a failed-launch worktree in place when it has tracked or untracked changes", async () => {
    const harness = await createFailedLaunchHarness({ status: " M src/index.ts" });

    await expect(harness.launch()).rejects.toThrow("createSession timed out after 45000ms");

    expect(harness.gitCall("worktree", "remove")).toBeUndefined();
    expect(harness.gitCall("branch", "-D")).toBeUndefined();
  });

  it("leaves a failed-launch worktree in place when its HEAD moved", async () => {
    const harness = await createFailedLaunchHarness({ headAfterCreate: "b".repeat(40) });

    await expect(harness.launch()).rejects.toThrow("createSession timed out after 45000ms");

    expect(harness.gitCall("worktree", "remove")).toBeUndefined();
    expect(harness.gitCall("branch", "-D")).toBeUndefined();
  });

  it("leaves a failed-launch worktree in place when it no longer owns the branch this call created", async () => {
    const harness = await createFailedLaunchHarness({
      checkedOutRef: "refs/heads/marshal/subagent/someone-else",
    });

    await expect(harness.launch()).rejects.toThrow("createSession timed out after 45000ms");

    expect(harness.gitCall("worktree", "remove")).toBeUndefined();
  });

  it("never removes a worktree outside the Marshal worktree roots", async () => {
    const harness = await createFailedLaunchHarness({
      // A root that carries no `marshal-worktrees` path segment, re-pointed
      // before the discard — the shape of a user's own checkout.
      worktreeRootAtCreate: nodePath.resolve("C:\\internal\\wt-store"),
      worktreeRootAtDiscard: nodePath.resolve("C:\\users\\me\\checkouts"),
    });

    await expect(harness.launch()).rejects.toThrow("createSession timed out after 45000ms");

    expect(harness.gitCall("worktree", "remove")).toBeUndefined();
    expect(harness.gitCall("worktree", "list")).toBeUndefined();
  });

  it("keeps the branch when it advanced past the commit the worktree was created at", async () => {
    const harness = await createFailedLaunchHarness({ branchHeadAtDiscard: "c".repeat(40) });

    await expect(harness.launch()).rejects.toThrow("createSession timed out after 45000ms");

    expect(harness.gitCall("worktree", "remove")).toEqual([
      "worktree",
      "remove",
      harness.worktreePath,
    ]);
    expect(harness.gitCall("branch", "-D")).toBeUndefined();
  });

  it("throws the unchanged error for non-built-in agentName without workspace", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    expect(() => access.selectRepositoryAgent(undefined, "nonexistent-thing")).toThrow(
      /agentName requires a workspaceName, repoPath, or worktree/,
    );
  });

  it("applies the subagent tier default model for plain subagents", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    let backendModel: string | undefined = "unexpected";
    access.replaceCreateBackendSession(async (_sessionId, _isNew, model) => {
      backendModel = model;
    });

    const session = await mgr.createSession(undefined, undefined, {
      source: "subagent",
      setActive: false,
    });

    // Reverses the earlier no-fallback hotfix: plain subagents now inherit the
    // subagent tier default (falls back to the chat default = DEFAULT_MODEL)
    // so they no longer run at the SDK's low-effort default.
    expect(session.model).toBe(DEFAULT_MODEL);
    expect(backendModel).toBe(DEFAULT_MODEL);
  });

  it.each([
    {
      memory: "a memory block",
      memoryPrompt:
        "\n\n## Memory\n\n<untrusted_memory>\n- [preference|2026-09-24|src:session] Never restart Marshal\n</untrusted_memory>",
      throws: false,
    },
    { memory: "a failing memory provider", memoryPrompt: "", throws: true },
  ])(
    "appends the delegation guidance (SDK default model) for a plain subagent SDK session with $memory",
    async ({ memoryPrompt, throws }) => {
      const sdkSession = {
        sessionId: "sdk-plain-subagent",
        on: vi.fn<() => void>(),
        rpc: { mcp: { list: vi.fn<() => Promise<unknown>>().mockResolvedValue({}) } },
      };
      const createSession = vi.fn<
        (cfg: { systemMessage?: unknown; model?: string }) => Promise<unknown>
      >(async () => sdkSession);
      const { SessionManager } = await import("./sessions");
      const { LocalBackend } = await import("./backend/local/provider");
      // The mocked fs cannot resolve the scratchpad workspace; MCP config is not under test here.
      const prepareMcpConfig = vi
        .spyOn(LocalBackend.prototype, "prepareMcpConfig")
        .mockResolvedValue({});
      onTestFinished(() => prepareMcpConfig.mockRestore());
      const mgr = new SessionManager("/test/workspace", await createTestBackend());
      const access = new SessionTestAccess(mgr);
      access.client = { createSession };
      const formatForSystemPrompt = vi.fn<(request?: { workspacePath?: string }) => string>(() => {
        if (throws) throw new Error("memory provider offline");
        return memoryPrompt;
      });
      access.selfToolDeps = {
        memoryManager: { formatForSystemPrompt },
        settingsManager: { get: () => ({}) },
      };
      vi.spyOn(access.store, "loadSessionData").mockReturnValue({
        id: "subagent-1",
        name: "Plain subagent",
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: false,
        source: "subagent",
        runtimeId: "copilot",
        backendOrigin: "copilot",
        messages: [],
      });
      vi.spyOn(access.store, "saveSessionData").mockImplementation(() => undefined);
      vi.spyOn(access.store, "withIndexLock").mockImplementation(async (fn) =>
        fn({ sessions: [], activeSessionId: null }),
      );
      access.replaceRefreshExpiredTokens(async () => undefined);

      await access.createBackendSession("subagent-1", true, undefined, undefined);

      const config = createSession.mock.calls[0]?.[0];
      expect(config).toBeDefined();
      // Plain subagents now run on the subagent tier default model (falls back to
      // DEFAULT_MODEL) while still getting only the task-vs-spawn guidance
      // appended to the SDK's own coder persona — not the full Marshal system prompt.
      expect(config?.model).toBe(DEFAULT_MODEL);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test reads the wrapped append-mode systemMessage shape
      const systemMessage = config?.systemMessage as { content?: string } | undefined;
      expect(systemMessage?.content).toBe(`${SUBAGENT_DELEGATION_GUIDANCE}${memoryPrompt}`);
      expect(formatForSystemPrompt).toHaveBeenCalledTimes(1);
      // Guard against the full Marshal prompt leaking into the SDK-default runtime.
      expect(systemMessage?.content).not.toContain("Privacy & Outbound Communications");
    },
  );

  it("uses the full Marshal runtime when opening an MCP-scoped subagent SDK session", async () => {
    const sdkSession = {
      sessionId: "sdk-mcp-subagent",
      on: vi.fn<() => void>(),
      rpc: { mcp: { list: vi.fn<() => Promise<unknown>>().mockResolvedValue({}) } },
    };
    const createSession = vi.fn<
      (cfg: {
        systemMessage?: unknown;
        model?: string;
        mcpServers?: Record<string, unknown>;
      }) => Promise<unknown>
    >(async () => sdkSession);
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    mgr.mcpStatus.setCustomMcpServers([{ name: "incident-query", url: "https://example.com/mcp" }]);
    const access = new SessionTestAccess(mgr);
    access.client = { createSession };
    vi.spyOn(access.store, "loadSessionData").mockReturnValue({
      id: "subagent-1",
      name: "MCP subagent",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: false,
      source: "subagent",
      scopedMcp: ["incident-query"],
      messages: [],
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => undefined);
    vi.spyOn(access.store, "withIndexLock").mockImplementation(async (fn) =>
      fn({ sessions: [], activeSessionId: null }),
    );
    access.replaceRefreshExpiredTokens(async () => undefined);

    await access.createBackendSession("subagent-1", true, undefined, undefined);

    const config = createSession.mock.calls[0]?.[0];
    expect(config).toBeDefined();
    expect(config).toHaveProperty("systemMessage");
    expect(config?.model).toBe(mgr.getDefaultModel());
    expect(config?.mcpServers).toHaveProperty("incident-query");
  });

  it("uses the full Marshal runtime for workflow-owned subagents so MCP servers are available", async () => {
    const sdkSession = {
      sessionId: "workflow-child",
      on: vi.fn<() => void>(),
      rpc: { mcp: { list: vi.fn<() => Promise<unknown>>().mockResolvedValue({}) } },
    };
    const createSession = vi.fn<
      (cfg: {
        systemMessage?: unknown;
        model?: string;
        mcpServers?: Record<string, unknown>;
      }) => Promise<unknown>
    >(async () => sdkSession);
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    mgr.mcpStatus.setCustomMcpServers([
      { name: "incident-dataflows", url: "https://example.com/mcp" },
    ]);
    const access = new SessionTestAccess(mgr);
    access.client = { createSession };
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId: string) => {
      if (sessionId === "workflow-host") {
        return {
          id: "workflow-host",
          name: "Workflow host",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          backendOrigin: "copilot" as const,
          isActive: false,
          source: "workflow-run",
          messages: [],
        };
      }
      return {
        id: "workflow-child",
        name: "Workflow child",
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        backendOrigin: "copilot" as const,
        isActive: false,
        source: "subagent",
        parentSessionId: "workflow-host",
        messages: [],
      };
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => undefined);
    vi.spyOn(access.store, "withIndexLock").mockImplementation(async (fn) =>
      fn({ sessions: [], activeSessionId: null }),
    );
    access.replaceRefreshExpiredTokens(async () => undefined);

    await access.createBackendSession("workflow-child", true, undefined, undefined);

    const config = createSession.mock.calls[0]?.[0];
    expect(config).toBeDefined();
    expect(config).toHaveProperty("systemMessage");
    expect(config?.model).toBe(mgr.getDefaultModel());
    expect(config?.mcpServers).toHaveProperty("incident-dataflows");
  });
});

describe("SessionManager.createSession – playwrightHeadless persistence", () => {
  function setupInMemoryDisk() {
    const diskStore = new Map<string, string>();
    mockedFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      return s.includes("index.json") || diskStore.has(s);
    });
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes("index.json")) return JSON.stringify({ sessions: [] });
      if (diskStore.has(s)) return diskStore.get(s)!;
      return "{}";
    });
    mockedFs.writeFileSync.mockImplementation((p: any, data: any) => {
      diskStore.set(String(p), String(data));
    });
  }

  it("createSession persists playwrightHeadless when provided", async () => {
    setupInMemoryDisk();

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
    vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined);

    const meta = await mgr.createSession(undefined, undefined, {
      name: "auto",
      source: "automation",
      automationId: "a1",
      playwrightHeadless: true,
    });

    const stored = new SessionTestAccess(mgr).loadSessionData(meta.id);
    expect(stored).not.toBeNull();
    expect(stored?.playwrightHeadless).toBe(true);
  });

  it("createSession defaults playwrightHeadless to undefined", async () => {
    setupInMemoryDisk();

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
    vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined);

    const meta = await mgr.createSession();
    const stored = new SessionTestAccess(mgr).loadSessionData(meta.id);
    expect(stored).not.toBeNull();
    expect(stored?.playwrightHeadless).toBeUndefined();
  });

  it("createSession coerces a disallowed soul to 'default' on disk", async () => {
    setupInMemoryDisk();

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
    vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined);

    // Retired legacy personality ids coerce to the default soul at create time.
    const meta = await mgr.createSession(undefined, "not-a-soul");
    const stored = new SessionTestAccess(mgr).loadSessionData(meta.id);
    expect(stored?.soul).toBe("default");
  });
});

describe("SessionManager runtime accounts", () => {
  async function managerWithAccounts(runtimeAccounts: MSettings["runtimeAccounts"]) {
    const diskStore = new Map<string, string>();
    mockedFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      return s.includes("index.json") || diskStore.has(s);
    });
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes("index.json")) return JSON.stringify({ sessions: [] });
      return diskStore.get(s) ?? "{}";
    });
    mockedFs.writeFileSync.mockImplementation((p: any, data: any) => {
      diskStore.set(String(p), String(data));
    });
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
    vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined);
    const access = new SessionTestAccess(mgr);
    access.selfToolDeps = { settingsManager: { get: () => ({ runtimeAccounts }) } };
    return { mgr, access };
  }

  it("creates a session on a configured account", async () => {
    const { mgr, access } = await managerWithAccounts({ claude: { accounts: [{ id: "work" }] } });

    const meta = await mgr.createSession("claude@work:opus");

    expect(access.loadSessionData(meta.id)?.model).toBe("claude@work:opus");
  });

  it("rejects a model naming an account that is not configured", async () => {
    const { mgr } = await managerWithAccounts(undefined);

    await expect(mgr.createSession("claude@work:opus")).rejects.toThrow(
      'names the claude account "work", which is not configured',
    );
    expect(mgr.isModelAvailable("claude@work:opus")).toBe(false);
  });
});

// Per-session skills/MCP scoping (R1-FIXES A13). The fields are accepted
// by `createSession`'s options block (forwarded by `prepareSubagentSession`
// when the workflow engine spawns with explicit `skills` / `mcp`) and must
// round-trip onto the persisted session record so the self-tools layer
// (`listSkills` / `getSkill`) and `PermissionPolicy.evaluatePreHook`
// can apply the scope on subsequent tool calls.
describe("SessionManager.createSession – scopedSkills / scopedMcp persistence", () => {
  function setupInMemoryDisk() {
    const diskStore = new Map<string, string>();
    mockedFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      return s.includes("index.json") || diskStore.has(s);
    });
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes("index.json")) return JSON.stringify({ sessions: [] });
      if (diskStore.has(s)) return diskStore.get(s)!;
      return "{}";
    });
    mockedFs.writeFileSync.mockImplementation((p: any, data: any) => {
      diskStore.set(String(p), String(data));
    });
  }

  it("persists scopedSkills and scopedMcp when provided", async () => {
    setupInMemoryDisk();

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
    vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined);

    const meta = await mgr.createSession(undefined, undefined, {
      name: "scoped-subagent",
      source: "subagent",
      skills: ["pqo-research"],
      mcp: ["query-mcp"],
    });

    const stored = new SessionTestAccess(mgr).loadSessionData(meta.id);
    expect(stored?.scopedSkills).toEqual(["pqo-research"]);
    expect(stored?.scopedMcp).toEqual(["query-mcp"]);
    expect(mgr.getSessionSkillsScope(meta.id)).toEqual(["pqo-research"]);
  });

  it("preserves the empty-array scope (means 'no skills' / 'no MCPs')", async () => {
    setupInMemoryDisk();

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
    vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined);

    const meta = await mgr.createSession(undefined, undefined, {
      name: "no-tools-subagent",
      source: "subagent",
      skills: [],
      mcp: [],
    });

    const stored = new SessionTestAccess(mgr).loadSessionData(meta.id);
    // Empty array MUST round-trip — `undefined` means "inherit global",
    // `[]` means "deny everything", and they are not equivalent.
    expect(stored?.scopedSkills).toEqual([]);
    expect(stored?.scopedMcp).toEqual([]);
  });

  it("persists allowedTools, including the empty tool-free list", async () => {
    setupInMemoryDisk();

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
    vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined);

    const restricted = await mgr.createSession(undefined, undefined, {
      source: "subagent",
      allowedTools: ["runtimeInvoke", "runtimeSearch"],
    });
    const toolFree = await mgr.createSession(undefined, undefined, {
      source: "subagent",
      allowedTools: [],
    });
    const unrestricted = await mgr.createSession();

    const access = new SessionTestAccess(mgr);
    expect(access.loadSessionData(restricted.id)?.allowedTools).toEqual([
      "runtimeInvoke",
      "runtimeSearch",
    ]);
    expect(access.loadSessionData(toolFree.id)?.allowedTools).toEqual([]);
    expect(access.loadSessionData(unrestricted.id)?.allowedTools).toBeUndefined();
  });

  it("leaves scopedSkills and scopedMcp undefined when not provided", async () => {
    setupInMemoryDisk();

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
    vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined);

    const meta = await mgr.createSession();
    const stored = new SessionTestAccess(mgr).loadSessionData(meta.id);
    expect(stored?.scopedSkills).toBeUndefined();
    expect(stored?.scopedMcp).toBeUndefined();
    expect(mgr.getSessionSkillsScope(meta.id)).toBeUndefined();
  });

  it("preserves reasoning effort and runtime agent role in the session index", async () => {
    setupInMemoryDisk();

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const index = { sessions: [] as SessionMetadata[], activeSessionId: null as string | null };
    vi.spyOn(access.store, "loadIndex").mockImplementation(() => index);
    vi.spyOn(access.store, "withIndexLock").mockImplementation(async (update) => update(index));
    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
    vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined);

    const meta = await mgr.createSession("gpt-5.4", undefined, {
      source: "subagent",
      parentSessionId: "parent-session",
      reasoningEffort: "high",
      runtimeAgentRole: "brain",
      setActive: false,
    });

    expect(meta).toMatchObject({
      reasoningEffort: "high",
      runtimeAgentRole: "brain",
    });
    const indexed = index.sessions.find((session) => session.id === meta.id);
    expect(indexed).toMatchObject({
      id: meta.id,
      reasoningEffort: "high",
      runtimeAgentRole: "brain",
    });
  });

  describe("assignRuntimeAgentRole", () => {
    const MISSING_SESSION_ID = "missing-session";
    const ROLE_SWARM = "swarm" as const;
    const ROLE_PLANNER = "planner" as const;

    it("persists the role onto the session file and index", async () => {
      setupInMemoryDisk();

      const { SessionManager } = await import("./sessions");
      const mgr = new SessionManager("/test/workspace", await createTestBackend());
      const access = new SessionTestAccess(mgr);
      const index = { sessions: [] as SessionMetadata[], activeSessionId: null as string | null };
      vi.spyOn(access.store, "loadIndex").mockImplementation(() => index);
      vi.spyOn(access.store, "withIndexLock").mockImplementation(async (update) => update(index));
      vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
      vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined);

      const meta = await mgr.createSession("gpt-5.4", undefined, { setActive: false });
      index.sessions.push(meta);
      await mgr.assignRuntimeAgentRole(meta.id, ROLE_SWARM);
      expect(() => mgr.sendRuntimeContinuation("unrelated-owner", meta.id, "automatic", 0)).toThrow(
        "does not belong",
      );
      expect(() => mgr.cancelRuntimeContinuations("unrelated-owner", meta.id)).toThrow(
        "does not belong",
      );

      const signalResumeTrigger = vi.fn<() => void>();
      mgr.setGoalIntegration(
        testDouble<Parameters<typeof mgr.setGoalIntegration>[0]>({}),
        testDouble<Parameters<typeof mgr.setGoalIntegration>[1]>({ signalResumeTrigger }),
      );
      await mgr.assignRuntimeAgentRole(meta.id, ROLE_SWARM, "delegation-current", "controller");
      expect(mgr.isRuntimeTaskControllerActive(meta.id)).toBe(true);
      await mgr.releaseRuntimeTaskController(meta.id, "delegation-stale");
      expect(mgr.isRuntimeTaskControllerActive(meta.id)).toBe(true);
      expect(signalResumeTrigger).not.toHaveBeenCalled();
      await mgr.releaseRuntimeTaskController(meta.id, "delegation-current");
      expect(mgr.isRuntimeTaskControllerActive(meta.id)).toBe(false);
      expect(access.loadSessionData(meta.id)?.runtimeDelegationId).toBe("delegation-current");
      expect(
        index.sessions.find((session) => session.id === meta.id)?.runtimeTaskController,
      ).toBeUndefined();
      expect(signalResumeTrigger).toHaveBeenCalledExactlyOnceWith(meta.id);
      await mgr.releaseRuntimeTaskController(meta.id, "delegation-current");
      expect(signalResumeTrigger).toHaveBeenCalledOnce();

      expect(access.loadSessionData(meta.id)?.runtimeAgentRole).toBe(ROLE_SWARM);
      expect(index.sessions.find((session) => session.id === meta.id)?.runtimeAgentRole).toBe(
        ROLE_SWARM,
      );
    });

    it("rejects a missing session", async () => {
      setupInMemoryDisk();

      const { SessionManager } = await import("./sessions");
      const mgr = new SessionManager("/test/workspace", await createTestBackend());

      await expect(mgr.assignRuntimeAgentRole(MISSING_SESSION_ID, ROLE_PLANNER)).rejects.toThrow(
        `Session "${MISSING_SESSION_ID}" was not found.`,
      );
    });

    it("overwrites an existing runtime agent role", async () => {
      setupInMemoryDisk();

      const { SessionManager } = await import("./sessions");
      const mgr = new SessionManager("/test/workspace", await createTestBackend());
      const access = new SessionTestAccess(mgr);
      vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
      vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined);

      const meta = await mgr.createSession("gpt-5.4", undefined, {
        runtimeAgentRole: ROLE_PLANNER,
        setActive: false,
      });
      await mgr.assignRuntimeAgentRole(meta.id, ROLE_SWARM);

      expect(access.loadSessionData(meta.id)?.runtimeAgentRole).toBe(ROLE_SWARM);
    });
  });

  it("defaults agent sessions to no MCP inheritance unless explicitly scoped", async () => {
    setupInMemoryDisk();

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
    vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined);

    const implicit = await mgr.createSession(undefined, undefined, {
      source: "subagent",
      setActive: false,
    });
    const explicit = await mgr.createSession(undefined, undefined, {
      source: "workflow-agent",
      mcp: ["ado-repo"],
      setActive: false,
    });

    expect(new SessionTestAccess(mgr).loadSessionData(implicit.id)?.scopedMcp).toEqual([]);
    expect(new SessionTestAccess(mgr).loadSessionData(explicit.id)?.scopedMcp).toEqual([
      "ado-repo",
    ]);
  });
});

describe("resolveSessionMcpScope", () => {
  it("defaults legacy agents to empty while preserving explicit and chat scopes", () => {
    expect(resolveSessionMcpScope({ source: "subagent" })).toEqual([]);
    expect(resolveSessionMcpScope({ source: "workflow-agent" })).toEqual([]);
    expect(resolveSessionMcpScope({ source: "subagent", scopedMcp: ["ado-repo"] })).toEqual([
      "ado-repo",
    ]);
    expect(resolveSessionMcpScope({ source: "workspace" })).toBeNull();
  });
});

describe("SessionManager.getDefaultSoul – migration", () => {
  it("returns 'default' when defaultSoul is null/undefined", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({ sessions: [] });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const soul = mgr.getDefaultSoul();
    expect(soul).toBe("default");
  });

  it("returns stored soul when it exists in presets", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({ sessions: [], defaultSoul: "analyst" });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const soul = mgr.getDefaultSoul();
    expect(soul).toBe("analyst");
  });

  it("migrates unknown soul ID ('custom') to 'default'", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({ sessions: [], defaultSoul: "custom" });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const soul = mgr.getDefaultSoul();
    expect(soul).toBe("default");
  });

  it("migrates any unknown soul ID to 'default'", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({ sessions: [], defaultSoul: "nonexistent" });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const soul = mgr.getDefaultSoul();
    expect(soul).toBe("default");
  });
});

// System prompt, shell command blocking, sendAndCollect, and timezone tests
// have been moved to sessions-outgoing.test.ts and sessions-incoming.test.ts
// with more thorough coverage.

describe("SessionManager.purgeExpiredSessions", () => {
  const now = new Date("2026-03-29T00:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

  it("deletes sessions older than retention period", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "old", name: "Old", updatedAt: daysAgo(100), backendOrigin: "copilot" },
            { id: "recent", name: "Recent", updatedAt: daysAgo(10), backendOrigin: "copilot" },
            {
              id: "foreign-old",
              name: "Foreign old",
              updatedAt: daysAgo(200),
              runtimeId: "codex",
              backendOrigin: "copilot",
            },
          ],
          activeSessionId: "recent",
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const deleteSpy = vi
      .spyOn<typeof mgr, "deleteSession">(mgr, "deleteSession")
      .mockResolvedValue(null);

    vi.setSystemTime(now);
    const purged = await mgr.purgeExpiredSessions(90);

    expect(purged).toBe(1);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith("old", {
      suppressChangeEvent: true,
      cause: "purge-expired",
    });
    vi.useRealTimers();
  });

  it("does nothing when retention is 0 (disabled)", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const purged = await mgr.purgeExpiredSessions(0);
    expect(purged).toBe(0);
    expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
  });

  it("does nothing when all sessions are within retention", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({
          sessions: [{ id: "s1", name: "S1", updatedAt: daysAgo(5), backendOrigin: "copilot" }],
          activeSessionId: "s1",
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const deleteSpy = vi
      .spyOn<typeof mgr, "deleteSession">(mgr, "deleteSession")
      .mockResolvedValue(null);

    vi.setSystemTime(now);
    const purged = await mgr.purgeExpiredSessions(90);
    expect(purged).toBe(0);
    expect(deleteSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("delegates to deleteSession which handles activeSessionId reassignment", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({
          sessions: [
            {
              id: "old-active",
              name: "Old Active",
              updatedAt: daysAgo(100),
              backendOrigin: "copilot",
            },
            { id: "recent", name: "Recent", updatedAt: daysAgo(5), backendOrigin: "copilot" },
          ],
          activeSessionId: "old-active",
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const deleteSpy = vi
      .spyOn<typeof mgr, "deleteSession">(mgr, "deleteSession")
      .mockResolvedValue("recent");

    vi.setSystemTime(now);
    await mgr.purgeExpiredSessions(90);

    expect(deleteSpy).toHaveBeenCalledWith("old-active", {
      suppressChangeEvent: true,
      cause: "purge-expired",
    });
    vi.useRealTimers();
  });
});

describe("SessionManager.renameSessionsByWorkspace", () => {
  it("updates workspaceName in both index and session data", async () => {
    const sessionData = {
      id: "ws-session-1",
      name: "Test",
      backendOrigin: "copilot" as const,
      source: "workspace",
      workspaceName: "OldName",
      messages: [],
    };
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const pathStr = String(p);
      if (pathStr.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            {
              id: "ws-session-1",
              name: "Test",
              backendOrigin: "copilot" as const,
              source: "workspace",
              workspaceName: "OldName",
              updatedAt: new Date().toISOString(),
            },
            {
              id: "other-session",
              name: "Other",
              backendOrigin: "copilot" as const,
              source: "user",
              updatedAt: new Date().toISOString(),
            },
          ],
          activeSessionId: "ws-session-1",
        });
      }
      if (pathStr.includes("ws-session-1")) {
        return JSON.stringify(sessionData);
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    await mgr.renameSessionsByWorkspace("OldName", "NewName");

    // Index should be saved with updated workspaceName
    const indexWriteCall = [...mockedFs.writeFileSync.mock.calls]
      .reverse()
      .find(([p]) => String(p).includes("index.json"));
    expect(indexWriteCall).toBeTruthy();
    const savedIndex = JSON.parse(indexWriteCall![1] as string); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- extracting mock call data
    const renamedMeta = savedIndex.sessions.find((s: { id: string }) => s.id === "ws-session-1");
    expect(renamedMeta.workspaceName).toBe("NewName");

    // Other session should be unaffected
    const otherMeta = savedIndex.sessions.find((s: { id: string }) => s.id === "other-session");
    expect(otherMeta.workspaceName).toBeUndefined();

    // Session data file should be saved with updated workspaceName
    const dataWriteCall = [...mockedFs.writeFileSync.mock.calls]
      .reverse()
      .find(([p]) => String(p).includes("ws-session-1"));
    expect(dataWriteCall).toBeTruthy();
    const savedData = JSON.parse(dataWriteCall![1] as string); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- extracting mock call data
    expect(savedData.workspaceName).toBe("NewName");
  });

  it("does nothing when no sessions match the workspace", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({
          sessions: [
            {
              id: "s1",
              name: "S1",
              source: "user",
              updatedAt: new Date().toISOString(),
              backendOrigin: "copilot",
            },
          ],
          activeSessionId: "s1",
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    await mgr.renameSessionsByWorkspace("NonExistent", "NewName");

    // withIndexLock always saves, but no session should have been renamed
    const indexWrites = mockedFs.writeFileSync.mock.calls.filter(([p]) =>
      String(p).includes("index.json"),
    );
    for (const [, content] of indexWrites) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extracting vitest mock call arg
      const saved = JSON.parse(content as string) as {
        sessions: Array<{ workspaceName?: string }>;
      };
      const renamed = saved.sessions.filter((s) => s.workspaceName === "NewName");
      expect(renamed).toHaveLength(0);
    }
  });
});

describe("SessionManager.appendMessage — auto-title ownership", () => {
  it("does not launch title generation from generic backend message appends", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "sess-bg", name: "Hello world", updatedAt: "", backendOrigin: "copilot" },
          ],
        });
      }
      if (path.includes("sess-bg")) {
        return JSON.stringify({
          id: "sess-bg",
          name: "Hello world",
          backendOrigin: "copilot" as const,
          aiGeneratedTitle: "Hello world",
          needsAiTitle: true,
          messages: [],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const generateTitleSpy = vi.spyOn(mgr, "generateTitle").mockResolvedValue("AI Generated Title");

    mgr.appendMessage("sess-bg", {
      id: "1",
      role: "user",
      content: "Hello world",
      timestamp: new Date().toISOString(),
    });

    expect(generateTitleSpy).not.toHaveBeenCalled();
  });

  it("does not trigger generateTitle when needsAiTitle is false", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "sess-bg2", name: "Titled Session", updatedAt: "", backendOrigin: "copilot" },
          ],
        });
      }
      if (path.includes("sess-bg2")) {
        return JSON.stringify({
          id: "sess-bg2",
          name: "Titled Session",
          backendOrigin: "copilot" as const,
          aiGeneratedTitle: "Titled Session",
          messages: [{ id: "1", role: "user", content: "Hello", timestamp: "" }],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const generateTitleSpy = vi.spyOn(mgr, "generateTitle");

    mgr.appendMessage("sess-bg2", {
      id: "2",
      role: "assistant",
      content: "World",
      timestamp: new Date().toISOString(),
    });

    expect(generateTitleSpy).not.toHaveBeenCalled();
  });

  it("invalidates cached contextSummary when a new message is appended", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "sess-ctx", name: "Summarized", updatedAt: "", backendOrigin: "copilot" },
          ],
        });
      }
      if (path.includes("sess-ctx")) {
        return JSON.stringify({
          id: "sess-ctx",
          name: "Summarized",
          backendOrigin: "copilot" as const,
          messages: [{ id: "1", role: "user", content: "Hello", timestamp: "" }],
          contextSummary: "Previously summarized conversation",
          summaryUpToMessageId: "1",
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    mgr.appendMessage("sess-ctx", {
      id: "2",
      role: "assistant",
      content: "New response",
      timestamp: new Date().toISOString(),
    });

    // The saved session should have contextSummary cleared
    const sessionWrites = mockedFs.writeFileSync.mock.calls.filter(
      ([p]) => String(p).includes("sess-ctx") && !String(p).includes("index"),
    );
    expect(sessionWrites.length).toBeGreaterThan(0);
    const lastWrite = sessionWrites[sessionWrites.length - 1];
    const saved = parseWrittenJson(lastWrite[1]);
    expect(saved.contextSummary).toBeUndefined();
    expect(saved.summaryUpToMessageId).toBeUndefined();
  });
});

describe("SessionManager.appendMessage — consecutive assistant copies", () => {
  const DUPLICATE_ASSISTANT_CONTENT = "Done—I waited ten seconds.";
  const IDLE_SAFETY_NET_MESSAGE_ID = "1710000000000";
  const COMMITTED_ASSISTANT_ID = "a2-uuid";
  const LATER_TURN_ASSISTANT_ID = "a3-uuid";

  it("does not persist a committed copy of an idle safety-net assistant message", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [{ id: "sess-dup", name: "Dup", updatedAt: "", backendOrigin: "copilot" }],
        });
      }
      if (path.includes("sess-dup")) {
        return JSON.stringify({
          id: "sess-dup",
          name: "Dup",
          backendOrigin: "copilot" as const,
          messages: [
            { id: "u1", role: "user", content: "think for ten second", timestamp: "" },
            {
              id: IDLE_SAFETY_NET_MESSAGE_ID,
              role: "assistant",
              content: DUPLICATE_ASSISTANT_CONTENT,
              timestamp: "",
            },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    expect(
      mgr.appendMessage("sess-dup", {
        id: COMMITTED_ASSISTANT_ID,
        role: "assistant",
        content: DUPLICATE_ASSISTANT_CONTENT,
        timestamp: new Date().toISOString(),
      }),
    ).toBe(false);
  });

  it("still persists a later assistant turn with the same content", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "sess-repeat", name: "Repeat", updatedAt: "", backendOrigin: "copilot" },
          ],
        });
      }
      if (path.includes("sess-repeat")) {
        return JSON.stringify({
          id: "sess-repeat",
          name: "Repeat",
          backendOrigin: "copilot" as const,
          messages: [
            { id: "u1", role: "user", content: "say ok", timestamp: "" },
            {
              id: COMMITTED_ASSISTANT_ID,
              role: "assistant",
              content: DUPLICATE_ASSISTANT_CONTENT,
              timestamp: "",
            },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    expect(
      mgr.appendMessage("sess-repeat", {
        id: LATER_TURN_ASSISTANT_ID,
        role: "assistant",
        content: DUPLICATE_ASSISTANT_CONTENT,
        timestamp: new Date().toISOString(),
      }),
    ).toBe(true);
  });
});

describe("SessionManager.renameSession — clears needsAiTitle on manual rename", () => {
  it("clears needsAiTitle when renamed without aiGeneratedTitle (manual rename)", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "sess-mr", name: "Quick title text", updatedAt: "", backendOrigin: "copilot" },
          ],
        });
      }
      if (path.includes("sess-mr")) {
        return JSON.stringify({
          id: "sess-mr",
          name: "Quick title text",
          backendOrigin: "copilot" as const,
          aiGeneratedTitle: "Quick title text",
          needsAiTitle: true,
          messages: [],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    // Manual rename — no aiGeneratedTitle param
    mockedFs.writeFileSync.mockClear();
    await mgr.renameSession("sess-mr", "My Custom Name");

    const writeCall = [...mockedFs.writeFileSync.mock.calls]
      .reverse()
      .find(([p]) => String(p).includes("sess-mr") && !String(p).includes("index"));
    expect(writeCall).toBeDefined();
    const saved = parseWrittenJson(writeCall![1]);
    expect(saved.needsAiTitle).toBe(false);
    expect(saved.name).toBe("My Custom Name");
  });

  it("does not alter needsAiTitle when renamed with aiGeneratedTitle (auto rename)", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "sess-ar", name: "Quick title", updatedAt: "", backendOrigin: "copilot" },
          ],
        });
      }
      if (path.includes("sess-ar")) {
        return JSON.stringify({
          id: "sess-ar",
          name: "Quick title",
          backendOrigin: "copilot" as const,
          aiGeneratedTitle: "Quick title",
          needsAiTitle: false,
          messages: [],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    // Auto rename — with aiGeneratedTitle param
    await mgr.renameSession("sess-ar", "AI Title", "AI Title");

    const writeCall = mockedFs.writeFileSync.mock.calls.find(
      ([p]) => String(p).includes("sess-ar") && !String(p).includes("index"),
    );
    expect(writeCall).toBeDefined();
    const saved = parseWrittenJson(writeCall![1]);
    // Auto rename should not touch needsAiTitle — it stays false
    expect(saved.needsAiTitle).toBe(false);
  });
});

describe("SessionManager.sendMessage — starts background auto-title", () => {
  it("writes a concise fallback and launches one title generation call", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "sess-sm", name: DEFAULT_SESSION_NAME, updatedAt: "", backendOrigin: "copilot" },
          ],
        });
      }
      if (path.includes("sess-sm")) {
        return JSON.stringify({
          id: "sess-sm",
          name: DEFAULT_SESSION_NAME,
          backendOrigin: "copilot" as const,
          messages: [],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const ta = new SessionTestAccess(mgr);

    // Set up both sessionHandles and activeSessions so sendMessage doesn't try to recreate
    const mockSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    ta.activeSessions.set("sess-sm", { send: mockSend, on: vi.fn<() => void>() });
    ta.sessionHandles.set("sess-sm", { sessionId: "sess-sm", backendId: "sdk-sm" });
    const generateTitleSpy = vi.spyOn(mgr, "generateTitle").mockResolvedValue("React Auth Setup");

    mockedFs.writeFileSync.mockClear();
    await mgr.sendMessage("sess-sm", "How do I implement auth in React?");

    // Find the session data write (not index)
    const sessionWrites = mockedFs.writeFileSync.mock.calls.filter(
      ([p]) => String(p).includes("sess-sm") && !String(p).includes("index"),
    );
    expect(sessionWrites.length).toBeGreaterThan(0);
    const fallbackWrite = sessionWrites
      .map(([, data]) => parseWrittenJson(data))
      .find((saved) => saved.name === "How do I implement" && saved.needsAiTitle === false);
    expect(fallbackWrite).toMatchObject({
      name: "How do I implement",
      aiGeneratedTitle: "How do I implement",
      needsAiTitle: false,
    });
    expect(generateTitleSpy).toHaveBeenCalledTimes(1);
    expect(generateTitleSpy).toHaveBeenCalledWith("sess-sm", [
      expect.objectContaining({ role: "user", content: "How do I implement auth in React?" }),
    ]);
  });

  it("does not set quick-title when session already has messages", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "sess-em", name: "Existing Title", updatedAt: "", backendOrigin: "copilot" },
          ],
        });
      }
      if (path.includes("sess-em")) {
        return JSON.stringify({
          id: "sess-em",
          name: "Existing Title",
          backendOrigin: "copilot" as const,
          messages: [{ id: "1", role: "user", content: "Hi", timestamp: "" }],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const ta = new SessionTestAccess(mgr);

    // Set up both sessionHandles and activeSessions so sendMessage doesn't try to recreate
    const mockSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    ta.activeSessions.set("sess-em", { send: mockSend, on: vi.fn<() => void>() });
    ta.sessionHandles.set("sess-em", { sessionId: "sess-em", backendId: "sdk-em" });

    mockedFs.writeFileSync.mockClear();
    await mgr.sendMessage("sess-em", "Follow-up question");

    // Session writes happen (appendMessage persists user message), but
    // none of them should set needsAiTitle — quick-title is only for
    // the first message in an untitled session.
    const sessionWrites = mockedFs.writeFileSync.mock.calls.filter(
      ([p]) => String(p).includes("sess-em") && !String(p).includes("index"),
    );
    for (const [, data] of sessionWrites) {
      const saved = parseWrittenJson(data);
      if (saved.name === undefined) continue;
      expect(saved.needsAiTitle).toBeFalsy();
      expect(saved.name).toBe("Existing Title");
    }
  });
});

describe("SessionManager.sendMessage — broadcasts user message", () => {
  it("emits a session:view snapshot carrying the user message in committedMessages (Channel 1 / cross-window broadcast)", async () => {
    // The critical pin: peer windows only ever see `session:view` IPC
    // broadcasts (main.ts wires sessionManager.addViewEventListener →
    // chatWindowManager.broadcast). If we only fire the in-process
    // TurnEvent channel (emitEvent), the broadcast never goes out — that
    // was the original mirroring regression.
    //
    // We assert the *view-event* listener sees the committed message, not
    // the TurnEvent listener, because the former is what reaches peers.
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [{ id: "sess-bv", name: "Existing", updatedAt: "", backendOrigin: "copilot" }],
        });
      }
      if (path.includes("sess-bv")) {
        return JSON.stringify({
          id: "sess-bv",
          name: "Existing",
          backendOrigin: "copilot" as const,
          messages: [{ id: "1", role: "user", content: "Earlier", timestamp: "" }],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const ta = new SessionTestAccess(mgr);

    const mockSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    ta.activeSessions.set("sess-bv", { send: mockSend, on: vi.fn<() => void>() });
    ta.sessionHandles.set("sess-bv", { sessionId: "sess-bv", backendId: "sdk-bv" });

    const viewListener =
      vi.fn<
        (
          sessionId: string,
          event: import("../common/marshal-ipc-contract").SessionViewEvent,
        ) => void
      >();
    mgr.addViewEventListener(viewListener);

    await mgr.sendMessage("sess-bv", "hello peers", undefined, {
      clientMessageId: "shared-id-1",
    });

    // Among the view-event calls (setSubmitted fires one too), one must
    // carry our user message in committedMessages.
    expect(viewListener).toHaveBeenCalledWith(
      "sess-bv",
      expect.objectContaining({
        committedMessages: expect.arrayContaining([
          expect.objectContaining({
            id: "shared-id-1",
            role: "user",
            content: "hello peers",
          }),
        ]),
      }),
    );
  });

  it("keeps the goal continuation composer exchange out of the view channel", async () => {
    const session: PersistedSession = {
      id: "sub-goal-composer",
      name: "Research helper",
      source: "subagent",
      backendOrigin: "copilot",
      backendId: "sdk-goal-composer",
      createdAt: "2026-07-24T09:00:00.000Z",
      updatedAt: "2026-07-24T09:00:00.000Z",
      hasUnread: false,
      isActive: false,
      messages: [],
    };
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(session);
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    access.activeSessions.set(session.id, {
      send: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      on: vi.fn<() => void>(),
    });
    access.sessionHandles.set(session.id, {
      sessionId: session.id,
      backendId: session.backendId!,
    });
    access.subscribeToBackendEvents(session.id);

    await mgr.sendMessage(session.id, "Compose the next continuation", undefined, {
      clientMessageId: "composer-message",
      internalControl: {
        kind: "goal-continuation-composer",
        exchangeId: "goal-continuation-composer:1",
        side: "request",
      },
    });
    const backendListener = [...access.getCopilotBackendSessionSubscribers(session.id)].at(0);
    if (!backendListener) throw new Error("Expected a subscribed backend listener");
    backendListener({ type: "text-delta", text: "PRIVATE_COMPOSER_DRAFT" });
    await Promise.resolve();

    // The composer runs its own throwaway exchange; revealing the pursuing
    // agent's work must not widen the gate to this plumbing.
    expect(mgr.getSessionView(session.id).view.streamingText).not.toContain(
      "PRIVATE_COMPOSER_DRAFT",
    );
  });

  it("emits the provided clientMessageId with preserved agent-message metadata", async () => {
    // Pin for the cross-window mirroring fix. The assistant path already emits
    // turn:message-committed (in turn-accumulator.ts on turn-complete), so peer
    // windows see assistant output. Without this user-message emit, peer
    // windows show nothing until the next session switch refetches from disk.
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [{ id: "sess-um", name: "Existing", updatedAt: "", backendOrigin: "copilot" }],
        });
      }
      if (path.includes("sess-um")) {
        return JSON.stringify({
          id: "sess-um",
          name: "Existing",
          backendOrigin: "copilot" as const,
          messages: [{ id: "1", role: "user", content: "Earlier", timestamp: "" }],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const ta = new SessionTestAccess(mgr);

    const mockSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    ta.activeSessions.set("sess-um", { send: mockSend, on: vi.fn<() => void>() });
    ta.sessionHandles.set("sess-um", { sessionId: "sess-um", backendId: "sdk-um" });

    const listener = vi.fn<(sessionId: string, event: unknown) => void>();
    mgr.addEventListener(listener);

    await mgr.sendMessage("sess-um", "hello there", undefined, {
      clientMessageId: "client-msg-id-1",
      agentMessage: {
        source: "child-1",
        sourceLabel: "Worker",
        kind: "parent",
        deliveryMode: "queue",
        sequence: 7,
      },
    });

    expect(listener).toHaveBeenCalledWith("sess-um", {
      type: "turn:message-committed",
      message: {
        id: "client-msg-id-1",
        role: "user",
        content: "hello there",
        timestamp: expect.any(String),
        agentMessage: {
          source: "child-1",
          sourceLabel: "Worker",
          kind: "parent",
          deliveryMode: "queue",
          sequence: 7,
        },
      },
    });
  });

  it("suppresses only outbox-owned delivery control failures in the visible transcript", async () => {
    const session: PersistedSession = {
      id: "sess-agent-control",
      name: "Existing",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [{ id: "1", role: "user", content: "Earlier", timestamp: "" }],
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(session);
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    const send = vi.spyOn(backend.sessions, "send").mockResolvedValue(undefined);
    access.sessionHandles.set(session.id, {
      sessionId: session.id,
      backendId: "sdk-agent-control",
    });
    const viewEvents: import("../common/marshal-ipc-contract").SessionViewEvent[] = [];
    mgr.addViewEventListener((_sessionId, event) => viewEvents.push(event));
    const controlError = new AgentMessageDeliveryControlError(
      "agent-message-1",
      "backend-acceptance",
      "Agent-message lease was invalidated before dispatch",
    );

    await expect(
      mgr.sendMessage(session.id, "review feedback", undefined, {
        clientMessageId: "agent-message-1",
        agentMessage: {
          source: "review-ui",
          sourceLabel: "Review UI",
          kind: "review-feedback",
          deliveryMode: "queue",
          sequence: 1,
        },
        onBackendDispatchStarting: () => {
          throw controlError;
        },
      }),
    ).rejects.toBe(controlError);

    expect(viewEvents.some((event) => event.view.error !== null)).toBe(false);
    expect(access.busyTracker.isBusy(session.id)).toBe(false);
    expect(session.messages.filter((message) => message.id === "agent-message-1")).toHaveLength(1);

    const lateDeliveryError = new AgentMessageDeliveryControlError(
      "agent-message-late",
      "backend-delivery",
      "Agent-message lease was invalidated before backend delivery",
    );
    await expect(
      mgr.sendMessage(session.id, "late review feedback", undefined, {
        clientMessageId: "agent-message-late",
        agentMessage: {
          source: "review-ui",
          sourceLabel: "Review UI",
          kind: "review-feedback",
          deliveryMode: "queue",
          sequence: 2,
        },
        onBackendDelivered: () => {
          session.messages.push({
            id: "newer-turn",
            role: "user",
            content: "newer turn",
            timestamp: new Date().toISOString(),
          });
          access.busyTracker.setBusy(session.id);
          throw lateDeliveryError;
        },
      }),
    ).rejects.toBe(lateDeliveryError);

    expect(access.busyTracker.isBusy(session.id)).toBe(true);
    expect(viewEvents.some((event) => event.view.error !== null)).toBe(false);
    access.busyTracker.setIdle(session.id);

    const backendError = new Error("backend unavailable");
    send.mockRejectedValueOnce(backendError);
    await expect(
      mgr.sendMessage(session.id, "second review feedback", undefined, {
        clientMessageId: "agent-message-2",
        agentMessage: {
          source: "review-ui",
          sourceLabel: "Review UI",
          kind: "review-feedback",
          deliveryMode: "queue",
          sequence: 3,
        },
      }),
    ).rejects.toBe(backendError);

    expect(viewEvents.some((event) => event.view.error !== null)).toBe(true);
  });

  it("falls back to a server-generated id when clientMessageId is not provided", async () => {
    // Non-renderer callers (relay, automations, heartbeat) don't have an
    // optimistic-update step. They omit clientMessageId; the emit must still
    // carry an id so peer windows can render the message.
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [{ id: "sess-um2", name: "Existing", updatedAt: "", backendOrigin: "copilot" }],
        });
      }
      if (path.includes("sess-um2")) {
        return JSON.stringify({
          id: "sess-um2",
          name: "Existing",
          backendOrigin: "copilot" as const,
          messages: [{ id: "1", role: "user", content: "Earlier", timestamp: "" }],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const ta = new SessionTestAccess(mgr);

    const mockSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    ta.activeSessions.set("sess-um2", { send: mockSend, on: vi.fn<() => void>() });
    ta.sessionHandles.set("sess-um2", { sessionId: "sess-um2", backendId: "sdk-um2" });

    const listener = vi.fn<(sessionId: string, event: unknown) => void>();
    mgr.addEventListener(listener);

    await mgr.sendMessage("sess-um2", "no client id here");

    expect(listener).toHaveBeenCalledWith("sess-um2", {
      type: "turn:message-committed",
      message: {
        id: expect.stringMatching(/.+/),
        role: "user",
        content: "no client id here",
        timestamp: expect.any(String),
      },
    });
  });
});

describe("SessionManager.sendMessage — missing session error", () => {
  it("throws a clear, actionable error when the session is missing on disk", async () => {
    // Renderer holds a stale session UUID (e.g., after a crash that wiped
    // ~/.marshal/marshal-sessions or ~/.marshal/session-state). The backend has no
    // record of it, no data file exists, and recovery is not possible.
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({ sessions: [] });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    await expect(mgr.sendMessage("stale-uuid", "hello")).rejects.toThrow(
      /Session stale-uuid no longer exists.*start a new chat/i,
    );
  });

  it("throws the same actionable error in the noSwitch path (background callers)", async () => {
    // Same stale-UUID scenario, but reached via a background caller (relay /
    // heartbeat) that uses options.noSwitch=true. Without the fix this
    // would silently call createBackendSession with undefined model/soul
    // and then bubble the cryptic "No backend session for: <uuid>".
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({ sessions: [] });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    await expect(
      mgr.sendMessage("stale-uuid", "hello", undefined, { noSwitch: true }),
    ).rejects.toThrow(/Session stale-uuid no longer exists.*start a new chat/i);
  });
});

describe("SessionManager.sendMessageToSubagent — store resolution", () => {
  function wireReadinessWakeIntegration(
    manager: import("./sessions").SessionManager,
    getGoal: (sessionId: string) => GoalState | null = () => null,
  ) {
    type GoalEnginePort = Parameters<typeof manager.setGoalIntegration>[1];
    const start = vi.fn<GoalEnginePort["start"]>();
    manager.setGoalIntegration(
      testDouble<Parameters<typeof manager.setGoalIntegration>[0]>({
        getGoal,
        pause: vi.fn<() => null>(() => null),
      }),
      testDouble<Parameters<typeof manager.setGoalIntegration>[1]>({
        start,
        signalResumeTrigger: vi.fn<GoalEnginePort["signalResumeTrigger"]>(),
        pause: vi.fn<GoalEnginePort["pause"]>(),
        stop: vi.fn<GoalEnginePort["stop"]>(),
        isRunning: () => false,
      }),
    );
    const sendAndCollect = vi
      .spyOn(manager, "sendAndCollect")
      .mockImplementation(async (...args) => {
        await args[5]?.onBackendDispatchStarting?.();
        await args[5]?.onBackendDelivered?.();
        return { kind: "ok", text: "Parent resumed" };
      });
    return { sendAndCollect, start };
  }

  function makeReadinessWakeSessions(prefix: string): {
    parent: PersistedSession;
    child: PersistedSession;
  } {
    const parent: PersistedSession = {
      id: `${prefix}-parent`,
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    return {
      parent,
      child: {
        id: `${prefix}-child`,
        name: "Worker",
        source: "subagent",
        parentSessionId: parent.id,
        backendOrigin: "copilot",
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: true,
        messages: [{ id: `${prefix}-work`, role: "user", content: "Investigate", timestamp: "" }],
      },
    };
  }

  it("does not wait for the subagent turn when waitForResponse is false", async () => {
    const id = "sub-detached-send";
    const session: PersistedSession = {
      id,
      name: "Subagent: detached send",
      source: "subagent",
      parentSessionId: "parent-1",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      messages: [{ id: "m1", role: "user", content: "Initial task", timestamp: "" }],
    };

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) =>
      sessionId === id ? session : null,
    );
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});

    const mockSend = vi.fn<() => Promise<void>>().mockReturnValue(new Promise(() => {}));
    access.activeSessions.set(id, { send: mockSend, on: vi.fn<() => void>() });
    access.sessionHandles.set(id, { sessionId: id, backendId: "sdk-sub-detached" });
    await attachTestAgentMessageOutbox(mgr);

    const result = await Promise.race([
      mgr.sendMessageToSubagent({ sessionId: id, message: "continue" }),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);

    expectDurablyAccepted(result);
    await vi.waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ prompt: "continue" })),
    );
  });

  it("restarts a disposed backend before acceptance and lets the outbox retry", async () => {
    const id = "sub-disposed-pre-acceptance";
    const session: PersistedSession = {
      id,
      name: "Subagent: disposed recovery",
      source: "subagent",
      parentSessionId: "parent-1",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      messages: [{ id: "m1", role: "user", content: "Initial task", timestamp: "" }],
    };

    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const restart = vi.spyOn(backend, "restart").mockResolvedValue(undefined);
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) =>
      sessionId === id ? session : null,
    );
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    const sendAndCollect = vi
      .spyOn(mgr, "sendAndCollect")
      .mockRejectedValueOnce(new Error("Couldn't start session: Connection is disposed."))
      .mockImplementationOnce(async (...args) => {
        await args[5]?.onBackendDispatchStarting?.();
        await args[5]?.onBackendDelivered?.();
        return { kind: "ok", text: "Recovered" };
      });
    const outbox = await attachTestAgentMessageOutbox(mgr);

    const result = await mgr.sendMessageToSubagent({ sessionId: id, message: "continue" });

    expectDurablyAccepted(result);
    const messageId = result.messageId;
    if (!messageId) throw new Error("Expected durable message ID");
    await expect(outbox.waitForBackendAccepted(messageId, 1_000)).resolves.toMatchObject({
      messageId,
    });
    await vi.waitFor(() => expect(outbox.get(messageId)?.state).toBe("processed"));
    expect(restart).toHaveBeenCalledTimes(1);
    expect(sendAndCollect).toHaveBeenCalledTimes(2);
  });

  it("returns immediately for queued fire-and-forget delivery and sends after idle", async () => {
    const id = "sub-queued-fire-forget";
    const session: PersistedSession = {
      id,
      name: "Subagent: queued fire-forget",
      source: "subagent",
      parentSessionId: "parent-1",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      messages: [{ id: "m1", role: "user", content: "Initial task", timestamp: "" }],
    };

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) =>
      sessionId === id ? session : null,
    );
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    const mockSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    access.activeSessions.set(id, { send: mockSend, on: vi.fn<() => void>() });
    access.sessionHandles.set(id, { sessionId: id, backendId: "sdk-sub-queued-fire-forget" });
    access.busyTracker.setBusy(id);
    await attachTestAgentMessageOutbox(mgr);

    const result = await Promise.race([
      mgr.sendMessageToSubagent({ sessionId: id, message: "follow up", deliveryMode: "queue" }),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);

    expectDurablyAccepted(result);
    expect(mockSend).not.toHaveBeenCalled();

    access.busyTracker.setIdle(id);

    await vi.waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ prompt: "follow up" })),
    );
  });

  it("marks the next subagent idle for suppression when parent delivery interrupts", async () => {
    const id = "sub-interrupt-idle";
    const session: PersistedSession = {
      id,
      name: "Subagent: interrupt idle",
      source: "subagent",
      parentSessionId: "parent-1",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      messages: [{ id: "m1", role: "user", content: "Initial task", timestamp: "" }],
    };

    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) =>
      sessionId === id ? session : null,
    );
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    vi.spyOn(backend.sessions, "abort").mockResolvedValue({});
    vi.spyOn(mgr, "refreshSessionDedup").mockResolvedValue(undefined);
    access.busyTracker.setBusy(id);
    access.activeSessions.set(id, {
      send: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      on: vi.fn<() => void>(),
    });
    access.sessionHandles.set(id, { sessionId: id, backendId: "sdk-sub-interrupt-idle" });
    await attachTestAgentMessageOutbox(mgr);

    const result = await mgr.sendMessageToSubagent({
      sessionId: id,
      message: "Stop and answer this now.",
      deliveryMode: "interrupt",
    });

    expectDurablyAccepted(result);
    expect(mgr.consumeParentInterruptedSubagentIdle(id)).toBe(true);
    expect(mgr.consumeParentInterruptedSubagentIdle(id)).toBe(true);
    mgr.markBusy(id);
    expect(mgr.consumeParentInterruptedSubagentIdle(id)).toBe(false);
  });

  it("holds the parent wake while a subagent has queued messages and releases it when they are cancelled", async () => {
    vi.useFakeTimers();
    const parent: PersistedSession = {
      id: "parent-held-wake",
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    const child: PersistedSession = {
      id: "sub-held-wake",
      name: "Queued worker",
      source: "subagent",
      parentSessionId: parent.id,
      backendOrigin: "copilot",
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:01:00.000Z",
      hasUnread: false,
      isActive: false,
      messages: [{ id: "work-1", role: "user", content: "Do work", timestamp: "" }],
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === parent.id) return parent;
      if (sessionId === child.id) return child;
      return null;
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    mockCurrentRuntimeIndex(access, [parent, child]);
    access.currentSessionId = parent.id;
    const { sendAndCollect } = wireReadinessWakeIntegration(mgr);
    const outbox = await attachTestAgentMessageOutbox(mgr, { pauseDispatch: true });
    await outbox.enqueue({
      source: parent.id,
      target: child.id,
      kind: "subagent",
      content: "Queued instruction",
    });

    await mgr.noteSubagentIdle(child, Date.now(), { wasBusy: true });
    await vi.advanceTimersByTimeAsync(250);
    expect(parent.messages).toEqual([]);
    expect(sendAndCollect).not.toHaveBeenCalled();

    await outbox.cancelQueuedFromSource(child.id, parent.id);
    await vi.advanceTimersByTimeAsync(250);
    expect(parent.messages).toEqual([
      expect.objectContaining({ id: `subagent-ready:${parent.id}:${child.id}:work-1` }),
    ]);
    expect(sendAndCollect).toHaveBeenCalledTimes(1);
  });

  it("still reports a failed subagent turn while messages are queued", async () => {
    vi.useFakeTimers();
    const parent: PersistedSession = {
      id: "parent-failed-wake",
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    const child: PersistedSession = {
      id: "sub-failed-wake",
      name: "Failing worker",
      source: "subagent",
      parentSessionId: parent.id,
      backendOrigin: "copilot",
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:01:00.000Z",
      hasUnread: false,
      isActive: false,
      messages: [{ id: "work-1", role: "user", content: "Do work", timestamp: "" }],
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === parent.id) return parent;
      if (sessionId === child.id) return child;
      return null;
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    mockCurrentRuntimeIndex(access, [parent, child]);
    access.currentSessionId = parent.id;
    wireReadinessWakeIntegration(mgr);
    const outbox = await attachTestAgentMessageOutbox(mgr, { pauseDispatch: true });
    await outbox.enqueue({
      source: parent.id,
      target: child.id,
      kind: "subagent",
      content: "Queued instruction",
    });

    await mgr.noteSubagentIdle(child, Date.now(), {
      wasBusy: true,
      outcome: "failed",
      detail: "boom",
    });

    expect(parent.messages).toHaveLength(1);
  });

  it("wakes an idle direct owner once across duplicate readiness transitions", async () => {
    vi.useFakeTimers();
    const parent: PersistedSession = {
      id: "parent-idle-notify",
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    const child: PersistedSession = {
      id: "sub-idle-notify",
      name: "Idle worker",
      source: "subagent",
      parentSessionId: "parent-idle-notify",
      backendOrigin: "copilot",
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:01:00.000Z",
      hasUnread: false,
      isActive: false,
      messages: [{ id: "work-1", role: "user", content: "Do work", timestamp: "" }],
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === parent.id) return parent;
      if (sessionId === child.id) return child;
      return null;
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    mockCurrentRuntimeIndex(access, [parent, child]);
    access.currentSessionId = parent.id;
    const send = vi.spyOn(backend.sessions, "send");
    const { sendAndCollect } = wireReadinessWakeIntegration(mgr);
    const readinessEvents: string[] = [];
    mgr.addEventListener((_sessionId, event) => {
      if (
        event.type === "turn:message-committed" &&
        event.message.agentMessage?.kind === "readiness"
      ) {
        readinessEvents.push(event.message.id);
      }
    });

    await Promise.all([
      mgr.noteSubagentIdle(child, Date.now(), { wasBusy: true }),
      mgr.noteSubagentIdle(child, Date.now(), { wasBusy: true }),
    ]);
    await mgr.noteSubagentIdle(child, Date.now(), { wasBusy: false });
    await vi.advanceTimersByTimeAsync(250);

    const restarted = new SessionManager("/test/workspace", backend);
    const restartedAccess = new SessionTestAccess(restarted);
    vi.spyOn(restartedAccess.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === parent.id) return parent;
      if (sessionId === child.id) return child;
      return null;
    });
    vi.spyOn(restartedAccess.store, "saveSessionData").mockImplementation(() => {});
    mockCurrentRuntimeIndex(restartedAccess, [parent, child]);
    restartedAccess.currentSessionId = parent.id;
    await restarted.noteSubagentIdle(child, Date.now(), { wasBusy: false });
    await restarted.noteSubagentIdle(child, Date.now(), { wasBusy: true });

    expect(parent.messages).toEqual([
      expect.objectContaining({
        id: `subagent-ready:${parent.id}:${child.id}:work-1`,
        role: "system",
        agentMessage: expect.objectContaining({
          source: child.id,
          target: parent.id,
          kind: "readiness",
          readinessGeneration: "work-1",
        }),
      }),
    ]);
    expect(readinessEvents).toEqual([`subagent-ready:${parent.id}:${child.id}:work-1`]);
    expect(sendAndCollect).toHaveBeenCalledTimes(1);
    expect(sendAndCollect).toHaveBeenCalledWith(
      expect.stringContaining(child.id),
      expect.any(Number),
      undefined,
      parent.id,
      undefined,
      expect.objectContaining({
        internalControl: expect.objectContaining({
          kind: "subagent-readiness",
          side: "request",
        }),
        disableConnectionLostRetry: true,
      }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("does not wake a conversational parent for a runtime-managed child", async () => {
    vi.useFakeTimers();
    const { parent, child } = makeReadinessWakeSessions("runtime-managed");
    child.suppressParentReadinessWake = true;
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === parent.id) return parent;
      if (sessionId === child.id) return child;
      return null;
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    mockCurrentRuntimeIndex(access, [parent, child]);
    const { sendAndCollect } = wireReadinessWakeIntegration(manager);

    await manager.noteSubagentIdle(child, Date.now(), { wasBusy: true, outcome: "completed" });
    await vi.advanceTimersByTimeAsync(250);

    expect(parent.messages).toEqual([]);
    expect(access.pendingParentReadinessWakes.has(parent.id)).toBe(false);
    expect(sendAndCollect).not.toHaveBeenCalled();
  });

  it("ignores child readiness after its parent has been deleted from the current index", async () => {
    const { parent, child } = makeReadinessWakeSessions("idle-after-delete");
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    const index = {
      sessions: [parent, child],
      activeSessionId: null,
    };
    let parentCached = true;
    vi.spyOn(access.store, "loadIndex").mockImplementation(() => index);
    vi.spyOn(access.store, "withIndexLock").mockImplementation(async (update) => update(index));
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === parent.id) return parentCached ? parent : null;
      if (sessionId === child.id) return child;
      return null;
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    vi.spyOn(access.store, "deleteSessionData").mockImplementation((sessionId) => {
      if (sessionId === parent.id) parentCached = false;
    });
    const { sendAndCollect } = wireReadinessWakeIntegration(manager);

    await manager.deleteSession(parent.id);
    await manager.noteSubagentIdle(child, Date.now(), { wasBusy: true });

    expect(index.sessions.map((session) => session.id)).toEqual([child.id]);
    expect(parent.messages).toEqual([]);
    expect(sendAndCollect).not.toHaveBeenCalled();
  });

  it("defers a readiness wake until the direct owner becomes idle", async () => {
    vi.useFakeTimers();
    const parent: PersistedSession = {
      id: "parent-busy-readiness",
      name: "Busy parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    const child: PersistedSession = {
      id: "child-busy-readiness",
      name: "Worker",
      source: "subagent",
      parentSessionId: parent.id,
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [{ id: "work-busy-1", role: "user", content: "Investigate", timestamp: "" }],
    };
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === parent.id) return parent;
      if (sessionId === child.id) return child;
      return null;
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    mockCurrentRuntimeIndex(access, [parent, child]);
    const { sendAndCollect } = wireReadinessWakeIntegration(manager);
    access.busyTracker.setBusy(parent.id);

    await manager.noteSubagentIdle(child, Date.now(), { wasBusy: true });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendAndCollect).not.toHaveBeenCalled();

    access.busyTracker.setIdle(parent.id);
    await vi.advanceTimersByTimeAsync(0);

    expect(sendAndCollect).toHaveBeenCalledTimes(1);
    expect(sendAndCollect.mock.calls[0]?.[3]).toBe(parent.id);
  });

  it("preserves workflow-group readiness during bulk cleanup and dispatches after cleanup", async () => {
    vi.useFakeTimers();
    const { parent, child } = makeReadinessWakeSessions("workflow-bulk");
    parent.source = "workflow-run";
    const chat: PersistedSession = {
      ...makeReadinessWakeSessions("workflow-bulk-chat").parent,
      id: "workflow-bulk-chat",
    };
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    const index = {
      sessions: [chat, parent, child],
      activeSessionId: chat.id,
    };
    vi.spyOn(access.store, "loadIndex").mockImplementation(() => index);
    vi.spyOn(access.store, "withIndexLock").mockImplementation(async (update) => update(index));
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === chat.id) return chat;
      if (sessionId === parent.id) return parent;
      if (sessionId === child.id) return child;
      return null;
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    const deleteStarted = deferredPromise<void>();
    const releaseDelete = deferredPromise<void>();
    vi.spyOn(manager, "deleteSession").mockImplementation(async (sessionId) => {
      expect(sessionId).toBe(chat.id);
      deleteStarted.resolve(undefined);
      await releaseDelete.promise;
      return null;
    });
    const { sendAndCollect } = wireReadinessWakeIntegration(manager);

    const cleanup = manager.deleteAllSessionsPreservingWorkflowGroups();
    await deleteStarted.promise;
    await manager.noteSubagentIdle(child, Date.now(), { wasBusy: true });
    await vi.advanceTimersByTimeAsync(250);

    expect(sendAndCollect).not.toHaveBeenCalled();
    expect(access.pendingParentReadinessWakes.get(parent.id)?.size).toBe(1);

    releaseDelete.resolve(undefined);
    await cleanup;
    await vi.advanceTimersByTimeAsync(0);

    expect(sendAndCollect).toHaveBeenCalledTimes(1);
    expect(access.pendingParentReadinessWakes.has(parent.id)).toBe(false);
  });

  it("consumes the wake when the hidden request fails before backend dispatch acceptance", async () => {
    vi.useFakeTimers();
    const { parent, child } = makeReadinessWakeSessions("predispatch");
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === parent.id) return parent;
      if (sessionId === child.id) return child;
      return null;
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    mockCurrentRuntimeIndex(access, [parent, child]);
    const { sendAndCollect } = wireReadinessWakeIntegration(manager);
    sendAndCollect.mockReset();
    sendAndCollect.mockImplementationOnce(async (...args) => {
      const options = args[5];
      if (!options?.clientMessageId || !options.internalControl) {
        throw new Error("Missing hidden readiness control metadata");
      }
      parent.messages.push({
        id: options.clientMessageId,
        role: "user",
        content: args[0],
        timestamp: new Date().toISOString(),
        internalControl: options.internalControl,
      });
      throw new Error("Runtime reset before backend dispatch");
    });

    await manager.noteSubagentIdle(child, Date.now(), { wasBusy: true });
    vi.clearAllTimers();
    await access.flushParentReadinessWake(parent.id);

    expect(sendAndCollect).toHaveBeenCalledTimes(1);
    expect(access.pendingParentReadinessWakes.has(parent.id)).toBe(false);
    expect(
      parent.messages.filter((message) => message.internalControl?.kind === "subagent-readiness"),
    ).toHaveLength(1);

    vi.clearAllTimers();
    await access.flushParentReadinessWake(parent.id);

    expect(sendAndCollect).toHaveBeenCalledTimes(1);
  });

  it("polls a busy-deferred wake after runtime reset clears busy state without callbacks", async () => {
    vi.useFakeTimers();
    const { parent, child } = makeReadinessWakeSessions("runtime-reset");
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const manager = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(manager);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === parent.id) return parent;
      if (sessionId === child.id) return child;
      return null;
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    mockCurrentRuntimeIndex(access, [parent, child]);
    vi.spyOn(backend, "restart").mockResolvedValue(undefined);
    const { sendAndCollect } = wireReadinessWakeIntegration(manager);
    access.busyTracker.setBusy(parent.id);

    await manager.noteSubagentIdle(child, Date.now(), { wasBusy: true });
    vi.clearAllTimers();
    await access.flushParentReadinessWake(parent.id);

    expect(sendAndCollect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await access.performBackendRuntimeRestart();
    expect(access.busyTracker.isBusy(parent.id)).toBe(false);

    await vi.advanceTimersByTimeAsync(999);
    expect(sendAndCollect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sendAndCollect).toHaveBeenCalledTimes(1);
    expect(access.pendingParentReadinessWakes.has(parent.id)).toBe(false);
  });

  it("resets the backend client without throwing", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const restart = vi.spyOn(backend, "restart").mockResolvedValue(undefined);
    const manager = new SessionManager("/test/workspace", backend);

    await expect(manager.resetClient()).resolves.toBeUndefined();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("records readiness separately from an explicit child handoff", async () => {
    const parent: PersistedSession = {
      id: "parent-handoff-readiness",
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [
        {
          id: "handoff-1",
          role: "user",
          content: "Message from subagent Worker (child-handoff):\n\nImplementation complete.",
          timestamp: "2026-07-25T08:59:00.000Z",
          agentMessage: {
            source: "child-handoff",
            sourceLabel: "Worker",
            sourceSessionSource: "subagent",
            kind: "parent",
            deliveryMode: "queue",
            sequence: 1,
          },
        },
      ],
    };
    const child: PersistedSession = {
      id: "child-handoff",
      name: "Worker",
      source: "subagent",
      parentSessionId: parent.id,
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [
        {
          id: "work-handoff",
          role: "user",
          content: "Implement the repair",
          timestamp: "2026-07-25T08:00:00.000Z",
        },
      ],
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const manager = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(manager);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === parent.id) return parent;
      if (sessionId === child.id) return child;
      return null;
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    mockCurrentRuntimeIndex(access, [parent, child]);
    const send = vi.spyOn(backend.sessions, "send");

    await manager.noteSubagentIdle(child, Date.parse("2026-07-25T09:00:00.000Z"), {
      wasBusy: true,
    });

    expect(parent.messages.map((message) => message.agentMessage?.kind)).toEqual([
      "parent",
      "readiness",
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not replay migrated legacy readiness for unchanged child work", async () => {
    const parent: PersistedSession = {
      id: "parent-legacy-readiness",
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [
        {
          id: "legacy-readiness",
          role: "system",
          content:
            'Message from subagent Worker (child-legacy):\n\nSubagent "Worker" (child-legacy) is idle and ready for follow-up.',
          timestamp: "2026-07-25T08:01:00.000Z",
          agentMessage: {
            source: "child-legacy",
            sourceLabel: "Worker",
            sourceSessionSource: "subagent",
            kind: "readiness",
            deliveryMode: "queue",
            sequence: 1,
            target: "parent-legacy-readiness",
            processedAt: "2026-07-25T08:01:00.000Z",
            readinessGeneration: "legacy:subagent-idle:child-legacy:2026-07-25T08:01:00.000Z",
          },
        },
      ],
    };
    const child: PersistedSession = {
      id: "child-legacy",
      name: "Worker",
      source: "subagent",
      parentSessionId: parent.id,
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [
        {
          id: "legacy-work",
          role: "user",
          content: "Do the work",
          timestamp: "2026-07-25T08:00:00.000Z",
        },
      ],
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const manager = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(manager);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === parent.id) return parent;
      if (sessionId === child.id) return child;
      return null;
    });
    mockCurrentRuntimeIndex(access, [parent, child]);
    const send = vi.spyOn(backend.sessions, "send");

    await manager.noteSubagentIdle(child, Date.parse("2026-07-25T08:02:00.000Z"), {
      wasBusy: true,
    });

    expect(parent.messages).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("coalesces a large readiness wave while direct siblings are still active", async () => {
    vi.useFakeTimers();
    const parent: PersistedSession = {
      id: "large-readiness-parent",
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    const readyChildren: PersistedSession[] = Array.from({ length: 8 }, (_, index) => ({
      id: `large-readiness-ready-${index}`,
      name: `Ready worker ${index}`,
      source: "subagent",
      parentSessionId: parent.id,
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [
        {
          id: `large-readiness-work-${index}`,
          role: "user",
          content: "Do work",
          timestamp: "",
        },
      ],
    }));
    const activeSibling: PersistedSession = {
      id: "large-readiness-active",
      name: "Still active worker",
      source: "subagent",
      parentSessionId: parent.id,
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [
        { id: "large-readiness-active-work", role: "user", content: "Do work", timestamp: "" },
      ],
    };
    const sessions = [parent, ...readyChildren, activeSibling];
    const { SessionManager } = await import("./sessions");
    const manager = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(manager);
    vi.spyOn(access.store, "loadSessionData").mockImplementation(
      (sessionId) => sessions.find((session) => session.id === sessionId) ?? null,
    );
    vi.spyOn(access.store, "loadSessionHeader").mockImplementation((sessionId) => {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      return session ? { ...session, messageCount: session.messages.length } : null;
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    mockCurrentRuntimeIndex(access, sessions);
    const { sendAndCollect: wake } = wireReadinessWakeIntegration(manager);

    access.busyTracker.setBusy(activeSibling.id);
    await Promise.all(
      readyChildren.map((child) => manager.noteSubagentIdle(child, Date.now(), { wasBusy: true })),
    );
    await vi.advanceTimersByTimeAsync(250);

    expect(wake).not.toHaveBeenCalled();
    expect(access.pendingParentReadinessWakes.get(parent.id)?.size).toBe(8);

    access.busyTracker.setIdle(activeSibling.id);
    await access.flushParentReadinessWake(parent.id);

    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]?.[0]).toContain("8 new readiness generations");
    await wake.mock.calls[0]?.[5]?.onBackendDelivered?.();
    expect(access.pendingParentReadinessWakes.has(parent.id)).toBe(false);
  });

  it("batches nested readiness per direct owner without bubbling hidden wake generations", async () => {
    vi.useFakeTimers();
    const root: PersistedSession = {
      id: "root-agent",
      name: "Root",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    const coordinator: PersistedSession = {
      id: "coordinator-agent",
      name: "Coordinator",
      source: "subagent",
      parentSessionId: root.id,
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [{ id: "coordinate-1", role: "user", content: "Coordinate", timestamp: "" }],
    };
    const validators: PersistedSession[] = [
      {
        id: "frontend-validator",
        name: "Frontend validator",
        source: "subagent",
        parentSessionId: coordinator.id,
        backendOrigin: "copilot",
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: true,
        messages: [{ id: "frontend-work-1", role: "user", content: "Validate UI", timestamp: "" }],
      },
      {
        id: "backend-validator",
        name: "Backend validator",
        source: "subagent",
        parentSessionId: coordinator.id,
        backendOrigin: "copilot",
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: true,
        messages: [{ id: "backend-work-1", role: "user", content: "Validate API", timestamp: "" }],
      },
    ];
    const sessions = new Map<string, PersistedSession>([
      [root.id, root],
      [coordinator.id, coordinator],
      ...validators.map((session) => [session.id, session] as const),
    ]);
    const backend = await createTestBackend();
    const send = vi.spyOn(backend.sessions, "send");
    const makeManager = async () => {
      const { SessionManager } = await import("./sessions");
      const manager = new SessionManager("/test/workspace", backend);
      const access = new SessionTestAccess(manager);
      vi.spyOn(access.store, "loadSessionData").mockImplementation(
        (sessionId) => sessions.get(sessionId) ?? null,
      );
      vi.spyOn(access.store, "saveSessionData").mockImplementation((session) => {
        sessions.set(session.id, session);
      });
      mockCurrentRuntimeIndex(access, [...sessions.values()]);
      access.currentSessionId = root.id;
      const { sendAndCollect: wake } = wireReadinessWakeIntegration(manager);
      return { manager, access, wake };
    };
    let { manager, wake } = await makeManager();

    await Promise.all(
      validators.map(async (validator) => {
        await manager.noteSubagentIdle(validator, Date.now(), { wasBusy: false });
        await Promise.all([
          manager.noteSubagentIdle(validator, Date.now(), { wasBusy: true }),
          manager.noteSubagentIdle(validator, Date.now(), { wasBusy: true }),
        ]);
      }),
    );
    await vi.advanceTimersByTimeAsync(250);

    expect(root.messages).toEqual([]);
    expect(
      coordinator.messages.filter((message) => message.agentMessage?.kind === "readiness"),
    ).toEqual([
      expect.objectContaining({
        id: "subagent-ready:coordinator-agent:frontend-validator:frontend-work-1",
      }),
      expect.objectContaining({
        id: "subagent-ready:coordinator-agent:backend-validator:backend-work-1",
      }),
    ]);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]?.[0]).toEqual(
      expect.stringMatching(
        /frontend-validator[\s\S]*backend-validator|backend-validator[\s\S]*frontend-validator/,
      ),
    );
    expect(wake.mock.calls[0]?.[3]).toBe(coordinator.id);
    expect(send).not.toHaveBeenCalled();
    expect(
      [...root.messages, ...coordinator.messages].filter(
        (message) => message.role === "assistant" && !message.content.trim(),
      ),
    ).toEqual([]);

    ({ manager, wake } = await makeManager());
    await Promise.all(
      validators.map(async (validator) => {
        await manager.noteSubagentIdle(validator, Date.now(), { wasBusy: false });
        await manager.noteSubagentIdle(validator, Date.now(), { wasBusy: true });
      }),
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(
      coordinator.messages.filter((message) => message.agentMessage?.kind === "readiness"),
    ).toHaveLength(2);
    expect(wake).not.toHaveBeenCalled();

    coordinator.messages.push({
      id: "coordinate-2",
      role: "user",
      content: "Integrate validator results",
      timestamp: new Date().toISOString(),
    });
    coordinator.messages.push({
      id: "subagent-readiness:coordinator-agent:test",
      role: "user",
      content: "PRIVATE_READINESS_CONTROL",
      timestamp: new Date().toISOString(),
      internalControl: {
        kind: "subagent-readiness",
        exchangeId: "subagent-readiness:coordinator-agent:test",
        side: "request",
      },
    });
    await manager.noteSubagentIdle(coordinator, Date.now(), { wasBusy: true });
    await manager.noteSubagentIdle(coordinator, Date.now(), { wasBusy: true });
    await vi.advanceTimersByTimeAsync(250);

    expect(root.messages).toEqual([
      expect.objectContaining({
        id: "subagent-ready:root-agent:coordinator-agent:coordinate-2",
        agentMessage: expect.objectContaining({
          source: coordinator.id,
          target: root.id,
          kind: "readiness",
          readinessGeneration: "coordinate-2",
        }),
      }),
    ]);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]?.[0]).toContain(coordinator.id);
    expect(wake.mock.calls[0]?.[3]).toBe(root.id);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("SessionManager.sendReviewCommentsToSession", () => {
  it("uses stable review UI provenance instead of the globally selected session", async () => {
    const target: PersistedSession = {
      id: "review-target",
      name: "Review target",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      messages: [],
    };
    const unrelated: PersistedSession = {
      id: "selected-subagent",
      name: "Unrelated selected worker",
      source: "subagent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      messages: [],
    };
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    access.currentSessionId = unrelated.id;
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === target.id) return target;
      if (sessionId === unrelated.id) return unrelated;
      return null;
    });
    const outbox = await attachTestAgentMessageOutbox(mgr, { pauseDispatch: true });

    const result = await mgr.sendReviewCommentsToSession({
      sessionId: target.id,
      message: "Please address the review.",
    });

    expectDurablyAccepted(result);
    if (!result.messageId) throw new Error("Expected message ID");
    expect(outbox.get(result.messageId)).toMatchObject({
      source: "review-ui",
      sourceLabel: "Review UI",
      kind: "review-feedback",
      target: target.id,
    });
    expect(outbox.get(result.messageId)?.sourceSessionSource).toBeUndefined();
  });

  it("returns a retryable result when collection times out before backend acceptance", async () => {
    const target: PersistedSession = {
      id: "review-timeout-target",
      name: "Review target",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      messages: [],
    };
    const message: AgentMessageRecord = {
      messageId: "review-timeout-message",
      idempotencyKey: "review-timeout-message",
      source: "review-ui",
      sourceLabel: "Review UI",
      target: target.id,
      kind: "review-feedback",
      deliveryMode: "queue",
      priority: 0,
      sequence: 1,
      content: "Review feedback",
      attempts: 1,
      state: "leased",
      acceptedAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
    };
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(target);
    vi.spyOn(mgr, "sendAndCollect").mockResolvedValue({ kind: "timeout", text: "" });

    await expect(
      mgr.deliverAgentMessage(message, {
        markBackendAccepted: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        markBackendDelivered: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      }),
    ).resolves.toEqual({
      state: "pending",
      error: "Target did not finish before the delivery timeout",
    });
  });

  it("does not process an accepted agent message after the target turn is cancelled", async () => {
    const session: PersistedSession = {
      id: "cancelled-review-target",
      name: "Review target",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(session);
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    access.sessionHandles.set(session.id, {
      sessionId: session.id,
      backendId: "sdk-cancelled-review",
    });
    const sendGate = deferredPromise<void>();
    vi.spyOn(backend.sessions, "send").mockImplementation(async () => await sendGate.promise);
    vi.spyOn(backend.sessions, "abort").mockResolvedValue({});
    const viewEvents: import("../common/marshal-ipc-contract").SessionViewEvent[] = [];
    mgr.addViewEventListener((_sessionId, event) => viewEvents.push(event));
    const outbox = await attachTestAgentMessageOutbox(mgr);
    const accepted = await mgr.sendReviewCommentsToSession({
      sessionId: session.id,
      message: "Review before cancellation",
    });
    expectDurablyAccepted(accepted);
    const messageId = accepted.messageId;
    if (!messageId) throw new Error("Expected durable message ID");
    await vi.waitFor(() => expect(outbox.get(messageId)?.state).toBe("backend-accepted"));

    await mgr.cancelTurn(session.id);
    await vi.waitFor(() => expect(outbox.get(messageId)?.state).toBe("delivery-unknown"));
    sendGate.resolve(undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(access.busyTracker.isBusy(session.id)).toBe(false);
    expect(outbox.get(messageId)?.state).toBe("delivery-unknown");
    expect(outbox.get(messageId)).not.toHaveProperty("backendDeliveredAt");
    expect(session.messages.filter((message) => message.id === messageId)).toHaveLength(1);
    expect(viewEvents.some((event) => event.view.error !== null)).toBe(false);
  });
});

describe("SessionManager.sendMessageToParent — store resolution", () => {
  it("does not wait for the parent turn when waitForResponse is false", async () => {
    const childId = "sub-detached-parent";
    const parentId = "parent-detached-parent";
    const child: PersistedSession = {
      id: childId,
      name: "Subagent: detached parent",
      source: "subagent",
      parentSessionId: parentId,
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      messages: [{ id: "child-m1", role: "user", content: "Initial task", timestamp: "" }],
    };
    const parent: PersistedSession = {
      id: parentId,
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      messages: [{ id: "parent-m1", role: "user", content: "Spawn subagent", timestamp: "" }],
    };

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    let childAvailable = true;
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === childId) return childAvailable ? child : null;
      if (sessionId === parentId) return parent;
      return null;
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});

    const mockSend = vi.fn<() => Promise<void>>().mockReturnValue(new Promise(() => {}));
    access.activeSessions.set(parentId, { send: mockSend, on: vi.fn<() => void>() });
    access.sessionHandles.set(parentId, { sessionId: parentId, backendId: "sdk-parent-detached" });
    const outbox = await attachTestAgentMessageOutbox(mgr, { pauseDispatch: true });

    const result = await Promise.race([
      mgr.sendMessageToParent({ sessionId: childId, message: "final handoff" }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);

    expectDurablyAccepted(result);
    if (result === "timeout" || !result.messageId) throw new Error("Expected message ID");
    expect(outbox.get(result.messageId)).toMatchObject({
      sourceLabel: "Subagent: detached parent",
      sourceSessionSource: "subagent",
    });
    childAvailable = false;
    outbox.resumeAfterRuntimeReset();
    await vi.waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: `Message from subagent Subagent: detached parent (${childId}):\n\nfinal handoff`,
        }),
      ),
    );
    const deliveredMessage = parent.messages.at(-1);
    expect(deliveredMessage).toMatchObject({
      id: expect.any(String),
      role: "user",
      content: `Message from subagent Subagent: detached parent (${childId}):\n\nfinal handoff`,
      agentMessage: {
        messageId: expect.any(String),
        idempotencyKey: expect.any(String),
        source: childId,
        target: parentId,
        kind: "parent",
        deliveryMode: "queue",
        priority: 10,
        sequence: expect.any(Number),
        attempts: 1,
        state: "leased",
        acceptedAt: expect.any(String),
        updatedAt: expect.any(String),
        sourceLabel: "Subagent: detached parent",
        sourceSessionSource: "subagent",
      },
    });
    expect(deliveredMessage?.id).toBe(deliveredMessage?.agentMessage?.messageId);
    expect(deliveredMessage?.agentMessage).not.toHaveProperty("content");
  });

  it("refuses to send a parent message back into the same session", async () => {
    const id = "sub-self-parent";
    const session: PersistedSession = {
      id,
      name: "Subagent: self parent",
      source: "subagent",
      parentSessionId: id,
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      messages: [{ id: "child-m1", role: "user", content: "Initial task", timestamp: "" }],
    };

    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const sendSpy = vi.spyOn(backend.sessions, "send").mockResolvedValue(undefined);
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) =>
      sessionId === id ? session : null,
    );

    const result = await mgr.sendMessageToParent({
      sessionId: id,
      message: "final handoff",
    });

    expect(result).toEqual({
      success: false,
      error: "This session is configured as its own parent",
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("returns immediately for queued fire-and-forget parent delivery and sends after idle", async () => {
    const childId = "sub-queued-parent";
    const parentId = "parent-queued-parent";
    const child: PersistedSession = {
      id: childId,
      name: "Subagent: queued parent",
      source: "subagent",
      parentSessionId: parentId,
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      messages: [{ id: "child-m1", role: "user", content: "Initial task", timestamp: "" }],
    };
    const parent: PersistedSession = {
      id: parentId,
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      messages: [{ id: "parent-m1", role: "user", content: "Spawn subagent", timestamp: "" }],
    };

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === childId) return child;
      if (sessionId === parentId) return parent;
      return null;
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    const mockSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    access.activeSessions.set(parentId, { send: mockSend, on: vi.fn<() => void>() });
    access.sessionHandles.set(parentId, { sessionId: parentId, backendId: "sdk-parent-queued" });
    access.busyTracker.setBusy(parentId);
    await attachTestAgentMessageOutbox(mgr);

    const result = await Promise.race([
      mgr.sendMessageToParent({ sessionId: childId, message: "final handoff" }),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);

    expectDurablyAccepted(result);
    expect(mockSend).not.toHaveBeenCalled();

    access.busyTracker.setIdle(parentId);

    await vi.waitFor(() =>
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: `Message from subagent Subagent: queued parent (${childId}):\n\nfinal handoff`,
        }),
      ),
    );
  });
});

describe("SessionManager subagent interrupt through the outbox", () => {
  it("cancels a turn started by an earlier message and delivers the backlog with the interrupt", async () => {
    const childId = "sub-interrupt-outbox";
    const parentId = "parent-interrupt-outbox";
    const child: PersistedSession = {
      id: childId,
      name: "Subagent: interrupted",
      source: "subagent",
      parentSessionId: parentId,
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      messages: [{ id: "child-m1", role: "user", content: "Initial task", timestamp: "" }],
    };
    const parent: PersistedSession = {
      id: parentId,
      name: "Parent",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      messages: [],
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockImplementation((sessionId) => {
      if (sessionId === childId) return child;
      if (sessionId === parentId) return parent;
      return null;
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    const abort = vi.spyOn(backend.sessions, "abort").mockResolvedValue({});
    const backendSend = vi.spyOn(backend.sessions, "send");
    const mockSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    access.activeSessions.set(childId, { send: mockSend, on: vi.fn<() => void>() });
    access.sessionHandles.set(childId, { sessionId: childId, backendId: "sdk-child-interrupt" });
    await attachTestAgentMessageOutbox(mgr);
    const prompts = (): string[] =>
      backendSend.mock.calls.map((call) => {
        const options = (call as unknown[]).find(
          (arg): arg is { prompt: string } =>
            typeof arg === "object" && arg !== null && "prompt" in arg,
        );
        return options?.prompt ?? "";
      });

    const send = (message: string, deliveryMode: "queue" | "interrupt") =>
      mgr.sendMessageToSubagent({
        sessionId: childId,
        message,
        deliveryMode,
        sourceSessionId: parentId,
      });
    await send("long task", "queue");
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    expect(mgr.isSessionBusy(childId)).toBe(true);
    await send("old plan", "queue");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prompts()).toHaveLength(1);

    await send("new plan", "interrupt");

    await vi.waitFor(() => expect(abort).toHaveBeenCalled());
    await vi.waitFor(() => expect(prompts()).toHaveLength(2));
    const batch = prompts()[1];
    expect(batch).toContain("2 messages were queued");
    expect(batch.indexOf("old plan")).toBeLessThan(batch.indexOf("new plan"));
    const committed = child.messages.filter((message) => message.content.includes("new plan"));
    expect(committed).toHaveLength(1);
    expect(committed[0].agentMessage?.coalescedMessageCount).toBe(2);
    expect(mgr.countQueuedAgentMessages(childId)).toBe(0);
  });
});

describe("SessionManager.generateTitle — deterministic fallback", () => {
  it("sets an intent-based fallback when inference returns empty", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "sess-fb", name: DEFAULT_SESSION_NAME, updatedAt: "", backendOrigin: "copilot" },
          ],
        });
      }
      if (path.includes("sess-fb")) {
        return JSON.stringify({
          id: "sess-fb",
          name: DEFAULT_SESSION_NAME,
          backendOrigin: "copilot" as const,
          messages: [
            { id: "1", role: "user", content: "Hello" },
            { id: "2", role: "assistant", content: "Hi" },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);

    // Mock the backend's infer to return empty string (triggers date fallback)
    vi.spyOn(backend, "infer").mockResolvedValue("");

    const title = await mgr.generateTitle("sess-fb");
    expect(title).toBe("Hello");
  });

  it("preserves quick-title when LLM returns empty (no date clobber)", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            {
              id: "sess-qt-fb",
              name: "help me with typescript",
              updatedAt: "",
              backendOrigin: "copilot",
            },
          ],
        });
      }
      if (path.includes("sess-qt-fb")) {
        return JSON.stringify({
          id: "sess-qt-fb",
          name: "help me with typescript",
          backendOrigin: "copilot" as const,
          aiGeneratedTitle: "help me with typescript",
          messages: [
            { id: "1", role: "user", content: "help me with typescript" },
            { id: "2", role: "assistant", content: "Sure, what do you need?" },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);

    // Empty infer result (timeout, unavailable model, etc.) must NOT clobber
    // the quick-title with a generic date — the user's words are a better label.
    vi.spyOn(backend, "infer").mockResolvedValue("");

    // generateTitle writes via renameSession; spying ensures no clobber.
    const renameSpy = vi.spyOn(mgr, "renameSession").mockResolvedValue();

    const title = await mgr.generateTitle("sess-qt-fb");
    expect(title).toBeNull();
    expect(renameSpy).not.toHaveBeenCalled();
  });
});

describe("SessionManager.renameSession — emits turn:metadata-updated", () => {
  it("emits turn:metadata-updated on manual rename", async () => {
    mockedFs.existsSync.mockImplementation(
      (path: any) => !String(path).endsWith("session-store.db"),
    );
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [{ id: "sess-ev", name: "Old Name", updatedAt: "", backendOrigin: "copilot" }],
        });
      }
      if (path.includes("sess-ev")) {
        return JSON.stringify({
          id: "sess-ev",
          name: "Old Name",
          messages: [],
          backendOrigin: "copilot",
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const listener = vi.fn<(sessionId: string, event: unknown) => void>();
    mgr.addEventListener(listener);

    await mgr.renameSession("sess-ev", "New Name");

    expect(listener).toHaveBeenCalledWith("sess-ev", {
      type: "turn:metadata-updated",
      changes: { name: "New Name", updatedAt: expect.any(String) },
    });
  });

  it("emits turn:metadata-updated on auto rename (with aiGeneratedTitle)", async () => {
    mockedFs.existsSync.mockImplementation(
      (path: any) => !String(path).endsWith("session-store.db"),
    );
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "sess-ev2", name: "Quick title", updatedAt: "", backendOrigin: "copilot" },
          ],
        });
      }
      if (path.includes("sess-ev2")) {
        return JSON.stringify({
          id: "sess-ev2",
          name: "Quick title",
          backendOrigin: "copilot" as const,
          aiGeneratedTitle: "Quick title",
          messages: [],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    const listener = vi.fn<(sessionId: string, event: unknown) => void>();
    mgr.addEventListener(listener);

    await mgr.renameSession("sess-ev2", "AI Title", "AI Title");

    expect(listener).toHaveBeenCalledWith("sess-ev2", {
      type: "turn:metadata-updated",
      changes: { name: "AI Title", updatedAt: expect.any(String) },
    });
  });
});

describe("SessionManager.switchSession — index-only session hydration", () => {
  async function setup(
    id: string,
    opts: {
      indexEntry?: Partial<SessionMetadata>;
      fetched?: StoredSession | null;
      fetchedPromise?: Promise<StoredSession | null>;
    },
  ) {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) {
        return JSON.stringify({
          sessions: [
            {
              id,
              name: "Cron-spawned",
              updatedAt: "",
              backendOrigin: "copilot",
              hasUnread: true,
              ...opts.indexEntry,
            },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();

    const fetchSpy = vi.spyOn(backend.sessions, "fetchSessionData");
    if (opts.fetchedPromise) fetchSpy.mockReturnValue(opts.fetchedPromise);
    else fetchSpy.mockResolvedValue(opts.fetched ?? null);

    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    access.sessionHandles.set(id, {});

    let saved = null as PersistedSession | null;
    vi.spyOn(access.store, "loadSessionData").mockImplementation((q) => (q === id ? saved : null));
    vi.spyOn(access.store, "saveSessionData").mockImplementation((s) => {
      saved = s;
    });

    const hydrationEvents: SessionHydrationEvent[] = [];
    mgr.addHydrationListener((evt) => hydrationEvents.push(evt));

    return { mgr, fetchSpy, hydrationEvents, getSaved: () => saved };
  }

  it("index-only switch: emits started → loaded, persists once, returns null", async () => {
    const id = "sess-cron-spawn";
    const populated: StoredSession = {
      id,
      name: "Cron-spawned",
      messages: [{ id: "m1", role: "user", content: "hi", timestamp: "2026-05-13T14:00:00Z" }],
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
    };
    const { mgr, fetchSpy, hydrationEvents, getSaved } = await setup(id, {
      fetched: populated,
    });

    const result = await mgr.switchSession(id);

    expect(result.kind).toBe("hydrating");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(hydrationEvents.map((e) => e.state)).toEqual(["started", "loaded"]);
    expect(getSaved()?.messages).toHaveLength(1);
  });

  it("index-only switch: emits started → failed when fetchSessionData returns null", async () => {
    const id = "sess-fetch-fail";
    const { mgr, hydrationEvents, getSaved } = await setup(id, { fetched: null });

    const result = await mgr.switchSession(id);

    expect(result.kind).toBe("hydrating");
    expect(hydrationEvents.map((e) => e.state)).toEqual(["started", "failed"]);
    expect(getSaved()).toBeNull();
  });

  it("index-only switch: concurrent same-id calls join the in-flight fetch", async () => {
    const id = "sess-dup-click";
    let resolveFetch!: (s: StoredSession | null) => void;
    const fetchedPromise = new Promise<StoredSession | null>((r) => {
      resolveFetch = r;
    });
    const { mgr, fetchSpy, hydrationEvents } = await setup(id, { fetchedPromise });

    const first = mgr.switchSession(id);
    const second = mgr.switchSession(id);
    // Resolve with null so we don't have to construct a populated session
    // for an assertion that's about dedup, not about loaded-vs-failed. The
    // load-vs-fail invariant is covered by the two preceding tests.
    resolveFetch(null);
    await Promise.all([first, second]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(hydrationEvents.map((e) => e.state)).toEqual(["started", "failed"]);
  });

  it("deleteSession clears fetchInFlight so a resolved fetch can't write an orphaned data file", async () => {
    const id = "sess-delete-during-fetch";
    let resolveFetch!: (s: StoredSession | null) => void;
    const fetchedPromise = new Promise<StoredSession | null>((r) => {
      resolveFetch = r;
    });
    const { mgr, hydrationEvents, getSaved } = await setup(id, { fetchedPromise });

    await mgr.switchSession(id);
    await mgr.deleteSession(id);
    // Resolve AFTER delete — the .then's fetchInFlight identity check must
    // suppress the saveSessionData + loaded emit.
    resolveFetch({
      id,
      name: "Cron-spawned",
      messages: [{ id: "m1", role: "user", content: "hi", timestamp: "2026-05-13T14:00:00Z" }],
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
    });

    await vi.waitFor(() =>
      expect(hydrationEvents.find((e) => e.state === "started")).toBeDefined(),
    );
    // Give the resolved-after-delete chain a tick to attempt the (suppressed) write.
    await Promise.resolve();
    await Promise.resolve();

    expect(getSaved()).toBeNull();
    expect(hydrationEvents.find((e) => e.state === "loaded")).toBeUndefined();
  });

  it("index-only switch: catches unexpected fetchSessionData rejection and emits failed with error", async () => {
    const id = "sess-fetch-boom";
    const { mgr, hydrationEvents } = await setup(id, {
      fetchedPromise: Promise.reject(new Error("network blip")),
    });

    const result = await mgr.switchSession(id);
    expect(result.kind).toBe("hydrating");

    await vi.waitFor(() => expect(hydrationEvents.find((e) => e.state === "failed")).toBeDefined());
    const failed = hydrationEvents.find((e) => e.state === "failed");
    // Narrow + assert in one shape so oxlint's vitest/no-conditional-expect
    // is happy: an unconditional expect on the narrowed payload.
    expect(failed && "error" in failed ? failed.error : undefined).toContain("network blip");
  });
});

describe("SessionManager.getSessionAsync", () => {
  async function setup() {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue("{}");
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const store = new SessionTestAccess(mgr).store;
    return { mgr, store, runtimeId: backend.runtimeId };
  }

  const session = (id: string, runtimeId: string): PersistedSession => ({
    id,
    runtimeId,
    name: "s",
    createdAt: "",
    updatedAt: "",
    hasUnread: false,
    backendOrigin: "copilot" as const,
    isActive: false,
    messages: [],
  });

  it("returns the stored session", async () => {
    const { mgr, store, runtimeId } = await setup();
    const sync = vi.spyOn(store, "loadSessionData").mockReturnValue(session("warm", runtimeId));

    const result = await mgr.getSessionAsync("warm");

    expect(result?.id).toBe("warm");
    expect(sync).toHaveBeenCalledWith("warm");
  });

  it("returns null when the store has no data for the session", async () => {
    const { mgr, store } = await setup();
    vi.spyOn(store, "loadSessionData").mockReturnValue(null);

    const result = await mgr.getSessionAsync("missing");

    expect(result).toBeNull();
  });
});

describe("SessionManager.getSessionScopeAsync", () => {
  async function setup() {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    return { mgr, store: new SessionTestAccess(mgr).store };
  }

  const header = (id: string, extra: Partial<PersistedSession> = {}) =>
    testDouble<SessionHeader>({
      id,
      name: "s",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: false,
      messageCount: 3,
      ...extra,
    });

  it("reads the local header without loading the message history", async () => {
    const { mgr, store } = await setup();
    vi.spyOn(store, "loadSessionHeader").mockReturnValue(
      header("h", { workspaceName: "acme", runtimeId: "copilot" }),
    );
    const full = vi.spyOn(store, "loadSessionData");

    const result = await mgr.getSessionScopeAsync("h");

    expect(result?.workspaceName).toBe("acme");
    expect(full).not.toHaveBeenCalled();
  });

  it("hides a local header that belongs to another runtime", async () => {
    const { mgr, store } = await setup();
    vi.spyOn(store, "loadSessionHeader").mockReturnValue(
      header("codex-session", { runtimeId: "codex", backendOrigin: "copilot" }),
    );

    await expect(mgr.getSessionScopeAsync("codex-session")).resolves.toBeNull();
  });
});

describe("withIndexLock — race condition prevention", () => {
  it("concurrent createSession calls don't overwrite each other in the index", async () => {
    // In-memory disk store so loadIndex() always reads what saveIndex() last wrote
    let indexOnDisk = JSON.stringify({ sessions: [], activeSessionId: null });

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) return indexOnDisk;
      return "{}";
    });
    mockedFs.writeFileSync.mockImplementation((p: any, data: any) => {
      if (String(p).includes("index.json")) {
        indexOnDisk = String(data);
      }
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    // Stub initClient + createSDKSession to avoid real SDK
    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
    vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined);

    // Fire 3 concurrent createSession calls
    const [s1, s2, s3] = await Promise.all([
      mgr.createSession(),
      mgr.createSession(),
      mgr.createSession(),
    ]);

    // All 3 sessions must be in the index — no overwrites
    const finalIndex = JSON.parse(indexOnDisk);
    expect(finalIndex.sessions).toHaveLength(3);

    const ids = finalIndex.sessions.map((s: { id: string }) => s.id);
    expect(ids).toContain(s1.id);
    expect(ids).toContain(s2.id);
    expect(ids).toContain(s3.id);
  });

  it("concurrent create + delete don't lose the created session", async () => {
    const existingSession = {
      id: "to-delete",
      name: "Old session",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: false,
    };
    let indexOnDisk = JSON.stringify({
      sessions: [existingSession],
      activeSessionId: "to-delete",
    });
    const sessionFiles = new Map<string, string>();
    sessionFiles.set(
      "to-delete",
      JSON.stringify({
        ...existingSession,
        messages: [],
      }),
    );

    mockedFs.existsSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) return true;
      for (const id of sessionFiles.keys()) {
        if (path.includes(id)) return true;
      }
      return false;
    });
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) return indexOnDisk;
      for (const [id, data] of sessionFiles) {
        if (path.includes(id)) return data;
      }
      return "{}";
    });
    mockedFs.writeFileSync.mockImplementation((p: any, data: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        indexOnDisk = String(data);
      } else {
        // session data writes
        for (const id of sessionFiles.keys()) {
          if (path.includes(id)) {
            sessionFiles.set(id, String(data));
            return;
          }
        }
      }
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
    vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined);

    // Fire create + delete concurrently
    const [created] = await Promise.all([mgr.createSession(), mgr.deleteSession("to-delete")]);

    const finalIndex = JSON.parse(indexOnDisk);
    // The created session must survive, the deleted one must be gone
    const ids = finalIndex.sessions.map((s: { id: string }) => s.id);
    expect(ids).toContain(created.id);
    expect(ids).not.toContain("to-delete");
    expect(finalIndex.sessions).toHaveLength(1);
  });

  it("withIndexLock serializes: second mutation sees first mutation's result", async () => {
    let indexOnDisk = JSON.stringify({ sessions: [], activeSessionId: null });

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) return indexOnDisk;
      return "{}";
    });
    mockedFs.writeFileSync.mockImplementation((p: any, data: any) => {
      if (String(p).includes("index.json")) indexOnDisk = String(data);
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
    vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined);

    // Sequential creates — each should see the previous one
    await mgr.createSession();
    await mgr.createSession();

    const finalIndex = JSON.parse(indexOnDisk);
    expect(finalIndex.sessions).toHaveLength(2);
  });

  it("error in one locked operation doesn't block subsequent operations", async () => {
    let indexOnDisk = JSON.stringify({ sessions: [], activeSessionId: null });

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) return indexOnDisk;
      return "{}";
    });
    mockedFs.writeFileSync.mockImplementation((p: any, data: any) => {
      if (String(p).includes("index.json")) indexOnDisk = String(data);
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
    vi.spyOn(mgr as any, "createBackendSession")
      .mockRejectedValueOnce(new Error("SDK fail"))
      .mockResolvedValue(undefined);

    // First create fails (SDK error) — session file is cleaned up
    await expect(mgr.createSession()).rejects.toThrow("SDK fail");

    // Second create should still work — queue must not be stuck
    const session = await mgr.createSession();
    const finalIndex = JSON.parse(indexOnDisk);
    expect(finalIndex.sessions).toHaveLength(1);
    expect(finalIndex.sessions[0].id).toBe(session.id);
  });
});

describe("isAutomatedSession", () => {
  let mgr: import("./sessions").SessionManager;

  beforeAll(async () => {
    const { SessionManager } = await import("./sessions");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
    mgr = new (SessionManager as any)("", {}) as import("./sessions").SessionManager;
  });

  it("returns false for user sessions", () => {
    expect(mgr.isAutomatedSession({ source: "user" })).toBe(false);
  });

  it("returns false for workspace sessions (interactive Co-Create UI)", () => {
    expect(mgr.isAutomatedSession({ source: "workspace" })).toBe(false);
  });

  it("returns false for undefined source (legacy sessions)", () => {
    expect(mgr.isAutomatedSession({ source: undefined })).toBe(false);
    expect(mgr.isAutomatedSession(null)).toBe(false);
  });

  it("returns true for automation sessions", () => {
    expect(mgr.isAutomatedSession({ source: "automation" })).toBe(true);
  });

  it("returns true for legacy workflow sessions", () => {
    expect(mgr.isAutomatedSession({ source: "workflow" })).toBe(true);
  });

  it("returns false for legacy teams sessions (they normalize to user)", () => {
    expect(mgr.isAutomatedSession({ source: "teams" })).toBe(false);
  });

  it("returns true for heartbeat sessions", () => {
    expect(mgr.isAutomatedSession({ source: "heartbeat" })).toBe(true);
  });
});

describe("heartbeat session schema validation", () => {
  it("SessionMetadataSchema accepts source: heartbeat", async () => {
    const { SessionMetadataSchema } = await import("./schemas/session-schema");
    const result = SessionMetadataSchema.safeParse({
      id: "hb-1",
      name: "Heartbeat",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: false,
      source: "heartbeat",
    });
    const data = expectZodSuccess(result);
    expect(data.source).toBe("heartbeat");
  });

  it("StoredSessionSchema preserves source: heartbeat on round-trip", async () => {
    const { StoredSessionSchema } = await import("./schemas/session-schema");
    const session = {
      id: "hb-2",
      name: "Heartbeat",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: false,
      source: "heartbeat",
      messages: [],
    };
    const result = StoredSessionSchema.safeParse(session);
    const data = expectZodSuccess(result);
    expect(data.source).toBe("heartbeat");
  });
});

describe("isPinned schema round-trip", () => {
  // SessionMetadataSchema is .strip(), so an index row loses any field the
  // schema does not declare. Pinning lives on the index row, so a missing
  // declaration would make pins silently vanish on the next index write with
  // nothing failing anywhere.
  it("SessionMetadataSchema preserves isPinned through .strip()", async () => {
    const { SessionMetadataSchema } = await import("./schemas/session-schema");
    const result = SessionMetadataSchema.safeParse({
      id: "pin-1",
      name: "Test",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: false,
      isPinned: true,
    });
    const data = expectZodSuccess(result);
    expect(data.isPinned).toBe(true);
  });

  it("leaves isPinned absent for sessions written before pinning existed", async () => {
    const { SessionMetadataSchema } = await import("./schemas/session-schema");
    const result = SessionMetadataSchema.safeParse({
      id: "pre-pin",
      name: "Test",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: false,
    });
    const data = expectZodSuccess(result);
    expect("isPinned" in data).toBe(false);
  });

  it("StoredSessionSchema preserves isPinned on round-trip", async () => {
    const { StoredSessionSchema } = await import("./schemas/session-schema");
    const result = StoredSessionSchema.safeParse({
      id: "pin-2",
      name: "Test",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: false,
      isPinned: true,
      messages: [],
    });
    const data = expectZodSuccess(result);
    expect(data.isPinned).toBe(true);
  });
});

describe("setPinned", () => {
  // The schema round-trip tests above guard the index row's SHAPE. They cannot
  // catch the write path refusing to reach the index at all, which is what
  // actually broke: pinning silently no-opped for every session whose local
  // data file was absent, while the optimistic UI briefly showed a pin.
  const makeIndex = (rows: SessionMetadata[]) => ({
    sessions: rows,
    activeSessionId: null,
  });
  const row = (overrides: Partial<SessionMetadata> & { id: string }): SessionMetadata => ({
    name: "Thread",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    hasUnread: false,
    backendOrigin: "copilot" as const,
    isActive: false,
    ...overrides,
  });

  it("pins a session that has an index row but no local data file", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const index = makeIndex([row({ id: "s1" })]);

    // A row can outlive its data file.
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(null);
    vi.spyOn(access.store, "loadIndex").mockReturnValue(index);
    vi.spyOn(access.store, "withIndexLock").mockImplementation(async (fn) => fn(index));

    const applied = await mgr.setPinned("s1", true);

    expect(applied).toBe(true);
    expect(index.sessions[0]?.isPinned).toBe(true);
  });

  it("reports failure for an unknown session instead of an unconditional success", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const index = makeIndex([]);
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(null);
    vi.spyOn(access.store, "loadIndex").mockReturnValue(index);
    const lock = vi
      .spyOn(access.store, "withIndexLock")
      .mockImplementation(async (fn) => fn(index));

    expect(await mgr.setPinned("missing", true)).toBe(false);
    expect(lock).not.toHaveBeenCalled();
  });

  it("still writes the data file when one is present, so pins survive an index rebuild", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const index = makeIndex([row({ id: "s2" })]);
    const stored: PersistedSession = {
      id: "s2",
      name: "Thread",
      backendOrigin: "copilot",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      hasUnread: false,
      isActive: false,
      messages: [],
    };
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(stored);
    vi.spyOn(access.store, "loadIndex").mockReturnValue(index);
    vi.spyOn(access.store, "withIndexLock").mockImplementation(async (fn) => fn(index));
    const save = vi.spyOn(access.store, "saveSessionData").mockImplementation(() => undefined);

    expect(await mgr.setPinned("s2", true)).toBe(true);
    expect(save).toHaveBeenCalledOnce();
    expect(stored.isPinned).toBe(true);
    expect(index.sessions[0]?.isPinned).toBe(true);
  });

  it("does not touch the index when the session is already in the requested state", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    const index = makeIndex([row({ id: "s3", isPinned: true })]);
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(null);
    vi.spyOn(access.store, "loadIndex").mockReturnValue(index);
    const lock = vi
      .spyOn(access.store, "withIndexLock")
      .mockImplementation(async (fn) => fn(index));

    expect(await mgr.setPinned("s3", true)).toBe(true);
    expect(lock).not.toHaveBeenCalled();
  });
});

describe("originWorkspaceName schema round-trip", () => {
  // Worktree sessions cannot carry workspaceName (captureWorkspaceBinding
  // rejects a workspaceName whose root differs from repoPath), so the origin
  // workspace is recorded separately for display. It rides the same .strip()
  // index row as isPinned: undeclared means silently dropped, and the sidebar
  // would quietly file every worktree agent under "General" again.
  it("SessionMetadataSchema preserves originWorkspaceName through .strip()", async () => {
    const { SessionMetadataSchema } = await import("./schemas/session-schema");
    const result = SessionMetadataSchema.safeParse({
      id: "wt-1",
      name: "Test",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: false,
      originWorkspaceName: "my-project",
    });
    const data = expectZodSuccess(result);
    expect(data.originWorkspaceName).toBe("my-project");
  });

  it("keeps originWorkspaceName independent of workspaceName", async () => {
    // A worktree row legitimately has an origin but no binding workspace.
    const { SessionMetadataSchema } = await import("./schemas/session-schema");
    const result = SessionMetadataSchema.safeParse({
      id: "wt-2",
      name: "Test",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: false,
      originWorkspaceName: "my-project",
      repoPath: "/tmp/worktrees/my-project-abc12345",
    });
    const data = expectZodSuccess(result);
    expect(data.originWorkspaceName).toBe("my-project");
    expect(data.workspaceName).toBeUndefined();
  });
});

describe("askUser tool result schema validation", () => {
  it("accepts a valid structured question payload", async () => {
    const { AskUserToolResultSchema } = await import("./schemas/session-schema");
    const result = AskUserToolResultSchema.safeParse({
      success: true,
      question: "What database should I use?",
      answers: [
        { title: "PostgreSQL", description: "Best for relational data" },
        { title: "SQLite" },
      ],
      recommendedIndex: 0,
    });
    const data = expectZodSuccess(result);
    expect(data.recommendedIndex).toBe(0);
    expect(data.answers[0].title).toBe("PostgreSQL");
  });

  it("rejects recommendedIndex values outside the answer array", async () => {
    const { AskUserToolResultSchema } = await import("./schemas/session-schema");
    const result = AskUserToolResultSchema.safeParse({
      success: true,
      question: "What database should I use?",
      answers: [{ title: "PostgreSQL" }, { title: "SQLite" }],
      recommendedIndex: 2,
    });
    expect(result.success).toBe(false);
  });

  it("rejects payloads with fewer than two answers", async () => {
    const { AskUserToolResultSchema } = await import("./schemas/session-schema");
    const result = AskUserToolResultSchema.safeParse({
      success: true,
      question: "What database should I use?",
      answers: [{ title: "PostgreSQL" }],
    });
    expect(result.success).toBe(false);
  });

  it("strips payloads with the old recommended field name", async () => {
    const { AskUserToolResultSchema } = await import("./schemas/session-schema");
    const result = AskUserToolResultSchema.safeParse({
      success: true,
      question: "What database should I use?",
      answers: [{ title: "PostgreSQL" }, { title: "SQLite" }],
      recommended: 0,
    });
    const data = expectZodSuccess(result);
    expect(data.recommendedIndex).toBeUndefined();
  });
});

describe("SessionManager.patchQuestionSelection", () => {
  it("persists the selected answer and round-trips through StoredSessionSchema", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [{ id: "sess-q", name: "Question session", backendOrigin: "copilot" }],
        });
      }
      if (path.includes("sess-q")) {
        return JSON.stringify({
          id: "sess-q",
          name: "Question session",
          backendOrigin: "copilot" as const,
          messages: [
            {
              id: "msg-1",
              role: "assistant",
              content: "",
              timestamp: "",
              question: {
                question: "Pick one",
                answers: [{ title: "A" }, { title: "B" }],
              },
            },
          ],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const { StoredSessionSchema } = await import("./schemas/session-schema");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    expect(mgr.patchQuestionSelection("sess-q", "msg-1", "A. A")).toBe(true);

    const chunkWrite = mockedFs.writeFileSync.mock.calls.find(
      ([p, body]) =>
        String(p).includes("sess-q.chunks") &&
        typeof body === "string" &&
        body.includes("selectedAnswer"),
    );
    expect(chunkWrite).toBeDefined();
    const parsed = StoredSessionSchema.safeParse({
      id: "sess-q",
      name: "Question session",
      backendOrigin: "copilot",
      messages: parseWrittenJson(chunkWrite![1]),
    });
    const data = expectZodSuccess(parsed);
    expect(data.messages[0].question?.selectedAnswer).toBe("A. A");
  });

  it("returns false when the session cannot be found", async () => {
    mockedFs.existsSync.mockReturnValue(false);

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    expect(mgr.patchQuestionSelection("missing", "msg-1", "A. A")).toBe(false);
    const sessionWrites = mockedFs.writeFileSync.mock.calls.filter(
      ([p]) => String(p).includes("missing") && !String(p).includes("index"),
    );
    expect(sessionWrites).toHaveLength(0);
  });

  it("returns false when the target message has no question", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id: "sess-no-question", name: "Question session", backendOrigin: "copilot" },
          ],
        });
      }
      if (path.includes("sess-no-question")) {
        return JSON.stringify({
          id: "sess-no-question",
          name: "Question session",
          backendOrigin: "copilot" as const,
          messages: [{ id: "msg-1", role: "assistant", content: "Hello", timestamp: "" }],
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    expect(mgr.patchQuestionSelection("sess-no-question", "msg-1", "A. A")).toBe(false);
    const sessionWrites = mockedFs.writeFileSync.mock.calls.filter(
      ([p, body]) =>
        String(p).includes("sess-no-question") &&
        typeof body === "string" &&
        body.includes("selectedAnswer"),
    );
    expect(sessionWrites).toHaveLength(0);
  });
});

describe("SessionManager.refreshSession gateway short-circuit", () => {
  // Guards the fix that avoided a duplicate sessions.create when
  // the renderer fired setInterceptFileChooser / skill-toggle IPCs. Without
  // the applyConfigChange delegation, refreshSession would call
  // backend.sessions.destroy + createBackendSession — spinning up a second
  // cloud session for the same logical chat and splitting the runId stream.
  // After the T16 refactor, sessions.ts delegates to
  // backend.sessions.applyConfigChange which on GatewaySessionBackend is a
  // no-op that warns but does NOT call recreate.
  it("does not call backend.sessions.destroy when origin is gateway", async () => {
    const diskStore = new Map<string, string>();
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- vi.fn signature
    mockedFs.existsSync.mockImplementation((p: any) => diskStore.has(String(p)));
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const key = String(p);
      if (diskStore.has(key)) return diskStore.get(key)!;
      return JSON.stringify({ sessions: [] });
    });
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.writeFileSync.mockImplementation((p: any, data: any) => {
      diskStore.set(String(p), String(data));
    });
    mockedFs.mkdirSync.mockReturnValue(undefined);

    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    Object.defineProperties(backend, {
      runtimeId: { value: "gateway" },
      origin: { value: "gateway" },
    });
    const manager = new SessionManager("/test/workspace", backend);
    const destroySpy = vi.spyOn(backend.sessions, "destroy");
    // Mirror GatewaySessionBackend.applyConfigChange: warn and do NOT call recreate
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(backend.sessions, "applyConfigChange").mockImplementation(
      async (sessionId, _recreate) => {
        console.warn(
          `[gateway] applyConfigChange(${sessionId}) skipped: local config changes (skills / MCP / file-chooser) are not yet synced to cloud — see pushConfig spec`,
        );
      },
    );
    try {
      await manager.refreshSession("some-session-id");
      expect(destroySpy).not.toHaveBeenCalled();
      // The warn comes from the gateway backend (not sessions.ts) — verifies
      // the gap is still observable in logs until pushConfig() lands.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("applyConfigChange(some-session-id) skipped"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("SessionManager.findAndReuseEmpty runtime scoping", () => {
  // Regression test for an earlier bug: findAndReuseEmpty scanned every
  // session on disk without filtering by runtime. In gateway mode it would
  // pick up a stale Copilot empty session, then switchSession →
  // createBackendSession would throw the cross-runtime guard and "New chat"
  // looked broken. We spy on switchSession to check which session (if any)
  // findAndReuseEmpty picks, without letting the backend run.
  async function setup(runtimeId = "gateway", origin: "copilot" | "gateway" = "gateway") {
    const diskStore = new Map<string, string>();
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.existsSync.mockImplementation((p: any) => diskStore.has(String(p)));
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const k = String(p);
      if (diskStore.has(k)) return diskStore.get(k)!;
      return JSON.stringify({ sessions: [] });
    });
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.writeFileSync.mockImplementation((p: any, data: any) => {
      diskStore.set(String(p), String(data));
    });
    mockedFs.mkdirSync.mockReturnValue(undefined);
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    Object.defineProperties(backend, {
      runtimeId: { value: runtimeId },
      origin: { value: origin },
    });
    const manager = new SessionManager("/test/workspace", backend);
    return { manager, store: new SessionTestAccess(manager).store };
  }

  it("returns null when the only empty session belongs to a different backend origin", async () => {
    const { manager, store } = await setup();
    // Seed a copilot-origin empty session — from gateway's perspective this
    // must NOT be reused (would trip the cross-origin guard).
    const copilotEmpty: PersistedSession = {
      id: "cop-empty",
      name: DEFAULT_SESSION_NAME,
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      backendOrigin: "copilot",
      messages: [],
    };
    store.saveSessionData(copilotEmpty);
    await store.withIndexLock((idx) => {
      idx.sessions.push({
        id: copilotEmpty.id,
        name: copilotEmpty.name,
        createdAt: copilotEmpty.createdAt,
        updatedAt: copilotEmpty.updatedAt,
        hasUnread: false,
        isActive: false,
        backendOrigin: "copilot",
      });
    });

    const switchSpy = vi.spyOn(manager, "switchSession");
    const result = await manager.findAndReuseEmpty("user");
    expect(result).toBeNull();
    expect(switchSpy).not.toHaveBeenCalled();
  });

  it("picks a same-runtime empty session and calls switchSession for it", async () => {
    const { manager, store } = await setup();
    const gwEmpty: PersistedSession = {
      id: "gw-empty",
      name: DEFAULT_SESSION_NAME,
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      backendOrigin: "gateway",
      messages: [],
    };
    store.saveSessionData(gwEmpty);
    await store.withIndexLock((idx) => {
      idx.sessions.push({
        id: gwEmpty.id,
        name: gwEmpty.name,
        createdAt: gwEmpty.createdAt,
        updatedAt: gwEmpty.updatedAt,
        hasUnread: false,
        isActive: false,
        backendOrigin: "gateway",
      });
    });

    // Stub switchSession so the backend-dependent tail doesn't run.
    const switchSpy = vi
      .spyOn(manager, "switchSession")
      .mockResolvedValue({ kind: "loaded", session: { ...gwEmpty, isActive: true } });
    const result = await manager.findAndReuseEmpty("user");
    expect(result?.id).toBe("gw-empty");
    expect(switchSpy).toHaveBeenCalledWith("gw-empty");
  });

  it("does not reuse another local adapter's empty session with the same origin", async () => {
    const { manager, store } = await setup("codex", "copilot");
    const copilotEmpty: PersistedSession = {
      id: "copilot-empty",
      name: DEFAULT_SESSION_NAME,
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: false,
      runtimeId: "copilot",
      backendOrigin: "copilot",
      messages: [],
    };
    store.saveSessionData(copilotEmpty);
    await store.withIndexLock((index) => {
      const { messages: _messages, ...metadata } = copilotEmpty;
      index.sessions.push(metadata);
    });

    const switchSpy = vi.spyOn(manager, "switchSession");
    await expect(manager.findAndReuseEmpty("user")).resolves.toBeNull();
    expect(switchSpy).not.toHaveBeenCalled();
  });
});

describe("SessionManager.applyRemoteEvent", () => {
  async function makeManagerWithRuntime(runtimeId: string, origin: "copilot" | "gateway") {
    const diskStore = new Map<string, string>();
    mockedFs.existsSync.mockImplementation((p: unknown) => diskStore.has(String(p)));
    mockedFs.readFileSync.mockImplementation((p: unknown) => {
      const key = String(p);
      return diskStore.get(key) ?? JSON.stringify({ sessions: [] });
    });
    mockedFs.writeFileSync.mockImplementation((p: unknown, data: unknown) => {
      diskStore.set(String(p), String(data));
    });
    mockedFs.mkdirSync.mockReturnValue(undefined);
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    Object.defineProperties(backend, {
      runtimeId: { value: runtimeId },
      origin: { value: origin },
    });
    const manager = new SessionManager("/test/workspace", backend);
    return { manager, store: new SessionTestAccess(manager).store };
  }

  async function makeManagerWithGatewayBackend() {
    const diskStore = new Map<string, string>();

    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.existsSync.mockImplementation((p: any) => diskStore.has(String(p)));
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const key = String(p);
      if (diskStore.has(key)) return diskStore.get(key)!;
      return JSON.stringify({ sessions: [] });
    });
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.writeFileSync.mockImplementation((p: any, data: any) => {
      diskStore.set(String(p), String(data));
    });
    mockedFs.mkdirSync.mockReturnValue(undefined);

    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    Object.defineProperties(backend, {
      runtimeId: { value: "gateway" },
      origin: { value: "gateway" },
    });
    const manager = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(manager);
    return { manager, store: access.store };
  }

  it("applies index-snapshot via writer.replaceAll", async () => {
    const { manager } = await makeManagerWithGatewayBackend();
    const snapshot = {
      type: "index-snapshot" as const,
      sessions: [
        {
          id: "gw-1",
          name: "From cloud",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: false,
          backendOrigin: "gateway" as const,
          backendId: "cloud-1",
        },
      ],
    };
    await manager.applyRemoteEvent(snapshot);
    expect((await manager.listSessions()).find((s) => s.id === "gw-1")?.backendId).toBe("cloud-1");
  });

  it("applies session-upsert (new row)", async () => {
    const { manager } = await makeManagerWithGatewayBackend();
    await manager.applyRemoteEvent({
      type: "session-upsert",
      session: {
        id: "gw-2",
        name: "Live push",
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: false,
        backendOrigin: "gateway" as const,
        backendId: "cloud-2",
      },
    });
    expect((await manager.listSessions()).find((s) => s.id === "gw-2")).toBeDefined();
  });

  it("index-snapshot preserves local id when a pre-existing local row matches by backendId", async () => {
    const { manager, store } = await makeManagerWithGatewayBackend();
    // Seed a locally-created gateway row: its id is a marshal-assigned
    // UUID; its backendId is the cloud sessionId returned from sessions.create.
    // These MUST be different values — that's the whole point of the test.
    await store.withIndexLock((idx) => {
      idx.sessions.push({
        id: "local-uuid",
        name: "Local chat",
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: false,
        backendOrigin: "gateway" as const,
        backendId: "cloud-xyz",
      });
    });
    // Snapshot arrives after reconnect: parseGatewayRow sets both id and
    // backendId to the cloud sessionId. Writer should recognize this is the
    // same session (by backendId) and preserve the local id, not duplicate.
    await manager.applyRemoteEvent({
      type: "index-snapshot",
      sessions: [
        {
          id: "cloud-xyz",
          name: "Local chat (from cloud)",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: false,
          backendOrigin: "gateway" as const,
          backendId: "cloud-xyz",
        },
      ],
    });
    const gw = (await manager.listSessions()).filter((s) => s.backendOrigin === "gateway");
    expect(gw).toHaveLength(1);
    expect(gw[0].id).toBe("local-uuid");
    expect(gw[0].backendId).toBe("cloud-xyz");
  });

  it("applies session-delete by backendId", async () => {
    const { manager, store } = await makeManagerWithGatewayBackend();
    await store.withIndexLock((idx) => {
      idx.sessions.push({
        id: "gw-3",
        name: "Doomed",
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: false,
        backendOrigin: "gateway" as const,
        backendId: "cloud-3",
      });
    });
    await manager.applyRemoteEvent({ type: "session-delete", backendId: "cloud-3" });
    expect((await manager.listSessions()).find((s) => s.id === "gw-3")).toBeUndefined();
  });

  it("remote reconciliation cannot overwrite a sibling local runtime partition", async () => {
    const { manager, store } = await makeManagerWithRuntime("codex", "copilot");
    await store.withIndexLock((index) => {
      index.sessions.push({
        id: "copilot-local",
        name: "Copilot",
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: false,
        runtimeId: "copilot",
        backendOrigin: "copilot",
        backendId: "shared-backend-id",
      });
    });

    await manager.applyRemoteEvent({
      type: "index-snapshot",
      sessions: [
        {
          id: "codex-remote",
          name: "Codex",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: false,
          runtimeId: "codex",
          backendOrigin: "copilot",
          backendId: "shared-backend-id",
        },
      ],
    });

    expect(
      store
        .loadIndex()
        .sessions.map(({ id, runtimeId }) => ({ id, runtimeId }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual([
      { id: "codex-remote", runtimeId: "codex" },
      { id: "copilot-local", runtimeId: "copilot" },
    ]);
  });
});

describe("SessionManager.refreshSession via applyConfigChange", () => {
  async function setupDiskStore() {
    const diskStore = new Map<string, string>();
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.existsSync.mockImplementation((p: any) => diskStore.has(String(p)));
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const key = String(p);
      if (diskStore.has(key)) return diskStore.get(key)!;
      return JSON.stringify({ sessions: [] });
    });
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.writeFileSync.mockImplementation((p: any, data: any) => {
      diskStore.set(String(p), String(data));
    });
    mockedFs.mkdirSync.mockReturnValue(undefined);
  }

  it("copilot: invokes recreate — disconnect is called for seeded session handle", async () => {
    await setupDiskStore();
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const manager = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(manager);

    // Seed a session handle so the recreate callback's guard passes
    ta.sessionHandles.set("sess-1", { sessionId: "sess-1", backendId: "sdk-1" });

    const disconnectSpy = vi.spyOn(backend.sessions, "disconnect").mockResolvedValue(undefined);
    const destroySpy = vi.spyOn(backend.sessions, "destroy");
    const applyConfigChangeSpy = vi.spyOn(backend.sessions, "applyConfigChange");
    // Prevent createBackendSession from running the full init + create chain
    vi.spyOn(backend, "init").mockResolvedValue(undefined);
    vi.spyOn(backend.sessions, "create").mockResolvedValue({
      sessionId: "sess-1",
      backendId: "sdk-1-new",
    });

    await manager.refreshSession("sess-1");

    expect(applyConfigChangeSpy).toHaveBeenCalledWith("sess-1", expect.any(Function));
    expect(disconnectSpy).toHaveBeenCalledWith("sess-1");
    expect(destroySpy).not.toHaveBeenCalled();
  });

  it("copilot: refresh preserves and resumes stored SDK session instead of creating summary-only context", async () => {
    await setupDiskStore();
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const manager = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(manager);

    ta.sessionHandles.set("sess-resume", { sessionId: "sess-resume", backendId: "sdk-old" });
    ta.sdkSessionIds.set("sess-resume", "sdk-old");
    vi.spyOn(ta.store, "loadSessionData").mockReturnValue({
      id: "sess-resume",
      name: "Existing Chat",
      createdAt: "",
      updatedAt: "",
      backendId: "sdk-old",
      messages: [{ id: "m1", role: "user", content: "remember this", timestamp: "" }],
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: false,
    });

    const disconnectSpy = vi.spyOn(backend.sessions, "disconnect").mockResolvedValue(undefined);
    const destroySpy = vi.spyOn(backend.sessions, "destroy");
    const createSpy = vi.spyOn(backend.sessions, "create");
    const resumeSpy = vi.spyOn(backend.sessions, "resume").mockResolvedValue({
      sessionId: "sess-resume",
      backendId: "sdk-old",
    });
    vi.spyOn(backend, "init").mockResolvedValue(undefined);
    vi.spyOn(backend.sessions, "activeSessionCount").mockReturnValue(0);

    await manager.refreshSession("sess-resume");

    expect(disconnectSpy).toHaveBeenCalledWith("sess-resume");
    expect(destroySpy).not.toHaveBeenCalled();
    expect(resumeSpy).toHaveBeenCalledWith(
      "sess-resume",
      expect.objectContaining({ backendId: "sdk-old" }),
    );
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("delivers a queued review message once through the recreated backend session", async () => {
    await setupDiskStore();
    const session: PersistedSession = {
      id: "sess-review-refresh",
      name: "Existing Chat",
      createdAt: "",
      updatedAt: "",
      backendId: "sdk-old",
      backendOrigin: "copilot",
      messages: [{ id: "m1", role: "user", content: "remember this", timestamp: "" }],
      hasUnread: false,
      isActive: true,
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const manager = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(manager);
    access.sessionHandles.set(session.id, { sessionId: session.id, backendId: "sdk-old" });
    access.sdkSessionIds.set(session.id, "sdk-old");
    access.busyTracker.setBusy(session.id);
    access.turnAccumulators.set(session.id, { chunks: [] });
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(session);
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    const disconnect = vi.spyOn(backend.sessions, "disconnect").mockResolvedValue(undefined);
    const resume = vi.spyOn(backend.sessions, "resume").mockResolvedValue({
      sessionId: session.id,
      backendId: "sdk-new",
    });
    vi.spyOn(backend, "init").mockResolvedValue(undefined);
    vi.spyOn(backend.sessions, "activeSessionCount").mockReturnValue(0);
    const send = vi.spyOn(backend.sessions, "send").mockImplementation(async () => {
      manager.emitEvent(session.id, { type: "turn:idle" });
      access.busyTracker.setIdle(session.id);
    });
    const outbox = await attachTestAgentMessageOutbox(manager);
    const accepted = await manager.sendReviewCommentsToSession({
      sessionId: session.id,
      message: "Review after refresh",
    });
    expectDurablyAccepted(accepted);
    const messageId = accepted.messageId;
    if (!messageId) throw new Error("Expected durable message ID");
    await vi.waitFor(() => expect(outbox.get(messageId)?.state).toBe("pending"));
    await manager.refreshSession(session.id);
    await manager.refreshSession(session.id);

    await vi.waitFor(() => expect(outbox.get(messageId)?.state).toBe("processed"));
    expect(disconnect).toHaveBeenCalledWith(session.id);
    expect(resume).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ backendId: "sdk-old" }),
    );
    expect(send).toHaveBeenCalledOnce();
    expect(resume.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(access.turnAccumulators.has(session.id)).toBe(false);
    expect(session.messages.filter((message) => message.id === messageId)).toHaveLength(1);
    expect(outbox.get(messageId)?.backendDeliveredAt).toEqual(expect.any(String));
  });

  it("interrupts an accepted delivery before recreated-session events can complete it", async () => {
    await setupDiskStore();
    const session: PersistedSession = {
      id: "sess-review-interrupted",
      name: "Existing Chat",
      createdAt: "",
      updatedAt: "",
      backendId: "sdk-old",
      backendOrigin: "copilot",
      messages: [{ id: "m1", role: "user", content: "remember this", timestamp: "" }],
      hasUnread: false,
      isActive: true,
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const manager = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(manager);
    access.sessionHandles.set(session.id, { sessionId: session.id, backendId: "sdk-old" });
    access.sdkSessionIds.set(session.id, "sdk-old");
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(session);
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    vi.spyOn(backend.sessions, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(backend.sessions, "resume").mockResolvedValue({
      sessionId: session.id,
      backendId: "sdk-new",
    });
    vi.spyOn(backend, "init").mockResolvedValue(undefined);
    vi.spyOn(backend.sessions, "activeSessionCount").mockReturnValue(0);
    let rejectOldSend!: (error: Error) => void;
    const oldSendGate = new Promise<void>((_resolve, reject) => {
      rejectOldSend = reject;
    });
    const send = vi
      .spyOn(backend.sessions, "send")
      .mockImplementation(async () => await oldSendGate);
    const viewEvents: import("../common/marshal-ipc-contract").SessionViewEvent[] = [];
    manager.addViewEventListener((_sessionId, event) => viewEvents.push(event));
    const outbox = await attachTestAgentMessageOutbox(manager);
    const accepted = await manager.sendReviewCommentsToSession({
      sessionId: session.id,
      message: "Review before refresh",
    });
    expectDurablyAccepted(accepted);
    const messageId = accepted.messageId;
    if (!messageId) throw new Error("Expected durable message ID");
    await vi.waitFor(() => expect(outbox.get(messageId)?.state).toBe("backend-accepted"));

    await manager.refreshSession(session.id);
    await vi.waitFor(() => expect(outbox.get(messageId)?.state).toBe("delivery-unknown"));
    manager.emitEvent(session.id, {
      type: "turn:message-committed",
      message: {
        id: "replacement-response",
        role: "assistant",
        content: "Response from replacement session",
        timestamp: new Date().toISOString(),
      },
    });
    manager.emitEvent(session.id, { type: "turn:idle" });
    access.busyTracker.setBusy(session.id);
    rejectOldSend(new Error("old runtime failed"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(send).toHaveBeenCalledOnce();
    expect(access.busyTracker.isBusy(session.id)).toBe(true);
    expect(outbox.get(messageId)?.state).toBe("delivery-unknown");
    expect(outbox.get(messageId)).not.toHaveProperty("backendDeliveredAt");
    expect(session.messages.filter((message) => message.id === messageId)).toHaveLength(1);
    expect(viewEvents.some((event) => event.view.error !== null)).toBe(false);
  });

  it("clears interrupted busy state without emitting idle when recreation fails", async () => {
    await setupDiskStore();
    const session: PersistedSession = {
      id: "sess-refresh-failure",
      name: "Existing Chat",
      createdAt: "",
      updatedAt: "",
      backendId: "sdk-old",
      backendOrigin: "copilot",
      messages: [{ id: "m1", role: "user", content: "remember this", timestamp: "" }],
      hasUnread: false,
      isActive: true,
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const manager = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(manager);
    access.sessionHandles.set(session.id, { sessionId: session.id, backendId: "sdk-old" });
    access.sdkSessionIds.set(session.id, "sdk-old");
    access.busyTracker.setBusy(session.id);
    access.turnAccumulators.set(session.id, { chunks: [] });
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(session);
    vi.spyOn(backend.sessions, "disconnect").mockResolvedValue(undefined);
    vi.spyOn(backend.sessions, "resume").mockRejectedValue(new Error("resume failed"));
    vi.spyOn(backend.sessions, "create").mockRejectedValue(new Error("create failed"));
    vi.spyOn(backend, "init").mockResolvedValue(undefined);
    vi.spyOn(backend.sessions, "activeSessionCount").mockReturnValue(0);
    const updateView = vi.spyOn(access.viewEmission, "updateView");

    await expect(manager.refreshSession(session.id)).rejects.toThrow("create failed");

    expect(access.busyTracker.isBusy(session.id)).toBe(false);
    expect(access.turnAccumulators.has(session.id)).toBe(false);
    expect(updateView).not.toHaveBeenCalledWith(session.id, { type: "turn:idle" });
  });

  it("does not recreate a session deleted while refresh waits for disconnect", async () => {
    await setupDiskStore();
    const session: PersistedSession = {
      id: "sess-refresh-delete-race",
      name: "Existing Chat",
      createdAt: "",
      updatedAt: "",
      backendId: "sdk-old",
      backendOrigin: "copilot",
      messages: [{ id: "m1", role: "user", content: "remember this", timestamp: "" }],
      hasUnread: false,
      isActive: true,
    };
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const manager = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(manager);
    access.sessionHandles.set(session.id, { sessionId: session.id, backendId: "sdk-old" });
    access.sdkSessionIds.set(session.id, "sdk-old");
    let deleted = false;
    vi.spyOn(access.store, "loadSessionData").mockImplementation(() => (deleted ? null : session));
    vi.spyOn(access.store, "loadSessionHeader").mockReturnValue(null);
    vi.spyOn(access.store, "deleteSessionData").mockImplementation(() => {
      deleted = true;
    });
    const disconnectStarted = deferredPromise<void>();
    const releaseDisconnect = deferredPromise<void>();
    vi.spyOn(backend.sessions, "disconnect").mockImplementation(async () => {
      disconnectStarted.resolve(undefined);
      await releaseDisconnect.promise;
    });
    vi.spyOn(backend.sessions, "destroy").mockResolvedValue(undefined);
    const resume = vi.spyOn(backend.sessions, "resume");
    const create = vi.spyOn(backend.sessions, "create");

    const refresh = manager.refreshSession(session.id);
    await disconnectStarted.promise;
    await manager.deleteSession(session.id, { cause: "user-ipc" });
    releaseDisconnect.resolve(undefined);

    await expect(refresh).rejects.toThrow("changed while its backend session was being recreated");
    expect(resume).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(access.sessionHandles.has(session.id)).toBe(false);
  });

  it("gateway: does NOT invoke recreate — destroy is never called", async () => {
    await setupDiskStore();
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    Object.defineProperties(backend, {
      runtimeId: { value: "gateway" },
      origin: { value: "gateway" },
    });
    const manager = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(manager);

    // Seed a session handle to verify destroy is still NOT called even when it exists
    ta.sessionHandles.set("sess-1", { sessionId: "sess-1", backendId: "gw-1" });

    const destroySpy = vi.spyOn(backend.sessions, "destroy");
    // Mirror the real GatewaySessionBackend: applyConfigChange warns and does NOT call recreate
    vi.spyOn(backend.sessions, "applyConfigChange").mockImplementation(async (_id, _recreate) => {
      // intentionally does not call _recreate — simulates gateway no-op
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await manager.refreshSession("sess-1");
      expect(destroySpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ── refreshSessionDedup ─────────────────────────────────────────────────

  it("refreshSessionDedup dedupes concurrent calls for the same id", async () => {
    await setupDiskStore();
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const manager = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(manager);
    ta.sessionHandles.set("sess-dedup", { sessionId: "sess-dedup", backendId: "sdk-1" });

    let resolveApply: () => void = () => {};
    const applyConfigChangeSpy = vi.spyOn(backend.sessions, "applyConfigChange").mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveApply = res;
        }),
    );

    const p1 = manager.refreshSessionDedup("sess-dedup");
    const p2 = manager.refreshSessionDedup("sess-dedup");

    expect(p1).toBe(p2);
    expect(applyConfigChangeSpy).toHaveBeenCalledTimes(1);

    resolveApply();
    await Promise.all([p1, p2]);
  });

  it("refreshSessionDedup runs again after the previous call settles", async () => {
    await setupDiskStore();
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const manager = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(manager);
    ta.sessionHandles.set("sess-cycle", { sessionId: "sess-cycle", backendId: "sdk-1" });

    const applyConfigChangeSpy = vi
      .spyOn(backend.sessions, "applyConfigChange")
      .mockResolvedValue(undefined);

    await manager.refreshSessionDedup("sess-cycle");
    await manager.refreshSessionDedup("sess-cycle");

    expect(applyConfigChangeSpy).toHaveBeenCalledTimes(2);
  });

  it("refreshSessionDedup clears the in-flight slot on rejection so a retry re-runs", async () => {
    // Locks in `.finally()` (not `.then()`) cleanup. If the dedup map were
    // poisoned on rejection, `onStuck` (3-min timer, primary rejection-prone
    // caller) would silently piggyback on the failed promise forever.
    await setupDiskStore();
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const manager = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(manager);
    ta.sessionHandles.set("sess-reject", { sessionId: "sess-reject", backendId: "sdk-1" });

    const applyConfigChangeSpy = vi
      .spyOn(backend.sessions, "applyConfigChange")
      .mockRejectedValueOnce(new Error("backend down"))
      .mockResolvedValueOnce(undefined);

    await expect(manager.refreshSessionDedup("sess-reject")).rejects.toThrow("backend down");

    // Second call must re-invoke applyConfigChange — not reuse the rejected
    // in-flight promise.
    await expect(manager.refreshSessionDedup("sess-reject")).resolves.toBeUndefined();
    expect(applyConfigChangeSpy).toHaveBeenCalledTimes(2);
  });

  // ── busy-tracker stuck signal triggers visible recovery ──────────────

  it("busy-tracker stuck timer emits an error and refreshes desktop sessions", async () => {
    vi.useFakeTimers();
    try {
      const { SessionManager } = await import("./sessions");
      const backend = await createTestBackend();
      const manager = new SessionManager("/test/workspace", backend);
      const ta = new SessionTestAccess(manager);
      const events: Array<{ type: string; error?: string }> = [];
      manager.addEventListener((_sessionId, event) => events.push(event));

      vi.spyOn(backend.sessions, "applyConfigChange").mockResolvedValue(undefined);
      const refreshSpy = vi.spyOn(manager, "refreshSessionDedup");

      ta.busyTracker.setBusy("desktop-1");
      ta.busyTracker.resetActivityTimer("desktop-1");

      await vi.advanceTimersByTimeAsync(STUCK_TIMEOUT_MS + 100);

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn:error",
          error: expect.stringContaining("without activity"),
        }),
      );
      expect(refreshSpy).toHaveBeenCalledWith("desktop-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("busy-tracker stuck timer recovers user sessions with an error and refresh", async () => {
    vi.useFakeTimers();
    try {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation((p: any) => {
        if (String(p).includes("index.json")) {
          return JSON.stringify({
            sessions: [{ id: "user-1", name: "Chat", backendOrigin: "copilot" }],
          });
        }
        return "{}";
      });
      mockedFs.writeFileSync.mockImplementation(() => {});
      mockedFs.mkdirSync.mockReturnValue(undefined);

      const { SessionManager } = await import("./sessions");
      const backend = await createTestBackend();
      const manager = new SessionManager("/test/workspace", backend);
      const ta = new SessionTestAccess(manager);
      const events: Array<{ type: string }> = [];
      manager.addEventListener((_sessionId, event) => events.push(event));

      vi.spyOn(backend.sessions, "applyConfigChange").mockResolvedValue(undefined);
      const refreshSpy = vi.spyOn(manager, "refreshSessionDedup");

      ta.busyTracker.setBusy("user-1");
      ta.busyTracker.resetActivityTimer("user-1");

      await vi.advanceTimersByTimeAsync(STUCK_TIMEOUT_MS + 100);

      expect(refreshSpy).toHaveBeenCalledWith("user-1");
      expect(events.some((event) => event.type === "turn:error")).toBe(true);
      expect(events.some((event) => event.type === "turn:idle")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SessionManager.updateSessionModelQuietly", () => {
  it("persists model to both session file and index for evicted sessions", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            {
              id: "sess-q",
              name: "Test",
              model: "old-model",
              updatedAt: "",
              backendOrigin: "copilot",
            },
          ],
        });
      }
      if (path.includes("sess-q")) {
        return JSON.stringify({
          id: "sess-q",
          name: "Test",
          model: "old-model",
          messages: [],
          backendOrigin: "copilot",
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());

    await mgr.updateSessionModelQuietly("sess-q", "new-model");

    const sessionWrites = mockedFs.writeFileSync.mock.calls.filter(
      ([p]) => String(p).includes("sess-q") && !String(p).includes("index"),
    );
    expect(sessionWrites.length).toBeGreaterThan(0);
    expect(parseWrittenJson(sessionWrites.at(-1)![1]).model).toBe("new-model");

    const indexWrites = mockedFs.writeFileSync.mock.calls.filter(([p]) =>
      String(p).includes("index.json"),
    );
    expect(indexWrites.length).toBeGreaterThan(0);
    const savedIndex = parseWrittenJson(indexWrites[indexWrites.length - 1][1]);
    const meta = savedIndex.sessions.find((s: { id: string }) => s.id === "sess-q");
    expect(meta.model).toBe("new-model");
  });

  it("calls backend.sessions.setModel for live sessions and persists on success", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            {
              id: "sess-live",
              name: "Test",
              model: "old",
              updatedAt: "",
              backendOrigin: "copilot",
            },
          ],
        });
      }
      if (path.includes("sess-live")) {
        return JSON.stringify({
          id: "sess-live",
          name: "Test",
          model: "old",
          messages: [],
          backendOrigin: "copilot",
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.sessionHandles.set("sess-live", { sessionId: "sess-live", backendId: "sdk-1" });
    const setModelSpy = vi.spyOn(backend.sessions, "setModel").mockResolvedValue(undefined);

    await mgr.updateSessionModelQuietly("sess-live", "new-model");

    // Reasoning resolves to the system default (High) for the swapped model.
    expect(setModelSpy).toHaveBeenCalledWith("sess-live", "new-model", {
      reasoningEffort: "high",
    });
    const sessionWrites = mockedFs.writeFileSync.mock.calls.filter(
      ([p]) => String(p).includes("sess-live") && !String(p).includes("index"),
    );
    expect(sessionWrites.length).toBeGreaterThan(0);
    expect(parseWrittenJson(sessionWrites.at(-1)![1]).model).toBe("new-model");
  });

  it("leaves disk unchanged when backend setModel fails for live sessions", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            {
              id: "sess-fail",
              name: "Test",
              model: "old",
              updatedAt: "",
              backendOrigin: "copilot",
            },
          ],
        });
      }
      if (path.includes("sess-fail")) {
        return JSON.stringify({
          id: "sess-fail",
          name: "Test",
          model: "old",
          messages: [],
          backendOrigin: "copilot",
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.sessionHandles.set("sess-fail", { sessionId: "sess-fail", backendId: "sdk-1" });
    vi.spyOn(backend.sessions, "setModel").mockRejectedValue(new Error("backend down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await mgr.updateSessionModelQuietly("sess-fail", "new-model");

    const sessionWrites = mockedFs.writeFileSync.mock.calls.filter(
      ([p]) => String(p).includes("sess-fail") && !String(p).includes("index"),
    );
    expect(sessionWrites.map(([, body]) => parseWrittenJson(body).model)).not.toContain(
      "new-model",
    );

    warnSpy.mockRestore();
  });
});

describe("SessionManager.setSessionReasoningEffort", () => {
  function setupReasoningSession(id: string) {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id, name: "Test", model: "gpt-5.6", updatedAt: "", backendOrigin: "copilot" },
          ],
        });
      }
      if (path.includes(id)) {
        return JSON.stringify({
          id,
          name: "Test",
          backendOrigin: "copilot",
          model: "gpt-5.6",
          messages: [{ id: "m1", role: "user", content: "Existing chat", timestamp: "" }],
        });
      }
      return "{}";
    });
  }

  it("persists an effort change for an existing idle chat", async () => {
    setupReasoningSession("sess-reasoning");
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    mockedFs.writeFileSync.mockClear();

    await mgr.setSessionReasoningEffort("sess-reasoning", "high");

    const sessionWrites = mockedFs.writeFileSync.mock.calls.filter(
      ([p]) => String(p).includes("sess-reasoning") && !String(p).includes("index"),
    );
    expect(sessionWrites.length).toBeGreaterThan(0);
    expect(
      sessionWrites.some(([, data]) => parseWrittenJson(data).reasoningEffort === "high"),
    ).toBe(true);

    const indexWrites = mockedFs.writeFileSync.mock.calls.filter(([p]) =>
      String(p).includes("index.json"),
    );
    const savedIndex = parseWrittenJson(indexWrites[indexWrites.length - 1][1]);
    expect(savedIndex.sessions[0].reasoningEffort).toBe("high");
  });

  it("rejects an effort change while the chat is responding", async () => {
    setupReasoningSession("sess-busy-reasoning");
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const ta = new SessionTestAccess(mgr);
    ta.busyTracker.setBusy("sess-busy-reasoning");
    mockedFs.writeFileSync.mockClear();

    await expect(mgr.setSessionReasoningEffort("sess-busy-reasoning", "high")).rejects.toThrow(
      "while the session is responding",
    );

    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe("SessionManager.setSessionContextTier", () => {
  function setupContextSession(id: string) {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            { id, name: "Test", model: "gpt-5.6-sol", updatedAt: "", backendOrigin: "copilot" },
          ],
        });
      }
      if (path.includes(id)) {
        return JSON.stringify({
          id,
          name: "Test",
          backendOrigin: "copilot",
          model: "gpt-5.6-sol",
          messages: [{ id: "m1", role: "user", content: "Existing chat", timestamp: "" }],
        });
      }
      return "{}";
    });
  }

  it("persists a context-tier change for an existing idle chat", async () => {
    setupContextSession("sess-context");
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const refreshSpy = vi.spyOn(mgr, "refreshSession").mockResolvedValue(true);
    mockedFs.writeFileSync.mockClear();

    await mgr.setSessionContextTier("sess-context", "long_context");

    const sessionWrites = mockedFs.writeFileSync.mock.calls.filter(
      ([p]) => String(p).includes("sess-context") && !String(p).includes("index"),
    );
    expect(
      sessionWrites.some(([, data]) => parseWrittenJson(data).contextTier === "long_context"),
    ).toBe(true);

    const indexWrites = mockedFs.writeFileSync.mock.calls.filter(([p]) =>
      String(p).includes("index.json"),
    );
    const savedIndex = parseWrittenJson(indexWrites[indexWrites.length - 1][1]);
    expect(savedIndex.sessions[0].contextTier).toBe("long_context");
    expect(refreshSpy).toHaveBeenCalledWith("sess-context", { pendingStartAlreadyAwaited: true });
  });

  it("rejects a context-tier change while the chat is responding", async () => {
    setupContextSession("sess-busy-context");
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    access.busyTracker.setBusy("sess-busy-context");
    mockedFs.writeFileSync.mockClear();

    await expect(mgr.setSessionContextTier("sess-busy-context", "long_context")).rejects.toThrow(
      "while the session is responding",
    );
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe("SessionManager.sendMessage — status events during recovery", () => {
  function setupSession(id: string) {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [{ id, name: "Test", updatedAt: "", backendOrigin: "copilot" }],
        });
      }
      if (path.includes(id)) {
        return JSON.stringify({ id, name: "Test", messages: [], backendOrigin: "copilot" });
      }
      return "{}";
    });
  }

  it("emits 'Initializing session...' when waiting for pending session creation", async () => {
    setupSession("sess-init");
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const ta = new SessionTestAccess(mgr);

    const events: Array<{ type: string; status?: string | null }> = [];
    mgr.addEventListener((_sid, evt) => {
      if (evt.type === "turn:status") events.push(evt);
    });

    let resolvePending!: () => void;
    const pendingInit = new Promise<void>((r) => {
      resolvePending = r;
    });
    void pendingInit.then(() => ta.pendingSessionCreations.delete("sess-init"));
    ta.pendingSessionCreations.set("sess-init", pendingInit);

    const mockSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    ta.activeSessions.set("sess-init", { send: mockSend, on: vi.fn<() => void>() });
    ta.sessionHandles.set("sess-init", { sessionId: "sess-init", backendId: "sdk-1" });

    const sendPromise = mgr.sendMessage("sess-init", "hello");
    await vi.waitFor(() =>
      expect(events.some((e) => e.status === "Initializing session...")).toBe(true),
    );

    resolvePending();
    await sendPromise;
  });

  it("emits 'Session expired, reconnecting...' on session-expired error", async () => {
    setupSession("sess-exp");
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const ta = new SessionTestAccess(mgr);

    const events: Array<{ type: string; status?: string | null }> = [];
    mgr.addEventListener((_sid, evt) => {
      if (evt.type === "turn:status") events.push(evt);
    });

    // First send throws "Session not found" (triggers isSessionExpiredError)
    // Second send (retry) would need a full backend session — just verify the status was emitted
    const mockSend = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("Session not found"));
    ta.activeSessions.set("sess-exp", { send: mockSend, on: vi.fn<() => void>() });
    ta.sessionHandles.set("sess-exp", { sessionId: "sess-exp", backendId: "sdk-1" });

    // The recovery will fail (no real backend), but the status should still be emitted
    await mgr.sendMessage("sess-exp", "hello").catch(() => {});

    expect(events.some((e) => e.status === "Session expired, reconnecting...")).toBe(true);
  });

  it("clears status after pending session creation resolves", async () => {
    setupSession("sess-clear");
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const ta = new SessionTestAccess(mgr);

    const events: Array<{ type: string; status?: string | null }> = [];
    mgr.addEventListener((_sid, evt) => {
      if (evt.type === "turn:status") events.push(evt);
    });

    let resolvePending!: () => void;
    const pendingClear = new Promise<void>((r) => {
      resolvePending = r;
    });
    void pendingClear.then(() => ta.pendingSessionCreations.delete("sess-clear"));
    ta.pendingSessionCreations.set("sess-clear", pendingClear);

    const mockSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    ta.activeSessions.set("sess-clear", { send: mockSend, on: vi.fn<() => void>() });
    ta.sessionHandles.set("sess-clear", { sessionId: "sess-clear", backendId: "sdk-1" });

    const sendPromise = mgr.sendMessage("sess-clear", "hello");
    await vi.waitFor(() =>
      expect(events.some((e) => e.status === "Initializing session...")).toBe(true),
    );
    resolvePending();
    await sendPromise;

    // Status should be set then cleared
    expect(events.some((e) => e.status === "Initializing session...")).toBe(true);
    expect(events.some((e) => e.status === null)).toBe(true);
    // Last status event should be the clear
    const lastStatus = events[events.length - 1];
    expect(lastStatus.status).toBeNull();
  });

  it("clears status when session creation fails", async () => {
    setupSession("sess-fail");
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const ta = new SessionTestAccess(mgr);

    const events: Array<{ type: string; status?: string | null }> = [];
    mgr.addEventListener((_sid, evt) => {
      if (evt.type === "turn:status") events.push(evt);
    });

    // Pending creation that resolves but doesn't set up a session handle → throws
    ta.pendingSessionCreations.set("sess-fail", Promise.resolve());
    // No sessionHandles or activeSessions → will throw "No backend session"

    await mgr.sendMessage("sess-fail", "hello").catch(() => {});

    // Status should be cleared even on failure
    expect(events.some((e) => e.status === "Initializing session...")).toBe(true);
    expect(events.some((e) => e.status === null)).toBe(true);
  });

  it("clears 'Initializing session...' when pending session creation rejects", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const ta = new SessionTestAccess(mgr);
    const session = {
      id: "sess-start-reject",
      name: "Test",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: true,
      messages: [],
    };
    vi.spyOn(ta.store, "loadSessionData").mockReturnValue(session);
    const events: Array<string | null> = [];
    mgr.addEventListener((sessionId, event) => {
      if (sessionId === session.id && event.type === "turn:status") events.push(event.status);
    });
    let rejectPending!: (error: Error) => void;
    ta.pendingSessionCreations.set(
      session.id,
      new Promise<void>((_resolve, reject) => {
        rejectPending = reject;
      }),
    );

    const sending = mgr.sendMessage(session.id, "hello");
    await vi.waitFor(() => expect(events).toContain("Initializing session..."));
    rejectPending(new Error("startup failed"));

    await expect(sending).rejects.toThrow("Couldn't start session: startup failed");
    expect(events.at(-1)).toBeNull();
  });

  it("clears 'Resuming session...' when switchSession reports a missing session", async () => {
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    vi.spyOn(access.store, "loadSessionData").mockReturnValue({
      id: "sess-missing",
      name: "Missing",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: false,
      messages: [],
    });
    vi.spyOn(mgr, "switchSession").mockResolvedValue({ kind: "notFound" });
    const statuses: Array<string | null> = [];
    mgr.addEventListener((sessionId, event) => {
      if (sessionId === "sess-missing" && event.type === "turn:status") {
        statuses.push(event.status);
      }
    });

    await expect(mgr.sendMessage("sess-missing", "hello")).rejects.toThrow(
      /no longer exists.*start a new chat/i,
    );

    expect(statuses).toContain("Resuming session...");
    expect(statuses.at(-1)).toBeNull();
  });

  it("clears status before emitViewError on expired-session retry failure", async () => {
    setupSession("sess-exp-fail");
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const ta = new SessionTestAccess(mgr);

    const events: Array<{ type: string; status?: string | null }> = [];
    mgr.addEventListener((_sid, evt) => {
      if (evt.type === "turn:status") events.push(evt);
    });

    const mockSend = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("Session not found"));
    ta.activeSessions.set("sess-exp-fail", { send: mockSend, on: vi.fn<() => void>() });
    ta.sessionHandles.set("sess-exp-fail", { sessionId: "sess-exp-fail", backendId: "sdk-1" });

    await mgr.sendMessage("sess-exp-fail", "hello").catch(() => {});

    // Status should be set then cleared (even though recovery failed)
    expect(events.some((e) => e.status === "Session expired, reconnecting...")).toBe(true);
    expect(events.some((e) => e.status === null)).toBe(true);
  });

  it("does not emit status on happy path (no recovery needed)", async () => {
    setupSession("sess-happy");
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const ta = new SessionTestAccess(mgr);

    const events: Array<{ type: string; status?: string | null }> = [];
    mgr.addEventListener((_sid, evt) => {
      if (evt.type === "turn:status") events.push(evt);
    });

    const mockSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    ta.activeSessions.set("sess-happy", { send: mockSend, on: vi.fn<() => void>() });
    ta.sessionHandles.set("sess-happy", { sessionId: "sess-happy", backendId: "sdk-1" });

    await mgr.sendMessage("sess-happy", "hello");

    // No status events — session was ready, no recovery needed
    expect(events).toHaveLength(0);
  });

  it("does not resend an accepted readiness control after connection loss", async () => {
    setupSession("sess-readiness-connection-loss");
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(mgr);
    const session: PersistedSession = {
      id: "sess-readiness-connection-loss",
      name: "Test",
      backendOrigin: "copilot",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      messages: [],
    };
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(session);
    vi.spyOn(access.store, "loadSessionHeader").mockReturnValue({
      ...session,
      messageCount: 0,
    });
    vi.spyOn(access.store, "saveSessionData").mockImplementation(() => {});
    const backendSend = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("Connection is closed"));
    access.activeSessions.set("sess-readiness-connection-loss", {
      send: backendSend,
      on: vi.fn<() => void>(),
    });
    access.sessionHandles.set("sess-readiness-connection-loss", {
      sessionId: "sess-readiness-connection-loss",
      backendId: "sdk-readiness-connection-loss",
    });
    const restart = vi.spyOn(backend, "restart");
    const accepted = vi.fn<() => void>();

    await expect(
      mgr.sendMessage(
        "sess-readiness-connection-loss",
        '<marshal-control kind="subagent-readiness">resume</marshal-control>',
        undefined,
        {
          noSwitch: true,
          clientMessageId: "subagent-readiness:sess-readiness-connection-loss:batch",
          internalControl: {
            kind: "subagent-readiness",
            exchangeId: "subagent-readiness:sess-readiness-connection-loss:batch",
            side: "request",
          },
          onBackendDispatchStarting: accepted,
          disableConnectionLostRetry: true,
        },
      ),
    ).rejects.toThrow("Connection is closed");

    expect(accepted).toHaveBeenCalledTimes(1);
    expect(backendSend).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
  });

  it("rebuilds the backend session after a corrupted attachment turn-error", async () => {
    setupSession("sess-bad-attachment");
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const ta = new SessionTestAccess(mgr);

    const mockSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    ta.activeSessions.set("sess-bad-attachment", { send: mockSend, on: vi.fn<() => void>() });
    ta.sessionHandles.set("sess-bad-attachment", {
      sessionId: "sess-bad-attachment",
      backendId: "sdk-1",
    });

    let resolveRefresh!: () => void;
    const refreshSpy = vi.spyOn(mgr, "refreshSessionDedup").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    await mgr.sendMessage("sess-bad-attachment", "summarize this", [
      { type: "file", path: "/tmp/bad.pdf", displayName: "bad.pdf" },
    ]);

    ta.subscribeToBackendEvents("sess-bad-attachment");
    const subs = ta.getCopilotBackendSessionSubscribers("sess-bad-attachment");

    for (const listener of subs) {
      listener({
        type: "turn-error",
        error:
          "Execution failed: CAPIError: 400 The file you uploaded is badly formatted or corrupted. Please fix the file and try again.",
        recoverable: true,
      });
    }

    expect(refreshSpy).toHaveBeenCalledWith("sess-bad-attachment");
    expect(ta.pendingSessionCreations.has("sess-bad-attachment")).toBe(true);

    resolveRefresh();
  });

  it("recovers when send rejects synchronously with a corrupt attachment error", async () => {
    setupSession("sess-bad-sync");
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const ta = new SessionTestAccess(mgr);

    const mockSend = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(
        new Error(
          "Execution failed: CAPIError: 400 The file you uploaded is badly formatted or corrupted. Please fix the file and try again.",
        ),
      );
    ta.activeSessions.set("sess-bad-sync", { send: mockSend, on: vi.fn<() => void>() });
    ta.sessionHandles.set("sess-bad-sync", { sessionId: "sess-bad-sync", backendId: "sdk-1" });

    let resolveRefresh!: () => void;
    const refreshSpy = vi.spyOn(mgr, "refreshSessionDedup").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    await expect(
      mgr.sendMessage("sess-bad-sync", "summarize this", [
        { type: "file", path: "/tmp/bad.pdf", displayName: "bad.pdf" },
      ]),
    ).rejects.toThrow("badly formatted or corrupted");

    expect(refreshSpy).toHaveBeenCalledWith("sess-bad-sync");
    expect(ta.pendingSessionCreations.has("sess-bad-sync")).toBe(true);

    resolveRefresh();
  });

  it("clears attachment tracking on idle before a later bad-attachment turn-error", async () => {
    setupSession("sess-bad-idle");
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const ta = new SessionTestAccess(mgr);

    const mockSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    ta.activeSessions.set("sess-bad-idle", { send: mockSend, on: vi.fn<() => void>() });
    ta.sessionHandles.set("sess-bad-idle", { sessionId: "sess-bad-idle", backendId: "sdk-1" });
    const refreshSpy = vi.spyOn(mgr, "refreshSessionDedup").mockResolvedValue(undefined);

    await mgr.sendMessage("sess-bad-idle", "summarize this", [
      { type: "file", path: "/tmp/good.pdf", displayName: "good.pdf" },
    ]);

    ta.subscribeToBackendEvents("sess-bad-idle");
    const subs = ta.getCopilotBackendSessionSubscribers("sess-bad-idle");

    for (const listener of subs) {
      listener({ type: "idle" });
      listener({
        type: "turn-error",
        error:
          "Execution failed: CAPIError: 400 The file you uploaded is badly formatted or corrupted. Please fix the file and try again.",
        recoverable: true,
      });
    }

    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("does not recover a bad-attachment-shaped turn-error without an attachment turn", async () => {
    setupSession("sess-bad-no-attachment");
    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const ta = new SessionTestAccess(mgr);

    const mockSend = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    ta.activeSessions.set("sess-bad-no-attachment", { send: mockSend, on: vi.fn<() => void>() });
    ta.sessionHandles.set("sess-bad-no-attachment", {
      sessionId: "sess-bad-no-attachment",
      backendId: "sdk-1",
    });
    const refreshSpy = vi.spyOn(mgr, "refreshSessionDedup").mockResolvedValue(undefined);

    await mgr.sendMessage("sess-bad-no-attachment", "hello");

    ta.subscribeToBackendEvents("sess-bad-no-attachment");
    const subs = ta.getCopilotBackendSessionSubscribers("sess-bad-no-attachment");

    for (const listener of subs) {
      listener({
        type: "turn-error",
        error:
          "Execution failed: CAPIError: 400 The file you uploaded is badly formatted or corrupted. Please fix the file and try again.",
        recoverable: true,
      });
    }

    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe("SessionManager.initiateMcpOAuth forceReauth", () => {
  it("clears the cached server status before delegating to the backend", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    // Pre-populate a server status in the cache
    ta.mcpServerStatuses.set("testserver", { serverName: "TestServer", status: "connected" });
    // Set an active session so initiateMcpOAuth proceeds past the early guard
    ta.currentSessionId = "sess-1";
    ta.sessionHandles.set("sess-1", { sessionId: "sess-1", backendId: "sdk-1" });
    // Backend will reject — we only care about the status-delete side effect
    vi.spyOn(backend.sessions, "initiateMcpOAuth").mockRejectedValue(new Error("no sdk session"));

    await expect(
      mgr.mcpStatus.initiateMcpOAuth("TestServer", { forceReauth: true }),
    ).rejects.toThrow(/no sdk session/i);
    expect(ta.mcpServerStatuses.has("testserver")).toBe(false);
  });

  it("clears cached status even when forceReauth is omitted", async () => {
    // Always-clear contract: any new OAuth flow must invalidate the local UI
    // status cache so a subsequent waitForMcpServerConnection does not settle
    // synchronously from a stale "connected" or "failed" reading. The
    // forceReauth flag is passed through to the backend (so the SDK knows
    // to discard its OWN token cache) but is independent of this UI cache.
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.mcpServerStatuses.set("testserver", { serverName: "TestServer", status: "connected" });
    ta.currentSessionId = "sess-1";
    ta.sessionHandles.set("sess-1", { sessionId: "sess-1", backendId: "sdk-1" });
    vi.spyOn(backend.sessions, "initiateMcpOAuth").mockRejectedValue(new Error("no sdk session"));

    await expect(mgr.mcpStatus.initiateMcpOAuth("TestServer")).rejects.toThrow(/no sdk session/i);
    expect(ta.mcpServerStatuses.has("testserver")).toBe(false);
  });

  it("retry-without-alias: stale 'failed' status does NOT pre-reject the wait", async () => {
    // Self-review F1: the IPC handler sets forceReauth = !!loginHint, so a
    // "Retry sign in" without a typed alias used to leave a stale "failed"
    // entry in the cache. waitForMcpServerConnection then read that entry and
    // synchronously rejected with the *previous* error before the new flow
    // had a chance to start. After always-clearing, the wait must stay
    // pending until a fresh status event arrives.
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.mcpServerStatuses.set("testserver", {
      serverName: "TestServer",
      status: "failed",
      error: "previous network error",
    });
    ta.currentSessionId = "sess-1";
    ta.sessionHandles.set("sess-1", { sessionId: "sess-1", backendId: "sdk-1" });
    vi.spyOn(backend.sessions, "initiateMcpOAuth").mockResolvedValue({ authorizationUrl: "" });

    // forceReauth is intentionally omitted — mirrors the "Retry sign in
    // without alias" path from mcp-oauth-ipc.ts.
    await mgr.mcpStatus.initiateMcpOAuth("TestServer");

    let settled: "resolved" | "rejected" | "pending" = "pending";
    let rejectMessage: string | undefined;
    const wait = mgr.mcpStatus
      .waitForMcpServerConnection("TestServer", 10_000)
      .then(() => {
        settled = "resolved";
      })
      .catch((err: unknown) => {
        settled = "rejected";
        rejectMessage = err instanceof Error ? err.message : String(err);
      });

    await Promise.resolve();
    expect(settled).toBe("pending");
    expect(rejectMessage).toBeUndefined();

    ta.emitMcpStatusEvent({
      type: "mcp-server-status",
      serverName: "TestServer",
      status: "connected",
    });
    await wait;
    expect(settled).toBe("resolved");
  });

  it("forceReauth + waitForMcpServerConnection: pre-existing 'connected' status does NOT pre-resolve", async () => {
    // Behavioral contract for forceReauth: even though TestServer is currently
    // marked "connected" in the cache, initiateMcpOAuth({forceReauth:true})
    // must clear that entry FIRST so a subsequent waitForMcpServerConnection
    // does not see stale "connected" and resolve immediately. The wait should
    // only resolve when a fresh "connected" event arrives after re-auth.
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.mcpServerStatuses.set("testserver", { serverName: "TestServer", status: "connected" });
    ta.currentSessionId = "sess-1";
    ta.sessionHandles.set("sess-1", { sessionId: "sess-1", backendId: "sdk-1" });
    vi.spyOn(backend.sessions, "initiateMcpOAuth").mockResolvedValue({ authorizationUrl: "" });

    await mgr.mcpStatus.initiateMcpOAuth("TestServer", { forceReauth: true });
    expect(ta.mcpServerStatuses.has("testserver")).toBe(false);

    let settled: "resolved" | "rejected" | "pending" = "pending";
    const wait = mgr.mcpStatus
      .waitForMcpServerConnection("TestServer", 10_000)
      .then(() => {
        settled = "resolved";
      })
      .catch(() => {
        settled = "rejected";
      });

    // Microtask flush — wait must NOT have pre-resolved on the cleared cache.
    await Promise.resolve();
    expect(settled).toBe("pending");

    // A fresh "connected" event after re-auth resolves the wait.
    ta.emitMcpStatusEvent({
      type: "mcp-server-status",
      serverName: "TestServer",
      status: "connected",
    });
    await wait;
    expect(settled).toBe("resolved");
  });
});

describe("SessionManager.initiateMcpOAuth executor selection", () => {
  // The OAuth `oauth.login` RPC is per-session because the SDK looks up
  // serverName in that session's mcpServers config. We must always pick a
  // live session — preferring the originating one when available — and never
  // throw a user-facing "Open a chat session" error.

  it("prefers the originating session (contextSessionId) when its handle is live", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    // Foreground is sess-current, but the originating event came from sess-origin.
    ta.currentSessionId = "sess-current";
    ta.sessionHandles.set("sess-current", { sessionId: "sess-current", backendId: "sdk-c" });
    ta.sessionHandles.set("sess-origin", { sessionId: "sess-origin", backendId: "sdk-o" });
    const spy = vi
      .spyOn(backend.sessions, "initiateMcpOAuth")
      .mockResolvedValue({ authorizationUrl: "" });

    await mgr.mcpStatus.initiateMcpOAuth("TestServer", { contextSessionId: "sess-origin" });

    expect(spy).toHaveBeenCalledWith("sess-origin", "TestServer", { forceReauth: undefined });
  });

  it("falls back to the current session when the originating handle is gone", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.currentSessionId = "sess-current";
    ta.sessionHandles.set("sess-current", { sessionId: "sess-current", backendId: "sdk-c" });
    // contextSessionId points at a session whose handle no longer exists
    // (session was destroyed / never created).
    const spy = vi
      .spyOn(backend.sessions, "initiateMcpOAuth")
      .mockResolvedValue({ authorizationUrl: "" });

    await mgr.mcpStatus.initiateMcpOAuth("TestServer", { contextSessionId: "sess-gone" });

    expect(spy).toHaveBeenCalledWith("sess-current", "TestServer", { forceReauth: undefined });
  });

  it("falls back to any live session when there is no current session", async () => {
    // Regression: prior to the fix this path threw "Open a chat session
    // before signing in to an MCP server."
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.currentSessionId = null;
    ta.sessionHandles.set("sess-live", { sessionId: "sess-live", backendId: "sdk-l" });
    const spy = vi
      .spyOn(backend.sessions, "initiateMcpOAuth")
      .mockResolvedValue({ authorizationUrl: "" });

    await expect(mgr.mcpStatus.initiateMcpOAuth("TestServer")).resolves.toBeDefined();
    expect(spy).toHaveBeenCalledWith("sess-live", "TestServer", { forceReauth: undefined });
  });

  it("no longer throws when no current session exists (creates an executor)", async () => {
    // Even with zero live handles, the user-facing throw must be gone. The
    // manager creates a session as a last resort. We mock createSession to
    // verify the no-throw contract without exercising the full creation path
    // (which other tests in this file already cover).
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.currentSessionId = null;
    expect(ta.sessionHandles.size).toBe(0);

    // Stub createSession so we don't exercise the real backend creation
    // path; install a live handle as if creation succeeded.
    const createSpy = vi.spyOn(mgr, "createSession").mockImplementation(async () => {
      ta.sessionHandles.set("sess-new", { sessionId: "sess-new", backendId: "sdk-n" });
      return {
        id: "sess-new",
        name: "New Chat",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        hasUnread: false,
        backendOrigin: "copilot" as const,
        isActive: true,
        model: "gpt-5",
        soul: undefined,
      };
    });
    const spy = vi
      .spyOn(backend.sessions, "initiateMcpOAuth")
      .mockResolvedValue({ authorizationUrl: "" });

    await expect(mgr.mcpStatus.initiateMcpOAuth("TestServer")).resolves.toBeDefined();
    expect(spy).toHaveBeenCalledWith("sess-new", "TestServer", { forceReauth: undefined });
    // The throwaway executor must NOT activate — user did not ask to switch chats.
    expect(createSpy).toHaveBeenCalledWith(undefined, undefined, { setActive: false });
  });

  it("waits for an in-flight session creation rather than forking a duplicate", async () => {
    // Init / switchSession kicks off background backend session creation and
    // registers a Promise in pendingSessionCreations. While the promise is
    // running, `createBackendSession` (~line 1811) ALSO installs a
    // placeholder handle (`backendId: "pending:..."`) in sessionHandles.
    // initiateMcpOAuth must (a) skip the placeholder and (b) await the
    // pending promise, then use the real handle that replaces the placeholder.
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.currentSessionId = null;
    // Placeholder as installed by createBackendSession before its async
    // backend.sessions.create() returns.
    ta.sessionHandles.set("sess-pending", {
      sessionId: "sess-pending",
      backendId: "pending:sess-pending",
    });
    let resolveCreation!: () => void;
    const pendingPromise = new Promise<void>((resolve) => {
      resolveCreation = resolve;
    }).then(() => {
      // Simulate createBackendSession's effect on success — placeholder
      // overwritten with the real handle.
      ta.sessionHandles.set("sess-pending", {
        sessionId: "sess-pending",
        backendId: "sdk-real",
      });
    });
    ta.pendingSessionCreations.set("sess-pending", pendingPromise);

    const createSpy = vi.spyOn(mgr, "createSession");
    const oauthSpy = vi
      .spyOn(backend.sessions, "initiateMcpOAuth")
      .mockResolvedValue({ authorizationUrl: "" });

    const initiatePromise = mgr.mcpStatus.initiateMcpOAuth("TestServer");

    // Resolve the pending creation after a tick so initiateMcpOAuth has to
    // actually wait on it.
    await Promise.resolve();
    resolveCreation();

    await initiatePromise;

    expect(createSpy).not.toHaveBeenCalled();
    expect(oauthSpy).toHaveBeenCalledWith("sess-pending", "TestServer", {
      forceReauth: undefined,
    });
  });

  it("skips placeholder handles for the originating session and falls back to a usable one", async () => {
    // Production race: the SDK fires mcp.oauth_required on session A while
    // createBackendSession is mid-flight for that same session. The
    // placeholder handle is in sessionHandles but the SDK doesn't have an
    // active session yet. Picking the placeholder would surface as
    // "No active Copilot session" — exactly the regression we're fixing.
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.currentSessionId = null;
    ta.sessionHandles.set("sess-origin", {
      sessionId: "sess-origin",
      backendId: "pending:sess-origin",
    });
    // A different session has already been fully created — it's the usable
    // executor.
    ta.sessionHandles.set("sess-other", { sessionId: "sess-other", backendId: "sdk-other" });
    const oauthSpy = vi
      .spyOn(backend.sessions, "initiateMcpOAuth")
      .mockResolvedValue({ authorizationUrl: "" });

    await mgr.mcpStatus.initiateMcpOAuth("TestServer", { contextSessionId: "sess-origin" });

    // Must NOT be called with the placeholder id.
    expect(oauthSpy).toHaveBeenCalledWith("sess-other", "TestServer", {
      forceReauth: undefined,
    });
  });

  // Step 5: when there are zero live handles AND no in-flight creations,
  // but the index has at least one persisted session for this backend,
  // resolveMcpOAuthExecutor must revive that session via createBackendSession
  // (NOT switchSession) so the SDK has a real handle for the oauth.login
  // RPC. The user did not ask to switch chats, so the revive must not
  // activate the session.
  it("revives a persisted session via createBackendSession when no live handles exist", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.currentSessionId = null;
    expect(ta.sessionHandles.size).toBe(0);

    // Seed the store with one persisted session for this backend.
    vi.spyOn(ta.store, "loadIndex").mockReturnValue({
      activeSessionId: null,
      sessions: [
        {
          id: "sess-persisted",
          name: "Old Chat",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
          hasUnread: false,
          isActive: false,
          backendOrigin: backend.origin,
        },
      ],
    });
    vi.spyOn(ta.store, "loadSessionData").mockReturnValue({
      id: "sess-persisted",
      name: "Old Chat",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      hasUnread: false,
      isActive: false,
      messages: [],
      model: "gpt-5",
      backendOrigin: backend.origin,
    });

    // Stub createBackendSession so we don't exercise the full backend
    // create path. Verify it's called with setActive: false (so the user's
    // UI doesn't jump chats on a sign-in click).
    const reviveSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- access private createBackendSession for test
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
      .spyOn(mgr as any, "createBackendSession")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- match createBackendSession signature
      .mockImplementation(async (...args: any[]) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double, args is `any[]`
        const sessionId: string = args[0] as string;
        ta.sessionHandles.set(sessionId, { sessionId, backendId: "sdk-revived" });
      });
    // switchSession MUST NOT be called — that path has UX side effects
    // (marks read, memory extraction, activates the session) we don't want
    // for a transparent executor revive.
    const switchSpy = vi.spyOn(mgr, "switchSession");
    const oauthSpy = vi
      .spyOn(backend.sessions, "initiateMcpOAuth")
      .mockResolvedValue({ authorizationUrl: "" });

    await expect(mgr.mcpStatus.initiateMcpOAuth("TestServer")).resolves.toBeDefined();

    expect(reviveSpy).toHaveBeenCalledWith("sess-persisted", false, "gpt-5", undefined);
    expect(switchSpy).not.toHaveBeenCalled();
    expect(oauthSpy).toHaveBeenCalledWith("sess-persisted", "TestServer", {
      forceReauth: undefined,
    });
  });

  // Q1 follow-up from review: pin the step-5 → step-6 warn-and-recover branch.
  // If reviving the persisted candidate throws (corrupt session data, backend
  // create rejects, etc.), the resolver MUST swallow + warn and fall through
  // to step 6 (fresh hidden createSession) so the user's sign-in click still
  // succeeds instead of bubbling the revive error back through the IPC.
  it("falls through to step 6 (fresh hidden session) when persisted-session revive throws", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.currentSessionId = null;
    expect(ta.sessionHandles.size).toBe(0);

    vi.spyOn(ta.store, "loadIndex").mockReturnValue({
      activeSessionId: null,
      sessions: [
        {
          id: "sess-corrupt",
          name: "Old Chat",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
          hasUnread: false,
          isActive: false,
          backendOrigin: backend.origin,
        },
      ],
    });
    vi.spyOn(ta.store, "loadSessionData").mockReturnValue(null);

    // Step 5: revive throws.
    const reviveSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- access private createBackendSession for test
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
      .spyOn(mgr as any, "createBackendSession")
      .mockRejectedValue(new Error("revive boom"));
    // Step 6: createSession installs a usable handle for the fresh executor.
    const freshId = "sess-fresh-fallback";
    const createSessionSpy = vi.spyOn(mgr, "createSession").mockImplementation(async () => {
      ta.sessionHandles.set(freshId, { sessionId: freshId, backendId: "sdk-fresh" });
      return {
        id: freshId,
        name: "New Chat",
        createdAt: "2024-02-01T00:00:00Z",
        updatedAt: "2024-02-01T00:00:00Z",
        hasUnread: false,
        isActive: false,
        backendOrigin: backend.origin,
      };
    });
    const oauthSpy = vi
      .spyOn(backend.sessions, "initiateMcpOAuth")
      .mockResolvedValue({ authorizationUrl: "" });

    await expect(mgr.mcpStatus.initiateMcpOAuth("TestServer")).resolves.toBeDefined();

    expect(reviveSpy).toHaveBeenCalledWith("sess-corrupt", false, undefined, undefined);
    // Fresh hidden session is the fallback executor — `setActive: false` so
    // the user's UI does not switch chats.
    expect(createSessionSpy).toHaveBeenCalledWith(undefined, undefined, { setActive: false });
    expect(oauthSpy).toHaveBeenCalledWith(freshId, "TestServer", {
      forceReauth: undefined,
    });
  });
});

describe("SessionManager.signOutMcpOAuth", () => {
  // signOutMcpOAuth is the atomic primitive for user-initiated MCP sign-out.
  // It (1) clears the persisted oauthAlias *before* (2) pushing the config
  // refresh and (3) calling oauth.login({forceReauth: true}). The alias-first
  // ordering matters because forceReauth deletes the cached token as its
  // first SDK operation — a failure partway through must leave the UI in a
  // recoverable state, never claiming "Signed in as foo" with no credentials.

  it("calls the backend with forceReauth: true on a live session", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.currentSessionId = "sess-current";
    ta.sessionHandles.set("sess-current", { sessionId: "sess-current", backendId: "sdk-c" });
    const spy = vi
      .spyOn(backend.sessions, "initiateMcpOAuth")
      .mockResolvedValue({ authorizationUrl: "https://discarded.example/authorize" });

    await mgr.mcpStatus.signOutMcpOAuth("TestServer");

    expect(spy).toHaveBeenCalledWith("sess-current", "TestServer", { forceReauth: true });
  });

  it("clears the cached MCP status entry so subsequent waits don't pre-resolve on stale state", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.mcpServerStatuses.set("testserver", { serverName: "TestServer", status: "connected" });
    ta.currentSessionId = "sess-current";
    ta.sessionHandles.set("sess-current", { sessionId: "sess-current", backendId: "sdk-c" });
    vi.spyOn(backend.sessions, "initiateMcpOAuth").mockResolvedValue({ authorizationUrl: "" });

    await mgr.mcpStatus.signOutMcpOAuth("TestServer");

    expect(ta.mcpServerStatuses.has("testserver")).toBe(false);
  });

  it("propagates backend errors so the IPC handler can audit-log a failure", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.currentSessionId = "sess-current";
    ta.sessionHandles.set("sess-current", { sessionId: "sess-current", backendId: "sdk-c" });
    vi.spyOn(backend.sessions, "initiateMcpOAuth").mockRejectedValue(new Error("SDK kaboom"));

    await expect(mgr.mcpStatus.signOutMcpOAuth("TestServer")).rejects.toThrow(/SDK kaboom/i);
  });

  it("clears the persisted alias and pushes config refresh BEFORE dropping the SDK token", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);
    ta.currentSessionId = "sess-current";
    ta.sessionHandles.set("sess-current", { sessionId: "sess-current", backendId: "sdk-c" });

    const order: string[] = [];
    const customServers: CustomMcpServer[] = [
      { name: "TestServer", url: "https://example.com/mcp", oauthAlias: "alice" },
    ];
    const mcpStore = testDouble<import("./mcp-store").McpStore>({
      getCustomServers: vi.fn<() => CustomMcpServer[]>(() => customServers),
      updateServerConfig: vi
        .fn<(name: string, update: Partial<CustomMcpServer>) => void>()
        .mockImplementation((name, update) => {
          order.push("updateServerConfig");
          // Mutate the array so getCustomServers reflects the new state when
          // setCustomMcpServers re-reads it.
          const idx = customServers.findIndex((s) => s.name === name);
          if (idx >= 0) {
            Object.assign(customServers[idx], update);
          }
        }),
    });
    mgr.setMcpStore(mcpStore);
    const setCustomSpy = vi.spyOn(mgr.mcpStatus, "setCustomMcpServers").mockImplementation(() => {
      order.push("setCustomMcpServers");
    });
    const sdkSpy = vi.spyOn(backend.sessions, "initiateMcpOAuth").mockImplementation(async () => {
      order.push("sdkInitiateMcpOAuth");
      return { authorizationUrl: "" };
    });

    await mgr.mcpStatus.signOutMcpOAuth("TestServer");

    expect(order).toEqual(["updateServerConfig", "setCustomMcpServers", "sdkInitiateMcpOAuth"]);
    expect(mcpStore.updateServerConfig).toHaveBeenCalledWith("TestServer", {
      oauthAlias: undefined,
    });
    expect(setCustomSpy).toHaveBeenCalledTimes(1);
    expect(sdkSpy).toHaveBeenCalledWith("sess-current", "TestServer", { forceReauth: true });
  });

  it("normalizes the server name via toMcpServerKey when looking up the custom-server entry", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);
    ta.currentSessionId = "sess-current";
    ta.sessionHandles.set("sess-current", { sessionId: "sess-current", backendId: "sdk-c" });

    // Canonical name has different casing/punctuation than the caller passed.
    const mcpStore = testDouble<import("./mcp-store").McpStore>({
      getCustomServers: vi.fn<() => CustomMcpServer[]>(() => [
        { name: "Power BI MCP", url: "https://example.com/mcp", oauthAlias: "alice" },
      ]),
      updateServerConfig: vi.fn<(name: string, update: Partial<CustomMcpServer>) => void>(),
    });
    mgr.setMcpStore(mcpStore);
    vi.spyOn(mgr.mcpStatus, "setCustomMcpServers").mockImplementation(() => {});
    const sdkSpy = vi
      .spyOn(backend.sessions, "initiateMcpOAuth")
      .mockResolvedValue({ authorizationUrl: "" });

    await mgr.mcpStatus.signOutMcpOAuth("power_bi_mcp");

    // Update was called with the *canonical* name from the custom-server entry.
    expect(mcpStore.updateServerConfig).toHaveBeenCalledWith("Power BI MCP", {
      oauthAlias: undefined,
    });
    // SDK call uses the canonical name too — the SDK looks up serverName in
    // the session's mcpServers config, which is keyed on the canonical name.
    expect(sdkSpy).toHaveBeenCalledWith("sess-current", "Power BI MCP", { forceReauth: true });
  });

  it("skips alias-clear when the server isn't in the custom-server list (SDK-only runtime entry)", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);
    ta.currentSessionId = "sess-current";
    ta.sessionHandles.set("sess-current", { sessionId: "sess-current", backendId: "sdk-c" });

    const mcpStore = testDouble<import("./mcp-store").McpStore>({
      getCustomServers: vi.fn<() => CustomMcpServer[]>(() => []),
      updateServerConfig: vi.fn<(name: string, update: Partial<CustomMcpServer>) => void>(),
    });
    mgr.setMcpStore(mcpStore);
    const setCustomSpy = vi
      .spyOn(mgr.mcpStatus, "setCustomMcpServers")
      .mockImplementation(() => {});
    vi.spyOn(backend.sessions, "initiateMcpOAuth").mockResolvedValue({ authorizationUrl: "" });

    await mgr.mcpStatus.signOutMcpOAuth("SdkOnlyServer");

    expect(mcpStore.updateServerConfig).not.toHaveBeenCalled();
    expect(setCustomSpy).not.toHaveBeenCalled();
  });
});

describe("SessionManager.waitForMcpServerConnection", () => {
  it("pre-resolves when the cached status is already 'connected'", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.mcpServerStatuses.set("powerbi", { serverName: "PowerBI", status: "connected" });

    await expect(
      mgr.mcpStatus.waitForMcpServerConnection("PowerBI", 5_000),
    ).resolves.toBeUndefined();
    // Listener was added then removed during cleanup — should be empty after settle.
    expect(ta.mcpStatusListeners.size).toBe(0);
    expect(ta.pendingConnectionWaits.has("powerbi")).toBe(false);
  });

  it("pre-rejects with cached error when the cached status is 'failed'", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.mcpServerStatuses.set("powerbi", {
      serverName: "PowerBI",
      status: "failed",
      error: "tenant blocked",
    });

    await expect(mgr.mcpStatus.waitForMcpServerConnection("PowerBI", 5_000)).rejects.toThrow(
      /tenant blocked/,
    );
    expect(ta.mcpStatusListeners.size).toBe(0);
    expect(ta.pendingConnectionWaits.has("powerbi")).toBe(false);
  });

  it("resolves when a 'connected' status event arrives", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    const wait = mgr.mcpStatus.waitForMcpServerConnection("PowerBI", 5_000);
    expect(ta.pendingConnectionWaits.has("powerbi")).toBe(true);
    expect(ta.mcpStatusListeners.size).toBe(1);

    ta.emitMcpStatusEvent({
      type: "mcp-server-status",
      serverName: "PowerBI",
      status: "connected",
    });

    await expect(wait).resolves.toBeUndefined();
    // Listener removed and pending entry cleared via .finally().
    expect(ta.mcpStatusListeners.size).toBe(0);
    expect(ta.pendingConnectionWaits.has("powerbi")).toBe(false);
  });

  it("rejects when a 'failed' status event arrives", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    const wait = mgr.mcpStatus.waitForMcpServerConnection("PowerBI", 5_000);
    ta.emitMcpStatusEvent({
      type: "mcp-server-status",
      serverName: "PowerBI",
      status: "failed",
      error: "token exchange failed",
    });

    await expect(wait).rejects.toThrow(/token exchange failed/);
    expect(ta.mcpStatusListeners.size).toBe(0);
    expect(ta.pendingConnectionWaits.has("powerbi")).toBe(false);
  });

  it("ignores 'pending' / 'needs-auth' status events and keeps waiting", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    let settled: "resolved" | "rejected" | "pending" = "pending";
    const wait = mgr.mcpStatus
      .waitForMcpServerConnection("PowerBI", 5_000)
      .then(() => {
        settled = "resolved";
      })
      .catch(() => {
        settled = "rejected";
      });

    ta.emitMcpStatusEvent({
      type: "mcp-server-status",
      serverName: "PowerBI",
      status: "pending",
    });
    ta.emitMcpStatusEvent({
      type: "mcp-server-status",
      serverName: "PowerBI",
      status: "needs-auth",
    });

    await Promise.resolve();
    expect(settled).toBe("pending");

    // 'connected' finally lands.
    ta.emitMcpStatusEvent({
      type: "mcp-server-status",
      serverName: "PowerBI",
      status: "connected",
    });
    await wait;
    expect(settled).toBe("resolved");
  });

  it("rejects with a timeout error when no status arrives within timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const { SessionManager } = await import("./sessions");
      const backend = await createTestBackend();
      const mgr = new SessionManager("/test/workspace", backend);
      const ta = new SessionTestAccess(mgr);

      const wait = mgr.mcpStatus.waitForMcpServerConnection("PowerBI", 1_000);
      // Suppress potential unhandled-rejection noise while the timer is pending.
      const settled = wait.catch((e: Error) => e);

      vi.advanceTimersByTime(1_001);
      const err = await settled;
      expect(err).toBeInstanceOf(Error);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/Timed out waiting/);

      // Cleanup: listener removed, pending entry cleared.
      expect(ta.mcpStatusListeners.size).toBe(0);
      expect(ta.pendingConnectionWaits.has("powerbi")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces concurrent callers for the same server onto a shared promise", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    const a = mgr.mcpStatus.waitForMcpServerConnection("PowerBI", 5_000);
    const b = mgr.mcpStatus.waitForMcpServerConnection("powerbi", 5_000); // same key after normalization

    // Both callers must share a single in-flight promise — exactly one listener
    // registered, exactly one pending entry.
    expect(ta.pendingConnectionWaits.size).toBe(1);
    expect(ta.mcpStatusListeners.size).toBe(1);
    // The toMcpServerKey-normalized map entry is the same for both casings.
    expect(a).toBe(b);

    ta.emitMcpStatusEvent({
      type: "mcp-server-status",
      serverName: "PowerBI",
      status: "connected",
    });

    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
    expect(ta.pendingConnectionWaits.size).toBe(0);
    expect(ta.mcpStatusListeners.size).toBe(0);
  });

  it("registers an aborter alongside each pending wait", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    // Don't await — we want to observe in-flight bookkeeping.
    const wait = mgr.mcpStatus.waitForMcpServerConnection("PowerBI", 5_000);
    // Suppress unhandled-rejection noise from the wait we're abandoning.
    const settled = wait.catch((e: Error) => e);

    expect(ta.pendingConnectionWaits.size).toBe(1);
    expect(ta.mcpConnectionWaitAborters.size).toBe(1);
    expect(ta.mcpConnectionWaitAborters.has("powerbi")).toBe(true);

    // Drive the wait to completion so the aborter self-evicts via cleanup().
    ta.emitMcpStatusEvent({
      type: "mcp-server-status",
      serverName: "PowerBI",
      status: "connected",
    });
    await settled;

    expect(ta.mcpConnectionWaitAborters.size).toBe(0);
  });
});

describe("SessionManager — pending MCP connection waits drained on session teardown", () => {
  // Regression test for a round-7 review finding: prior to the drain, a
  // pauseSession / deleteSession / deleteAllSessions call while OAuth was in
  // flight left the wait promise pending for the full 180s timeout, wedging
  // the IPC handler and blocking future callers from starting a fresh wait
  // for the same server (because pendingConnectionWaits coalesces by key).

  it("rejects in-flight waits when pauseSession tears down the last session", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    // Simulate "exactly one active session" so `sessionHandles.size === 0`
    // becomes true after pauseSession runs. We don't need a real session
    // handle — the drain trigger is the size-check guard.
    ta.sessionHandles.set("session-1", { id: "session-1" });

    const wait = mgr.mcpStatus.waitForMcpServerConnection("PowerBI", 60_000);
    const rejected = wait.catch((e: Error) => e);
    expect(ta.pendingConnectionWaits.has("powerbi")).toBe(true);

    await mgr.pauseSession("session-1");

    const err = await rejected;
    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toMatch(/wait aborted: session torn down/i);
    expect(ta.pendingConnectionWaits.size).toBe(0);
    expect(ta.mcpConnectionWaitAborters.size).toBe(0);
    expect(ta.mcpStatusListeners.size).toBe(0);
  });

  it("does NOT drain when other sessions remain active after pauseSession", async () => {
    // When pauseSession is called but sessions are still active, the OAuth
    // wait initiated under the session that paused may still be relevant
    // (e.g. another active session is the same SDK session), so the existing
    // guard says "only drain when the last session is gone". This test pins
    // that guard so a future change can't accidentally widen the drain.
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.sessionHandles.set("session-1", { id: "session-1" });
    ta.sessionHandles.set("session-2", { id: "session-2" });

    const wait = mgr.mcpStatus.waitForMcpServerConnection("PowerBI", 60_000);
    const rejected = wait.catch((e: Error) => e);

    await mgr.pauseSession("session-1");

    // session-2 is still alive — wait must remain pending.
    expect(ta.pendingConnectionWaits.has("powerbi")).toBe(true);
    expect(ta.mcpConnectionWaitAborters.has("powerbi")).toBe(true);

    // Cleanup: drain the remaining wait so the test doesn't leak a timer.
    await mgr.deleteAllSessions();
    await rejected;
  });

  it("rejects in-flight waits on deleteAllSessions", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    const wait = mgr.mcpStatus.waitForMcpServerConnection("PowerBI", 60_000);
    const rejected = wait.catch((e: Error) => e);
    expect(ta.pendingConnectionWaits.has("powerbi")).toBe(true);

    await mgr.deleteAllSessions();

    const err = await rejected;
    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toMatch(/wait aborted: session torn down/i);
    expect(ta.pendingConnectionWaits.size).toBe(0);
    expect(ta.mcpConnectionWaitAborters.size).toBe(0);
    expect(ta.mcpStatusListeners.size).toBe(0);
  });

  it("rejects in-flight waits when deleteSession removes the last session", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    ta.sessionHandles.set("session-1", { id: "session-1" });

    const wait = mgr.mcpStatus.waitForMcpServerConnection("PowerBI", 60_000);
    const rejected = wait.catch((e: Error) => e);

    await mgr.deleteSession("session-1");

    const err = await rejected;
    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toMatch(/wait aborted: session torn down/i);
    expect(ta.pendingConnectionWaits.size).toBe(0);
    expect(ta.mcpConnectionWaitAborters.size).toBe(0);
    expect(ta.mcpStatusListeners.size).toBe(0);
  });

  it("allows a fresh wait for the same server after a drained session teardown", async () => {
    // Without the drain, pendingConnectionWaits keeps the old (already-resolved)
    // promise entry, and the second caller silently joins a wait that nobody
    // will ever resolve. With the drain, the entry is cleared and the next
    // call gets a fresh promise.
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);

    const first = mgr.mcpStatus.waitForMcpServerConnection("PowerBI", 60_000);
    const firstRejected = first.catch((e: Error) => e);

    await mgr.deleteAllSessions();
    await firstRejected;

    // A fresh wait must produce a new pending promise, not the rejected one.
    const second = mgr.mcpStatus.waitForMcpServerConnection("PowerBI", 5_000);
    expect(second).not.toBe(first);
    expect(ta.pendingConnectionWaits.has("powerbi")).toBe(true);
    expect(ta.mcpConnectionWaitAborters.has("powerbi")).toBe(true);

    ta.emitMcpStatusEvent({
      type: "mcp-server-status",
      serverName: "PowerBI",
      status: "connected",
    });
    await expect(second).resolves.toBeUndefined();
  });
});

describe("SessionManager — llm-usage telemetry via log.event", () => {
  function setupSession(id: string) {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes("index.json")) {
        return JSON.stringify({
          sessions: [{ id, name: "Test", updatedAt: "", backendOrigin: "copilot" }],
        });
      }
      if (path.includes(id)) {
        return JSON.stringify({ id, name: "Test", messages: [], backendOrigin: "copilot" });
      }
      return "{}";
    });
  }

  it("emits a log.event with LlmTokenUsage scenario when an llm-usage event fires", async () => {
    setupSession("sess-telemetry");
    const { addLogSink } = await import("../common/marshal-logger");
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();

    // Capture log entries via a sink.
    const captured: Array<import("../common/marshal-logger").LogEntry> = [];
    const removeSink = addLogSink((entry) => {
      if (entry.event?.scenario === "LlmTokenUsage") captured.push(entry);
    });

    let subscribedListener: ((event: unknown) => void) | undefined;
    const origSubscribe = backend.sessions.subscribe.bind(backend.sessions);
    vi.spyOn(backend.sessions, "subscribe").mockImplementation(
      (sessionId: string, listener: (event: any) => void) => {
        subscribedListener = listener;
        return origSubscribe(sessionId, listener);
      },
    );

    const mgr = new SessionManager("/test/workspace", backend);
    const ta = new SessionTestAccess(mgr);
    ta.sessionHandles.set("sess-telemetry", {
      sessionId: "sess-telemetry",
      backendId: "sdk-1",
    });
    ta.subscribeToBackendEvents("sess-telemetry");

    expect(subscribedListener).toBeDefined();

    subscribedListener!({
      type: "llm-usage",
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      cost: 0.5,
      duration: 1000,
      ttftMs: 80,
      interTokenLatencyMs: 10,
      initiator: undefined,
      apiCallId: undefined,
      providerCallId: undefined,
    });

    try {
      expect(captured).toHaveLength(1);
      expect(captured[0].event!.fields).toEqual({
        type: "llm-usage",
        sessionId: "sess-telemetry",
        model: "gpt-4o",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        cost: 0.5,
        duration: 1000,
        ttftMs: 80,
        interTokenLatencyMs: 10,
        initiator: undefined,
        apiCallId: undefined,
        providerCallId: undefined,
        source: "HostApp",
      });
    } finally {
      removeSink();
    }
  });
});

// ── emitSessionsListChanged coverage ───────────────────────────────────────
// Pins the invariant: every SessionManager index-mutating method fires
// addSessionsListListener callbacks.

describe("SessionManager.emitSessionsListChanged", () => {
  function seedOneSession(id = "s1") {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const pathStr = String(p);
      if (pathStr.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            {
              id,
              name: "Test",
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
              hasUnread: false,
              isActive: true,
              source: "user",
              backendOrigin: "copilot",
            },
          ],
          activeSessionId: id,
        });
      }
      if (pathStr.includes(id)) {
        return JSON.stringify({
          id,
          name: "Test",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
          hasUnread: false,
          isActive: true,
          messages: [],
          backendOrigin: "copilot",
        });
      }
      return "{}";
    });
  }

  function seedWorkspaceSession(id = "ws-1") {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const pathStr = String(p);
      if (pathStr.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            {
              id,
              name: "WS Test",
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
              hasUnread: false,
              isActive: true,
              source: "workspace",
              workspaceName: "OldName",
              backendOrigin: "copilot",
            },
          ],
          activeSessionId: id,
        });
      }
      if (pathStr.includes(id)) {
        return JSON.stringify({
          id,
          name: "WS Test",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
          hasUnread: false,
          isActive: true,
          messages: [],
          source: "workspace",
          workspaceName: "OldName",
          backendOrigin: "copilot",
        });
      }
      return "{}";
    });
  }

  it("createSession emits sessions:list-changed", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes("index.json")) return JSON.stringify({ sessions: [] });
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
    vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined);

    const emitted: number[] = [];
    mgr.addSessionsListListener(() => emitted.push(1));

    await mgr.createSession();
    expect(emitted).toHaveLength(1);
  });

  it("switchSession emits sessions:list-changed", async () => {
    seedOneSession("sw-1");

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spying on private method
    vi.spyOn(mgr as any, "createBackendSession").mockResolvedValue(undefined);
    const emitted: number[] = [];
    mgr.addSessionsListListener(() => emitted.push(1));

    await mgr.switchSession("sw-1");
    expect(emitted).toHaveLength(1);
  });

  it("deleteSession emits sessions:list-changed", async () => {
    seedOneSession("del-1");

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const emitted: number[] = [];
    mgr.addSessionsListListener(() => emitted.push(1));

    await mgr.deleteSession("del-1");
    expect(emitted).toHaveLength(1);
  });

  it("deleteAllSessions emits sessions:list-changed", async () => {
    seedOneSession("da-1");

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const emitted: number[] = [];
    mgr.addSessionsListListener(() => emitted.push(1));

    await mgr.deleteAllSessions();
    expect(emitted).toHaveLength(1);
  });

  it("renameSession emits sessions:list-changed", async () => {
    seedOneSession("ren-1");

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const emitted: number[] = [];
    mgr.addSessionsListListener(() => emitted.push(1));

    await mgr.renameSession("ren-1", "New Name");
    expect(emitted).toHaveLength(1);
  });

  it("markUnread emits sessions:list-changed", async () => {
    seedOneSession("mu-1");

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    // markUnread skips the current session, so set currentSessionId to something else
    access.currentSessionId = "other-session";
    const emitted: number[] = [];
    mgr.addSessionsListListener(() => emitted.push(1));

    mgr.markUnread("mu-1");
    expect(emitted).toHaveLength(1);
  });

  it("markRead emits sessions:list-changed", async () => {
    // Seed with hasUnread: true so markRead has work to do
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const pathStr = String(p);
      if (pathStr.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            {
              id: "mr-1",
              name: "Test",
              hasUnread: true,
              isActive: true,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
              backendOrigin: "copilot",
            },
          ],
        });
      }
      if (pathStr.includes("mr-1")) {
        return JSON.stringify({
          id: "mr-1",
          name: "Test",
          hasUnread: true,
          messages: [],
          backendOrigin: "copilot",
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const emitted: number[] = [];
    mgr.addSessionsListListener(() => emitted.push(1));

    mgr.markRead("mr-1");
    expect(emitted).toHaveLength(1);
  });

  it("renameSessionsByWorkspace emits sessions:list-changed", async () => {
    seedWorkspaceSession("ws-emit-1");

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const emitted: number[] = [];
    mgr.addSessionsListListener(() => emitted.push(1));

    await mgr.renameSessionsByWorkspace("OldName", "NewName");
    expect(emitted).toHaveLength(1);
  });

  // ── No-op guards: verify that redundant mutations suppress the emit ──

  it("markRead on already-read session does NOT emit", async () => {
    // Session with hasUnread: false
    seedOneSession("noop-mr");

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const emitted: number[] = [];
    mgr.addSessionsListListener(() => emitted.push(1));

    mgr.markRead("noop-mr");
    expect(emitted).toHaveLength(0);
  });

  it("markUnread on already-unread session does NOT emit", async () => {
    // Seed with hasUnread: true
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const pathStr = String(p);
      if (pathStr.includes("index.json")) {
        return JSON.stringify({
          sessions: [
            {
              id: "noop-mu",
              name: "Test",
              hasUnread: true,
              isActive: true,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
              backendOrigin: "copilot",
            },
          ],
        });
      }
      if (pathStr.includes("noop-mu")) {
        return JSON.stringify({
          id: "noop-mu",
          name: "Test",
          hasUnread: true,
          messages: [],
          backendOrigin: "copilot",
        });
      }
      return "{}";
    });

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const access = new SessionTestAccess(mgr);
    access.currentSessionId = "other-session";
    const emitted: number[] = [];
    mgr.addSessionsListListener(() => emitted.push(1));

    mgr.markUnread("noop-mu");
    expect(emitted).toHaveLength(0);
  });

  it("renameSessionsByWorkspace with no matching sessions does NOT emit", async () => {
    seedOneSession("noop-rw"); // user session, not workspace

    const { SessionManager } = await import("./sessions");
    const mgr = new SessionManager("/test/workspace", await createTestBackend());
    const emitted: number[] = [];
    mgr.addSessionsListListener(() => emitted.push(1));

    await mgr.renameSessionsByWorkspace("NonExistent", "NewName");
    expect(emitted).toHaveLength(0);
  });
});

describe("SessionManager.compactSession", () => {
  it("resumes an inactive persisted session before compacting", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    vi.spyOn(backend, "capabilities").mockReturnValue({
      ...backend.capabilities(),
      sessionCompaction: true,
    });
    const compact = vi.spyOn(backend.sessions, "compact").mockResolvedValue();
    const manager = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(manager);
    const session = testDouble<PersistedSession>({
      id: "compact-inactive",
      name: "Compact inactive",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: true,
      messages: [],
      backendId: "backend-compact-inactive",
    });
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(session);
    const createBackendSession = vi.fn<Parameters<typeof access.replaceCreateBackendSession>[0]>(
      async (sessionId) => {
        access.sessionHandles.set(sessionId, {
          sessionId,
          backendId: session.backendId,
        });
      },
    );
    access.replaceCreateBackendSession(createBackendSession);

    await manager.compactSession(session.id);

    expect(createBackendSession).toHaveBeenCalledWith(
      session.id,
      false,
      session.model,
      session.soul,
    );
    expect(compact).toHaveBeenCalledWith(session.id);
  });

  it("recreates a stale backend handle and retries compaction once", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    vi.spyOn(backend, "capabilities").mockReturnValue({
      ...backend.capabilities(),
      sessionCompaction: true,
    });
    const compact = vi
      .spyOn(backend.sessions, "compact")
      .mockRejectedValueOnce(new Error("No active runtime session for: compact-stale"))
      .mockResolvedValueOnce();
    const manager = new SessionManager("/test/workspace", backend);
    const access = new SessionTestAccess(manager);
    const session = testDouble<PersistedSession>({
      id: "compact-stale",
      name: "Compact stale",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      backendOrigin: "copilot" as const,
      isActive: true,
      messages: [],
      backendId: "backend-compact-stale",
    });
    vi.spyOn(access.store, "loadSessionData").mockReturnValue(session);
    access.sessionHandles.set(session.id, {
      sessionId: session.id,
      backendId: session.backendId,
    });
    const createBackendSession = vi.fn<Parameters<typeof access.replaceCreateBackendSession>[0]>(
      async (sessionId) => {
        access.sessionHandles.set(sessionId, {
          sessionId,
          backendId: session.backendId,
        });
      },
    );
    access.replaceCreateBackendSession(createBackendSession);

    await manager.compactSession(session.id);

    expect(createBackendSession).toHaveBeenCalledOnce();
    expect(compact).toHaveBeenCalledTimes(2);
  });
});

/**
 * Drives one worktree-backed subagent launch whose prompt dispatch fails, so the
 * failed-launch worktree discard can be proven end to end through the real git
 * call sequence.
 */
async function createFailedLaunchHarness(options?: {
  status?: string;
  headAfterCreate?: string;
  checkedOutRef?: string;
  branchHeadAtDiscard?: string;
  worktreeRootAtCreate?: string;
  worktreeRootAtDiscard?: string;
}): Promise<{
  launch: () => Promise<unknown>;
  worktreePath: string;
  branchName: () => string;
  gitCall: (...prefix: string[]) => string[] | undefined;
}> {
  const { SessionManager } = await import("./sessions");
  const mgr = new SessionManager("/test/workspace", await createTestBackend());
  const access = new SessionTestAccess(mgr);
  vi.spyOn(mgr, "initClient").mockResolvedValue(undefined);
  access.replaceCreateBackendSession(async () => undefined);
  vi.spyOn(mgr, "sendMessage").mockRejectedValue(
    new Error("Couldn't start session: createSession timed out after 45000ms"),
  );

  const repoPath = nodePath.resolve("C:\\src\\marshal");
  const worktreeRoot =
    options?.worktreeRootAtCreate ?? nodePath.resolve("C:\\internal\\marshal-worktrees");
  const headAtCreate = "a".repeat(40);
  mockedFs.realpathSync.mockImplementation((value) => String(value));
  mockedFs.statSync.mockReturnValue(workspaceDirectoryStat());
  vi.spyOn(workspaceStore, "getWorkspaceRegistry").mockReturnValue({
    Scratchpad: { origin: "scratchpad" },
  });

  let created = false;
  let branchName = "";
  let worktreePath = "";
  const calls: string[][] = [];
  access.replaceGetWorktreeRoot(() =>
    created ? (options?.worktreeRootAtDiscard ?? worktreeRoot) : worktreeRoot,
  );
  access.replaceGit(async (_cwd, args) => {
    calls.push([...args]);
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return repoPath;
    if (args[0] === "worktree" && args[1] === "add") {
      branchName = args[3];
      worktreePath = args[4];
      created = true;
      return "";
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      // The first read is the creation head; a later read may show it moved.
      return calls.filter((call) => call[0] === "rev-parse" && call[1] === "HEAD").length === 1
        ? headAtCreate
        : (options?.headAfterCreate ?? headAtCreate);
    }
    if (args[0] === "worktree" && args[1] === "list") return `worktree ${worktreePath}\0`;
    if (args[0] === "status") return options?.status ?? "";
    if (args[0] === "symbolic-ref") {
      return options?.checkedOutRef ?? `refs/heads/${branchName}`;
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      return options?.branchHeadAtDiscard ?? headAtCreate;
    }
    return "";
  });

  return {
    launch: () =>
      mgr.createSubagentSession({
        task: "Implement the assigned change",
        workspaceName: "Scratchpad",
        repoPath,
        createWorktree: true,
        parentSessionId: "parent-1",
        suppressInitialTodoInstruction: true,
      }),
    get worktreePath() {
      return worktreePath;
    },
    branchName: () => branchName,
    gitCall: (...prefix) =>
      calls.find((call) => prefix.every((segment, index) => call[index] === segment)),
  };
}
