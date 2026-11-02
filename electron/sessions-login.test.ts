/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { testDouble, createTestBackend } from "./testing/harness";

const m = await vi.hoisted(async () => await import("./test-helpers/session-test-mocks"));
vi.mock("fs", m.fsFactory);
vi.mock("./session-archive", m.sessionArchiveFactory);
vi.mock("child_process", m.childProcessFactory);
vi.mock("electron", m.electronFactory);
vi.mock("@github/copilot-sdk", m.copilotSdkFactory);
vi.mock("./skills", m.skillsFactory);
vi.mock("./cli-path", m.cliPathFactory);
vi.mock("./safe-storage-file");

import { spawn } from "child_process";

const mockedSpawn = vi.mocked(spawn);

/** Create a mock ChildProcess with EventEmitter-based stdout, stderr, and process events. */
function createMockProcess() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = testDouble<
    EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    }
  >(new EventEmitter());
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = vi.fn<() => void>();
  return proc;
}

describe("SessionManager.login", () => {
  let mgr: any;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Login flow reads settings JSON files at startup; keep "{}" as the default
    // return so JSON.parse succeeds. Re-applied after clearAllMocks in case a
    // previous test set a different value and didn't restore it.
    vi.mocked(fs).readFileSync.mockReturnValue("{}");
    const { SessionManager } = await import("./sessions");
    mgr = new SessionManager("/test/workspace", await createTestBackend());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with device code when CLI outputs one", async () => {
    const proc = createMockProcess();
    mockedSpawn.mockReturnValue(testDouble<ChildProcess>(proc));

    const promise = mgr.login();

    // Simulate CLI output with device code
    proc.stdout.emit(
      "data",
      Buffer.from(
        "To authenticate, visit https://github.com/login/device and enter code AB12-CD34.\n",
      ),
    );

    const result = await promise;
    expect(result).toMatchObject({
      deviceCode: "AB12-CD34",
      verificationUri: "https://github.com/login/device",
    });
    expect(result.completion).toBeInstanceOf(Promise);
    expect(mgr.loginInProgress).toBe(true); // stays true until process exits
  });

  it("resolves with default verificationUri when CLI omits the URL", async () => {
    const proc = createMockProcess();
    mockedSpawn.mockReturnValue(testDouble<ChildProcess>(proc));

    const promise = mgr.login();
    proc.stdout.emit("data", Buffer.from("enter code: XY99-ZZ00\n"));

    const result = await promise;
    expect(result.deviceCode).toBe("XY99-ZZ00");
    expect(result.verificationUri).toBe("https://github.com/login/device");
  });

  it("resolves with {} when process exits code 0 without device code (browser flow success)", async () => {
    const proc = createMockProcess();
    mockedSpawn.mockReturnValue(testDouble<ChildProcess>(proc));

    const promise = mgr.login();

    // CLI completes browser flow and exits cleanly — no device code
    proc.emit("close", 0);

    const result = await promise;
    expect(result).toEqual({});
    expect(mgr.loginInProgress).toBe(false);
  });

  it("rejects when process exits with non-zero code", async () => {
    const proc = createMockProcess();
    mockedSpawn.mockReturnValue(testDouble<ChildProcess>(proc));

    const promise = mgr.login();

    proc.stderr.emit("data", Buffer.from("fatal error\n"));
    proc.emit("close", 1);

    await expect(promise).rejects.toThrow("copilot login exited with code 1: fatal error\n");
    expect(mgr.loginInProgress).toBe(false);
  });

  it("rejects when process emits an error", async () => {
    const proc = createMockProcess();
    mockedSpawn.mockReturnValue(testDouble<ChildProcess>(proc));

    const promise = mgr.login();
    proc.emit("error", new Error("spawn ENOENT"));

    await expect(promise).rejects.toThrow("spawn ENOENT");
    expect(mgr.loginInProgress).toBe(false);
  });

  it("rejects after 30s timeout when CLI hangs with no output", async () => {
    const proc = createMockProcess();
    mockedSpawn.mockReturnValue(testDouble<ChildProcess>(proc));

    const promise = mgr.login();

    // Advance past the 30s timeout
    vi.advanceTimersByTime(30_000);

    await expect(promise).rejects.toThrow(/no device code received within 30s/);
    await expect(promise).rejects.toThrow(/CLI output so far: \(empty\)/);
    expect(proc.kill).toHaveBeenCalled();
    expect(mgr.loginInProgress).toBe(false);
  });

  it("includes CLI output in timeout error message", async () => {
    const proc = createMockProcess();
    mockedSpawn.mockReturnValue(testDouble<ChildProcess>(proc));

    const promise = mgr.login();

    proc.stdout.emit("data", Buffer.from("Initializing...\n"));
    vi.advanceTimersByTime(30_000);

    await expect(promise).rejects.toThrow("Initializing...");
  });

  it("extends timeout to 2min when browser flow is detected", async () => {
    const proc = createMockProcess();
    mockedSpawn.mockReturnValue(testDouble<ChildProcess>(proc));

    const promise = mgr.login();

    // CLI mentions opening a browser → browser flow detected
    proc.stdout.emit("data", Buffer.from("Opening browser for authentication...\n"));

    // 30s passes — should NOT have timed out yet (extended to 2min)
    vi.advanceTimersByTime(30_000);
    // Promise should still be pending (not rejected)
    const raceResult = await Promise.race([
      promise.then(() => "resolved").catch(() => "rejected"),
      Promise.resolve("pending"),
    ]);
    expect(raceResult).toBe("pending");

    // Advance to 2 minutes total
    vi.advanceTimersByTime(90_000);

    await expect(promise).rejects.toThrow(/no device code received within 120s/);
    await expect(promise).rejects.toThrow(/browser flow detected/);
    expect(proc.kill).toHaveBeenCalled();
  });

  it("detects browser flow from localhost URL in output", async () => {
    const proc = createMockProcess();
    mockedSpawn.mockReturnValue(testDouble<ChildProcess>(proc));

    const promise = mgr.login();

    proc.stderr.emit("data", Buffer.from("Listening on http://localhost:12345/callback\n"));

    // 30s — should not timeout (browser flow detected)
    vi.advanceTimersByTime(30_000);
    const raceResult = await Promise.race([
      promise.then(() => "resolved").catch(() => "rejected"),
      Promise.resolve("pending"),
    ]);
    expect(raceResult).toBe("pending");

    // Process completes after browser flow
    proc.emit("close", 0);

    const result = await promise;
    expect(result).toEqual({});
  });

  it("device code takes priority over browser flow detection", async () => {
    const proc = createMockProcess();
    mockedSpawn.mockReturnValue(testDouble<ChildProcess>(proc));

    const promise = mgr.login();

    // CLI outputs both browser and device code info
    proc.stdout.emit(
      "data",
      Buffer.from(
        "Opening browser...\nVisit https://github.com/login/device and enter code AA11-BB22\n",
      ),
    );

    const result = await promise;
    expect(result.deviceCode).toBe("AA11-BB22");
  });

  it("kills process after 2min if it hangs after device code is found", async () => {
    const proc = createMockProcess();
    mockedSpawn.mockReturnValue(testDouble<ChildProcess>(proc));

    const promise = mgr.login();

    // Device code found — promise resolves, but process keeps running
    proc.stdout.emit(
      "data",
      Buffer.from("Visit https://github.com/login/device and enter code FF00-GG11\n"),
    );

    const result = await promise;
    expect(result.deviceCode).toBe("FF00-GG11");
    expect(mgr.loginInProgress).toBe(true);

    // Process hangs for 2 minutes (user completed auth but CLI doesn't exit).
    // Use async variant so the completion promise rejection and its catch
    // handler (which clears loginInProgress) can settle.
    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(proc.kill).toHaveBeenCalled();
    expect(mgr.loginInProgress).toBe(false);
  });

  it("does not kill process if it exits normally after device code", async () => {
    const proc = createMockProcess();
    mockedSpawn.mockReturnValue(testDouble<ChildProcess>(proc));

    // Provide a factory that returns an authenticated client so verification succeeds
    mgr.setClientFactory(async () => ({
      start: vi.fn<() => void>(),
      getAuthStatus: vi
        .fn<() => Promise<object>>()
        .mockResolvedValue({ isAuthenticated: true, login: "test-user" }),
    }));

    const promise = mgr.login();

    proc.stdout.emit("data", Buffer.from("enter code CC22-DD33\n"));
    await promise;

    // Process exits normally before the 2min lifetime — starts verification
    proc.emit("close", 0);
    expect(mgr.loginInProgress).toBe(true); // stays true during verification

    // Advance past the first verification delay (1.5s) and flush promises
    await vi.advanceTimersByTimeAsync(1500);
    expect(mgr.loginInProgress).toBe(false); // verified successfully

    // 2 min passes — kill should NOT have been called (timer was cleared by close handler)
    vi.advanceTimersByTime(2 * 60_000);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("clears signOutPromise on login", async () => {
    const proc = createMockProcess();
    mockedSpawn.mockReturnValue(testDouble<ChildProcess>(proc));

    // Simulate a prior sign-out lock
    mgr.signOutPromise = Promise.resolve();

    mgr.login();
    expect(mgr.signOutPromise).toBeNull();

    // Clean up
    proc.emit("close", 0);
  });

  it("spawns copilot login with correct args", async () => {
    const proc = createMockProcess();
    mockedSpawn.mockReturnValue(testDouble<ChildProcess>(proc));

    mgr.login();

    expect(mockedSpawn).toHaveBeenCalledWith("/mock/copilot", ["login"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.emit("close", 0);
  });

  it("fires loginFailedCallback when subprocess times out after device code", async () => {
    const proc = createMockProcess();
    mockedSpawn.mockReturnValue(testDouble<ChildProcess>(proc));

    const onLoginFailed = vi.fn<(reason: string) => void>();
    mgr.setLoginFailedCallback(onLoginFailed);

    const promise = mgr.login();
    proc.stdout.emit("data", Buffer.from("enter code AB12-CD34\n"));
    await promise;

    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(onLoginFailed).toHaveBeenCalledTimes(1);
    expect(onLoginFailed.mock.calls[0][0]).toMatch(/timed out after 2 min/);
  });

  it("does NOT fire loginFailedCallback when the subprocess is muted by a retry", async () => {
    const proc1 = createMockProcess();
    mockedSpawn.mockReturnValueOnce(testDouble<ChildProcess>(proc1));
    const onLoginFailed = vi.fn<(reason: string) => void>();
    mgr.setLoginFailedCallback(onLoginFailed);

    const first = mgr.login();
    proc1.stdout.emit("data", Buffer.from("enter code AA11-BB22\n"));
    await first;

    const proc2 = createMockProcess();
    mockedSpawn.mockReturnValueOnce(testDouble<ChildProcess>(proc2));
    void mgr.login();

    expect(proc1.kill).toHaveBeenCalled();
    proc1.emit("close", 1);
    await vi.advanceTimersByTimeAsync(10);

    expect(onLoginFailed).not.toHaveBeenCalled();
  });

  it("signOut cancels an in-flight login subprocess", async () => {
    const proc = createMockProcess();
    mockedSpawn.mockReturnValue(testDouble<ChildProcess>(proc));
    const onLoginFailed = vi.fn<(reason: string) => void>();
    mgr.setLoginFailedCallback(onLoginFailed);
    // The real signOut awaits a promisified execFile("cmdkey"); the mocked
    // execFile never invokes its callback, so signOut would hang. We only
    // need the synchronous activeLoginCancel branch to fire — kick off
    // signOut without awaiting and let afterEach clean up.

    const promise = mgr.login();
    proc.stdout.emit("data", Buffer.from("enter code AA11-BB22\n"));
    await promise;

    void mgr.signOut();

    expect(proc.kill).toHaveBeenCalled();
    proc.emit("close", 1);
    await vi.advanceTimersByTimeAsync(10);
    expect(onLoginFailed).not.toHaveBeenCalled();
  });

  it("propagates backend sign-out failures after clearing local state", async () => {
    const { SessionManager } = await import("./sessions");
    const backend = await createTestBackend();
    vi.spyOn(backend, "signOut").mockRejectedValue(new Error("Credentials remain"));
    const manager = new SessionManager("/test/workspace", backend);

    await expect(manager.signOut()).rejects.toThrow("Credentials remain");
    expect(manager.getCurrentSessionId()).toBeNull();
  });

  describe("post-login auth verification", () => {
    /** Helper: start login, emit device code, emit close(0), return the login promise */
    async function loginWithDeviceFlowThenClose() {
      const proc = createMockProcess();
      mockedSpawn.mockReturnValue(testDouble<ChildProcess>(proc));

      const promise = mgr.login();
      proc.stdout.emit("data", Buffer.from("enter code AA00-BB11\n"));
      await promise;

      proc.emit("close", 0);
    }

    it("retries and succeeds when getAuthStatus returns true on second attempt", async () => {
      const getAuthStatus = vi.fn<() => Promise<object>>();
      getAuthStatus
        .mockResolvedValueOnce({ isAuthenticated: false })
        .mockResolvedValueOnce({ isAuthenticated: true, login: "user" });
      mgr.setClientFactory(async () => ({
        start: vi.fn<() => void>(),
        getAuthStatus,
      }));

      await loginWithDeviceFlowThenClose();
      expect(mgr.loginInProgress).toBe(true);

      // First attempt (1.5s delay) — returns false
      await vi.advanceTimersByTimeAsync(1500);
      expect(mgr.loginInProgress).toBe(true);

      // Second attempt (2s delay) — returns true
      await vi.advanceTimersByTimeAsync(2000);
      expect(mgr.loginInProgress).toBe(false);
      expect(getAuthStatus).toHaveBeenCalledTimes(2);
    });

    it("clears loginInProgress after all retries are exhausted", async () => {
      const getAuthStatus = vi
        .fn<() => Promise<object>>()
        .mockResolvedValue({ isAuthenticated: false });
      mgr.setClientFactory(async () => ({
        start: vi.fn<() => void>(),
        getAuthStatus,
      }));

      await loginWithDeviceFlowThenClose();
      expect(mgr.loginInProgress).toBe(true);

      // Advance through all three retry delays: 1.5s + 2s + 3s
      await vi.advanceTimersByTimeAsync(1500);
      expect(mgr.loginInProgress).toBe(true);
      await vi.advanceTimersByTimeAsync(2000);
      expect(mgr.loginInProgress).toBe(true);
      await vi.advanceTimersByTimeAsync(3000);
      expect(mgr.loginInProgress).toBe(false); // finally cleared after exhaustion
      expect(getAuthStatus).toHaveBeenCalledTimes(3);
    });

    it("fires loginFailedCallback when all retries are exhausted (log-2 case)", async () => {
      const getAuthStatus = vi
        .fn<() => Promise<object>>()
        .mockResolvedValue({ isAuthenticated: false });
      mgr.setClientFactory(async () => ({
        start: vi.fn<() => void>(),
        getAuthStatus,
      }));
      const onLoginFailed = vi.fn<(reason: string) => void>();
      mgr.setLoginFailedCallback(onLoginFailed);

      await loginWithDeviceFlowThenClose();
      await vi.advanceTimersByTimeAsync(1500 + 2000 + 3000);

      expect(onLoginFailed).toHaveBeenCalledTimes(1);
      expect(onLoginFailed.mock.calls[0][0]).toMatch(/authentication could not be verified/i);
    });

    it("keeps loginInProgress true during verification so polls return 'Login in progress'", async () => {
      const getAuthStatus = vi
        .fn<() => Promise<object>>()
        .mockResolvedValue({ isAuthenticated: true, login: "user" });
      mgr.setClientFactory(async () => ({
        start: vi.fn<() => void>(),
        getAuthStatus,
      }));

      await loginWithDeviceFlowThenClose();

      // During the delay before the first attempt, flag should still be true
      await vi.advanceTimersByTimeAsync(500);
      expect(mgr.loginInProgress).toBe(true);

      // After first attempt succeeds
      await vi.advanceTimersByTimeAsync(1000);
      expect(mgr.loginInProgress).toBe(false);
    });

    it("aborts verification if sign-out is triggered", async () => {
      const getAuthStatus = vi
        .fn<() => Promise<object>>()
        .mockResolvedValue({ isAuthenticated: false });
      mgr.setClientFactory(async () => ({
        start: vi.fn<() => void>(),
        getAuthStatus,
      }));

      await loginWithDeviceFlowThenClose();

      // Simulate sign-out before verification starts
      mgr.signOutPromise = Promise.resolve();

      await vi.advanceTimersByTimeAsync(1500);
      expect(mgr.loginInProgress).toBe(false);
      expect(getAuthStatus).not.toHaveBeenCalled();
    });

    it("handles initClient() failure gracefully and retries", async () => {
      let callCount = 0;
      mgr.setClientFactory(async () => {
        callCount++;
        if (callCount === 1) throw new Error("spawn failed");
        return {
          start: vi.fn<() => void>(),
          getAuthStatus: vi
            .fn<() => Promise<object>>()
            .mockResolvedValue({ isAuthenticated: true, login: "user" }),
        };
      });

      await loginWithDeviceFlowThenClose();

      // First attempt (1.5s) — initClient throws
      await vi.advanceTimersByTimeAsync(1500);
      expect(mgr.loginInProgress).toBe(true);

      // Second attempt (2s) — succeeds
      await vi.advanceTimersByTimeAsync(2000);
      expect(mgr.loginInProgress).toBe(false);
    });

    it("verifies once, without the retry loop, when process exits without device flow", async () => {
      // A synchronous (browser-flow / already-authed) login performs one real
      // auth check instead of trusting a stale cache — after sign-out the
      // cache reads false and no completion phase will run, so goal dispatch
      // would otherwise stay parked until an unrelated renderer poll. The
      // backoff-based verifyAuthAfterLogin loop still must NOT run
      // on this path: exactly one check, loginInProgress cleared immediately.
      const getAuthStatus = vi
        .fn<() => Promise<{ isAuthenticated: boolean; login: string }>>()
        .mockResolvedValue({ isAuthenticated: true, login: "user" });
      mgr.setClientFactory(async () => ({
        start: vi.fn<() => void>(),
        getAuthStatus,
      }));

      const proc = createMockProcess();
      mockedSpawn.mockReturnValue(testDouble<ChildProcess>(proc));

      const promise = mgr.login();
      // Exit without device code (browser flow)
      proc.emit("close", 0);
      await promise;

      expect(mgr.loginInProgress).toBe(false); // cleared immediately
      await vi.advanceTimersByTimeAsync(5000);
      expect(getAuthStatus).toHaveBeenCalledTimes(1);
      expect(mgr.lastKnownAuthenticated).toBe(true);
    });
  });
});
