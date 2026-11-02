import type {
  ExternalOperationIdentity,
  ExternalOperationRequest,
} from "../../../common/external-operation-contract";
import type { GoalFence } from "../../../common/goal-contract";
import { createLogger } from "../../../common/marshal-logger";
import type {
  BackgroundToolCancellationRequest,
  BackgroundToolCancellationRequestToken,
  BackgroundToolDispatchClaim,
  BackgroundToolDispatchClaimRequest,
  BackgroundToolDispatchClaimResult,
  BackgroundToolInvocationCompletion,
  BackgroundToolInvocationRegistrationResult,
  BackgroundToolInvocationStart,
  BackgroundToolProcessAttacher,
  BackgroundToolProcessAttachment,
  IBackgroundToolInvocationManager,
  RunningToolCallInfo,
  RunningToolCancelResult,
  RunningToolCancellationScope,
  RunningToolInspectResult,
  RunningToolProcessInfo,
} from "../../backend/ports";
import { createHostManagedBackgroundToolAdapter, type ExternalOperationHandle } from "../adapters";
import type { ExternalOperationRegistry } from "../registry";
import type {
  ExternalOperationCancellationScope,
  ExternalOperationJson,
  StoredExternalOperationRecord,
} from "../types";

export {
  HandleBackedExternalOperationAdapter,
  createHostManagedBackgroundToolAdapter,
  type ExternalOperationHandle,
  type ExternalOperationHandleResolver,
  type HandleBackedExternalOperationAdapterOptions,
} from "../adapters";

const log = createLogger("BackgroundToolRegistryAdapter");
const LONG_RUNNING_TOOL_THRESHOLD_MS = 2 * 60 * 1_000;
const MAX_OUTPUT_PREVIEW = 4_000;
const DEFAULT_ADAPTER_ID = "background-tool-invocation-manager";

interface CompatibilityToolState {
  identity: ExternalOperationIdentity;
  claimToken: string;
  cancellationToken: BackgroundToolCancellationRequestToken;
  handle: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  serverName?: string;
  startedAtMs: number;
  completedAtMs?: number;
  status: RunningToolCallInfo["status"];
  backgrounded: boolean;
  result?: unknown;
  outputPreview?: string;
  resultTruncated?: boolean;
  error?: string;
  cancel?: () => Promise<void> | void;
  cancellationScope: RunningToolCancellationScope;
  process?: RunningToolProcessInfo;
  live: boolean;
  durabilityFailed?: boolean;
}

interface PendingDispatchClaim {
  identity: ExternalOperationIdentity;
  claimToken: string;
  claim: BackgroundToolDispatchClaim;
  toolName: string;
}

export interface BackgroundToolInvocationRegistryAdapterOptions {
  registry: ExternalOperationRegistry;
  resolveGoalFence: (request: Readonly<BackgroundToolDispatchClaimRequest>) => GoalFence;
  cancelTurn?: (sessionId: string) => Promise<void> | void;
  adapterId?: string;
  now?: () => number;
}

export class BackgroundToolInvocationRegistryAdapter implements IBackgroundToolInvocationManager {
  private readonly registry: ExternalOperationRegistry;
  private readonly resolveGoalFence: BackgroundToolInvocationRegistryAdapterOptions["resolveGoalFence"];
  private readonly cancelTurn?: BackgroundToolInvocationRegistryAdapterOptions["cancelTurn"];
  private readonly adapterId: string;
  private readonly now: () => number;
  private readonly tools = new Map<string, CompatibilityToolState>();
  private readonly pendingClaims = new Map<string, PendingDispatchClaim>();

  constructor(options: BackgroundToolInvocationRegistryAdapterOptions) {
    this.registry = options.registry;
    this.resolveGoalFence = options.resolveGoalFence;
    this.cancelTurn = options.cancelTurn;
    this.adapterId = options.adapterId ?? DEFAULT_ADAPTER_ID;
    this.now = options.now ?? Date.now;
    this.registry.registerAdapter(
      createHostManagedBackgroundToolAdapter(this.adapterId, (context) =>
        this.resolveHandle(context.operation.operationId),
      ),
    );
  }

  async claimBackgroundToolDispatch(
    request: BackgroundToolDispatchClaimRequest,
  ): Promise<BackgroundToolDispatchClaimResult> {
    validateDispatchClaimRequest(request);
    const handle = buildHandle(request.ownerSessionId, request.toolCallId);
    const fence = this.resolveGoalFence(request);
    const operationId = buildOperationId(handle, request.idempotencyKey);
    const externalRequest: ExternalOperationRequest = {
      operationId,
      fence,
      idempotencyKey: request.idempotencyKey,
      kind: request.toolName,
      effect: "side-effect",
      requestedAt: new Date(request.requestedAtMs).toISOString(),
      inputFingerprint: `${request.toolName}:${request.toolCallId}`,
    };
    const identity = identityFromRequest(externalRequest);
    try {
      await this.registry.register({
        request: externalRequest,
        metadata: {
          sessionId: request.ownerSessionId,
          launcherSessionId: request.ownerSessionId,
          capturedAt: externalRequest.requestedAt,
          values: {
            handle,
            backgrounded: false,
            cancellationScope: "none",
          },
        },
        provider: {
          kind: "host-tool",
          provider: "host",
          adapterId: this.adapterId,
        },
        runtimeIdentity: {
          toolName: request.toolName,
          toolCallId: request.toolCallId,
          sessionId: request.ownerSessionId,
        },
        cancellationScope: "none",
        actionSemantics: "non-idempotent",
        detached: true,
        watcher: { strategy: "host" },
      });
      const dispatch = await this.registry.claimDispatch({
        identity,
        claimedBy: handle,
      });
      const claimedAtMs = Date.parse(dispatch.claim.claimedAt);
      const claim: BackgroundToolDispatchClaim = {
        claimId: dispatch.claim.claimToken,
        ownerSessionId: request.ownerSessionId,
        toolCallId: request.toolCallId,
        claimedAtMs,
        cancellationToken: {
          tokenId: `${dispatch.claim.claimToken}:cancel`,
          ownerSessionId: request.ownerSessionId,
          claimId: dispatch.claim.claimToken,
          issuedAtMs: claimedAtMs,
        },
      };
      this.pendingClaims.set(claim.claimId, {
        identity,
        claimToken: dispatch.claim.claimToken,
        claim,
        toolName: request.toolName,
      });
      return { kind: "claimed", claim };
    } catch (error) {
      const conflict = dispatchConflict(error, handle);
      if (conflict) return conflict;
      throw error;
    }
  }

  async beginBackgroundToolInvocation(
    args: BackgroundToolInvocationStart,
  ): Promise<BackgroundToolInvocationRegistrationResult> {
    const handle = buildHandle(args.sessionId, args.toolCallId);
    const existing = this.tools.get(handle);
    if (
      existing?.live &&
      existing.status === "running" &&
      existing.claimToken === args.claim.claimId &&
      sameCancellationToken(existing.cancellationToken, args.claim.cancellationToken)
    ) {
      return { handle, claim: args.claim, invocation: this.toInfo(existing) };
    }
    const pending =
      this.pendingClaims.get(args.claim.claimId) ??
      this.restorePendingClaim(args.claim, args.toolName);
    if (
      !pending ||
      pending.claim.ownerSessionId !== args.sessionId ||
      pending.claim.toolCallId !== args.toolCallId ||
      pending.toolName !== args.toolName ||
      !sameCancellationToken(pending.claim.cancellationToken, args.claim.cancellationToken)
    ) {
      throw new Error("Background tool invocation claim is invalid or stale");
    }

    const startedAtMs = normalizeTimestamp(args.startedAtMs, this.now());
    const cancellationScope = args.cancellationScope ?? (args.cancel ? "tool" : "none");
    const state: CompatibilityToolState = {
      identity: pending.identity,
      claimToken: pending.claimToken,
      cancellationToken: pending.claim.cancellationToken,
      handle,
      sessionId: args.sessionId,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      serverName: args.serverName,
      startedAtMs,
      status: "running",
      backgrounded: false,
      cancel: args.cancel,
      cancellationScope,
      live: false,
    };

    try {
      await this.registry.attach({
        identity: pending.identity,
        claimToken: state.claimToken,
        runtimeIdentity: {
          toolName: args.toolName,
          toolCallId: args.toolCallId,
          sessionId: args.sessionId,
        },
        receipt: {
          handle,
          backgrounded: false,
          cancellationScope,
          claimId: args.claim.claimId,
          cancellationId: args.claim.cancellationToken.tokenId,
          cancellationIssuedAtMs: args.claim.cancellationToken.issuedAtMs,
        },
      });
      state.live = true;
      this.tools.set(handle, state);
      this.pendingClaims.delete(args.claim.claimId);
      return {
        handle,
        claim: args.claim,
        invocation: this.toInfo(state),
      };
    } catch (error) {
      this.markDurabilityFailure(state);
      throw error;
    }
  }

  async attachBackgroundToolProcess(
    handle: string,
    process: BackgroundToolProcessAttachment,
  ): Promise<RunningToolCallInfo | null> {
    const state = this.tools.get(handle);
    if (!state || !state.live || state.status !== "running" || state.process) return null;
    validateProcessAttachment(process);
    const ownerSessionId = exactProcessOwner(process);
    const spawnedAtMs = exactSpawnedAt(process);
    const exactProcess = {
      ownerSessionId,
      rootPid: process.rootPid,
      spawnedAtMs,
    };

    try {
      await this.registry.attach({
        identity: state.identity,
        claimToken: state.claimToken,
        receipt: {
          handle,
          backgrounded: state.backgrounded,
          rootPid: process.rootPid,
          cancellationScope: process.cancellationScope,
          ownerSessionId,
          spawnedAtMs,
        },
        exactProcess,
        cancellationScope: toExternalCancellationScope(process.cancellationScope),
      });
      state.cancel = process.cancel;
      state.cancellationScope = process.cancellationScope;
      state.process = {
        ownerSessionId,
        rootPid: process.rootPid,
        spawnedAtMs,
        identitySource: "spawned-child",
        cancellationScope: process.cancellationScope,
      };
      return this.toInfo(state);
    } catch (error) {
      this.markDurabilityFailure(state);
      throw error;
    }
  }

  createBackgroundToolProcessAttacher(handle: string): BackgroundToolProcessAttacher {
    return (process) => this.attachBackgroundToolProcess(handle, process);
  }

  async detachBackgroundToolInvocation(handle: string): Promise<RunningToolCallInfo | null> {
    const state = this.tools.get(handle);
    if (!state || !state.live || state.status !== "running") return null;
    try {
      await this.registry.heartbeat({
        identity: state.identity,
        receipt: {
          handle,
          backgrounded: true,
          ...(state.process ? { rootPid: state.process.rootPid } : {}),
        },
      });
      state.backgrounded = true;
      return this.toInfo(state);
    } catch (error) {
      this.markDurabilityFailure(state);
      throw error;
    }
  }

  async completeBackgroundToolInvocation(
    handle: string,
    completion: BackgroundToolInvocationCompletion,
  ): Promise<RunningToolCallInfo | null> {
    const state = this.tools.get(handle);
    if (!state || !state.live) return null;
    const completedAtMs = normalizeTimestamp(completion.completedAtMs, this.now());
    const summary = summarizeResult(completion.result);
    try {
      if (completion.success) {
        await this.registry.complete({
          identity: state.identity,
          claimToken: state.claimToken,
          result: summary.durable,
        });
      } else {
        await this.registry.fail({
          identity: state.identity,
          claimToken: state.claimToken,
          error: completion.error?.trim() || "Background tool invocation failed",
        });
      }
      state.completedAtMs = completedAtMs;
      state.status = completion.success ? "completed" : "failed";
      state.result = completion.result;
      state.error = completion.error;
      state.outputPreview = summary.preview;
      state.resultTruncated = summary.truncated;
      state.cancel = undefined;
      state.cancellationScope = "none";
      state.process = undefined;
      state.live = false;
      return this.toInfo(state);
    } catch (error) {
      this.markDurabilityFailure(state);
      throw error;
    }
  }

  listRunningTools(sessionId?: string): RunningToolCallInfo[] {
    this.refreshFromRegistry();
    return [...this.tools.values()]
      .filter(
        (tool) =>
          (tool.status === "running" || tool.status === "cancelling") &&
          (!sessionId || tool.sessionId === sessionId),
      )
      .map((tool) => this.toInfo(tool))
      .sort((left, right) => right.elapsedMs - left.elapsedMs);
  }

  inspectRunningTool(handle: string): RunningToolInspectResult {
    this.refreshFromRegistry();
    const state = this.tools.get(handle);
    if (!state) return { success: false, handle, error: "Tool handle not found" };
    return {
      success: true,
      handle,
      tool: {
        ...this.toInfo(state),
        ...(state.result !== undefined ? { result: state.result } : {}),
      },
    };
  }

  async requestBackgroundToolCancellation(
    request: BackgroundToolCancellationRequest,
  ): Promise<RunningToolCancelResult> {
    this.refreshFromRegistry();
    const state = this.tools.get(request.handle);
    if (!state) {
      return {
        success: false,
        handle: request.handle,
        error: "Tool handle not found or already completed",
      };
    }
    if (
      !sameCancellationToken(state.cancellationToken, request.token) ||
      request.token.ownerSessionId !== state.sessionId ||
      request.token.claimId !== state.claimToken ||
      !Number.isFinite(request.requestedAtMs) ||
      request.requestedAtMs < request.token.issuedAtMs
    ) {
      return {
        success: false,
        handle: request.handle,
        sessionId: state.sessionId,
        toolCallId: state.toolCallId,
        status: state.status,
        cancellationScope: state.cancellationScope,
        error: "Cancellation request token is invalid or stale",
      };
    }
    if (!state.live || state.status !== "running") {
      return {
        success: false,
        handle: request.handle,
        sessionId: state.sessionId,
        toolCallId: state.toolCallId,
        status: state.status,
        cancellationScope: state.cancellationScope,
        error: "Tool is not a live cancellable invocation",
      };
    }
    try {
      const operation = await this.registry.cancel({
        identity: state.identity,
        cancellationRequestId: request.token.tokenId,
        scope: toExternalCancellationScope(state.cancellationScope),
        requestedBy: "running-tool-compatibility",
      });
      if (!operation.cancellation?.accepted) {
        state.status = compatibilityStatus(operation);
        state.error = operation.cancellation?.lastError;
        return {
          success: false,
          handle: request.handle,
          sessionId: state.sessionId,
          toolCallId: state.toolCallId,
          status: state.status,
          cancellationScope: state.cancellationScope,
          error: operation.cancellation?.lastError ?? "Tool cancellation was not accepted",
        };
      }
      state.status = "cancelled";
      state.completedAtMs = this.now();
      state.cancel = undefined;
      state.process = undefined;
      state.live = false;
      return {
        success: true,
        handle: request.handle,
        sessionId: state.sessionId,
        toolCallId: state.toolCallId,
        status: "cancelled",
        cancellationScope: state.cancellationScope,
      };
    } catch (error) {
      this.markDurabilityFailure(state);
      throw error;
    }
  }

  async cancelRunningTool(handle: string): Promise<RunningToolCancelResult> {
    this.refreshFromRegistry();
    const state = this.tools.get(handle);
    if (!state) {
      return { success: false, handle, error: "Tool handle not found or already completed" };
    }
    return await this.requestBackgroundToolCancellation({
      token: state.cancellationToken,
      handle,
      requestedAtMs: this.now(),
    });
  }

  async checkpoint(): Promise<void> {
    try {
      await this.registry.checkpoint();
    } catch (error) {
      for (const state of this.tools.values()) this.markDurabilityFailure(state);
      throw error;
    }
  }

  private restorePendingClaim(
    claim: BackgroundToolDispatchClaim,
    toolName: string,
  ): PendingDispatchClaim | undefined {
    const operation = this.registry
      .list({ providerKind: "host-tool", includeTerminal: false })
      .find(
        (candidate) =>
          candidate.dispatchClaim?.claimToken === claim.claimId &&
          candidate.identity.sessionId === claim.ownerSessionId &&
          candidate.identity.toolCallId === claim.toolCallId &&
          candidate.identity.toolName === toolName,
      );
    if (!operation || operation.receipt) return undefined;
    const dispatchClaim = operation.dispatchClaim;
    if (!dispatchClaim) return undefined;
    const restoredClaim: BackgroundToolDispatchClaim = {
      claimId: claim.claimId,
      ownerSessionId: claim.ownerSessionId,
      toolCallId: claim.toolCallId,
      claimedAtMs: Date.parse(dispatchClaim.claimedAt),
      cancellationToken: {
        tokenId: `${claim.claimId}:cancel`,
        ownerSessionId: claim.ownerSessionId,
        claimId: claim.claimId,
        issuedAtMs: Date.parse(dispatchClaim.claimedAt),
      },
    };
    if (!sameCancellationToken(restoredClaim.cancellationToken, claim.cancellationToken)) {
      return undefined;
    }
    return {
      identity: identityFromStored(operation),
      claimToken: claim.claimId,
      claim: restoredClaim,
      toolName,
    };
  }

  private resolveHandle(operationId: string): ExternalOperationHandle | null {
    const state = [...this.tools.values()].find(
      (candidate) => candidate.identity.operationId === operationId && candidate.live,
    );
    if (!state) return null;
    return {
      inspect: async () => ({ state: "running" }),
      cancel: async (scope, cancellationRequestId) => {
        if (!cancellationRequestId) {
          return { accepted: false, scope, error: "Cancellation request token is required" };
        }
        if (state.cancel) {
          await state.cancel();
        } else if (state.cancellationScope === "turn" && this.cancelTurn) {
          await this.cancelTurn(state.sessionId);
        } else {
          return { accepted: false, scope, error: "Tool has no attached cancellation handle" };
        }
        return {
          accepted: true,
          scope,
          observation: { state: "cancelled" },
        };
      },
    };
  }

  private refreshFromRegistry(): void {
    for (const operation of this.registry.list({ providerKind: "host-tool" })) {
      if (operation.provider.adapterId !== this.adapterId) continue;
      if (operation.state === "registered" && !operation.receipt) continue;
      const handle =
        readString(operation.receipt?.handle) ?? readString(operation.metadata.values?.handle);
      const sessionId = operation.identity.sessionId;
      const toolCallId = operation.identity.toolCallId;
      const toolName = operation.identity.toolName;
      if (!handle || !sessionId || !toolCallId || !toolName) continue;
      const existing = this.tools.get(handle);
      if (existing?.identity.operationId === operation.operationId) {
        this.applyDurableRecord(existing, operation);
        continue;
      }
      const status = compatibilityStatus(operation);
      const claimToken =
        readString(operation.receipt?.claimId) ??
        operation.dispatchClaim?.claimToken ??
        `retired:${operation.operationId}`;
      const cancellationToken: BackgroundToolCancellationRequestToken = {
        tokenId: readString(operation.receipt?.cancellationId) ?? `${claimToken}:cancel`,
        ownerSessionId: sessionId,
        claimId: claimToken,
        issuedAtMs:
          readNumber(operation.receipt?.cancellationIssuedAtMs) ?? Date.parse(operation.createdAt),
      };
      const restored: CompatibilityToolState = {
        identity: identityFromStored(operation),
        claimToken,
        cancellationToken,
        handle,
        sessionId,
        toolCallId,
        toolName,
        serverName: readString(operation.metadata.values?.serverName),
        startedAtMs: Date.parse(operation.publicRecord.startedAt ?? operation.createdAt),
        status,
        backgrounded: readBoolean(operation.receipt?.backgrounded) ?? true,
        completedAtMs: operation.publicRecord.completedAt
          ? Date.parse(operation.publicRecord.completedAt)
          : undefined,
        result: operation.terminalEvent?.result,
        outputPreview: resultPreview(operation),
        resultTruncated: false,
        error: operation.terminalEvent?.error ?? operation.lastError,
        cancellationScope:
          readCancellationScope(operation.receipt?.cancellationScope) ??
          compatibilityCancellationScope(operation.cancellationScope),
        process: restoredProcess(operation),
        live: false,
      };
      this.tools.set(handle, restored);
    }
  }

  private applyDurableRecord(
    state: CompatibilityToolState,
    operation: StoredExternalOperationRecord,
  ): void {
    if (state.durabilityFailed) return;
    state.status = compatibilityStatus(operation);
    state.backgrounded = readBoolean(operation.receipt?.backgrounded) ?? state.backgrounded;
    state.completedAtMs = operation.publicRecord.completedAt
      ? Date.parse(operation.publicRecord.completedAt)
      : state.completedAtMs;
    state.error = operation.terminalEvent?.error ?? operation.lastError ?? state.error;
    // The registry keeps only a compacted terminal result ({ type: "text", length }). A process
    // that completed the call still holds the full result and its preview: refreshing from the
    // registry must not replace them (inspectRunningTool refreshes on every call).
    if (state.result === undefined) {
      state.outputPreview = resultPreview(operation) ?? state.outputPreview;
      state.result = operation.terminalEvent?.result;
    }
    if (operation.state === "unknown" || operation.state === "cancelling") state.live = false;
  }

  private markDurabilityFailure(state: CompatibilityToolState): void {
    state.durabilityFailed = true;
    state.status = "failed";
    state.completedAtMs = this.now();
    state.error = "Durable external-operation persistence failed";
    state.live = false;
    log
      .with({ operationId: state.identity.operationId })
      .error("Durable background-tool persistence failed");
  }

  private toInfo(state: CompatibilityToolState): RunningToolCallInfo {
    const elapsedMs = Math.max(0, this.now() - state.startedAtMs);
    return {
      handle: state.handle,
      sessionId: state.sessionId,
      toolCallId: state.toolCallId,
      toolName: state.toolName,
      ...(state.serverName ? { serverName: state.serverName } : {}),
      startedAt: new Date(state.startedAtMs).toISOString(),
      elapsedMs,
      status: state.status,
      backgrounded: state.backgrounded,
      resultAvailable:
        state.result !== undefined ||
        state.error !== undefined ||
        state.outputPreview !== undefined,
      ...(state.completedAtMs ? { completedAt: new Date(state.completedAtMs).toISOString() } : {}),
      ...(state.outputPreview ? { outputPreview: state.outputPreview } : {}),
      ...(state.resultTruncated !== undefined ? { resultTruncated: state.resultTruncated } : {}),
      ...(state.error ? { error: state.error } : {}),
      longRunning: elapsedMs >= LONG_RUNNING_TOOL_THRESHOLD_MS,
      cancellable:
        state.live &&
        state.status === "running" &&
        Boolean(state.cancel || (state.cancellationScope === "turn" && this.cancelTurn)),
      cancellationScope: state.cancellationScope,
      ...(state.process ? { process: state.process } : {}),
    };
  }
}

function buildHandle(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`;
}

function buildOperationId(handle: string, idempotencyKey: string): string {
  return `background-tool:${handle}:${idempotencyKey}`;
}

function identityFromRequest(request: ExternalOperationRequest): ExternalOperationIdentity {
  return {
    operationId: request.operationId,
    fence: request.fence,
    idempotencyKey: request.idempotencyKey,
    assignmentId: request.assignmentId,
  };
}

function identityFromStored(operation: StoredExternalOperationRecord): ExternalOperationIdentity {
  return {
    operationId: operation.operationId,
    fence: operation.goalFence,
    idempotencyKey: operation.idempotencyKey,
    assignmentId: operation.publicRecord.assignmentId,
  };
}

function normalizeTimestamp(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function validateDispatchClaimRequest(request: BackgroundToolDispatchClaimRequest): void {
  if (!request.ownerSessionId.trim()) throw new Error("ownerSessionId is required");
  if (!request.toolCallId.trim()) throw new Error("toolCallId is required");
  if (!request.toolName.trim()) throw new Error("toolName is required");
  if (!request.idempotencyKey.trim()) throw new Error("idempotencyKey is required");
  if (!Number.isFinite(request.requestedAtMs) || request.requestedAtMs < 0) {
    throw new Error("requestedAtMs must be non-negative");
  }
}

function sameCancellationToken(
  left: BackgroundToolCancellationRequestToken,
  right: BackgroundToolCancellationRequestToken,
): boolean {
  return (
    left.tokenId === right.tokenId &&
    left.ownerSessionId === right.ownerSessionId &&
    left.claimId === right.claimId &&
    left.issuedAtMs === right.issuedAtMs
  );
}

function dispatchConflict(
  error: unknown,
  handle: string,
): BackgroundToolDispatchClaimResult | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("already claimed")) {
    return { kind: "conflict", reason: "already-claimed", existingHandle: handle };
  }
  if (message.includes("idempotency conflict") || message.includes("identity collision")) {
    return { kind: "conflict", reason: "owner-mismatch", existingHandle: handle };
  }
  if (message.includes("not claimable") || message.includes("already terminal")) {
    return { kind: "conflict", reason: "already-completed", existingHandle: handle };
  }
  return null;
}

function validateProcessAttachment(process: BackgroundToolProcessAttachment): void {
  if (!Number.isSafeInteger(process.rootPid) || process.rootPid <= 0) {
    throw new Error("Background tool rootPid must be a positive integer");
  }
  const owner = exactProcessOwner(process);
  if (owner.trim().length === 0) {
    throw new Error("Background tool exact process owner must be non-empty");
  }
  const spawnedAtMs = exactSpawnedAt(process);
  if (!Number.isFinite(spawnedAtMs) || spawnedAtMs < 0) {
    throw new Error("Background tool spawnedAtMs must be non-negative");
  }
}

function exactProcessOwner(process: BackgroundToolProcessAttachment): string {
  return process.ownerSessionId;
}

function exactSpawnedAt(process: BackgroundToolProcessAttachment): number {
  return process.spawnedAtMs;
}

function toExternalCancellationScope(
  scope: RunningToolCancellationScope,
): ExternalOperationCancellationScope {
  const value = scope;
  if (
    value === "none" ||
    value === "tool" ||
    value === "turn" ||
    value === "process-group" ||
    value === "process-tree"
  ) {
    return value;
  }
  throw new Error("Unsupported cancellation scope");
}

function compatibilityCancellationScope(
  scope: ExternalOperationCancellationScope,
): RunningToolCancellationScope {
  if (scope === "process-tree") return "process-tree";
  if (scope === "process-group") return "process-group";
  if (scope === "tool") return "tool";
  if (scope === "turn") return "turn";
  return "none";
}

function compatibilityStatus(
  operation: StoredExternalOperationRecord,
): RunningToolCallInfo["status"] {
  if (operation.state === "unknown") return "unknown";
  if (operation.state === "cancelling") return "cancelling";
  if (operation.state === "succeeded") return "completed";
  if (operation.state === "failed") return "failed";
  if (operation.state === "cancelled") return "cancelled";
  if (operation.state === "surrendered" || operation.state === "superseded") return "failed";
  return "running";
}

function restoredProcess(
  operation: StoredExternalOperationRecord,
): RunningToolProcessInfo | undefined {
  if (isTerminalCompatibilityState(operation.state) || !operation.exactProcess) return undefined;
  return {
    ownerSessionId: operation.exactProcess.ownerSessionId,
    rootPid: operation.exactProcess.rootPid,
    spawnedAtMs: operation.exactProcess.spawnedAtMs,
    identitySource: "spawned-child",
    cancellationScope: compatibilityProcessScope(operation),
  };
}

function isTerminalCompatibilityState(state: StoredExternalOperationRecord["state"]): boolean {
  return (
    state === "succeeded" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "surrendered" ||
    state === "superseded"
  );
}

function compatibilityProcessScope(
  operation: StoredExternalOperationRecord,
): RunningToolProcessInfo["cancellationScope"] {
  const persisted = readCancellationScope(operation.receipt?.cancellationScope);
  if (persisted === "process-tree" || persisted === "process-group") {
    return persisted;
  }
  return "process-group";
}

function summarizeResult(result: unknown): {
  preview?: string;
  truncated: boolean;
  durable?: ExternalOperationJson;
} {
  if (result === undefined) return { truncated: false };
  if (result === null || typeof result === "boolean" || typeof result === "number") {
    return { preview: String(result), truncated: false, durable: result };
  }
  if (typeof result === "string") {
    return {
      preview: result.slice(0, MAX_OUTPUT_PREVIEW),
      truncated: result.length > MAX_OUTPUT_PREVIEW,
      durable: result.slice(0, MAX_OUTPUT_PREVIEW),
    };
  }
  const serialized = serializeForPreview(result);
  return {
    preview: serialized === undefined ? "[result available]" : serialized.slice(0, MAX_OUTPUT_PREVIEW),
    truncated: serialized !== undefined && serialized.length > MAX_OUTPUT_PREVIEW,
    durable: { available: true },
  };
}

function serializeForPreview(result: unknown): string | undefined {
  try {
    return JSON.stringify(result);
  } catch {
    return undefined;
  }
}

function resultPreview(operation: StoredExternalOperationRecord): string | undefined {
  const result = operation.terminalEvent?.result;
  if (typeof result === "string") return result.slice(0, MAX_OUTPUT_PREVIEW);
  if (typeof result === "number" || typeof result === "boolean" || result === null) {
    return String(result);
  }
  return result === undefined ? undefined : "[result available]";
}

function readString(value: ExternalOperationJson | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readBoolean(value: ExternalOperationJson | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: ExternalOperationJson | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readCancellationScope(
  value: ExternalOperationJson | undefined,
): RunningToolCancellationScope | undefined {
  if (typeof value !== "string") return undefined;
  if (
    value === "none" ||
    value === "tool" ||
    value === "turn" ||
    value === "process-tree" ||
    value === "process-group"
  ) {
    return value;
  }
  return undefined;
}
