import type {
  RelayAddress,
  RelayAttachmentKind,
  RelayMessageId,
  RelayProviderId,
  RelayPublishRequest,
} from "../../../common/relay-contract";
import type {
  RelayAccountScope,
  RelayDefaultDenyToolPolicyDescriptor,
  RelayFixedAgentRole,
  RelayFixedAgentSpecification,
  RelayManagedGroupDescriptor,
  RelayManagedGroupRole,
  RelaySessionPriority,
} from "../../../common/relay-experience-contract";
import type {
  RelayEnsuredSessionAccessPoint,
  RelayEnsureSessionAccessPointRequest,
} from "../host-experience/types";
import type { RelayFixedAgentCatalogPort } from "../experience-ports";

export {
  RELAY_MANAGED_GROUP_ROLES,
  RELAY_SESSION_PRIORITIES,
} from "../../../common/relay-experience-contract";
export type {
  RelayAccountScope,
  RelayAllowedToolDescriptor,
  RelayDefaultDenyToolPolicyDescriptor,
  RelayFixedAgentRole,
  RelayFixedAgentSpecification,
  RelayManagedGroupDescriptor,
  RelayManagedGroupRole,
  RelaySessionPriority,
} from "../../../common/relay-experience-contract";
export type { RelayFixedAgentCatalogPort } from "../experience-ports";

export type RelayTimestamp = string;
export type RelayIdempotencyKey = string;

export interface RelayExperienceFailure<Code extends string> {
  readonly code: Code;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export type RelayExperienceResult<Value, Code extends string> =
  | {
      readonly ok: true;
      readonly value: Value;
    }
  | {
      readonly ok: false;
      readonly error: RelayExperienceFailure<Code>;
    };

export type RelayCatalogErrorCode = "not-found" | "unavailable" | "storage-failure";
export type RelaySessionErrorCode =
  | "invalid-request"
  | "not-found"
  | "conflict"
  | "unavailable"
  | "timeout"
  | "idempotency-conflict"
  | "storage-failure";
export type RelayPublicationErrorCode =
  | "invalid-request"
  | "not-found"
  | "conflict"
  | "not-connected"
  | "unavailable"
  | "timeout"
  | "rate-limited"
  | "idempotency-conflict"
  | "storage-failure"
  | "provider-failure";
export type RelayProvisioningErrorCode =
  | "invalid-request"
  | "not-found"
  | "already-exists"
  | "conflict"
  | "unsupported"
  | "not-connected"
  | "unavailable"
  | "idempotency-conflict"
  | "storage-failure"
  | "provider-failure";
export type RelayPersistenceErrorCode =
  | "invalid-request"
  | "not-found"
  | "conflict"
  | "idempotency-conflict"
  | "storage-failure";

export type RelaySessionDeliveryMode = "queue" | "interrupt";

export type RelaySessionKind = "fixed-agent" | "conversation";
export type RelaySessionStatus = "creating" | "ready" | "busy" | "paused" | "ended" | "error";

export interface RelaySessionDescriptor {
  readonly account: RelayAccountScope;
  readonly sessionId: string;
  readonly kind: RelaySessionKind;
  readonly status: RelaySessionStatus;
  readonly priority: RelaySessionPriority;
  readonly group?: RelayAddress;
  readonly fixedAgentId?: string;
  readonly createdAt: RelayTimestamp;
  readonly updatedAt: RelayTimestamp;
}

export interface RelayHostSessionDescriptor extends RelaySessionDescriptor {
  readonly title?: string;
  readonly agentId?: string;
  readonly persistence?: "persistent";
  readonly inspectable?: boolean;
  readonly retention?: "fixed" | "ordinary" | "dynamic";
  readonly creationDisposition?: "created" | "deduplicated";
}

export interface RelaySessionCreateRequest {
  readonly idempotencyKey: RelayIdempotencyKey;
  readonly requestedAt: RelayTimestamp;
  readonly group: RelayAddress;
  readonly kind: RelaySessionKind;
  readonly title: string;
  readonly priority: RelaySessionPriority;
  readonly fixedAgentId?: string;
}

export interface RelayHostSessionCreateRequest extends RelaySessionCreateRequest {
  readonly agentId?: string;
  readonly lifecycle?: RelayFixedAgentLifecycleDescriptor | RelayTaskSessionLifecycleDescriptor;
}

export interface RelaySessionQuery {
  readonly account: RelayAccountScope;
  readonly sessionId?: string;
  readonly group?: RelayAddress;
  readonly kind?: RelaySessionKind;
  readonly statuses?: readonly RelaySessionStatus[];
}

export interface RelayHostSessionQuery extends RelaySessionQuery {
  readonly text?: string;
  readonly limit?: number;
  readonly inspectableOnly?: true;
}

export interface RelayVoiceMetadata {
  readonly durationMs?: number;
  readonly languageHint?: string;
}

export interface RelayAttachmentMetadata {
  readonly address: RelayAddress;
  readonly providerMessageId: RelayMessageId;
  readonly attachmentId: string;
  readonly kind: RelayAttachmentKind;
  readonly mimeType: string;
  readonly fileName?: string;
  readonly sizeBytes?: number;
  readonly sha256?: string;
  readonly voice?: RelayVoiceMetadata;
}

export interface RelayIngestedAttachment {
  readonly metadata: RelayAttachmentMetadata;
  readonly localPath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly ingestedAt: RelayTimestamp;
}

export interface RelayVoiceTranscript {
  readonly address: RelayAddress;
  readonly providerMessageId: RelayMessageId;
  readonly attachmentId: string;
  readonly text: string;
  readonly language?: string;
  readonly durationMs?: number;
  readonly transcribedAt: RelayTimestamp;
}

export interface RelaySessionInput {
  readonly text?: string;
  readonly attachments?: readonly RelayIngestedAttachment[];
  readonly transcripts: readonly RelayVoiceTranscript[];
}

export interface RelaySessionSteerRequest {
  readonly idempotencyKey: RelayIdempotencyKey;
  readonly requestedAt: RelayTimestamp;
  readonly source: RelayAddress;
  readonly providerMessageId: RelayMessageId;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly priority: RelaySessionPriority;
  readonly deliveryMode: RelaySessionDeliveryMode;
  readonly input: RelaySessionInput;
}

export type RelayProgressReplyKind = "steering" | "clarification-answer";

export interface RelayHostSessionSteerRequest extends RelaySessionSteerRequest {
  readonly targetTurnId?: string;
  readonly relayReplyKind?: RelayProgressReplyKind;
}

export interface RelaySessionSteerReceipt {
  readonly sessionId: string;
  readonly correlationId: string;
  readonly deliveryMode: RelaySessionDeliveryMode;
  readonly acceptedAt: RelayTimestamp;
  readonly queuePosition?: number;
}

export interface RelaySessionCreationPort {
  create(
    request: RelayHostSessionCreateRequest,
  ): Promise<RelayExperienceResult<RelayHostSessionDescriptor, RelaySessionErrorCode>>;
}

export interface RelaySessionQueryPort {
  query(
    request: RelayHostSessionQuery,
  ): Promise<RelayExperienceResult<readonly RelayHostSessionDescriptor[], RelaySessionErrorCode>>;
}

export interface RelaySessionSteeringPort {
  steer(
    request: RelayHostSessionSteerRequest,
  ): Promise<RelayExperienceResult<RelaySessionSteerReceipt, RelaySessionErrorCode>>;
}

export type RelayProgressState = "update" | "completed" | "failed";

export interface RelayProgressCorrelation {
  readonly progressId: string;
  readonly sequence: number;
  readonly state: RelayProgressState;
}

export interface RelayPublicationIntent {
  readonly idempotencyKey: RelayIdempotencyKey;
  readonly requestedAt: RelayTimestamp;
  readonly intent: "deliberate";
  readonly correlationId: string;
  readonly request: RelayPublishRequest;
  readonly progress?: RelayProgressCorrelation;
}

export interface RelayPublicationEnqueueReceipt {
  readonly publicationId: string;
  readonly correlationId: string;
  readonly disposition: "queued" | "deduplicated";
  readonly acceptedAt: RelayTimestamp;
}

export interface RelayPublicationCorrelationRecord {
  readonly address: RelayAddress;
  readonly publicationId: string;
  readonly providerMessageId?: RelayMessageId;
  readonly correlationId: string;
  readonly sourceSessionId?: string;
  readonly sourceTurnId?: string;
  readonly progress?: RelayProgressCorrelation;
  readonly createdAt: RelayTimestamp;
  readonly publishedAt?: RelayTimestamp;
}

export interface RelayPublicationCorrelationQuery {
  readonly account: RelayAccountScope;
  readonly correlationId: string;
}

export interface RelayPublicationCommandPort {
  enqueue(
    intent: RelayPublicationIntent,
  ): Promise<RelayExperienceResult<RelayPublicationEnqueueReceipt, RelayPublicationErrorCode>>;
}

export interface RelayPublicationCorrelationReader {
  get(
    query: RelayPublicationCorrelationQuery,
  ): Promise<RelayExperienceResult<RelayPublicationCorrelationRecord, RelayPublicationErrorCode>>;
}

export interface RelayGroupSessionBinding {
  readonly bindingId: string;
  readonly group: RelayAddress;
  readonly role: RelayManagedGroupRole;
  readonly sessionId: string;
  readonly createdAt: RelayTimestamp;
  readonly updatedAt: RelayTimestamp;
}

export interface RelayManagedGroupEnsureRequest {
  readonly idempotencyKey: RelayIdempotencyKey;
  readonly requestedAt: RelayTimestamp;
  readonly account: RelayAccountScope;
  readonly communityAddress: RelayAddress;
  readonly groupKey: string;
  readonly role: RelayManagedGroupRole;
  readonly displayName: string;
  readonly reopen: boolean;
  readonly sourceAddress?: RelayAddress;
  readonly existingGroup?: RelayAddress;
}

export interface RelayManagedGroupEnsureReceipt {
  readonly group: RelayManagedGroupDescriptor;
  readonly disposition: "created" | "existing" | "reopened";
}

export interface RelayGroupSessionBindingUpsertRequest {
  readonly idempotencyKey: RelayIdempotencyKey;
  readonly requestedAt: RelayTimestamp;
  readonly bindingId?: string;
  readonly group: RelayAddress;
  readonly role: RelayManagedGroupRole;
  readonly sessionId: string;
}

export interface RelayFixedAgentManagedGroupPort {
  ensure(
    request: RelayManagedGroupEnsureRequest,
  ): Promise<RelayExperienceResult<RelayManagedGroupEnsureReceipt, RelayProvisioningErrorCode>>;
  bind(
    request: RelayGroupSessionBindingUpsertRequest,
  ): Promise<RelayExperienceResult<RelayGroupSessionBinding, RelayPersistenceErrorCode>>;
}

export interface RelayFixedAgentLifecycleDescriptor {
  readonly persistence: "persistent";
  readonly inspectable: true;
  readonly retention: "fixed";
  readonly dynamicCleanup: "exclude";
}

export interface RelayTaskSessionLifecycleDescriptor {
  readonly persistence: "persistent";
  readonly inspectable: true;
  readonly retention: "ordinary";
  readonly dynamicCleanup: "eligible-when-dynamic";
}

export interface RelayHostHistoryEntry {
  readonly idempotencyKey: string;
  readonly role: "system" | "user" | "assistant";
  readonly kind: "progress-publication";
  readonly content: string;
  readonly createdAt: string;
  readonly correlationId: string;
  readonly sourceSessionId: string;
  readonly sourceTurnId: string;
}

export interface RelayFixedAgentTurnOrigin {
  readonly address: RelayAddress;
  readonly providerMessageId: RelayMessageId;
}

export interface RelayFixedAgentTurn {
  readonly turnId: string;
  readonly correlationId: string;
  readonly text: string;
  readonly attachments: readonly RelayIngestedAttachment[];
  readonly receivedAt: string;
  readonly origin: RelayFixedAgentTurnOrigin;
  readonly replyToProgressCorrelationId?: string;
  readonly replyToProviderMessageId?: RelayMessageId;
}

export const RELAY_FIXED_AGENT_TOOL_NAMES = {
  newChatsClarify: "relay_new_chats_clarify",
  newChatsStartTask: "relay_new_chats_start_task",
  progressRouteReply: "relay_progress_route_reply",
  informationListRecent: "relay_information_list_recent_sessions",
  informationSearch: "relay_information_search_sessions",
  informationStatus: "relay_information_get_session_status",
  informationOpenGroup: "relay_information_open_session_group",
} as const;

export type RelayFixedAgentToolName =
  (typeof RELAY_FIXED_AGENT_TOOL_NAMES)[keyof typeof RELAY_FIXED_AGENT_TOOL_NAMES];

export interface RelayFixedAgentToolInvocation {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly turn: RelayFixedAgentTurn;
}

export interface RelayFixedAgentToolDefinition {
  readonly name: RelayFixedAgentToolName;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface RelayFixedAgentRemotePermissionRequest {
  readonly sessionId: string;
  readonly providerId: RelayProviderId;
  readonly toolName: string;
  readonly details?: unknown;
}

export interface RelayFixedAgentPermissionDecision {
  readonly decision: "reject";
  readonly reason: string;
}

export interface RelayFixedAgentToolRegistration {
  readonly definitions: readonly RelayFixedAgentToolDefinition[];
  readonly policy: RelayDefaultDenyToolPolicyDescriptor;
  readonly remotePermissionApproval: "forbidden";
  invoke(
    toolName: string,
    args: unknown,
    invocation: RelayFixedAgentToolInvocation,
  ): Promise<unknown>;
  resolveRemotePermission(
    request: RelayFixedAgentRemotePermissionRequest,
  ): RelayFixedAgentPermissionDecision;
}

export interface RelayFixedAgentToolResult {
  readonly toolName: string;
  readonly result: unknown;
}

export interface RelayFixedAgentTurnResult {
  readonly sessionId: string;
  readonly responseText?: string;
  readonly toolResults: readonly RelayFixedAgentToolResult[];
}

export interface RelayFixedAgentRuntimePort {
  appendHistory(sessionId: string, entry: RelayHostHistoryEntry): Promise<void>;
  registerTools(sessionId: string, registration: RelayFixedAgentToolRegistration): Promise<void>;
  submitNaturalLanguageTurn(
    sessionId: string,
    turn: RelayFixedAgentTurn,
  ): Promise<RelayFixedAgentTurnResult>;
}

export interface RelayClock {
  now(): RelayTimestamp;
}

export interface RelayFixedAgentToolPolicyMismatch {
  readonly mismatchId: "remote-permission-approval-not-represented";
  readonly affectedRoles: readonly RelayFixedAgentRole[];
  readonly canonicalDescriptor: "RelayDefaultDenyToolPolicyDescriptor";
  readonly hostRequirement: "remote-permission-approval-forbidden";
  readonly enforcement: "RelayFixedAgentToolRegistration.resolveRemotePermission";
}

export interface RelayFixedAgentHostOptions {
  readonly account: RelayAccountScope;
  readonly communityAddress: RelayAddress;
  readonly defaultTaskAgentId: string;
  readonly catalog: RelayFixedAgentCatalogPort;
  readonly sessionCreation: RelaySessionCreationPort;
  readonly sessionQuery: RelaySessionQueryPort;
  readonly sessionSteering: RelaySessionSteeringPort;
  readonly sessionRuntime: RelayFixedAgentRuntimePort;
  readonly managedGroups: RelayFixedAgentManagedGroupPort;
  readonly sessionAccessPoints?: {
    ensure(request: RelayEnsureSessionAccessPointRequest): Promise<RelayEnsuredSessionAccessPoint>;
  };
  readonly publicationCommands: RelayPublicationCommandPort;
  readonly publicationCorrelations: RelayPublicationCorrelationReader;
  readonly clock: RelayClock;
}

export interface InstalledRelayFixedAgent {
  readonly specification: RelayFixedAgentSpecification;
  readonly lifecycle: RelayFixedAgentLifecycleDescriptor;
  readonly session: RelayHostSessionDescriptor;
  readonly group: RelayManagedGroupDescriptor;
}

export interface PublishRelayProgressInput {
  readonly publicationId: string;
  readonly correlationId: string;
  readonly sourceSessionId: string;
  readonly sourceTurnId: string;
  readonly text: string;
  readonly publishedAt: string;
  readonly progress: RelayProgressCorrelation;
}

export interface PublishRelayProgressResult {
  readonly correlation: RelayPublicationCorrelationRecord;
  readonly receipt: RelayPublicationEnqueueReceipt;
}
