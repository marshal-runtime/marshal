/**
 * Pins the call-site wiring of the Marshal filesystem self-tools' confinement
 * boundary: a workspace-scoped ("Co-create") session must thread its own
 * workspaceDir (NOT the global one) into getSelfFsTools. Regression guard for the
 * bug where buildAllTools briefly used the global dir, caught only by the
 * flaky e2e-real/28 before this. getSelfFsTools is mocked here, so the tool's own
 * path enforcement (realpath guard, grant scoping) lives in marshal-fs/tools.test.ts.
 */
import type { Tool, ToolInvocation } from "@github/copilot-sdk";
import { describe, expect, it, vi } from "vitest";

import type { IBackgroundToolInvocationManager, RunningToolCallInfo } from "../ports";

const h = vi.hoisted(() => ({
  // Captures the deps object getSelfFsTools is constructed with, so we can read
  // back the workspaceDir the session threaded into it.
  capturedFsDeps: undefined as { getWorkspaceDir: () => string } | undefined,
  getSelfFsTools: vi.fn<(deps: { getWorkspaceDir: () => string }) => unknown[]>((deps) => {
    h.capturedFsDeps = deps;
    return [];
  }),
  getSelfTools: vi.fn<() => unknown[]>(() => []),
  cancelBackgroundEffect: undefined as (() => Promise<void> | void) | undefined,
  backgroundManager: {
    getExclusiveSessionTools: vi.fn<() => undefined>(() => undefined),
    claimBackgroundToolDispatch: vi.fn<
      IBackgroundToolInvocationManager["claimBackgroundToolDispatch"]
    >(async (request) => ({
      kind: "claimed",
      claim: {
        claimId: `${request.ownerSessionId}:${request.toolCallId}:claim`,
        ownerSessionId: request.ownerSessionId,
        toolCallId: request.toolCallId,
        claimedAtMs: request.requestedAtMs,
        cancellationToken: {
          tokenId: `${request.ownerSessionId}:${request.toolCallId}:token`,
          ownerSessionId: request.ownerSessionId,
          claimId: `${request.ownerSessionId}:${request.toolCallId}:claim`,
          issuedAtMs: request.requestedAtMs,
        },
      },
    })),
    beginBackgroundToolInvocation: vi.fn<
      IBackgroundToolInvocationManager["beginBackgroundToolInvocation"]
    >(async (args) => {
      h.cancelBackgroundEffect = args.cancel;
      const invocation: RunningToolCallInfo = {
        handle: `${args.sessionId}:${args.toolCallId}`,
        sessionId: args.sessionId,
        toolCallId: args.toolCallId,
        toolName: args.toolName,
        startedAt: "2026-06-08T14:00:00.000Z",
        elapsedMs: 0,
        status: "running",
        backgrounded: false,
        resultAvailable: false,
        longRunning: false,
        cancellable: true,
        cancellationScope: args.cancellationScope ?? "tool",
      };
      return { handle: invocation.handle, claim: args.claim, invocation };
    }),
    attachBackgroundToolProcess: vi.fn<
      IBackgroundToolInvocationManager["attachBackgroundToolProcess"]
    >(async () => null),
    detachBackgroundToolInvocation: vi.fn<
      IBackgroundToolInvocationManager["detachBackgroundToolInvocation"]
    >(async (handle) => ({
      handle,
      sessionId: "s1",
      toolCallId: "tool-1",
      toolName: "slow_tool",
      startedAt: "2026-06-08T14:00:00.000Z",
      elapsedMs: 30_000,
      status: "running",
      backgrounded: true,
      resultAvailable: false,
      longRunning: true,
      cancellable: true,
      cancellationScope: "tool",
    })),
    completeBackgroundToolInvocation: vi.fn<
      IBackgroundToolInvocationManager["completeBackgroundToolInvocation"]
    >(async (handle, completion) => ({
      handle,
      sessionId: "s1",
      toolCallId: "tool-1",
      toolName: "slow_tool",
      startedAt: "2026-06-08T14:00:00.000Z",
      elapsedMs: 30_000,
      status: completion.success ? "completed" : "failed",
      backgrounded: false,
      resultAvailable: true,
      longRunning: false,
      cancellable: false,
      cancellationScope: "none",
    })),
    requestBackgroundToolCancellation: vi.fn<
      IBackgroundToolInvocationManager["requestBackgroundToolCancellation"]
    >(async (request) => {
      await h.cancelBackgroundEffect?.();
      return {
        success: true,
        handle: request.handle,
        sessionId: request.token.ownerSessionId,
        status: "cancelling",
        cancellationScope: "tool",
      };
    }),
  },
}));

vi.mock("fs", () => ({
  default: { existsSync: vi.fn<() => boolean>(() => false), constants: { X_OK: 1 } },
  existsSync: vi.fn<() => boolean>(() => false),
  constants: { X_OK: 1 },
}));
vi.mock("child_process", () => ({ spawn: vi.fn<() => void>(), execFile: vi.fn<() => void>() }));
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0-test", getPath: () => "/tmp" },
}));
vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn<() => void>(),
  CopilotSession: vi.fn<() => void>(),
}));
vi.mock("../../marshal-fs/tools", () => ({ getSelfFsTools: h.getSelfFsTools }));
vi.mock("../../self-tools", () => ({ getSelfTools: h.getSelfTools }));

import type { ContextTier, ReasoningEffort } from "../../../common/marshal-ipc-contract";
import { testDouble } from "../../testing/harness";
import type { CreateSessionOpts } from "../types";
import type { ICopilotProviderForSession } from "./internal";

const GLOBAL_DIR = "/global/workspace";

async function createSessionWith(opts: Partial<CreateSessionOpts>): Promise<{
  createSession: ReturnType<typeof vi.fn>;
  sessionBackend: InstanceType<typeof import("./session").CopilotSessionBackend>;
  sdkSession: {
    sessionId: string;
    on: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
  unsubscribe: ReturnType<typeof vi.fn>;
  config: {
    workingDirectory?: string;
    systemMessage?: unknown;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    contextTier?: ContextTier;
    tools?: Tool[];
    availableTools?: string[];
  };
  workingDirectory: string | undefined;
}> {
  h.capturedFsDeps = undefined;
  h.cancelBackgroundEffect = undefined;
  h.getSelfFsTools.mockClear();
  h.getSelfTools.mockClear();
  h.backgroundManager.claimBackgroundToolDispatch.mockClear();
  h.backgroundManager.beginBackgroundToolInvocation.mockClear();
  h.backgroundManager.attachBackgroundToolProcess.mockClear();
  h.backgroundManager.detachBackgroundToolInvocation.mockClear();
  h.backgroundManager.completeBackgroundToolInvocation.mockClear();
  h.backgroundManager.requestBackgroundToolCancellation.mockClear();
  const { CopilotSessionBackend } = await import("./session");

  const unsubscribe = vi.fn<() => void>();
  const sdkSession = {
    sessionId: "sdk-1",
    on: vi.fn<() => () => void>(() => unsubscribe),
    send: vi.fn<() => Promise<string>>().mockResolvedValue("accepted"),
    abort: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    disconnect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    rpc: { mcp: { list: vi.fn<() => Promise<unknown>>().mockResolvedValue({}) } },
  };
  const createSession = vi.fn<
    (cfg: {
      workingDirectory?: string;
      systemMessage?: unknown;
      model?: string;
      reasoningEffort?: ReasoningEffort;
      contextTier?: ContextTier;
      tools?: Tool[];
      availableTools?: string[];
    }) => Promise<unknown>
  >(async (cfg) => {
    void cfg;
    return sdkSession;
  });
  const client = { createSession };
  let activeSession: typeof sdkSession | undefined;

  const backend = testDouble<ICopilotProviderForSession>({
    getClient: () => client,
    initClient: vi.fn<() => void>(),
    getWorkspaceDir: () => GLOBAL_DIR,
    getMcpConfig: () => ({}),
    getSelfToolDeps: () => ({
      settingsManager: { get: () => ({}) },
      workServices: {},
      sessionManager: h.backgroundManager,
    }),
    getPermissionPolicy: () => ({ getEffectiveFolderGrants: () => ({ read: [], write: [] }) }),
    getTimezone: () => "UTC",
    getActiveSession: () => activeSession,
    setActiveSession: vi.fn<(_sessionId: string, session: typeof sdkSession) => void>(
      (_sessionId, session) => {
        activeSession = session;
      },
    ),
    deleteActiveSession: vi.fn<() => void>(() => {
      activeSession = undefined;
    }),
    deleteSessionSubscribers: vi.fn<() => void>(),
  });

  const sessionBackend = new CopilotSessionBackend(backend);
  await sessionBackend.create({
    sessionId: "s1",
    model: "test-model",
    systemMessage: "sys",
    ...opts,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal valid CreateSessionOpts for this focused test
  } as CreateSessionOpts);

  const cfg = createSession.mock.calls[0]?.[0] as
    | {
        workingDirectory?: string;
        systemMessage?: unknown;
        model?: string;
        reasoningEffort?: ReasoningEffort;
        contextTier?: ContextTier;
        tools?: Tool[];
        availableTools?: string[];
      }
    | undefined;
  if (!cfg) throw new Error("createSession was not called");
  return {
    createSession,
    sessionBackend,
    sdkSession,
    unsubscribe,
    config: cfg,
    workingDirectory: cfg.workingDirectory,
  };
}

describe("CopilotSessionBackend create — self-tools workspace confinement", () => {
  it("releases the active execution route immediately but waits for chat abort quiescence", async () => {
    const { sessionBackend, sdkSession } = await createSessionWith({});
    await sessionBackend.send("s1", { prompt: "first turn" });
    let resolveAbort!: () => void;
    sdkSession.abort.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          resolveAbort = resolve;
        }),
    );

    const abort = sessionBackend.abort("s1");
    let abortSettled = false;
    void abort.then(() => {
      abortSettled = true;
    });
    await vi.waitFor(() => expect(sdkSession.abort).toHaveBeenCalledOnce());
    expect(abortSettled).toBe(false);
    await expect(sessionBackend.send("s1", { prompt: "steering replacement" })).resolves.toBe(
      undefined,
    );
    resolveAbort();
    await expect(abort).resolves.toEqual({});

    expect(sdkSession.send).toHaveBeenCalledTimes(2);
  });

  it("disconnects an SDK session that succeeds after its start timeout", async () => {
    const { CopilotSessionBackend } = await import("./session");
    vi.useFakeTimers();
    try {
      const lateSession = {
        sessionId: "sdk-late",
        on: vi.fn<() => () => void>(() => () => {}),
        destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        disconnect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      };
      let resolveCreate!: (session: typeof lateSession) => void;
      let signalCreateStarted!: () => void;
      const createStarted = new Promise<void>((resolve) => {
        signalCreateStarted = resolve;
      });
      const client = {
        createSession: vi.fn<() => Promise<typeof lateSession>>(
          () =>
            new Promise((resolve) => {
              resolveCreate = resolve;
              signalCreateStarted();
            }),
        ),
      };
      const backend = testDouble<ICopilotProviderForSession>({
        getClient: () => client,
        initClient: vi.fn<() => void>(),
        getWorkspaceDir: () => GLOBAL_DIR,
        getMcpConfig: () => ({}),
        getSelfToolDeps: () => ({
          settingsManager: { get: () => ({}) },
          workServices: {},
          sessionManager: h.backgroundManager,
        }),
        getPermissionPolicy: () => ({ getEffectiveFolderGrants: () => ({ read: [], write: [] }) }),
        getTimezone: () => "UTC",
        getActiveSession: () => undefined,
        setActiveSession: vi.fn<() => void>(),
        deleteActiveSession: vi.fn<() => void>(),
        deleteSessionSubscribers: vi.fn<() => void>(),
      });
      const start = new CopilotSessionBackend(backend).create({ sessionId: "late" });
      const rejection = start.catch((error: unknown) => error);

      await createStarted;
      await vi.advanceTimersByTimeAsync(45_000);
      expect(String(await rejection)).toContain("createSession timed out");
      resolveCreate(lateSession);
      await Promise.resolve();
      await Promise.resolve();

      expect(lateSession.disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("scopes the filesystem self-tools to the session's workspaceDir, not the global one", async () => {
    const { workingDirectory } = await createSessionWith({ workspaceDir: "/session/sub" });
    expect(h.capturedFsDeps?.getWorkspaceDir()).toBe("/session/sub");
    // The SDK session is opened against the same per-session dir.
    expect(workingDirectory).toBe("/session/sub");
  });

  it("revalidates the workspace after backend preparation and before SDK creation", async () => {
    let validationCount = 0;
    const assertWorkspaceCurrent = vi.fn<() => void>(() => {
      validationCount += 1;
      if (validationCount === 2) throw new Error("workspace identity changed");
    });

    await expect(createSessionWith({ assertWorkspaceCurrent })).rejects.toThrow(
      "workspace identity changed",
    );
    expect(assertWorkspaceCurrent).toHaveBeenCalledTimes(2);
  });

  it("falls back to the global workspace when the session has no workspaceDir override", async () => {
    const { workingDirectory } = await createSessionWith({});
    expect(h.capturedFsDeps?.getWorkspaceDir()).toBe(GLOBAL_DIR);
    expect(workingDirectory).toBe(GLOBAL_DIR);
  });

  it("omits systemMessage when the session opts leave it undefined", async () => {
    const { config } = await createSessionWith({ systemMessage: undefined });
    expect(config).not.toHaveProperty("systemMessage");
  });

  it("does not substitute a model when the session opts leave it undefined", async () => {
    const { config } = await createSessionWith({ model: undefined });
    expect(config.model).toBeUndefined();
  });

  it("passes reasoning effort through to the SDK session config", async () => {
    const { config } = await createSessionWith({ reasoningEffort: "high" });
    expect(config.reasoningEffort).toBe("high");
  });

  it("passes max reasoning and long context through to the SDK session config", async () => {
    const { config } = await createSessionWith({
      reasoningEffort: "max",
      contextTier: "long_context",
    });
    expect(config).toMatchObject({
      reasoningEffort: "max",
      contextTier: "long_context",
    });
  });

  it("disables every tool only for planner Runtime agents", async () => {
    const planner = await createSessionWith({ runtimeAgentRole: "planner" });
    const reviewer = await createSessionWith({ runtimeAgentRole: "reviewer" });
    const validator = await createSessionWith({ runtimeAgentRole: "validator" });
    const worker = await createSessionWith({ runtimeAgentRole: "worker" });

    expect(planner.config.availableTools).toEqual([]);
    expect(reviewer.config.availableTools).toBeUndefined();
    expect(validator.config.availableTools).toBeUndefined();
    expect(worker.config.availableTools).toBeUndefined();
  });

  it("passes AbortSignal to abort-aware host-owned tools and installs a per-tool cancel hook", async () => {
    vi.useFakeTimers();
    try {
      let receivedSignal: AbortSignal | undefined;
      const tool: Tool & { supportsAbortSignal: true } = {
        name: "slow_tool",
        supportsAbortSignal: true,
        handler: async (_args: unknown, invocation: ToolInvocation & { signal?: AbortSignal }) => {
          receivedSignal = invocation.signal;
          return await new Promise(() => {});
        },
      };
      h.getSelfTools.mockReturnValueOnce([tool]);
      const { config } = await createSessionWith({});
      const wrapped = config.tools?.find((candidate) => candidate.name === "slow_tool");
      const handler = wrapped?.handler;
      if (!handler) throw new Error("wrapped tool handler not found");

      const promise = handler(
        {},
        {
          sessionId: "s1",
          toolCallId: "tool-1",
          toolName: "slow_tool",
          arguments: {},
        },
      );

      await vi.advanceTimersByTimeAsync(30_000);
      await expect(promise).resolves.toContain("Handle: s1:tool-1");
      const registrationStart =
        h.backgroundManager.beginBackgroundToolInvocation.mock.calls[0]?.[0];
      expect(registrationStart?.cancel).toEqual(expect.any(Function));
      if (!registrationStart) throw new Error("background registration did not start");
      await h.backgroundManager.requestBackgroundToolCancellation({
        token: registrationStart.claim.cancellationToken,
        handle: "s1:tool-1",
        requestedAtMs: 2_000,
      });
      expect(receivedSignal?.aborted).toBe(true);
      expect(h.backgroundManager.requestBackgroundToolCancellation).toHaveBeenCalledWith({
        token: registrationStart.claim.cancellationToken,
        handle: "s1:tool-1",
        requestedAtMs: 2_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("unsubscribes SDK events when disconnecting a session", async () => {
    const { sessionBackend, sdkSession, unsubscribe } = await createSessionWith({});

    await sessionBackend.disconnect("s1");

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(sdkSession.disconnect).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes SDK events when destroying a session", async () => {
    const { sessionBackend, sdkSession, unsubscribe } = await createSessionWith({});

    await sessionBackend.destroy("s1");

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(sdkSession.destroy).toHaveBeenCalledTimes(1);
  });
});
