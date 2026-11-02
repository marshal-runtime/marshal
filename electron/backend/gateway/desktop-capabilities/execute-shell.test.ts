import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PermissionDecision, PermissionPolicy } from "../../../permission-policy";
import { testDouble } from "../../../testing/harness/test-double";
import type {
  BackgroundToolProcessAttacher,
  BackgroundToolProcessAttachment,
  RunningToolCallInfo,
} from "../../ports";
import type { ApprovalRequest } from "../../types";
import { isDesktopCapabilityErrorThrow, type LocalToolRequest } from "../../types";
import { makeExecuteShellHandler } from "./execute-shell";

type EvaluateFn = (request: ApprovalRequest) => PermissionDecision;
type SpawnMockFn = (
  command: string,
  args: readonly string[],
  options: { windowsHide?: boolean; shell?: boolean; env?: NodeJS.ProcessEnv; detached?: boolean },
) => ChildProcess;

interface FakeChild {
  emit: EventEmitter["emit"];
  on: EventEmitter["on"];
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: string) => void;
  pid: number;
}

function makeFakeChild(pid = 4242): FakeChild & ChildProcess {
  const emitter = new EventEmitter();
  const fake: FakeChild = {
    emit: emitter.emit.bind(emitter),
    on: emitter.on.bind(emitter),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn<(signal?: string) => void>(),
    pid,
  };
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- FakeChild shape is intentionally narrower than ChildProcess; testDouble compensates
  return testDouble<ChildProcess>(fake) as FakeChild & ChildProcess;
}

function fakePolicy(decision: PermissionDecision): PermissionPolicy {
  const evaluate = vi.fn<EvaluateFn>(() => decision);
  return testDouble<PermissionPolicy>({ evaluate });
}

const baseRequest: LocalToolRequest = {
  kind: "shell",
  toolName: "shell",
  toolArgs: { command: "ls -la" },
  sessionId: "session-1",
};

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

describe("makeExecuteShellHandler", () => {
  it("spawns the command and resolves with stdout/stderr/exitCode on clean exit", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn<SpawnMockFn>(() => child);
    const handler = makeExecuteShellHandler({
      policy: fakePolicy("approve"),
      spawn: spawnFn,
      platform: "darwin",
    });

    const promise = handler(baseRequest);

    // Simulate child output and close.
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("hello\n"));
      child.stderr.emit("data", Buffer.from("warn\n"));
      child.emit("close", 0);
    });

    const { result } = await promise;
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      stdout: "hello\n",
      stderr: "warn\n",
      exitCode: 0,
    });
    expect(spawnFn).toHaveBeenCalledWith(
      "/bin/sh",
      ["-c", "ls -la"],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("uses cmd.exe with /d /s /c on Windows", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn<SpawnMockFn>(() => child);
    const handler = makeExecuteShellHandler({
      policy: fakePolicy("approve"),
      spawn: spawnFn,
      platform: "win32",
    });

    const promise = handler(baseRequest);
    setImmediate(() => {
      child.emit("close", 0);
    });
    await promise;

    expect(spawnFn).toHaveBeenCalledWith(
      "cmd.exe",
      ["/d", "/s", "/c", "ls -la"],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("throws DesktopCapabilityErrorThrow with code 'policy-deny' when policy denies", async () => {
    const spawnFn = vi.fn<SpawnMockFn>();
    const handler = makeExecuteShellHandler({
      policy: fakePolicy("deny"),
      spawn: spawnFn,
      platform: "darwin",
    });

    let caught: unknown;
    try {
      await handler(baseRequest);
    } catch (err) {
      caught = err;
    }

    if (!isDesktopCapabilityErrorThrow(caught))
      throw new Error("expected DesktopCapabilityErrorThrow");
    expect(caught.code).toBe("policy-deny");
    expect(caught.message).toMatch(/policy/i);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("spawns when defense-in-depth policy returns 'prompt' (cloud is the authoritative gate)", async () => {
    // Cloud-side gate is the authority — by the time we land here, the cloud
    // has already shown an approval card and the user has responded. Defense-
    // in-depth re-check enforces only the categorical "deny" floor; "prompt"
    // (and "approve") both pass through to spawn.
    const child = makeFakeChild();
    const spawnFn = vi.fn<SpawnMockFn>(() => child);
    const handler = makeExecuteShellHandler({
      policy: fakePolicy("prompt"),
      spawn: spawnFn,
      platform: "darwin",
    });

    const promise = handler(baseRequest);
    setImmediate(() => child.emit("close", 0));
    await promise;

    expect(spawnFn).toHaveBeenCalled();
  });

  it("returns success: false when toolArgs is missing the command field", async () => {
    const handler = makeExecuteShellHandler({
      policy: fakePolicy("approve"),
      spawn: vi.fn<SpawnMockFn>(),
      platform: "darwin",
    });

    const { result } = await handler({ ...baseRequest, toolArgs: {} });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/command/i);
  });

  it("returns success: false on non-zero exit code with the captured output", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn<SpawnMockFn>(() => child);
    const handler = makeExecuteShellHandler({
      policy: fakePolicy("approve"),
      spawn: spawnFn,
      platform: "darwin",
    });

    const promise = handler(baseRequest);
    setImmediate(() => {
      child.stderr.emit("data", Buffer.from("not found\n"));
      child.emit("close", 1);
    });
    const { result } = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/code 1/);
    expect(result.output).toMatchObject({ exitCode: 1, stderr: "not found\n" });
  });

  it("returns success: false when spawn throws synchronously", async () => {
    const handler = makeExecuteShellHandler({
      policy: fakePolicy("approve"),
      spawn: () => {
        throw new Error("ENOENT");
      },
      platform: "darwin",
    });

    const { result } = await handler(baseRequest);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ENOENT/);
  });

  it("returns success: false when child emits error before close", async () => {
    const child = makeFakeChild();
    const handler = makeExecuteShellHandler({
      policy: fakePolicy("approve"),
      spawn: () => child,
      platform: "darwin",
    });

    const promise = handler(baseRequest);
    setImmediate(() => {
      child.emit("error", new Error("spawn ENOENT"));
    });
    const { result } = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/spawn ENOENT/);
  });

  it("retains exact POSIX ownership after timeout kill acceptance until close", async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    const killProcessGroup = vi.spyOn(process, "kill").mockReturnValue(true);
    const attached: BackgroundToolProcessAttachment[] = [];
    const handler = makeExecuteShellHandler({
      policy: fakePolicy("approve"),
      spawn: () => child,
      platform: "darwin",
      timeoutMs: 50,
    });

    const promise = handler(baseRequest, undefined, async (process) => {
      attached.push(process);
      return testDouble<RunningToolCallInfo>({});
    });

    await vi.advanceTimersByTimeAsync(60);
    expect(killProcessGroup).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();

    const execution = await promise;
    expect(execution).toMatchObject({
      kind: "retained",
      result: {
        success: false,
        error: expect.stringMatching(/timed out/),
        output: { timedOut: true, exitCode: null },
      },
    });
    if (execution.kind !== "retained") throw new Error("expected retained execution");
    const settled = vi.fn<() => void>();
    void execution.completion.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    await attached[0].cancel();
    await attached[0].cancel();
    expect(killProcessGroup).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();

    child.emit("error", new Error("kill ESRCH"));
    expect(settled).not.toHaveBeenCalled();
    child.emit("close", null, "SIGKILL");
    await expect(execution.completion).resolves.toBeUndefined();
    expect(settled).toHaveBeenCalledOnce();
  });

  it("sanitizes post-timeout process errors and signal close status", async () => {
    // Regression for review-feedback finding #3: SIGKILL after the timeout
    // can synthesize an "error" event before "close". The handler must
    // honor `timedOut` and emit the timeout shape — cloud-side retry logic
    // may key off `timedOut: true`.
    vi.useFakeTimers();
    const child = makeFakeChild();
    const killProcessGroup = vi.spyOn(process, "kill").mockReturnValue(true);
    const handler = makeExecuteShellHandler({
      policy: fakePolicy("approve"),
      spawn: () => child,
      platform: "darwin",
      timeoutMs: 50,
    });

    const promise = handler(baseRequest);

    await vi.advanceTimersByTimeAsync(60);
    expect(killProcessGroup).toHaveBeenCalledWith(-4242, "SIGKILL");

    // Kill produced an error event before the close event lands.
    child.emit("error", new Error("kill ESRCH"));

    const execution = await promise;
    expect(execution).toMatchObject({
      kind: "retained",
      result: {
        success: false,
        error: expect.stringMatching(/timed out/),
        output: { timedOut: true, exitCode: null },
      },
    });
    if (execution.kind !== "retained") throw new Error("expected retained execution");
    let completed = false;
    void execution.completion.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    child.emit("close", null, "SIGKILL");
    await expect(execution.completion).resolves.toBeUndefined();
  });

  it("retains exact POSIX ownership after cancellation kill acceptance until close", async () => {
    const child = makeFakeChild();
    const killProcessGroup = vi.spyOn(process, "kill").mockReturnValue(true);
    const attachProcess = vi
      .fn<NonNullable<Parameters<ReturnType<typeof makeExecuteShellHandler>>[2]>>()
      .mockResolvedValue(testDouble<RunningToolCallInfo>({}));
    const controller = new AbortController();
    const handler = makeExecuteShellHandler({
      policy: fakePolicy("approve"),
      spawn: () => child,
      platform: "darwin",
    });

    const promise = handler(baseRequest, controller.signal, attachProcess);

    expect(attachProcess).toHaveBeenCalledWith({
      ownerSessionId: "session-1",
      rootPid: 4242,
      spawnedAtMs: expect.any(Number),
      cancellationScope: "process-group",
      cancel: expect.any(Function),
    });

    controller.abort();
    await vi.waitFor(() => expect(killProcessGroup).toHaveBeenCalledWith(-4242, "SIGKILL"));
    expect(child.kill).not.toHaveBeenCalled();

    const execution = await promise;
    expect(execution).toMatchObject({
      kind: "retained",
      result: {
        success: false,
        error: expect.stringMatching(/cancelled/),
        output: { cancelled: true, exitCode: null },
      },
    });
    if (execution.kind !== "retained") throw new Error("expected retained execution");
    let completed = false;
    void execution.completion.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    const attachedProcess = attachProcess.mock.calls[0]?.[0];
    await attachedProcess?.cancel();
    await attachedProcess?.cancel();
    expect(killProcessGroup).toHaveBeenCalledOnce();
    expect(completed).toBe(false);

    child.emit("close", null, "SIGKILL");
    await expect(execution.completion).resolves.toBeUndefined();
  });

  it("does not report process completion before the exact attachment is persisted", async () => {
    const child = makeFakeChild();
    const attachment = deferred<RunningToolCallInfo | null>();
    const attachProcess = vi.fn<BackgroundToolProcessAttacher>(() => attachment.promise);
    const handler = makeExecuteShellHandler({
      policy: fakePolicy("approve"),
      spawn: () => child,
      platform: "darwin",
    });
    const pending = handler(baseRequest, undefined, attachProcess);
    let returned = false;
    void pending.then(() => {
      returned = true;
    });

    child.emit("close", 0);
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(attachProcess).toHaveBeenCalledWith({
      ownerSessionId: "session-1",
      rootPid: 4242,
      spawnedAtMs: expect.any(Number),
      cancellationScope: "process-group",
      cancel: expect.any(Function),
    });

    attachment.resolve(testDouble<RunningToolCallInfo>({}));
    await expect(pending).resolves.toMatchObject({
      kind: "completed",
      result: { success: true },
    });
  });

  it("waits for child close before rejecting a killed attachment persistence failure", async () => {
    const child = makeFakeChild();
    const killProcessGroup = vi.spyOn(process, "kill").mockReturnValue(true);
    const handler = makeExecuteShellHandler({
      policy: fakePolicy("approve"),
      spawn: () => child,
      platform: "darwin",
    });

    const promise = handler(baseRequest, undefined, async () => null);
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.waitFor(() => expect(killProcessGroup).toHaveBeenCalledWith(-4242, "SIGKILL"));
    expect(child.kill).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit("error", new Error("kill ESRCH"));
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit("close", null, "SIGKILL");
    await expect(promise).rejects.toThrow("attachment was not persisted");
    expect(killProcessGroup).toHaveBeenCalledOnce();
  });

  it("settles with termination failure when a POSIX process-group kill throws", async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    const killProcessGroup = vi
      .spyOn(process, "kill")
      .mockImplementationOnce(() => {
        throw new Error("EPERM");
      })
      .mockReturnValueOnce(true);
    const attached: BackgroundToolProcessAttachment[] = [];
    const handler = makeExecuteShellHandler({
      policy: fakePolicy("approve"),
      spawn: () => child,
      platform: "darwin",
      timeoutMs: 50,
    });

    const promise = handler(baseRequest, undefined, async (process) => {
      attached.push(process);
      return testDouble<RunningToolCallInfo>({});
    });
    await vi.advanceTimersByTimeAsync(60);
    const execution = await promise;

    expect(execution.result).toMatchObject({
      success: false,
      error: "Shell command termination failed: EPERM",
      output: { timedOut: true, exitCode: null },
    });
    expect(execution.kind).toBe("retained");
    expect(child.kill).not.toHaveBeenCalled();

    await attached[0].cancel();
    expect(killProcessGroup).toHaveBeenNthCalledWith(2, -4242, "SIGKILL");
    if (execution.kind !== "retained") throw new Error("expected retained execution");
    let completed = false;
    void execution.completion.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    child.emit("close", null);
    await expect(execution.completion).resolves.toBeUndefined();
  });

  it("retains exact Windows tree ownership after taskkill acceptance until close", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_234_567);
    const child = makeFakeChild(5150);
    const taskkill = makeFakeChild(6160);
    const spawnFn = vi.fn<SpawnMockFn>().mockReturnValueOnce(child).mockReturnValueOnce(taskkill);
    const attached: BackgroundToolProcessAttachment[] = [];
    const attachProcess = vi.fn<BackgroundToolProcessAttacher>(async (process) => {
      attached.push(process);
      return testDouble<RunningToolCallInfo>({});
    });
    const handler = makeExecuteShellHandler({
      policy: fakePolicy("approve"),
      spawn: spawnFn,
      platform: "win32",
    });

    const promise = handler(baseRequest, undefined, attachProcess);

    expect(attached[0]).toMatchObject({
      ownerSessionId: "session-1",
      rootPid: 5150,
      spawnedAtMs: 1_234_567,
      cancellationScope: "process-tree",
      cancel: expect.any(Function),
    });
    const cancellation = attached[0].cancel();

    expect(spawnFn).toHaveBeenNthCalledWith(
      2,
      "taskkill.exe",
      ["/PID", "5150", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(child.kill).not.toHaveBeenCalled();
    taskkill.emit("close", 0);
    await cancellation;

    const execution = await promise;
    expect(execution).toMatchObject({
      kind: "retained",
      result: {
        success: false,
        error: "Shell command cancelled",
        output: { cancelled: true, exitCode: null },
      },
    });
    if (execution.kind !== "retained") throw new Error("expected retained execution");
    let completed = false;
    void execution.completion.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    await attached[0].cancel();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    child.emit("close", null);
    await expect(execution.completion).resolves.toBeUndefined();
  });

  it("retains ownership after nonzero taskkill and retries the exact tree", async () => {
    const child = makeFakeChild(5150);
    const failedTaskkill = makeFakeChild(6160);
    const retryTaskkill = makeFakeChild(7170);
    const spawnFn = vi
      .fn<SpawnMockFn>()
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(failedTaskkill)
      .mockReturnValueOnce(retryTaskkill);
    const attached: BackgroundToolProcessAttachment[] = [];
    const controller = new AbortController();
    const handler = makeExecuteShellHandler({
      policy: fakePolicy("approve"),
      spawn: spawnFn,
      platform: "win32",
    });

    const promise = handler(baseRequest, controller.signal, async (process) => {
      attached.push(process);
      return testDouble<RunningToolCallInfo>({});
    });
    controller.abort();
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledTimes(2));
    failedTaskkill.emit("close", 1);
    const execution = await promise;

    expect(execution.result).toMatchObject({
      success: false,
      error: "Shell command termination failed: taskkill exited with code 1",
      output: { cancelled: true, exitCode: null },
    });
    expect(execution.kind).toBe("retained");
    expect(child.kill).not.toHaveBeenCalled();

    const retry = attached[0].cancel();
    expect(spawnFn).toHaveBeenNthCalledWith(
      3,
      "taskkill.exe",
      ["/PID", "5150", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
    );
    retryTaskkill.emit("close", 0);
    await retry;
    if (execution.kind !== "retained") throw new Error("expected retained execution");
    let completed = false;
    void execution.completion.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    child.emit("close", null);
    await expect(execution.completion).resolves.toBeUndefined();
  });

  it("bounds a hung taskkill and retains ownership until child exit", async () => {
    vi.useFakeTimers();
    const child = makeFakeChild(5150);
    const taskkill = makeFakeChild(6160);
    const spawnFn = vi.fn<SpawnMockFn>().mockReturnValueOnce(child).mockReturnValueOnce(taskkill);
    const handler = makeExecuteShellHandler({
      policy: fakePolicy("approve"),
      spawn: spawnFn,
      platform: "win32",
      timeoutMs: 50,
    });

    const promise = handler(baseRequest);
    await vi.advanceTimersByTimeAsync(60);
    await vi.advanceTimersByTimeAsync(5_000);
    const execution = await promise;

    expect(execution.result).toMatchObject({
      success: false,
      error: "Shell command termination failed: taskkill timed out after 5000ms",
      output: { timedOut: true, exitCode: null },
    });
    expect(execution.kind).toBe("retained");
    expect(taskkill.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();

    if (execution.kind !== "retained") throw new Error("expected retained execution");
    let retainedSettled = false;
    void execution.completion.then(() => {
      retainedSettled = true;
    });
    await Promise.resolve();
    expect(retainedSettled).toBe(false);
    child.emit("close", null);
    await expect(execution.completion).resolves.toBeUndefined();
  });

  it("truncates stdout once maxOutputBytes is reached", async () => {
    const child = makeFakeChild();
    const handler = makeExecuteShellHandler({
      policy: fakePolicy("approve"),
      spawn: () => child,
      platform: "darwin",
      maxOutputBytes: 4,
    });

    const promise = handler(baseRequest);
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("abcdefgh"));
      child.emit("close", 0);
    });
    const { result } = await promise;

    expect(result.output).toMatchObject({
      stdout: "abcd",
      truncated: true,
    });
  });

  it("passes an allow-listed env to spawn (not the full process.env)", async () => {
    // Defense-in-depth: cloud-supplied commands shouldn't see internal env.
    // We allow a small POSIX/Windows-shared set and drop everything else.
    const sentinelKey = "MARSHAL_DESKTOP_CAPS_TEST_SENTINEL";
    const sentinelValue = "should-not-leak";
    process.env[sentinelKey] = sentinelValue;
    process.env["PATH"] = "/usr/bin:/bin";
    try {
      const child = makeFakeChild();
      const spawnFn = vi.fn<SpawnMockFn>(() => child);
      const handler = makeExecuteShellHandler({
        policy: fakePolicy("approve"),
        spawn: spawnFn,
        platform: "darwin",
      });

      const promise = handler(baseRequest);
      setImmediate(() => child.emit("close", 0));
      await promise;

      const opts = spawnFn.mock.calls[0][2];
      expect(opts.env).toBeDefined();
      const env = opts.env;
      // Allow-listed values pass through unchanged.
      expect(env?.["PATH"]).toBe("/usr/bin:/bin");
      // Non-allow-listed sentinel must not leak.
      expect(env?.[sentinelKey]).toBeUndefined();
    } finally {
      delete process.env[sentinelKey];
    }
  });

  it("constructs the ApprovalRequest with kind=shell and command as normalized field", async () => {
    const evaluate = vi.fn<EvaluateFn>(() => "approve");
    const policy = testDouble<PermissionPolicy>({ evaluate });
    const child = makeFakeChild();
    const handler = makeExecuteShellHandler({
      policy,
      spawn: () => child,
      platform: "darwin",
    });

    const promise = handler(baseRequest);
    setImmediate(() => child.emit("close", 0));
    await promise;

    const callArg = evaluate.mock.calls[0][0];
    expect(callArg.kind).toBe("shell");
    expect(callArg.sessionId).toBe("session-1");
    // Normalized shape: `command` is a top-level field — narrow by kind to access
    if (callArg.kind !== "shell") throw new Error(`expected shell, got ${callArg.kind}`);
    expect(callArg.command).toBe("ls -la");
  });
});
