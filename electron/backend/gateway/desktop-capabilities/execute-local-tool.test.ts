import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { testDouble } from "../../../testing/harness/test-double";
import {
  type BackgroundToolDispatchClaim,
  type BackgroundToolProcessAttachment,
  type IBackgroundToolInvocationManager,
  type IPermissionPolicy,
  type RunningToolCallInfo,
} from "../../ports";
import {
  isDesktopCapabilityErrorThrow,
  type LocalToolRequest,
  type LocalToolResult,
} from "../../types";
import { type ExecuteLocalToolDeps, makeExecuteLocalToolHandler } from "./execute-local-tool";
import { makeExecuteShellHandler } from "./execute-shell";

type ShellSpawnFn = NonNullable<Parameters<typeof makeExecuteShellHandler>[0]["spawn"]>;

interface FakeChild {
  emit: EventEmitter["emit"];
  on: EventEmitter["on"];
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: string) => void;
  pid: number;
}

function makeFakeChild(pid: number): FakeChild & ChildProcess {
  const emitter = new EventEmitter();
  const fake: FakeChild = {
    emit: emitter.emit.bind(emitter),
    on: emitter.on.bind(emitter),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn<(signal?: string) => void>(),
    pid,
  };
  return testDouble<FakeChild & ChildProcess>(fake);
}

function dispatchClaim(ownerSessionId: string, toolCallId: string): BackgroundToolDispatchClaim {
  const claimId = `${ownerSessionId}:${toolCallId}:claim`;
  return {
    claimId,
    ownerSessionId,
    toolCallId,
    claimedAtMs: 1_000,
    cancellationToken: {
      tokenId: `${claimId}:token`,
      ownerSessionId,
      claimId,
      issuedAtMs: 1_000,
    },
  };
}

const baseRequest: Omit<LocalToolRequest, "kind"> = {
  toolName: "tool",
  sessionId: "session-1",
};

function makeDeps() {
  const executeMcpTool = vi.fn<
    (request: LocalToolRequest, signal?: AbortSignal) => Promise<LocalToolResult>
  >(async () => ({ output: "mcp", success: true }) as LocalToolResult);
  const executeShell = vi.fn<ExecuteLocalToolDeps["executeShell"]>(async () => ({
    kind: "completed",
    result: { output: "shell", success: true },
  }));
  const executeSelfTool = vi.fn<
    (request: LocalToolRequest, signal?: AbortSignal) => Promise<LocalToolResult>
  >(async () => ({ output: "self", success: true }) as LocalToolResult);
  const toolInvocationManager = makeBackgroundManager();
  const supportsAbortSignal = vi.fn<(request: LocalToolRequest) => boolean>(
    (request) => request.kind === "shell",
  );
  return {
    executeMcpTool,
    executeShell,
    executeSelfTool,
    supportsAbortSignal,
    toolInvocationManager,
  };
}

function makeBackgroundManager(): IBackgroundToolInvocationManager {
  return {
    claimBackgroundToolDispatch: vi.fn<
      IBackgroundToolInvocationManager["claimBackgroundToolDispatch"]
    >(async (request) => ({
      kind: "claimed",
      claim: dispatchClaim(request.ownerSessionId, request.toolCallId),
    })),
    beginBackgroundToolInvocation: vi.fn<
      IBackgroundToolInvocationManager["beginBackgroundToolInvocation"]
    >(async (args) => {
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
        cancellationScope: "tool",
      };
      return { handle: invocation.handle, claim: args.claim, invocation };
    }),
    attachBackgroundToolProcess: vi.fn<
      IBackgroundToolInvocationManager["attachBackgroundToolProcess"]
    >(async (handle, process) => ({
      handle,
      sessionId: process.ownerSessionId,
      toolCallId: handle.split(":").at(-1) ?? handle,
      toolName: "shell",
      startedAt: "2026-06-08T14:00:00.000Z",
      elapsedMs: 0,
      status: "running",
      backgrounded: false,
      resultAvailable: false,
      longRunning: false,
      cancellable: true,
      cancellationScope: process.cancellationScope,
      process: {
        ownerSessionId: process.ownerSessionId,
        rootPid: process.rootPid,
        spawnedAtMs: process.spawnedAtMs,
        identitySource: "spawned-child",
        cancellationScope: process.cancellationScope,
      },
    })),
    detachBackgroundToolInvocation: vi.fn<
      IBackgroundToolInvocationManager["detachBackgroundToolInvocation"]
    >(async (handle) => ({
      handle,
      sessionId: handle.split(":")[0] ?? "session-1",
      toolCallId: handle.split(":").at(-1) ?? handle,
      toolName: "shell",
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
      sessionId: handle.split(":")[0] ?? "session-1",
      toolCallId: handle.split(":").at(-1) ?? handle,
      toolName: "shell",
      startedAt: "2026-06-08T14:00:00.000Z",
      elapsedMs: 0,
      status: completion.success ? "completed" : "failed",
      backgrounded: false,
      resultAvailable: true,
      longRunning: false,
      cancellable: false,
      cancellationScope: "none",
    })),
    requestBackgroundToolCancellation: vi.fn<
      IBackgroundToolInvocationManager["requestBackgroundToolCancellation"]
    >(async (request) => ({
      success: true,
      handle: request.handle,
      sessionId: request.token.ownerSessionId,
      status: "cancelling",
      cancellationScope: "process-tree",
    })),
  };
}

function makeStatefulBackgroundManager() {
  let tool: RunningToolCallInfo | null = null;
  let ownedProcess: BackgroundToolProcessAttachment | undefined;

  const snapshot = (): RunningToolCallInfo | null => {
    if (!tool) return null;
    return {
      ...tool,
      ...(ownedProcess
        ? {
            process: {
              ownerSessionId: ownedProcess.ownerSessionId,
              rootPid: ownedProcess.rootPid,
              spawnedAtMs: ownedProcess.spawnedAtMs,
              identitySource: "spawned-child" as const,
              cancellationScope: ownedProcess.cancellationScope,
            },
          }
        : {}),
    };
  };

  const manager: IBackgroundToolInvocationManager = {
    claimBackgroundToolDispatch: vi.fn<
      IBackgroundToolInvocationManager["claimBackgroundToolDispatch"]
    >(async (request) => ({
      kind: "claimed",
      claim: dispatchClaim(request.ownerSessionId, request.toolCallId),
    })),
    beginBackgroundToolInvocation: vi.fn<
      IBackgroundToolInvocationManager["beginBackgroundToolInvocation"]
    >(async (args) => {
      tool = {
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
        cancellable: args.cancel !== undefined,
        cancellationScope: args.cancellationScope ?? (args.cancel ? "tool" : "turn"),
      };
      return { handle: tool.handle, claim: args.claim, invocation: snapshot()! };
    }),
    attachBackgroundToolProcess: vi.fn<
      IBackgroundToolInvocationManager["attachBackgroundToolProcess"]
    >(async (handle, process) => {
      if (!tool || tool.handle !== handle || tool.status !== "running") return null;
      ownedProcess = process;
      tool = {
        ...tool,
        cancellable: true,
        cancellationScope: process.cancellationScope,
      };
      return snapshot();
    }),
    detachBackgroundToolInvocation: vi.fn<
      IBackgroundToolInvocationManager["detachBackgroundToolInvocation"]
    >(async (handle) => {
      if (!tool || tool.handle !== handle || tool.status !== "running") return null;
      tool = { ...tool, backgrounded: true };
      return snapshot();
    }),
    completeBackgroundToolInvocation: vi.fn<
      IBackgroundToolInvocationManager["completeBackgroundToolInvocation"]
    >(async (handle, completion) => {
      if (!tool || tool.handle !== handle) return null;
      ownedProcess = undefined;
      tool = {
        ...tool,
        status: completion.success ? "completed" : "failed",
        resultAvailable: true,
        cancellable: false,
        cancellationScope: "none",
        ...(completion.error ? { error: completion.error } : {}),
      };
      return snapshot();
    }),
    requestBackgroundToolCancellation: vi.fn<
      IBackgroundToolInvocationManager["requestBackgroundToolCancellation"]
    >(async (request) => {
      if (ownedProcess) await ownedProcess.cancel();
      return {
        success: true,
        handle: request.handle,
        sessionId: request.token.ownerSessionId,
        status: "cancelling",
        cancellationScope: ownedProcess?.cancellationScope ?? "tool",
      };
    }),
  };

  return { manager, inspect: snapshot };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("makeExecuteLocalToolHandler", () => {
  it("routes kind='mcp' to executeMcpTool", async () => {
    const deps = makeDeps();
    const handler = makeExecuteLocalToolHandler(deps);

    const result = await handler({ ...baseRequest, kind: "mcp", serverName: "filesystem" });

    expect(result.output).toBe("mcp");
    expect(deps.executeMcpTool).toHaveBeenCalledTimes(1);
    expect(deps.executeShell).not.toHaveBeenCalled();
    expect(deps.executeSelfTool).not.toHaveBeenCalled();
  });

  it("routes kind='shell' to executeShell", async () => {
    const deps = makeDeps();
    const handler = makeExecuteLocalToolHandler(deps);

    const result = await handler({
      ...baseRequest,
      kind: "shell",
      toolArgs: { command: "ls" },
    });

    expect(result.output).toBe("shell");
    expect(deps.executeShell).toHaveBeenCalledTimes(1);
    expect(deps.executeMcpTool).not.toHaveBeenCalled();
    expect(deps.executeSelfTool).not.toHaveBeenCalled();
  });

  it("uses distinct collision-safe operation IDs for shell requests without toolCallId", async () => {
    const deps = makeDeps();
    const handler = makeExecuteLocalToolHandler(deps);

    await Promise.all([
      handler({ ...baseRequest, kind: "shell", toolArgs: { command: "first" } }),
      handler({ ...baseRequest, kind: "shell", toolArgs: { command: "second" } }),
    ]);

    const claims = vi
      .mocked(deps.toolInvocationManager.claimBackgroundToolDispatch)
      .mock.calls.map(([request]) => request);
    const launches = deps.executeShell.mock.calls.map(([request]) => request);
    expect(claims).toHaveLength(2);
    expect(launches).toHaveLength(2);
    expect(claims[0]?.toolCallId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(claims[1]?.toolCallId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(claims[0]?.toolCallId).not.toBe(claims[1]?.toolCallId);
    expect(claims[0]?.toolCallId).not.toBe("session-1:tool");
    expect(launches.map((launch) => launch.toolCallId)).toEqual(
      claims.map((claim) => claim.toolCallId),
    );
  });

  it("attaches shell process ownership to the invocation handle", async () => {
    const deps = makeDeps();
    const cancel = vi.fn<() => void>();
    deps.executeShell.mockImplementationOnce(async (_request, _signal, attachProcess) => {
      await attachProcess?.({
        ownerSessionId: "session-1",
        rootPid: 4242,
        spawnedAtMs: 1_234_567,
        cancellationScope: "process-tree",
        cancel,
      });
      return { kind: "completed", result: { output: "shell", success: true } };
    });
    const handler = makeExecuteLocalToolHandler(deps);

    await handler({
      ...baseRequest,
      kind: "shell",
      toolName: "shell",
      toolCallId: "shell-1",
      toolArgs: { command: "build" },
    });

    expect(deps.toolInvocationManager.attachBackgroundToolProcess).toHaveBeenCalledWith(
      "session-1:shell-1",
      {
        ownerSessionId: "session-1",
        rootPid: 4242,
        spawnedAtMs: 1_234_567,
        cancellationScope: "process-tree",
        cancel,
      },
    );
  });

  it("routes kind='custom-tool' to executeSelfTool", async () => {
    const deps = makeDeps();
    const handler = makeExecuteLocalToolHandler(deps);

    const result = await handler({ ...baseRequest, kind: "custom-tool" });

    expect(result.output).toBe("self");
    expect(deps.executeSelfTool).toHaveBeenCalledTimes(1);
    expect(deps.executeMcpTool).not.toHaveBeenCalled();
  });

  it("canonicalizes a legacy custom-tool name before dispatch", async () => {
    const deps = makeDeps();
    const handler = makeExecuteLocalToolHandler(deps);

    await handler({
      ...baseRequest,
      kind: "custom-tool",
      toolName: "marshal_recall",
    });

    expect(deps.executeSelfTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "recall" }),
      expect.any(AbortSignal),
    );
    expect(deps.executeShell).not.toHaveBeenCalled();
  });

  it("does not background running-tool introspection/control tools", async () => {
    const deps = makeDeps();
    const handler = makeExecuteLocalToolHandler(deps);

    const result = await handler({
      ...baseRequest,
      kind: "custom-tool",
      toolName: "cancelRunningTool",
    });

    expect(result.output).toBe("self");
    expect(deps.toolInvocationManager.beginBackgroundToolInvocation).not.toHaveBeenCalled();
  });

  it("never backgrounds sleep — the explicit bounded blocking-wait primitive", async () => {
    // See tool-backgrounding.ts's NEVER_BACKGROUND_TOOL_NAMES: sleep's whole
    // purpose is a synchronous, bounded (<=120s) wait — backgrounding it
    // would silently defeat that and strand the caller believing the wait
    // is still running in its own turn.
    const deps = makeDeps();
    const handler = makeExecuteLocalToolHandler(deps);

    const result = await handler({
      ...baseRequest,
      kind: "custom-tool",
      toolName: "sleep",
    });

    expect(result.output).toBe("self");
    expect(deps.toolInvocationManager.beginBackgroundToolInvocation).not.toHaveBeenCalled();
  });

  it("does not let a control-tool name bypass shell ownership tracking", async () => {
    const deps = makeDeps();
    const handler = makeExecuteLocalToolHandler(deps);

    const result = await handler({
      ...baseRequest,
      kind: "shell",
      toolName: "cancelRunningTool",
      toolArgs: { command: "build" },
    });

    expect(result).toEqual({ output: "shell", success: true });
    expect(deps.toolInvocationManager.beginBackgroundToolInvocation).toHaveBeenCalledOnce();
    expect(deps.executeShell).toHaveBeenCalledOnce();
  });

  it("throws DesktopCapabilityErrorThrow with code 'not-supported' on unsupported kinds", async () => {
    const deps = makeDeps();
    const handler = makeExecuteLocalToolHandler(deps);

    let caught: unknown;
    try {
      await handler({ ...baseRequest, kind: "read" });
    } catch (err) {
      caught = err;
    }

    if (!isDesktopCapabilityErrorThrow(caught))
      throw new Error("expected DesktopCapabilityErrorThrow");
    expect(caught.code).toBe("not-supported");
    expect(caught.message).toMatch(/Unsupported tool kind/);
    expect(deps.executeMcpTool).not.toHaveBeenCalled();
    expect(deps.executeShell).not.toHaveBeenCalled();
    expect(deps.executeSelfTool).not.toHaveBeenCalled();
  });

  it("launches the chosen sub-handler with the normalized generated toolCallId", async () => {
    const deps = makeDeps();
    const handler = makeExecuteLocalToolHandler(deps);
    const request: LocalToolRequest = {
      kind: "shell",
      toolName: "bash",
      toolArgs: { command: "echo hi", extra: 1 },
      sessionId: "session-Z",
    };

    await handler(request);

    expect(deps.executeShell).toHaveBeenCalledWith(
      {
        ...request,
        toolCallId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
      },
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  it("preserves third-party MCP tool names that resemble legacy aliases", async () => {
    const deps = makeDeps();
    const handler = makeExecuteLocalToolHandler(deps);

    await handler({
      ...baseRequest,
      kind: "mcp",
      serverName: "third-party",
      toolName: "mail_send_email",
    });

    expect(deps.executeMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "mail_send_email", serverName: "third-party" }),
      expect.any(AbortSignal),
    );
  });

  it("propagates errors thrown by the sub-handler (no swallow)", async () => {
    const deps = makeDeps();
    deps.executeShell.mockRejectedValueOnce(new Error("nope"));
    const handler = makeExecuteLocalToolHandler(deps);

    await expect(
      handler({ ...baseRequest, kind: "shell", toolArgs: { command: "x" } }),
    ).rejects.toThrow("nope");
  });

  it("returns a background handle after the threshold and retains the late result", async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    const work = deferred<LocalToolResult>();
    deps.executeShell.mockImplementationOnce(async () => ({
      kind: "completed",
      result: await work.promise,
    }));
    vi.mocked(deps.toolInvocationManager.detachBackgroundToolInvocation).mockResolvedValue({
      handle: "session-1:tc-1",
      sessionId: "session-1",
      toolCallId: "tc-1",
      toolName: "shell",
      startedAt: "2026-06-08T14:00:00.000Z",
      elapsedMs: 30_000,
      status: "running",
      backgrounded: true,
      resultAvailable: false,
      longRunning: true,
      cancellable: true,
      cancellationScope: "process-group",
    });
    const handler = makeExecuteLocalToolHandler(deps);

    const promise = handler({
      ...baseRequest,
      kind: "shell",
      toolName: "shell",
      toolCallId: "tc-1",
      toolArgs: { command: "sleep 60" },
    });

    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        backgrounded: true,
        handle: "session-1:tc-1",
      }),
    );
    expect(String(result.output)).toContain("inspectRunningTool");

    work.resolve({ output: "late", success: true });
    await vi.runAllTimersAsync();

    expect(deps.toolInvocationManager.completeBackgroundToolInvocation).toHaveBeenCalledWith(
      "session-1:tc-1",
      { success: true, result: { output: "late", success: true } },
    );
  });

  it("keeps successful timeout termination owned until child close before durable completion", async () => {
    vi.useFakeTimers();
    const child = makeFakeChild(4242);
    const killProcessGroup = vi.spyOn(process, "kill").mockReturnValue(true);
    const deps = makeDeps();
    const { manager, inspect } = makeStatefulBackgroundManager();
    const handler = makeExecuteLocalToolHandler({
      ...deps,
      executeShell: makeExecuteShellHandler({
        policy: testDouble<IPermissionPolicy>({ evaluate: () => "approve" }),
        spawn: () => child,
        platform: "darwin",
        timeoutMs: 50,
      }),
      toolInvocationManager: manager,
    });

    const pending = handler({
      ...baseRequest,
      kind: "shell",
      toolName: "shell",
      toolCallId: "shell-timeout-owned",
      toolArgs: { command: "build" },
    });
    await vi.advanceTimersByTimeAsync(60);

    const result = await pending;
    const handle = "session-1:shell-timeout-owned";
    expect(result).toMatchObject({
      success: false,
      error: "Shell command timed out after 50ms",
      backgrounded: true,
      handle,
      output: { timedOut: true, exitCode: null },
    });
    expect(killProcessGroup).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(inspect()).toMatchObject({
      handle,
      status: "running",
      backgrounded: true,
      cancellable: true,
      process: {
        rootPid: 4242,
        identitySource: "spawned-child",
        cancellationScope: "process-group",
      },
    });
    expect(manager.completeBackgroundToolInvocation).not.toHaveBeenCalled();

    const ownedProcess = vi.mocked(manager.attachBackgroundToolProcess).mock.calls[0]?.[1];
    await ownedProcess?.cancel();
    await ownedProcess?.cancel();
    expect(killProcessGroup).toHaveBeenCalledOnce();
    expect(manager.completeBackgroundToolInvocation).not.toHaveBeenCalled();

    child.emit("error", new Error("kill ESRCH"));
    child.emit("close", null, "SIGKILL");
    await vi.waitFor(() => expect(manager.completeBackgroundToolInvocation).toHaveBeenCalledOnce());
    expect(manager.completeBackgroundToolInvocation).toHaveBeenCalledOnce();
    expect(manager.completeBackgroundToolInvocation).toHaveBeenCalledWith(handle, {
      success: false,
      result: expect.objectContaining({
        success: false,
        error: "Shell command timed out after 50ms",
        output: expect.objectContaining({ timedOut: true, exitCode: null }),
      }),
      error: "Shell command timed out after 50ms",
    });
    expect(inspect()).toMatchObject({
      handle,
      status: "failed",
      resultAvailable: true,
      cancellable: false,
      cancellationScope: "none",
    });
    expect(inspect()?.process).toBeUndefined();
  });

  it("delays attachment persistence failure completion until child close", async () => {
    const child = makeFakeChild(4242);
    const killProcessGroup = vi.spyOn(process, "kill").mockReturnValue(true);
    const deps = makeDeps();
    vi.mocked(deps.toolInvocationManager.attachBackgroundToolProcess).mockResolvedValueOnce(null);
    const handler = makeExecuteLocalToolHandler({
      ...deps,
      executeShell: makeExecuteShellHandler({
        policy: testDouble<IPermissionPolicy>({ evaluate: () => "approve" }),
        spawn: () => child,
        platform: "darwin",
      }),
    });

    const pending = handler({
      ...baseRequest,
      kind: "shell",
      toolName: "shell",
      toolCallId: "shell-attach-failure",
      toolArgs: { command: "build" },
    });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.waitFor(() => expect(killProcessGroup).toHaveBeenCalledWith(-4242, "SIGKILL"));
    expect(killProcessGroup).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(deps.toolInvocationManager.completeBackgroundToolInvocation).not.toHaveBeenCalled();

    child.emit("error", new Error("kill ESRCH"));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(deps.toolInvocationManager.completeBackgroundToolInvocation).not.toHaveBeenCalled();

    child.emit("close", null, "SIGKILL");
    await expect(pending).rejects.toThrow(
      "Background tool process attachment was not persisted for handle session-1:shell-attach-failure",
    );
    expect(deps.toolInvocationManager.completeBackgroundToolInvocation).toHaveBeenCalledOnce();
    expect(deps.toolInvocationManager.completeBackgroundToolInvocation).toHaveBeenCalledWith(
      "session-1:shell-attach-failure",
      {
        success: false,
        error:
          "Background tool process attachment was not persisted for handle session-1:shell-attach-failure",
      },
    );
  });

  it("retains exact ownership after termination failure until child exit", async () => {
    const deps = makeDeps();
    const lifetime = deferred<void>();
    const failure: LocalToolResult = {
      output: { timedOut: true },
      success: false,
      error: "Shell command termination failed: taskkill failed",
    };
    const cancelOwnedProcess = vi.fn<() => Promise<void>>(async () => lifetime.resolve());
    deps.executeShell.mockImplementationOnce(async (_request, _signal, attachProcess) => {
      await attachProcess?.({
        ownerSessionId: "session-1",
        rootPid: 4242,
        spawnedAtMs: 1_234_567,
        cancellationScope: "process-tree",
        cancel: cancelOwnedProcess,
      });
      return { kind: "retained", result: failure, completion: lifetime.promise };
    });
    vi.mocked(deps.toolInvocationManager.attachBackgroundToolProcess).mockResolvedValue({
      handle: "session-1:shell-retained",
      sessionId: "session-1",
      toolCallId: "shell-retained",
      toolName: "shell",
      startedAt: "2026-06-08T14:00:00.000Z",
      elapsedMs: 0,
      status: "running",
      backgrounded: false,
      resultAvailable: false,
      longRunning: false,
      cancellable: true,
      cancellationScope: "process-tree",
      process: {
        ownerSessionId: "session-1",
        rootPid: 4242,
        spawnedAtMs: 1_234_567,
        identitySource: "spawned-child",
        cancellationScope: "process-tree",
      },
    });
    vi.mocked(deps.toolInvocationManager.detachBackgroundToolInvocation).mockResolvedValue({
      handle: "session-1:shell-retained",
      sessionId: "session-1",
      toolCallId: "shell-retained",
      toolName: "shell",
      startedAt: "2026-06-08T14:00:00.000Z",
      elapsedMs: 0,
      status: "running",
      backgrounded: true,
      resultAvailable: false,
      longRunning: false,
      cancellable: true,
      cancellationScope: "process-tree",
      process: {
        ownerSessionId: "session-1",
        rootPid: 4242,
        spawnedAtMs: 1_234_567,
        identitySource: "spawned-child",
        cancellationScope: "process-tree",
      },
    });
    const handler = makeExecuteLocalToolHandler(deps);

    const result = await handler({
      ...baseRequest,
      kind: "shell",
      toolName: "shell",
      toolCallId: "shell-retained",
      toolArgs: { command: "build" },
    });

    expect(result).toEqual({
      ...failure,
      backgrounded: true,
      handle: "session-1:shell-retained",
    });
    expect(deps.toolInvocationManager.detachBackgroundToolInvocation).toHaveBeenCalledWith(
      "session-1:shell-retained",
    );
    expect(deps.toolInvocationManager.completeBackgroundToolInvocation).not.toHaveBeenCalled();

    const retainedProcess = vi.mocked(deps.toolInvocationManager.attachBackgroundToolProcess).mock
      .calls[0]?.[1];
    expect(retainedProcess).toMatchObject({
      ownerSessionId: "session-1",
      rootPid: 4242,
      spawnedAtMs: 1_234_567,
      cancellationScope: "process-tree",
      cancel: cancelOwnedProcess,
    });
    await retainedProcess?.cancel();
    await vi.waitFor(() =>
      expect(deps.toolInvocationManager.completeBackgroundToolInvocation).toHaveBeenCalledOnce(),
    );
    expect(cancelOwnedProcess).toHaveBeenCalledOnce();
    expect(deps.toolInvocationManager.completeBackgroundToolInvocation).toHaveBeenCalledWith(
      "session-1:shell-retained",
      { success: false, result: failure, error: failure.error },
    );
  });

  it.each([
    ["nonzero taskkill", "win32", "taskkill exited with code 1"],
    ["hung taskkill", "win32", "taskkill timed out after 5000ms"],
    ["POSIX process-group failure", "darwin", "EPERM"],
  ] as const)(
    "keeps the handle and PID ownership until child close after %s",
    async (failureKind, platform, terminationError) => {
      vi.useFakeTimers();
      const child = makeFakeChild(platform === "win32" ? 5150 : 4242);
      const taskkill = platform === "win32" ? makeFakeChild(6160) : null;
      const spawnFn = vi.fn<ShellSpawnFn>().mockReturnValueOnce(child);
      if (taskkill) spawnFn.mockReturnValueOnce(taskkill);
      if (platform !== "win32") {
        vi.spyOn(process, "kill").mockImplementation(() => {
          throw new Error("EPERM");
        });
      }

      const deps = makeDeps();
      const { manager, inspect } = makeStatefulBackgroundManager();
      const handler = makeExecuteLocalToolHandler({
        ...deps,
        executeShell: makeExecuteShellHandler({
          policy: testDouble<IPermissionPolicy>({ evaluate: () => "approve" }),
          spawn: spawnFn,
          platform,
          timeoutMs: 50,
        }),
        toolInvocationManager: manager,
      });

      const pending = handler({
        ...baseRequest,
        kind: "shell",
        toolName: "shell",
        toolCallId: "shell-retained-real",
        toolArgs: { command: "build" },
      });
      await vi.advanceTimersByTimeAsync(60);
      if (failureKind === "nonzero taskkill") taskkill?.emit("close", 1);
      if (failureKind === "hung taskkill") await vi.advanceTimersByTimeAsync(5_000);

      const result = await pending;
      const handle = "session-1:shell-retained-real";
      expect(result).toMatchObject({
        success: false,
        error: `Shell command termination failed: ${terminationError}`,
        backgrounded: true,
        handle,
      });
      expect(result).not.toHaveProperty("kind");
      expect(result).not.toHaveProperty("completion");
      expect(inspect()).toMatchObject({
        handle,
        status: "running",
        backgrounded: true,
        process: {
          rootPid: child.pid,
          identitySource: "spawned-child",
          cancellationScope: platform === "win32" ? "process-tree" : "process-group",
        },
      });
      expect(manager.completeBackgroundToolInvocation).not.toHaveBeenCalled();

      child.emit("close", null);
      await vi.waitFor(() =>
        expect(manager.completeBackgroundToolInvocation).toHaveBeenCalledOnce(),
      );
      expect(manager.completeBackgroundToolInvocation).toHaveBeenCalledWith(handle, {
        success: false,
        result: expect.objectContaining({
          success: false,
          error: `Shell command termination failed: ${terminationError}`,
        }),
        error: `Shell command termination failed: ${terminationError}`,
      });
      expect(inspect()).toMatchObject({
        handle,
        status: "failed",
        resultAvailable: true,
        cancellable: false,
        cancellationScope: "none",
      });
      expect(inspect()?.process).toBeUndefined();
    },
  );

  it("does not claim shell cancellation before process ownership is attached", async () => {
    vi.useFakeTimers();
    const shellDeps = makeDeps();
    vi.mocked(shellDeps.executeShell).mockImplementationOnce(async () => ({
      kind: "completed",
      result: await deferred<LocalToolResult>().promise,
    }));
    vi.mocked(shellDeps.toolInvocationManager.detachBackgroundToolInvocation).mockResolvedValue({
      handle: "session-1:shell-1",
      sessionId: "session-1",
      toolCallId: "shell-1",
      toolName: "shell",
      startedAt: "2026-06-08T14:00:00.000Z",
      elapsedMs: 30_000,
      status: "running",
      backgrounded: true,
      resultAvailable: false,
      longRunning: true,
      cancellable: true,
      cancellationScope: "process-group",
    });
    const shellHandler = makeExecuteLocalToolHandler(shellDeps);

    const shellPromise = shellHandler({
      ...baseRequest,
      kind: "shell",
      toolName: "shell",
      toolCallId: "shell-1",
      toolArgs: { command: "sleep 60" },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await shellPromise;

    expect(
      vi.mocked(shellDeps.toolInvocationManager.beginBackgroundToolInvocation).mock.calls[0]?.[0]
        .cancel,
    ).toBeUndefined();
    expect(
      vi.mocked(shellDeps.toolInvocationManager.beginBackgroundToolInvocation).mock.calls[0]?.[0]
        .cancellationScope,
    ).toBe("none");

    const selfDeps = makeDeps();
    vi.mocked(selfDeps.executeSelfTool).mockImplementationOnce(
      async () => await deferred<LocalToolResult>().promise,
    );
    vi.mocked(selfDeps.toolInvocationManager.detachBackgroundToolInvocation).mockResolvedValue({
      handle: "session-1:self-1",
      sessionId: "session-1",
      toolCallId: "self-1",
      toolName: "recall",
      startedAt: "2026-06-08T14:00:00.000Z",
      elapsedMs: 30_000,
      status: "running",
      backgrounded: true,
      resultAvailable: false,
      longRunning: true,
      cancellable: true,
      cancellationScope: "tool",
    });
    const selfHandler = makeExecuteLocalToolHandler(selfDeps);

    const selfPromise = selfHandler({
      ...baseRequest,
      kind: "custom-tool",
      toolName: "recall",
      toolCallId: "self-1",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await selfPromise;

    expect(
      vi.mocked(selfDeps.toolInvocationManager.beginBackgroundToolInvocation).mock.calls[0]?.[0]
        .cancel,
    ).toBeUndefined();
  });
});
