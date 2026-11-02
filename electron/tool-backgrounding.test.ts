import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BackgroundToolDispatchClaim,
  BackgroundToolProcessAttachment,
  IBackgroundToolInvocationManager,
  RunningToolCallInfo,
} from "./backend/ports";
import {
  backgroundToolObservation,
  runRetainableToolWithBackgrounding,
  runToolWithBackgrounding,
} from "./tool-backgrounding";

function toolInfo(overrides: Partial<RunningToolCallInfo> = {}): RunningToolCallInfo {
  return {
    handle: "session-1:tool-1",
    sessionId: "session-1",
    toolCallId: "tool-1",
    toolName: "slow_tool",
    startedAt: "2026-06-08T14:00:00.000Z",
    elapsedMs: 0,
    status: "running",
    backgrounded: false,
    resultAvailable: false,
    longRunning: false,
    cancellable: true,
    cancellationScope: "tool",
    ...overrides,
  };
}

function dispatchClaim(
  overrides: Partial<BackgroundToolDispatchClaim> = {},
): BackgroundToolDispatchClaim {
  return {
    claimId: "claim-1",
    ownerSessionId: "session-1",
    toolCallId: "tool-1",
    claimedAtMs: 1_000,
    cancellationToken: {
      tokenId: "token-1",
      ownerSessionId: "session-1",
      claimId: "claim-1",
      issuedAtMs: 1_000,
    },
    ...overrides,
  };
}

function makeManager(): IBackgroundToolInvocationManager {
  return {
    claimBackgroundToolDispatch: vi.fn<
      IBackgroundToolInvocationManager["claimBackgroundToolDispatch"]
    >(async (request) => ({
      kind: "claimed",
      claim: dispatchClaim({
        ownerSessionId: request.ownerSessionId,
        toolCallId: request.toolCallId,
      }),
    })),
    beginBackgroundToolInvocation: vi.fn<
      IBackgroundToolInvocationManager["beginBackgroundToolInvocation"]
    >(async (args) => {
      const invocation = toolInfo({
        handle: `${args.sessionId}:${args.toolCallId}`,
        sessionId: args.sessionId,
        toolCallId: args.toolCallId,
        toolName: args.toolName,
      });
      return { handle: invocation.handle, claim: args.claim, invocation };
    }),
    attachBackgroundToolProcess: vi.fn<
      IBackgroundToolInvocationManager["attachBackgroundToolProcess"]
    >(async (handle, process) =>
      toolInfo({
        handle,
        process: {
          ownerSessionId: process.ownerSessionId,
          rootPid: process.rootPid,
          spawnedAtMs: process.spawnedAtMs,
          identitySource: "spawned-child",
          cancellationScope: process.cancellationScope,
        },
      }),
    ),
    detachBackgroundToolInvocation: vi.fn<
      IBackgroundToolInvocationManager["detachBackgroundToolInvocation"]
    >(async (handle) => toolInfo({ handle, backgrounded: true, longRunning: true })),
    completeBackgroundToolInvocation: vi.fn<
      IBackgroundToolInvocationManager["completeBackgroundToolInvocation"]
    >(async (handle, completion) =>
      toolInfo({
        handle,
        sessionId: handle.split(":")[0] ?? "session-1",
        toolCallId: handle.split(":").slice(1).join(":"),
        status: completion.success ? "completed" : "failed",
        resultAvailable: true,
        cancellable: false,
        cancellationScope: "none",
      }),
    ),
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

describe("runToolWithBackgrounding", () => {
  it("claims and durably begins before the effect, then durably completes before returning", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_234_567);
    const manager = makeManager();
    const order: string[] = [];
    vi.mocked(manager.claimBackgroundToolDispatch).mockImplementationOnce(async (request) => {
      order.push("claim");
      return {
        kind: "claimed",
        claim: dispatchClaim({
          ownerSessionId: request.ownerSessionId,
          toolCallId: request.toolCallId,
        }),
      };
    });
    vi.mocked(manager.beginBackgroundToolInvocation).mockImplementationOnce(async (start) => {
      order.push("begin");
      const invocation = toolInfo();
      return { handle: invocation.handle, claim: start.claim, invocation };
    });
    vi.mocked(manager.completeBackgroundToolInvocation).mockImplementationOnce(
      async (handle, completion) => {
        order.push("complete");
        return toolInfo({
          handle,
          status: completion.success ? "completed" : "failed",
          resultAvailable: true,
        });
      },
    );

    const result = await runToolWithBackgrounding({
      manager,
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "slow_tool",
      run: async () => {
        order.push("effect");
        return "done";
      },
      detachedResult: ({ handle }) => backgroundToolObservation("slow_tool", handle),
    });

    expect(result).toBe("done");
    expect(order).toEqual(["claim", "begin", "effect", "complete"]);
    expect(manager.claimBackgroundToolDispatch).toHaveBeenCalledWith({
      ownerSessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "slow_tool",
      requestedAtMs: 1_234_567,
      idempotencyKey: 'background-tool-dispatch:v1:["session-1","tool-1","slow_tool"]',
    });
    expect(manager.beginBackgroundToolInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        claim: expect.objectContaining({ claimId: "claim-1" }),
        sessionId: "session-1",
        toolCallId: "tool-1",
        startedAtMs: 1_234_567,
      }),
    );
  });

  it("handles dispatch conflicts explicitly without beginning or running the effect", async () => {
    const manager = makeManager();
    vi.mocked(manager.claimBackgroundToolDispatch).mockResolvedValueOnce({
      kind: "conflict",
      reason: "already-claimed",
      existingHandle: "session-1:existing",
    });
    const effect = vi.fn<() => Promise<string>>();

    const pending = runToolWithBackgrounding({
      manager,
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "slow_tool",
      run: effect,
      detachedResult: ({ handle }) => backgroundToolObservation("slow_tool", handle),
    });

    await expect(pending).rejects.toMatchObject({
      name: "BackgroundToolDispatchConflictError",
      reason: "already-claimed",
      existingHandle: "session-1:existing",
    });
    expect(manager.beginBackgroundToolInvocation).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
  });

  it("does not run the effect when durable registration fails", async () => {
    const manager = makeManager();
    vi.mocked(manager.beginBackgroundToolInvocation).mockRejectedValueOnce(
      new Error("registration write failed"),
    );
    const effect = vi.fn<() => Promise<string>>();

    await expect(
      runToolWithBackgrounding({
        manager,
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "slow_tool",
        run: effect,
        detachedResult: ({ handle }) => backgroundToolObservation("slow_tool", handle),
      }),
    ).rejects.toThrow("registration write failed");
    expect(effect).not.toHaveBeenCalled();
  });

  it("cancels a malformed resolved registration with the issued token without running the effect", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);
    const manager = makeManager();
    vi.mocked(manager.beginBackgroundToolInvocation).mockResolvedValueOnce({
      handle: "session-1:tool-1",
      claim: dispatchClaim(),
      invocation: toolInfo({ toolCallId: "different-tool" }),
    });
    const effect = vi.fn<() => Promise<string>>();

    await expect(
      runToolWithBackgrounding({
        manager,
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "slow_tool",
        run: effect,
        detachedResult: ({ handle }) => backgroundToolObservation("slow_tool", handle),
      }),
    ).rejects.toThrow("registration did not match claim");

    expect(effect).not.toHaveBeenCalled();
    expect(manager.requestBackgroundToolCancellation).toHaveBeenCalledWith({
      token: dispatchClaim().cancellationToken,
      handle: "session-1:tool-1",
      requestedAtMs: 2_000,
    });
    expect(manager.completeBackgroundToolInvocation).not.toHaveBeenCalled();
  });

  it("cancels the exact process and requests token-authorized cancellation when attach fails", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);
    const manager = makeManager();
    vi.mocked(manager.attachBackgroundToolProcess).mockRejectedValueOnce(
      new Error("attachment write failed"),
    );
    const cancel = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const process: BackgroundToolProcessAttachment = {
      ownerSessionId: "session-1",
      rootPid: 4242,
      spawnedAtMs: 1_111,
      cancellationScope: "process-group",
      cancel,
    };

    await expect(
      runToolWithBackgrounding({
        manager,
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "execute-shell",
        run: async (_signal, attachProcess) => {
          await attachProcess(process);
          return "unreachable";
        },
        detachedResult: ({ handle }) => backgroundToolObservation("execute-shell", handle),
      }),
    ).rejects.toThrow("attachment write failed");

    expect(manager.attachBackgroundToolProcess).toHaveBeenCalledWith("session-1:tool-1", process);
    expect(manager.requestBackgroundToolCancellation).toHaveBeenCalledWith({
      token: dispatchClaim().cancellationToken,
      handle: "session-1:tool-1",
      requestedAtMs: 2_000,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels the exact process when attachment persistence resolves null", async () => {
    const manager = makeManager();
    vi.mocked(manager.attachBackgroundToolProcess).mockResolvedValueOnce(null);
    const cancel = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const process: BackgroundToolProcessAttachment = {
      ownerSessionId: "session-1",
      rootPid: 4242,
      spawnedAtMs: 1_111,
      cancellationScope: "process-group",
      cancel,
    };

    await expect(
      runToolWithBackgrounding({
        manager,
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "execute-shell",
        run: async (_signal, attachProcess) => {
          await attachProcess(process);
          return "unreachable";
        },
        detachedResult: ({ handle }) => backgroundToolObservation("execute-shell", handle),
      }),
    ).rejects.toThrow("attachment was not persisted");
    expect(cancel).toHaveBeenCalledOnce();
    expect(manager.requestBackgroundToolCancellation).toHaveBeenCalledWith(
      expect.objectContaining({
        token: dispatchClaim().cancellationToken,
        handle: "session-1:tool-1",
      }),
    );
  });

  it.each(["toolCallId", "toolName"] as const)(
    "rejects attached process identity with mismatched %s",
    async (field) => {
      const manager = makeManager();
      const cancel = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const process: BackgroundToolProcessAttachment = {
        ownerSessionId: "session-1",
        rootPid: 4242,
        spawnedAtMs: 1_111,
        cancellationScope: "process-group",
        cancel,
      };
      vi.mocked(manager.attachBackgroundToolProcess).mockResolvedValueOnce(
        toolInfo({
          handle: "session-1:tool-1",
          sessionId: "session-1",
          toolCallId: field === "toolCallId" ? "different-tool" : "tool-1",
          toolName: field === "toolName" ? "different-tool-name" : "execute-shell",
          process: {
            ownerSessionId: process.ownerSessionId,
            rootPid: process.rootPid,
            spawnedAtMs: process.spawnedAtMs,
            identitySource: "spawned-child",
            cancellationScope: process.cancellationScope,
          },
        }),
      );

      await expect(
        runToolWithBackgrounding({
          manager,
          sessionId: "session-1",
          toolCallId: "tool-1",
          toolName: "execute-shell",
          run: async (_signal, attachProcess) => {
            await attachProcess(process);
            return "unreachable";
          },
          detachedResult: ({ handle }) => backgroundToolObservation("execute-shell", handle),
        }),
      ).rejects.toThrow("attachment identity diverged");
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("rejects null terminal persistence", async () => {
    const manager = makeManager();
    vi.mocked(manager.completeBackgroundToolInvocation).mockResolvedValueOnce(null);

    await expect(
      runToolWithBackgrounding({
        manager,
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "slow_tool",
        run: async () => "done",
        detachedResult: ({ handle }) => backgroundToolObservation("slow_tool", handle),
      }),
    ).rejects.toThrow("terminal state was not persisted");
  });

  it.each(["running", "unknown", "cancelling"] as const)(
    "rejects %s as nonterminal without an identity mismatch",
    async (status) => {
      const manager = makeManager();
      const toolCallId = `tool-${status}`;
      vi.mocked(manager.completeBackgroundToolInvocation).mockImplementationOnce(async (handle) =>
        toolInfo({
          handle,
          sessionId: "session-1",
          toolCallId,
          status,
        }),
      );

      await expect(
        runToolWithBackgrounding({
          manager,
          sessionId: "session-1",
          toolCallId,
          toolName: "slow_tool",
          run: async () => "done",
          detachedResult: ({ handle }) => backgroundToolObservation("slow_tool", handle),
        }),
      ).rejects.toThrow(`terminal state remained ${status}`);
    },
  );

  it("waits for durable terminal persistence before returning the foreground result", async () => {
    const manager = makeManager();
    const persistence = deferred<RunningToolCallInfo | null>();
    vi.mocked(manager.completeBackgroundToolInvocation).mockReturnValueOnce(persistence.promise);
    const pending = runToolWithBackgrounding({
      manager,
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "slow_tool",
      run: async () => "done",
      detachedResult: ({ handle }) => backgroundToolObservation("slow_tool", handle),
    });
    let returned = false;
    void pending.then(() => {
      returned = true;
    });

    await vi.waitFor(() => expect(manager.completeBackgroundToolInvocation).toHaveBeenCalledOnce());
    expect(returned).toBe(false);
    persistence.resolve(toolInfo({ status: "completed", resultAvailable: true }));
    await expect(pending).resolves.toBe("done");
  });

  it("surfaces rejected foreground terminal persistence without reporting settlement", async () => {
    const manager = makeManager();
    const onExecutionSettled = vi.fn<() => void>();
    vi.mocked(manager.completeBackgroundToolInvocation).mockRejectedValueOnce(
      new Error("terminal write failed"),
    );

    await expect(
      runToolWithBackgrounding({
        manager,
        sessionId: "session-1",
        toolCallId: "tool-1",
        toolName: "slow_tool",
        run: async () => "done",
        onExecutionSettled,
        detachedResult: ({ handle }) => backgroundToolObservation("slow_tool", handle),
      }),
    ).rejects.toThrow("terminal write failed");
    expect(onExecutionSettled).not.toHaveBeenCalled();
  });

  it("awaits detach before returning a background observation and owns late persistence failure", async () => {
    vi.useFakeTimers();
    const manager = makeManager();
    const work = deferred<string>();
    const detach = deferred<RunningToolCallInfo | null>();
    vi.mocked(manager.detachBackgroundToolInvocation).mockReturnValueOnce(detach.promise);
    vi.mocked(manager.completeBackgroundToolInvocation).mockRejectedValueOnce(
      new Error("terminal write failed"),
    );
    const pending = runToolWithBackgrounding({
      manager,
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "slow_tool",
      thresholdMs: 30_000,
      run: async () => await work.promise,
      detachedResult: ({ handle }) => backgroundToolObservation("slow_tool", handle),
    });
    let returned = false;
    void pending.then(() => {
      returned = true;
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(returned).toBe(false);
    detach.resolve(toolInfo({ backgrounded: true, longRunning: true }));
    await expect(pending).resolves.toContain("Handle: session-1:tool-1");

    work.resolve("late result");
    await vi.runAllTimersAsync();
    expect(manager.completeBackgroundToolInvocation).toHaveBeenCalledWith("session-1:tool-1", {
      success: true,
      result: "late result",
    });
  });

  it("keeps retained execution unsettled until its owned lifetime and terminal write finish", async () => {
    const manager = makeManager();
    const lifetime = deferred<void>();
    const persistence = deferred<RunningToolCallInfo | null>();
    const onExecutionSettled = vi.fn<() => void>();
    vi.mocked(manager.completeBackgroundToolInvocation).mockReturnValueOnce(persistence.promise);

    const result = await runRetainableToolWithBackgrounding({
      manager,
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "execute-shell",
      run: async () => ({
        kind: "retained",
        result: { success: false, error: "termination failed" },
        completion: lifetime.promise,
      }),
      retainedResult: (executionResult, { handle }) => ({
        ...executionResult,
        backgrounded: true,
        handle,
      }),
      completionForResult: (executionResult) => ({
        success: executionResult.success,
        result: executionResult,
        error: executionResult.error,
      }),
      onExecutionSettled,
      detachedResult: ({ handle }) => ({ success: true, error: "", handle }),
    });

    expect(result).toEqual({
      success: false,
      error: "termination failed",
      backgrounded: true,
      handle: "session-1:tool-1",
    });
    expect(manager.detachBackgroundToolInvocation).toHaveBeenCalledWith("session-1:tool-1");
    expect(manager.completeBackgroundToolInvocation).not.toHaveBeenCalled();
    expect(onExecutionSettled).not.toHaveBeenCalled();

    lifetime.resolve();
    await vi.waitFor(() => expect(manager.completeBackgroundToolInvocation).toHaveBeenCalledOnce());
    expect(onExecutionSettled).not.toHaveBeenCalled();
    persistence.resolve(toolInfo({ status: "failed", resultAvailable: true }));
    await vi.waitFor(() => expect(onExecutionSettled).toHaveBeenCalledOnce());
  });

  it("owns retained terminal persistence rejection without reporting execution settled", async () => {
    const manager = makeManager();
    const lifetime = deferred<void>();
    const onExecutionSettled = vi.fn<() => void>();
    vi.mocked(manager.completeBackgroundToolInvocation).mockRejectedValueOnce(
      new Error("retained terminal write failed"),
    );

    await runRetainableToolWithBackgrounding({
      manager,
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "execute-shell",
      run: async () => ({
        kind: "retained",
        result: { success: false, error: "termination failed" },
        completion: lifetime.promise,
      }),
      completionForResult: (executionResult) => ({
        success: executionResult.success,
        result: executionResult,
        error: executionResult.error,
      }),
      onExecutionSettled,
      detachedResult: ({ handle }) => ({ success: true, error: "", handle }),
    });

    lifetime.resolve();
    await vi.waitFor(() => expect(manager.completeBackgroundToolInvocation).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(onExecutionSettled).not.toHaveBeenCalled();
  });
});
