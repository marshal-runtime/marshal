/**
 * `executeLocalTool` — shell path.
 *
 * Cloud-driven shell execution for cron-fired automations. The cloud is
 * expected to gate every call through `evaluateLocalPolicy` first
 * (and `showApprovalCard` when policy returns "prompt") — so the policy
 * decision has already been made before we land here.
 *
 * Defense-in-depth: we still re-run `PermissionPolicy.evaluate` on the
 * incoming request and refuse on `"deny"`. That re-check is cheap and
 * protects against a buggy or compromised cloud caller skipping the gate.
 *
 * Cross-platform spawn: matches the convention in CLAUDE.md
 * "Cross-Platform Requirement". Uses the OS shell so the cloud can pass
 * compound commands (`grep foo | sort`) without our needing to tokenize.
 *
 *   - Windows:  `cmd.exe /d /s /c "<command>"` with `windowsHide: true`
 *   - POSIX:    `/bin/sh -c "<command>"`
 *
 * Output capture: stdout + stderr concatenated as a single string field on
 * `output`, plus `exitCode`. We do NOT stream — the cloud's RPC contract is
 * request/response (`LocalToolResult` returns once).
 *
 * Spec: docs/specs/gateway-automations-phase-2b-design.md §5.1 (RPC #1).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { InternalToolExecution } from "../../../tool-backgrounding";
import type { BackgroundToolProcessAttacher, IPermissionPolicy } from "../../ports";
import type { ApprovalRequest } from "../../types";
import {
  DesktopCapabilityErrorThrow,
  type LocalToolRequest,
  type LocalToolResult,
} from "../../types";

/** Spawn signature used by the handler. Narrowed to what we actually call. */
type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { windowsHide?: boolean; shell?: boolean; env?: NodeJS.ProcessEnv; detached?: boolean },
) => ChildProcess;

/**
 * Env vars that pass through to the spawned shell. Defense-in-depth: the
 * cloud is the authoritative gate via `evaluateLocalPolicy` /
 * `showApprovalCard`, but the inherited environment shouldn't be part of
 * that trust boundary. Cloud-supplied commands like `printenv` would
 * otherwise see Marshal's internal env. Names span both POSIX and Windows so the same list
 * works on macOS / Linux / Windows without per-platform branching.
 */
const ENV_ALLOWLIST = [
  // POSIX
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  // Windows
  "USERPROFILE",
  "USERNAME", // many Windows programs read %USERNAME% for display strings
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
] as const;
const MARSHAL_TOOL_WORKER_LIMIT = "4";

function buildAllowlistedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The augmented `NodeJS.ProcessEnv` declares some always-set fields (NODE_ENV,
  // VITE_*) that the type system expects; build into a plain Record and return
  // through the type intersection — at runtime the spawned process only sees
  // the allow-listed keys we set here.
  const out: Record<string, string | undefined> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = env[key];
    if (v !== undefined) out[key] = v;
  }
  out.CARGO_BUILD_JOBS = env.CARGO_BUILD_JOBS ?? MARSHAL_TOOL_WORKER_LIMIT;
  out.CMAKE_BUILD_PARALLEL_LEVEL = env.CMAKE_BUILD_PARALLEL_LEVEL ?? MARSHAL_TOOL_WORKER_LIMIT;
  out.CTEST_PARALLEL_LEVEL = env.CTEST_PARALLEL_LEVEL ?? MARSHAL_TOOL_WORKER_LIMIT;
  out.MAKEFLAGS = env.MAKEFLAGS ?? `-j${MARSHAL_TOOL_WORKER_LIMIT}`;
  out.NINJAFLAGS = env.NINJAFLAGS ?? `-j${MARSHAL_TOOL_WORKER_LIMIT}`;
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Record<string, string|undefined> is structurally assignable; widening to NodeJS.ProcessEnv is safe at the boundary
  return out as NodeJS.ProcessEnv;
}

export interface ExecuteShellDeps {
  /**
   * Permission policy port — used for defense-in-depth re-check before
   * spawning. The cloud is expected to have called `evaluateLocalPolicy`
   * first; only `policy.evaluate` is consulted here, so the narrow
   * `IPermissionPolicy` port is sufficient.
   */
  policy: IPermissionPolicy;
  /** Test override; defaults to node's `child_process.spawn`. */
  spawn?: SpawnFn;
  /**
   * Inject `process.platform` for tests. Defaults to the real value.
   */
  platform?: NodeJS.Platform;
  /**
   * Cap captured stdout AND stderr **per stream**. Defaults to 1 MiB each,
   * so the worst case for a single shell call is `2 * maxOutputBytes` of
   * captured output across both streams. Switching to a shared counter
   * would change the buffer-overflow semantics (truncation across streams
   * couldn't be reasoned about per-stream) and isn't necessary for v0.
   * Truncation is signaled in `output.truncated`.
   */
  maxOutputBytes?: number;
  /**
   * Hard timeout for the spawned process. Defaults to 120s.
   *
   * Many real-world commands routinely exceed 60s on healthy machines:
   * dependency installs (`pnpm install`, `npm ci`), test runs (`pnpm test`,
   * `dotnet test`), package builds, and CI status polls (`gh pr checks
   * --watch`). The previous 60s default produced spurious timeouts that
   * surfaced as confusing "Shell command timed out" errors mid-turn. 120s
   * gives those commands room to breathe; per-call overrides remain
   * available for genuinely long-running work.
   */
  timeoutMs?: number;
}

interface ShellArgs {
  /** Raw command string passed verbatim to the shell. */
  command: string;
}

interface ShellOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Set when the captured output exceeded `maxOutputBytes`. */
  truncated?: boolean;
  /** Set when the process was killed by the timeout. */
  timedOut?: boolean;
  /** Set when the caller cancelled the process. */
  cancelled?: boolean;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_TIMEOUT_MS = 120_000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;

export function makeExecuteShellHandler(deps: ExecuteShellDeps) {
  const spawnFn = deps.spawn ?? spawn;
  const platform = deps.platform ?? process.platform;
  const maxOutputBytes = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function executeShell(
    request: LocalToolRequest,
    signal?: AbortSignal,
    attachProcess?: BackgroundToolProcessAttacher,
  ): Promise<InternalToolExecution<LocalToolResult>> {
    const command = extractCommand(request.toolArgs);
    if (!command) {
      return {
        kind: "completed",
        result: {
          output: null,
          success: false,
          error: "Missing 'command' in toolArgs",
        },
      };
    }

    // Defense-in-depth: re-evaluate policy. Cloud is the authoritative gate
    // (and may carry user-approved decisions we'd block in isolation), but
    // a categorical "deny" must hold here too.
    const permissionRequest: ApprovalRequest = {
      id: randomUUID(),
      sessionId: request.sessionId,
      toolCallId: undefined,
      kind: "shell",
      command,
      serverName: request.serverName ?? "",
      intention: undefined,
      warning: undefined,
      commandIdentifiers: [],
    };
    const decision = deps.policy.evaluate(permissionRequest);
    // "prompt" passes through — the cloud is the authoritative gate and has
    // already shown an approval card before dispatching this RPC. Defense-in-
    // depth here enforces only the categorical "deny" floor; "approve" and
    // "prompt" both proceed to spawn.
    if (decision === "deny") {
      throw new DesktopCapabilityErrorThrow("policy-deny", "Shell command blocked by local policy");
    }

    return await runShell({
      command,
      ownerSessionId: request.sessionId,
      spawnFn,
      platform,
      maxOutputBytes,
      timeoutMs,
      signal,
      attachProcess,
    });
  };
}

function extractCommand(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const a = args as Partial<ShellArgs>;
  return typeof a.command === "string" && a.command.length > 0 ? a.command : null;
}

interface RunShellOpts {
  command: string;
  ownerSessionId: string;
  spawnFn: SpawnFn;
  platform: NodeJS.Platform;
  maxOutputBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  attachProcess?: BackgroundToolProcessAttacher;
}

function runShell(opts: RunShellOpts): Promise<InternalToolExecution<LocalToolResult>> {
  return new Promise<InternalToolExecution<LocalToolResult>>((resolve, reject) => {
    const {
      command,
      ownerSessionId,
      spawnFn,
      platform,
      maxOutputBytes,
      timeoutMs,
      signal,
      attachProcess,
    } = opts;
    if (signal?.aborted) {
      resolve({
        kind: "completed",
        result: {
          output: { stdout: "", stderr: "", exitCode: null, cancelled: true },
          success: false,
          error: "Shell command cancelled",
        },
      });
      return;
    }
    const isWindows = platform === "win32";
    // Use the OS shell so cloud-supplied compound commands work without our
    // tokenizing. `windowsHide` keeps cmd.exe from flashing a console window.
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const args = isWindows ? ["/d", "/s", "/c", command] : ["-c", command];
    let child: ChildProcess;
    try {
      // Pass an allow-listed env (not process.env) so cloud-supplied commands
      // can't read Marshal's internal env. See ENV_ALLOWLIST for the full
      // list and the rationale.
      child = spawnFn(shell, args, {
        windowsHide: true,
        env: buildAllowlistedEnv(process.env),
        detached: !isWindows,
      });
    } catch (err) {
      resolve({
        kind: "completed",
        result: {
          output: null,
          success: false,
          error: `Failed to spawn shell: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
      return;
    }
    const spawnedAtMs = Date.now();

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let attachmentFailurePending = false;
    let attachmentReady = attachProcess === undefined;
    let pendingSettlement: { result: LocalToolResult; completion?: Promise<void> } | undefined;
    let termination: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let childClosed = false;
    let resolveChildClose!: () => void;
    const childClose = new Promise<void>((resolveLifetime) => {
      resolveChildClose = resolveLifetime;
    });
    const rootPid =
      child.pid !== undefined && Number.isSafeInteger(child.pid) && child.pid > 0
        ? child.pid
        : undefined;

    const markChildClosed = (): void => {
      if (childClosed) return;
      childClosed = true;
      resolveChildClose();
    };

    const finalizeSettlement = (result: LocalToolResult, completion?: Promise<void>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abortListener);
      resolve(
        completion ? { kind: "retained", result, completion } : { kind: "completed", result },
      );
    };

    const settle = (result: LocalToolResult, completion?: Promise<void>): void => {
      if (settled || attachmentFailurePending) return;
      if (!attachmentReady) {
        pendingSettlement = { result, ...(completion ? { completion } : {}) };
        return;
      }
      finalizeSettlement(result, completion);
    };

    const capturedOutput = (exitCode: number | null): ShellOutput => ({
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      exitCode,
      ...(truncated ? { truncated: true } : {}),
      ...(timedOut ? { timedOut: true } : {}),
      ...(cancelled ? { cancelled: true } : {}),
    });

    const settleInterrupted = (): void => {
      settle(
        {
          output: capturedOutput(null),
          success: false,
          error: cancelled
            ? "Shell command cancelled"
            : `Shell command timed out after ${opts.timeoutMs}ms`,
        },
        childClose,
      );
    };

    const terminateOwnedProcess = (): Promise<void> => {
      if (childClosed) return Promise.resolve();
      if (termination) return termination;
      const attempt = async (): Promise<void> => {
        if (rootPid === undefined) throw new Error("Spawned shell did not expose a root PID");
        if (isWindows) {
          await runWindowsTaskkill(spawnFn, rootPid);
          return;
        }
        process.kill(-rootPid, "SIGKILL");
      };
      const currentTermination = attempt().then(
        () => undefined,
        (error: unknown) => {
          if (childClosed) return;
          const terminationError = error instanceof Error ? error : new Error(String(error));
          if (termination === currentTermination) termination = undefined;
          settle(
            {
              output: capturedOutput(null),
              success: false,
              error: `Shell command termination failed: ${terminationError.message}`,
            },
            childClose,
          );
          throw terminationError;
        },
      );
      termination = currentTermination;
      void currentTermination.then(
        () => {},
        () => {
          if (termination === currentTermination) termination = undefined;
        },
      );
      return currentTermination;
    };

    const cancelOwnedProcess = async (): Promise<void> => {
      cancelled = true;
      await terminateOwnedProcess();
      settleInterrupted();
    };

    const abortListener = (): void => {
      void cancelOwnedProcess().catch(() => {});
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = maxOutputBytes - stdoutBytes;
      const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      stdoutChunks.push(slice);
      stdoutBytes += slice.length;
      if (chunk.length > remaining) truncated = true;
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = maxOutputBytes - stderrBytes;
      const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      stderrChunks.push(slice);
      stderrBytes += slice.length;
      if (chunk.length > remaining) truncated = true;
    });

    const handleChildError = (err: Error): void => {
      // Race: SIGKILL after the timeout can synthesize an "error" event before
      // "close" fires. The accepted kill request is not process settlement;
      // retain ownership until close and keep the interrupted result sanitized.
      if (timedOut || cancelled) {
        return;
      }
      settle({
        output: null,
        success: false,
        error: `Shell process error: ${err.message}`,
      });
    };

    child.on("error", (err) => {
      if (termination) {
        void termination.then(
          () => handleChildError(err),
          () => {},
        );
        return;
      }
      handleChildError(err);
    });

    const handleChildClose = (code: number | null): void => {
      const out = capturedOutput(code);
      // success = clean exit (code 0) AND not killed by timeout. Non-zero
      // exit is still a structured result the cloud can inspect via `output`,
      // but we surface it as `success: false` for the standard envelope.
      const success = code === 0 && !timedOut && !cancelled;
      const result: LocalToolResult = {
        output: out,
        success,
        ...(cancelled
          ? { error: "Shell command cancelled" }
          : timedOut
            ? { error: `Shell command timed out after ${opts.timeoutMs}ms` }
            : code !== 0 && code !== null
              ? { error: `Shell command exited with code ${code}` }
              : {}),
      };
      settle(result);
    };

    child.on("close", (code) => {
      markChildClosed();
      handleChildClose(code);
    });

    const startAfterAttachment = (): void => {
      if (settled) return;
      attachmentReady = true;
      const pending = pendingSettlement;
      pendingSettlement = undefined;
      if (pending) {
        finalizeSettlement(pending.result, pending.completion);
        return;
      }
      if (signal?.aborted) {
        void cancelOwnedProcess().catch(() => {});
        return;
      }
      signal?.addEventListener("abort", abortListener, { once: true });
      timer = setTimeout(() => {
        timedOut = true;
        void terminateOwnedProcess().then(settleInterrupted, () => {});
      }, timeoutMs);
    };

    const failAttachment = async (error: unknown): Promise<void> => {
      if (settled || attachmentFailurePending) return;
      attachmentFailurePending = true;
      pendingSettlement = undefined;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abortListener);
      try {
        await cancelOwnedProcess();
      } catch (cancellationError) {
        settled = true;
        reject(
          new AggregateError(
            [error, cancellationError],
            `Failed to persist and cancel shell process attachment for PID ${String(rootPid)}`,
          ),
        );
        return;
      }
      await childClose;
      settled = true;
      reject(error);
    };

    if (!attachProcess) {
      startAfterAttachment();
      return;
    }
    if (rootPid === undefined) {
      void failAttachment(new Error("Spawned shell did not expose a root PID"));
      return;
    }
    void (async () => {
      try {
        const attached = await attachProcess({
          ownerSessionId,
          rootPid,
          spawnedAtMs,
          cancellationScope: isWindows ? "process-tree" : "process-group",
          cancel: cancelOwnedProcess,
        });
        if (!attached) {
          throw new Error(`Shell process attachment was not persisted for PID ${rootPid}`);
        }
        startAfterAttachment();
      } catch (error) {
        await failAttachment(error);
      }
    })();
  });
}

function runWindowsTaskkill(spawnFn: SpawnFn, rootPid: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let taskkill: ChildProcess;
    try {
      taskkill = spawnFn("taskkill.exe", ["/PID", String(rootPid), "/T", "/F"], {
        windowsHide: true,
        env: buildAllowlistedEnv(process.env),
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        taskkill.kill("SIGKILL");
      } catch {
        // The bounded result is authoritative even if the exact helper process already exited.
      }
      reject(new Error(`taskkill timed out after ${WINDOWS_TASKKILL_TIMEOUT_MS}ms`));
    }, WINDOWS_TASKKILL_TIMEOUT_MS);
    taskkill.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    taskkill.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`taskkill exited with code ${String(code)}`));
    });
  });
}
