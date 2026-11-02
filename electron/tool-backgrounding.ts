import { randomUUID } from "crypto";

import { createLogger } from "../common/marshal-logger";
import type {
  BackgroundToolDispatchClaim,
  BackgroundToolDispatchClaimResult,
  BackgroundToolInvocationCompletion,
  BackgroundToolInvocationStart,
  BackgroundToolProcessAttacher,
  BackgroundToolProcessAttachment,
  IBackgroundToolInvocationManager,
  RunningToolCallInfo,
} from "./backend/ports";

const log = createLogger("ToolBackgrounding");
type BackgroundToolDispatchConflict = Extract<
  BackgroundToolDispatchClaimResult,
  { kind: "conflict" }
>;

export const TOOL_BACKGROUND_DETACH_THRESHOLD_MS = 30_000;

/**
 * Tool names that must never be moved to the background, regardless of how
 * long they run. An explicit, bounded blocking-wait primitive (the `sleep`
 * self-tool, electron/self-tools.ts — documented and clamped to at most
 * 120s) backgrounding itself defeats its entire purpose: the caller ends
 * its turn believing the wait is still running synchronously as a normal
 * tool call, and only learns the wait actually finished via the generic
 * background-tool wake later — an unnecessary detour for a call whose
 * maximum duration (120s) is already bounded and known up front, unlike an
 * arbitrary tool call this backgrounding machinery exists for.
 * Both call sites that wrap a tool handler in `runToolWithBackgrounding` /
 * `runRetainableToolWithBackgrounding` — `buildAllTools` in
 * electron/backend/local/session.ts, and `executeLocalTool` in
 * electron/backend/gateway/desktop-capabilities/execute-local-tool.ts —
 * check this set first and skip the wrapper entirely for a match.
 */
export const NEVER_BACKGROUND_TOOL_NAMES: ReadonlySet<string> = new Set(["sleep"]);

type ToolBackgroundManager = Pick<
  IBackgroundToolInvocationManager,
  | "claimBackgroundToolDispatch"
  | "beginBackgroundToolInvocation"
  | "attachBackgroundToolProcess"
  | "detachBackgroundToolInvocation"
  | "completeBackgroundToolInvocation"
  | "requestBackgroundToolCancellation"
>;

export interface BackgroundedToolInfo {
  handle: string;
  tool: RunningToolCallInfo;
}

export type InternalToolExecution<T> =
  | { kind: "completed"; result: T }
  | { kind: "retained"; result: T; completion: Promise<void> };

class BackgroundToolDispatchConflictError extends Error {
  readonly reason: BackgroundToolDispatchConflict["reason"];
  readonly existingHandle: string | undefined;

  constructor(reason: BackgroundToolDispatchConflict["reason"], existingHandle?: string) {
    super(
      `Background tool dispatch conflict: ${reason}${existingHandle ? ` (${existingHandle})` : ""}`,
    );
    this.name = "BackgroundToolDispatchConflictError";
    this.reason = reason;
    this.existingHandle = existingHandle;
  }
}

interface ToolBackgroundingOptions<T> {
  manager: ToolBackgroundManager;
  sessionId: string;
  toolCallId?: string;
  toolName: string;
  serverName?: string;
  thresholdMs?: number;
  enableAbortSignal?: boolean;
  cancellationScope?: "tool" | "turn" | "none";
  detachedResult: (info: BackgroundedToolInfo) => T;
  retainedResult?: (result: T, info: BackgroundedToolInfo) => T;
  completionForResult?: (result: T) => BackgroundToolInvocationCompletion;
  onExecutionSettled?: () => void;
}

export interface RunToolWithBackgroundingOptions<T> extends ToolBackgroundingOptions<T> {
  run: (signal: AbortSignal, attachProcess: BackgroundToolProcessAttacher) => Promise<T> | T;
}

export interface RunRetainableToolWithBackgroundingOptions<T> extends ToolBackgroundingOptions<T> {
  run: (
    signal: AbortSignal,
    attachProcess: BackgroundToolProcessAttacher,
  ) => Promise<InternalToolExecution<T>> | InternalToolExecution<T>;
}

type ToolBackgroundRaceResult<T> =
  | { kind: "execution"; result: T }
  | { kind: "detached"; result: T };

export function backgroundToolObservation(toolName: string, handle: string): string {
  return (
    `Tool ${toolName} is still running and has been moved to the background. ` +
    `Handle: ${handle}. Use inspectRunningTool with this handle to check status/results, ` +
    "or cancelRunningTool with this handle to stop it."
  );
}

export async function runToolWithBackgrounding<T>(
  opts: RunToolWithBackgroundingOptions<T>,
): Promise<T> {
  return await runRetainableToolWithBackgrounding({
    ...opts,
    run: async (signal, attachProcess) => ({
      kind: "completed",
      result: await opts.run(signal, attachProcess),
    }),
  });
}

export async function runRetainableToolWithBackgrounding<T>(
  opts: RunRetainableToolWithBackgroundingOptions<T>,
): Promise<T> {
  const controller = new AbortController();
  const toolCallId = opts.toolCallId ?? `bg-${randomUUID()}`;
  const requestedAtMs = Date.now();
  const claimResult = await opts.manager.claimBackgroundToolDispatch({
    ownerSessionId: opts.sessionId,
    toolCallId,
    toolName: opts.toolName,
    requestedAtMs,
    idempotencyKey: `background-tool-dispatch:v1:${JSON.stringify([
      opts.sessionId,
      toolCallId,
      opts.toolName,
    ])}`,
  });
  if (claimResult.kind === "conflict") {
    throw new BackgroundToolDispatchConflictError(claimResult.reason, claimResult.existingHandle);
  }
  const claim = claimResult.claim;
  const start: BackgroundToolInvocationStart = {
    claim,
    sessionId: opts.sessionId,
    toolCallId,
    toolName: opts.toolName,
    ...(opts.serverName ? { serverName: opts.serverName } : {}),
    startedAtMs: requestedAtMs,
    ...(opts.enableAbortSignal && opts.cancellationScope !== "none"
      ? { cancel: () => controller.abort() }
      : {}),
    ...(opts.cancellationScope ? { cancellationScope: opts.cancellationScope } : {}),
  };
  const registration = await opts.manager.beginBackgroundToolInvocation(start);
  try {
    assertRegistrationMatchesClaim(
      registration.handle,
      registration.claim,
      registration.invocation,
      claim,
      opts.toolName,
    );
  } catch (error) {
    try {
      const cancellation = await opts.manager.requestBackgroundToolCancellation({
        token: claim.cancellationToken,
        handle: registration.handle,
        requestedAtMs: Date.now(),
      });
      if (!cancellation.success) {
        throw new Error(
          `Invalid background tool registration cancellation was rejected for claim ${claim.claimId}`,
          { cause: error },
        );
      }
    } catch (cancellationError) {
      // oxlint-disable-next-line preserve-caught-error -- AggregateError retains both caught errors in its errors array.
      throw new AggregateError(
        [error, cancellationError],
        `Invalid background tool registration could not be cancelled for claim ${claim.claimId}`,
        { cause: error },
      );
    }
    throw error;
  }
  const handle = registration.handle;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let terminalPersistence: Promise<RunningToolCallInfo> | undefined;

  const complete = async (
    completion: BackgroundToolInvocationCompletion,
  ): Promise<RunningToolCallInfo> => {
    if (terminalPersistence) return await terminalPersistence;
    if (timer) clearTimeout(timer);
    terminalPersistence = (async () => {
      const persisted = await opts.manager.completeBackgroundToolInvocation(handle, completion);
      if (!persisted) {
        throw new Error(`Background tool terminal state was not persisted for handle ${handle}`);
      }
      if (
        persisted.handle !== handle ||
        persisted.sessionId !== claim.ownerSessionId ||
        persisted.toolCallId !== claim.toolCallId
      ) {
        throw new Error(`Background tool terminal state identity diverged for handle ${handle}`);
      }
      if (
        persisted.status === "running" ||
        persisted.status === "unknown" ||
        persisted.status === "cancelling"
      ) {
        throw new Error(
          `Background tool terminal state remained ${persisted.status} for handle ${handle}`,
        );
      }
      opts.onExecutionSettled?.();
      return persisted;
    })();
    return await terminalPersistence;
  };

  const attachProcess: BackgroundToolProcessAttacher = async (process) => {
    if (
      process.ownerSessionId !== claim.ownerSessionId ||
      !Number.isSafeInteger(process.rootPid) ||
      process.rootPid <= 0 ||
      !Number.isFinite(process.spawnedAtMs)
    ) {
      return await cancelAfterAttachmentFailure(
        opts.manager,
        handle,
        claim,
        process,
        new Error(`Background tool process identity did not match claim ${claim.claimId}`),
      );
    }
    try {
      const attached = await opts.manager.attachBackgroundToolProcess(handle, process);
      if (!attached) {
        throw new Error(
          `Background tool process attachment was not persisted for handle ${handle}`,
        );
      }
      const attachedProcess = attached.process;
      if (
        attached.handle !== registration.invocation.handle ||
        attached.sessionId !== registration.invocation.sessionId ||
        attached.toolCallId !== registration.invocation.toolCallId ||
        attached.toolName !== registration.invocation.toolName ||
        !attachedProcess ||
        attachedProcess.rootPid !== process.rootPid ||
        attachedProcess.spawnedAtMs !== process.spawnedAtMs ||
        attachedProcess.cancellationScope !== process.cancellationScope
      ) {
        throw new Error(
          `Background tool process attachment identity diverged for handle ${handle}`,
        );
      }
      return attached;
    } catch (error) {
      return await cancelAfterAttachmentFailure(opts.manager, handle, claim, process, error);
    }
  };

  const execution = (async (): Promise<T> => {
    let internalExecution: InternalToolExecution<T>;
    try {
      internalExecution = await opts.run(controller.signal, attachProcess);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await complete({ success: false, error: message });
      } catch (persistenceError) {
        // oxlint-disable-next-line preserve-caught-error -- AggregateError retains both caught errors in its errors array.
        throw new AggregateError(
          [error, persistenceError],
          `Background tool execution and terminal persistence both failed for handle ${handle}`,
          { cause: error },
        );
      }
      throw error;
    }

    const { result } = internalExecution;
    if (internalExecution.kind === "retained") {
      if (timer) clearTimeout(timer);
      const detachPersistence = opts.manager.detachBackgroundToolInvocation(handle);
      const retainedPersistence = (async () => {
        await Promise.allSettled([detachPersistence]);
        const completion = await internalExecution.completion.then(
          () => opts.completionForResult?.(result) ?? { success: true, result },
          (error: unknown): BackgroundToolInvocationCompletion => ({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        await complete(completion);
      })();
      void retainedPersistence.catch(() => {
        log.error("Retained background tool terminal persistence failed", { handle });
      });
      const retainedTool = await detachPersistence;
      if (!retainedTool) {
        throw new Error(`Background tool detach was not persisted for handle ${handle}`);
      }
      assertInvocationIdentity(retainedTool, handle, claim, "detach");
      return opts.retainedResult?.(result, { handle, tool: retainedTool }) ?? result;
    }
    await complete(opts.completionForResult?.(result) ?? { success: true, result });
    return result;
  })();

  const racedExecution = execution.then(
    (result): ToolBackgroundRaceResult<T> => ({ kind: "execution", result }),
  );
  const detachedPromise = new Promise<ToolBackgroundRaceResult<T>>((resolve, reject) => {
    timer = setTimeout(() => {
      void (async () => {
        try {
          const detachedTool = await opts.manager.detachBackgroundToolInvocation(handle);
          if (!detachedTool) {
            throw new Error(`Background tool detach was not persisted for handle ${handle}`);
          }
          assertInvocationIdentity(detachedTool, handle, claim, "detach");
          resolve({
            kind: "detached",
            result: opts.detachedResult({ handle, tool: detachedTool }),
          });
        } catch (error) {
          reject(error);
        }
      })();
    }, opts.thresholdMs ?? TOOL_BACKGROUND_DETACH_THRESHOLD_MS);
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
  });

  let outcome: ToolBackgroundRaceResult<T>;
  try {
    outcome = await Promise.race([racedExecution, detachedPromise]);
  } catch (error) {
    observeBackgroundExecution(execution, handle);
    throw error;
  }
  if (outcome.kind === "detached") {
    observeBackgroundExecution(execution, handle);
  }
  return outcome.result;
}

function observeBackgroundExecution(execution: Promise<unknown>, handle: string): void {
  void execution.catch(() => {
    log.error("Background tool execution failed after ownership transfer", { handle });
  });
}

function assertInvocationIdentity(
  invocation: RunningToolCallInfo,
  handle: string,
  claim: BackgroundToolDispatchClaim,
  operation: string,
): void {
  if (
    invocation.handle !== handle ||
    invocation.sessionId !== claim.ownerSessionId ||
    invocation.toolCallId !== claim.toolCallId
  ) {
    throw new Error(`Background tool ${operation} identity diverged for handle ${handle}`);
  }
}

function assertRegistrationMatchesClaim(
  handle: string,
  registeredClaim: BackgroundToolDispatchClaim,
  invocation: RunningToolCallInfo,
  claimed: BackgroundToolDispatchClaim,
  expectedToolName: string,
): void {
  if (
    registeredClaim.claimId !== claimed.claimId ||
    registeredClaim.ownerSessionId !== claimed.ownerSessionId ||
    registeredClaim.toolCallId !== claimed.toolCallId ||
    registeredClaim.claimedAtMs !== claimed.claimedAtMs ||
    registeredClaim.cancellationToken.tokenId !== claimed.cancellationToken.tokenId ||
    registeredClaim.cancellationToken.ownerSessionId !== claimed.cancellationToken.ownerSessionId ||
    registeredClaim.cancellationToken.claimId !== claimed.cancellationToken.claimId ||
    registeredClaim.cancellationToken.issuedAtMs !== claimed.cancellationToken.issuedAtMs ||
    handle !== invocation.handle ||
    invocation.sessionId !== claimed.ownerSessionId ||
    invocation.toolCallId !== claimed.toolCallId ||
    invocation.toolName !== expectedToolName
  ) {
    throw new Error(`Background tool registration did not match claim ${claimed.claimId}`);
  }
}

async function cancelAfterAttachmentFailure(
  manager: ToolBackgroundManager,
  handle: string,
  claim: BackgroundToolDispatchClaim,
  process: BackgroundToolProcessAttachment,
  attachmentError: unknown,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  try {
    const cancellation = await manager.requestBackgroundToolCancellation({
      token: claim.cancellationToken,
      handle,
      requestedAtMs: Date.now(),
    });
    if (!cancellation.success) {
      cleanupErrors.push(
        new Error(`Background tool cancellation request was rejected for handle ${handle}`),
      );
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await process.cancel();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [attachmentError, ...cleanupErrors],
      `Background tool process attachment cleanup failed for handle ${handle}`,
    );
  }
  throw attachmentError;
}
