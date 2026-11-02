import type {
  AgentMessageDeliveryMode,
  AgentMessageKind,
} from "../agent-message-outbox";
import type {
  GoalFence,
  GoalRuntimeSnapshot,
} from "../../common/goal-contract";
import type { GoalOperationRecord } from "../../common/goal-infrastructure-contract";
import type {
  ExternalOperationIdentity,
  ExternalOperationRecord,
  ExternalOperationRecordUpdate,
  ExternalOperationRequest,
  ExternalOperationSnapshot,
} from "../../common/external-operation-contract";

export type {
  GoalFence,
  GoalRuntimeSnapshot,
} from "../../common/goal-contract";
export type { GoalOperationRecord } from "../../common/goal-infrastructure-contract";
export type {
  ExternalOperationEffect,
  ExternalOperationIdentity,
  ExternalOperationRecord,
  ExternalOperationRecordUpdate,
  ExternalOperationRequest,
  ExternalOperationSnapshot,
  ExternalOperationStatus,
} from "../../common/external-operation-contract";

export type ExternalOperationJson =
  | null
  | boolean
  | number
  | string
  | ExternalOperationJson[]
  | { [key: string]: ExternalOperationJson };

export interface ExternalOperationMetadata {
  sessionId?: string;
  launcherSessionId?: string;
  runId?: string;
  provider?: Record<string, ExternalOperationJson>;
  capturedAt?: string;
  values?: Record<string, ExternalOperationJson>;
}

export interface ExternalOperationContractEnvelope {
  request?: ExternalOperationRequest;
  record?: ExternalOperationRecord;
  lastUpdate?: ExternalOperationRecordUpdate;
  snapshot?: ExternalOperationSnapshot;
  goalOperation?: GoalOperationRecord;
  goalRuntime?: GoalRuntimeSnapshot;
}

export type ExternalOperationProviderKind =
  | "host-tool"
  | "sdk-turn"
  | "child-process"
  | "subagent"
  | "workflow"
  | "provider";

export interface ExternalOperationProviderIdentity {
  kind: ExternalOperationProviderKind;
  provider: string;
  adapterId: string;
}

export interface StoredExternalOperationRuntimeIdentity {
  toolName?: string;
  toolCallId?: string;
  /** Provider metadata only; process ownership uses `exactProcess`. */
  processId?: number;
  processGroupId?: string;
  sessionId?: string;
  subagentSessionId?: string;
  workflowRunId?: string;
  providerOperationId?: string;
}

/**
 * Authoritative process attachment supplied by the launcher/provider.
 * `ownerSessionId` is explicit and never inferred from launcher metadata or a
 * workspace path. `spawnedAtMs` fences PID reuse for process lifecycle operations.
 */
export interface ExternalOperationExactProcessIdentity {
  ownerSessionId: string;
  rootPid: number;
  spawnedAtMs: number;
  startIdentity?: string;
  processGroupId?: string;
}

export type ExternalOperationCancellationScope =
  | "none"
  | "operation"
  | "tool"
  | "turn"
  | "process"
  | "process-group"
  | "tree"
  | "process-tree"
  | "subagent"
  | "workflow"
  | "provider";

export type ExternalOperationState =
  | "registered"
  | "running"
  | "reconciled"
  | "unknown"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "surrendered"
  | "superseded";

export type ExternalOperationTerminalState = Extract<
  ExternalOperationState,
  "succeeded" | "failed" | "cancelled" | "surrendered" | "superseded"
>;

export type ExternalOperationActionSemantics = "idempotent" | "non-idempotent";

export interface ExternalOperationWatcher {
  strategy: "poll" | "push" | "host";
  intervalMs: number;
  leaseDurationMs: number;
  lastCheckedAt?: string;
  nextCheckAt?: string;
}

export interface ExternalOperationWatcherLease {
  leaseId: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface ExternalOperationRetention {
  retentionMs?: number;
  retainUntil?: string;
}

export interface ExternalOperationTerminalNotification {
  target: string;
  content: string;
  kind?: AgentMessageKind;
  deliveryMode?: AgentMessageDeliveryMode;
  priority?: number;
  idempotencyKey?: string;
}

export interface ExternalOperationNotificationState {
  state: "not-required" | "pending" | "accepted";
  idempotencyKey?: string;
  messageId?: string;
  acceptedAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
}

export interface ExternalOperationCancellation {
  requestId: string;
  requestedAt: string;
  requestedBy?: string;
  scope: ExternalOperationCancellationScope;
  reason?: string;
  state: "requested" | "accepted" | "rejected";
  deliveryAttempts: number;
  retryAt?: string;
  accepted?: boolean;
  acknowledgedAt?: string;
  lastError?: string;
}

export interface ExternalOperationDispatchClaim {
  claimToken: string;
  claimedBy: string;
  claimedAt: string;
  leaseExpiresAt: string;
}

export interface ExternalOperationTerminalEvent {
  eventId: string;
  idempotencyKey: string;
  state: ExternalOperationTerminalState;
  occurredAt: string;
  result?: ExternalOperationJson;
  error?: string;
}

/**
 * Implementation-only durable state keyed by the canonical operationId.
 * Shared public request/record/update/snapshot shapes remain in
 * common/external-operation-contract.ts and are converted only at the port
 * adapter boundary.
 */
export interface StoredExternalOperationRecord {
  publicRecord: ExternalOperationRecord;
  operationId: string;
  idempotencyKey: string;
  goalFence: GoalFence;
  metadata: ExternalOperationMetadata;
  contract: ExternalOperationContractEnvelope;
  provider: ExternalOperationProviderIdentity;
  identity: StoredExternalOperationRuntimeIdentity;
  exactProcess?: ExternalOperationExactProcessIdentity;
  cancellationScope: ExternalOperationCancellationScope;
  actionSemantics: ExternalOperationActionSemantics;
  detached: boolean;
  state: ExternalOperationState;
  receipt?: Record<string, ExternalOperationJson>;
  watcher: ExternalOperationWatcher;
  watcherLease?: ExternalOperationWatcherLease;
  dispatchClaim?: ExternalOperationDispatchClaim;
  retention: ExternalOperationRetention;
  terminalNotification?: ExternalOperationTerminalNotification;
  notification: ExternalOperationNotificationState;
  cancellation?: ExternalOperationCancellation;
  terminalEvent?: ExternalOperationTerminalEvent;
  lastHeartbeatAt?: string;
  lastObservedAt?: string;
  lastError?: string;
  adoptedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterExternalOperationInput {
  request: ExternalOperationRequest;
  metadata?: ExternalOperationMetadata;
  provider: ExternalOperationProviderIdentity;
  runtimeIdentity?: StoredExternalOperationRuntimeIdentity;
  cancellationScope: ExternalOperationCancellationScope;
  actionSemantics: ExternalOperationActionSemantics;
  detached?: boolean;
  watcher?: Partial<ExternalOperationWatcher>;
  retention?: ExternalOperationRetention;
  terminalNotification?: ExternalOperationTerminalNotification;
}

export interface RegisterExternalOperationResult {
  disposition: "created" | "existing";
  operation: StoredExternalOperationRecord;
}

export interface AttachExternalOperationInput {
  identity: ExternalOperationIdentity;
  claimToken: string;
  adapterId?: string;
  receipt: Record<string, ExternalOperationJson>;
  runtimeIdentity?: StoredExternalOperationRuntimeIdentity;
  exactProcess?: ExternalOperationExactProcessIdentity;
  cancellationScope?: ExternalOperationCancellationScope;
  watcher?: Partial<ExternalOperationWatcher>;
  ownerId?: string;
}

export interface HeartbeatExternalOperationInput {
  identity: ExternalOperationIdentity;
  ownerId?: string;
  leaseId?: string;
  leaseDurationMs?: number;
  receipt?: Record<string, ExternalOperationJson>;
}

export interface AdoptExternalOperationInput {
  identity: ExternalOperationIdentity;
  ownerId: string;
  adapterId?: string;
  receipt?: Record<string, ExternalOperationJson>;
  leaseDurationMs?: number;
}

export interface CancelExternalOperationInput {
  identity: ExternalOperationIdentity;
  cancellationRequestId?: string;
  scope?: ExternalOperationCancellationScope;
  requestedBy?: string;
  reason?: string;
}

export interface CompleteExternalOperationInput {
  identity: ExternalOperationIdentity;
  claimToken?: string;
  result?: ExternalOperationJson;
  preDispatch?: boolean;
}

export interface FailExternalOperationInput {
  identity: ExternalOperationIdentity;
  claimToken?: string;
  error: string;
  preDispatch?: boolean;
}

export interface ExternalOperationDispatchClaimResult {
  disposition: "claimed" | "existing";
  claim: ExternalOperationDispatchClaim;
  operation: StoredExternalOperationRecord;
}

export interface ClaimExternalOperationDispatchInput {
  identity: ExternalOperationIdentity;
  claimedBy: string;
  leaseDurationMs?: number;
}

export interface ExternalOperationListFilter {
  goalId?: string;
  relatedSessionId?: string;
  providerKind?: ExternalOperationProviderKind;
  states?: ExternalOperationState[];
  includeTerminal?: boolean;
}

export interface ExternalOperationProcessQuery {
  ownerSessionId?: string;
  goalId?: string;
  states?: ExternalOperationState[];
  includeTerminal?: boolean;
}

export interface ExternalOperationExactProcessAttachment {
  operationId: string;
  idempotencyKey: string;
  goalFence: GoalFence;
  provider: ExternalOperationProviderIdentity;
  process: ExternalOperationExactProcessIdentity;
  state: ExternalOperationState;
  terminalState?: ExternalOperationTerminalState;
  updatedAt: string;
}

export interface ExternalOperationWaitResult {
  operation: StoredExternalOperationRecord;
  timedOut: boolean;
  followThroughComplete: boolean;
}

export type ExternalOperationObservation =
  | {
      state: "running";
      heartbeatAt?: string;
      receipt?: Record<string, ExternalOperationJson>;
      exactProcess?: ExternalOperationExactProcessIdentity;
    }
  | {
      state: "unknown";
      reason: string;
      receipt?: Record<string, ExternalOperationJson>;
      exactProcess?: ExternalOperationExactProcessIdentity;
    }
  | {
      state: ExternalOperationTerminalState;
      result?: ExternalOperationJson;
      error?: string;
      receipt?: Record<string, ExternalOperationJson>;
      exactProcess?: ExternalOperationExactProcessIdentity;
    };

export interface ExternalOperationAdapterContext {
  operation: Readonly<StoredExternalOperationRecord>;
  receipt: Readonly<Record<string, ExternalOperationJson>>;
}

export interface ExternalOperationCancelResult {
  accepted: boolean;
  scope: ExternalOperationCancellationScope;
  error?: string;
  observation?: ExternalOperationObservation;
}

export interface ExternalOperationCancellationProviderResult {
  identity: ExternalOperationIdentity;
  cancellationRequestId: string;
  accepted: boolean;
  error?: string;
  observation?: ExternalOperationObservation;
}

export interface ExternalOperationAdapter {
  readonly adapterId: string;
  readonly providerKinds: ReadonlySet<ExternalOperationProviderKind>;
  inspect(context: ExternalOperationAdapterContext): Promise<ExternalOperationObservation>;
  cancel(
    context: ExternalOperationAdapterContext,
    scope: ExternalOperationCancellationScope,
    cancellationRequestId?: string,
  ): Promise<ExternalOperationCancelResult>;
  adopt?(
    context: ExternalOperationAdapterContext,
    ownerId: string,
  ): Promise<ExternalOperationObservation | void>;
  subscribe?(
    context: ExternalOperationAdapterContext,
    onObservation: (observation: ExternalOperationObservation) => void,
  ): () => void;
}

export interface ExternalOperationNotificationAcceptance {
  accepted: true;
  messageId: string;
  state: string;
}

export interface ExternalOperationNotificationOutbox {
  enqueue(input: {
    idempotencyKey: string;
    source: string;
    target: string;
    kind: AgentMessageKind;
    deliveryMode: AgentMessageDeliveryMode;
    priority: number;
    content: string;
  }): Promise<ExternalOperationNotificationAcceptance>;
}

export function isExternalOperationTerminalState(
  state: ExternalOperationState,
): state is ExternalOperationTerminalState {
  return (
    state === "succeeded" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "surrendered" ||
    state === "superseded"
  );
}

export function isExternalOperationFollowThroughComplete(
  operation: Pick<StoredExternalOperationRecord, "notification">,
): boolean {
  return (
    operation.notification.state === "not-required" ||
    operation.notification.state === "accepted"
  );
}
