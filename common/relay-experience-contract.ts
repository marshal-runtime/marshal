import type {
  RelayAccountId,
  RelayAddress,
  RelayAttachmentKind,
  RelayIdentity,
  RelayMessageId,
  RelayProviderId,
  RelayPublishRequest,
} from "./relay-contract";

export type RelayTimestamp = string;
export type RelayIdempotencyKey = string;

export interface RelayAccountScope {
  readonly providerId: RelayProviderId;
  readonly accountId: RelayAccountId;
}

export interface RelayIdempotentRequest {
  readonly idempotencyKey: RelayIdempotencyKey;
  readonly requestedAt: RelayTimestamp;
}

export type RelayAccountOperationRequest = RelayAccountScope & RelayIdempotentRequest;

export const RELAY_EXPERIENCE_ERROR_CODES = [
  "invalid-request",
  "not-found",
  "already-exists",
  "conflict",
  "unsupported",
  "unauthorized",
  "forbidden",
  "not-connected",
  "pairing-expired",
  "unavailable",
  "timeout",
  "rate-limited",
  "idempotency-conflict",
  "storage-failure",
  "provider-failure",
  "ingestion-failure",
  "transcription-failure",
] as const;

export type RelayExperienceErrorCode = (typeof RELAY_EXPERIENCE_ERROR_CODES)[number];

export type RelaySetupErrorCode = Extract<
  RelayExperienceErrorCode,
  | "invalid-request"
  | "conflict"
  | "unsupported"
  | "not-connected"
  | "pairing-expired"
  | "unavailable"
  | "timeout"
  | "idempotency-conflict"
  | "provider-failure"
>;

export type RelayProvisioningErrorCode = Extract<
  RelayExperienceErrorCode,
  | "invalid-request"
  | "not-found"
  | "already-exists"
  | "conflict"
  | "unsupported"
  | "not-connected"
  | "unavailable"
  | "idempotency-conflict"
  | "storage-failure"
  | "provider-failure"
>;

export type RelayPersistenceErrorCode = Extract<
  RelayExperienceErrorCode,
  "invalid-request" | "not-found" | "conflict" | "idempotency-conflict" | "storage-failure"
>;

export type RelayCatalogErrorCode = Extract<
  RelayExperienceErrorCode,
  "not-found" | "unavailable" | "storage-failure"
>;

export type RelaySessionErrorCode = Extract<
  RelayExperienceErrorCode,
  | "invalid-request"
  | "not-found"
  | "conflict"
  | "unavailable"
  | "timeout"
  | "idempotency-conflict"
  | "storage-failure"
>;

export type RelayPublicationErrorCode = Extract<
  RelayExperienceErrorCode,
  | "invalid-request"
  | "not-found"
  | "conflict"
  | "not-connected"
  | "unavailable"
  | "timeout"
  | "rate-limited"
  | "idempotency-conflict"
  | "storage-failure"
  | "provider-failure"
>;

export type RelayAuthorizationErrorCode = Extract<
  RelayExperienceErrorCode,
  "invalid-request" | "unavailable" | "storage-failure"
>;

export type RelayMediaErrorCode = Extract<
  RelayExperienceErrorCode,
  | "invalid-request"
  | "not-found"
  | "unsupported"
  | "unavailable"
  | "timeout"
  | "idempotency-conflict"
  | "storage-failure"
  | "provider-failure"
  | "ingestion-failure"
  | "transcription-failure"
>;

export interface RelayExperienceFailure<
  Code extends RelayExperienceErrorCode = RelayExperienceErrorCode,
> {
  readonly code: Code;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export type RelayExperienceResult<
  Value,
  Code extends RelayExperienceErrorCode = RelayExperienceErrorCode,
> =
  | {
      readonly ok: true;
      readonly value: Value;
    }
  | {
      readonly ok: false;
      readonly error: RelayExperienceFailure<Code>;
    };

export const RELAY_SETUP_STATES = [
  "idle",
  "pairing",
  "qr",
  "connected",
  "reconnecting",
  "disconnected",
  "error",
] as const;

export type RelaySetupState = (typeof RELAY_SETUP_STATES)[number];

export interface RelayPairingQrPayload {
  readonly payload: string;
  readonly expiresAt?: RelayTimestamp;
}

export interface RelaySetupSnapshot {
  readonly account: RelayAccountScope;
  readonly state: RelaySetupState;
  readonly updatedAt: RelayTimestamp;
  readonly pairingAttemptId?: string;
  readonly qr?: RelayPairingQrPayload;
  readonly failure?: RelayExperienceFailure<RelaySetupErrorCode>;
}

export const RELAY_MANAGED_GROUP_ROLES = [
  "new-chats",
  "progress",
  "information-control",
  "session",
] as const;

export type RelayManagedGroupRole = (typeof RELAY_MANAGED_GROUP_ROLES)[number];
export type RelayFixedAgentRole = Exclude<RelayManagedGroupRole, "session">;
export type RelayManagedConversationState = "active" | "retired";

export interface RelayCommunityDescriptor {
  readonly address: RelayAddress;
  readonly displayName: string;
  readonly state: RelayManagedConversationState;
  readonly createdAt: RelayTimestamp;
  readonly updatedAt: RelayTimestamp;
}

export interface RelayManagedGroupDescriptor {
  readonly address: RelayAddress;
  readonly communityAddress: RelayAddress;
  readonly role: RelayManagedGroupRole;
  readonly displayName: string;
  readonly state: RelayManagedConversationState;
  readonly createdAt: RelayTimestamp;
  readonly updatedAt: RelayTimestamp;
}

export interface RelayManagedCommunityTopology {
  readonly community: RelayCommunityDescriptor;
  readonly groups: readonly RelayManagedGroupDescriptor[];
  readonly revision: number;
}

export interface RelayManagedGroupPlan {
  readonly role: RelayManagedGroupRole;
  readonly displayName: string;
}

export interface RelayCommunityProvisionRequest extends RelayAccountScope, RelayIdempotentRequest {
  readonly displayName: string;
  readonly groups: readonly RelayManagedGroupPlan[];
}

export interface RelayManagedGroupCreateRequest extends RelayIdempotentRequest {
  readonly communityAddress: RelayAddress;
  readonly role: RelayManagedGroupRole;
  readonly displayName: string;
  readonly existingAddress?: RelayAddress;
}

export interface RelayManagedGroupRenameRequest extends RelayIdempotentRequest {
  readonly address: RelayAddress;
  readonly displayName: string;
}

export interface RelayManagedGroupRetireRequest extends RelayIdempotentRequest {
  readonly address: RelayAddress;
}

export interface RelayGroupSessionBinding {
  readonly bindingId: string;
  readonly group: RelayAddress;
  readonly role: RelayManagedGroupRole;
  readonly sessionId: string;
  readonly createdAt: RelayTimestamp;
  readonly updatedAt: RelayTimestamp;
}

export interface RelayGroupSessionBindingUpsertRequest extends RelayIdempotentRequest {
  readonly bindingId?: string;
  readonly group: RelayAddress;
  readonly role: RelayManagedGroupRole;
  readonly sessionId: string;
}

export interface RelayGroupSessionBindingRemoveRequest extends RelayIdempotentRequest {
  readonly bindingId: string;
  readonly group: RelayAddress;
}

export type RelayGroupActivityKind = "inbound" | "publication" | "session";

export interface RelayGroupActivitySnapshot {
  readonly group: RelayAddress;
  readonly bindingId?: string;
  readonly lastInboundAt?: RelayTimestamp;
  readonly lastPublicationAt?: RelayTimestamp;
  readonly lastSessionActivityAt?: RelayTimestamp;
  readonly updatedAt: RelayTimestamp;
}

export interface RelayGroupActivityRecordRequest extends RelayIdempotentRequest {
  readonly group: RelayAddress;
  readonly bindingId?: string;
  readonly kind: RelayGroupActivityKind;
  readonly occurredAt: RelayTimestamp;
  readonly correlationId?: string;
}

export const RELAY_SESSION_PRIORITIES = ["foreground", "control", "background"] as const;

export type RelaySessionPriority = (typeof RELAY_SESSION_PRIORITIES)[number];
export type RelaySessionDeliveryMode = "queue" | "interrupt";

export interface RelayAllowedToolDescriptor {
  readonly toolId: string;
  readonly reason?: string;
}

export interface RelayDefaultDenyToolPolicyDescriptor {
  readonly mode: "default-deny";
  readonly allowedTools: readonly RelayAllowedToolDescriptor[];
}

export interface RelayFixedAgentSpecification {
  readonly agentId: string;
  readonly specVersion: number;
  readonly role: RelayFixedAgentRole;
  readonly displayName: string;
  readonly description: string;
  readonly instructions: string;
  readonly sessionPriority: RelaySessionPriority;
  readonly toolPolicy: RelayDefaultDenyToolPolicyDescriptor;
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

export interface RelayAttachmentLocalSource {
  readonly kind: "local-file";
  readonly sourceId: string;
  readonly path: string;
}

export interface RelayAttachmentIngestionRequest extends RelayIdempotentRequest {
  readonly attachment: RelayAttachmentMetadata;
  readonly source: RelayAttachmentLocalSource;
}

export interface RelayIngestedAttachment {
  readonly metadata: RelayAttachmentMetadata;
  readonly localPath: string;
  readonly storageKey?: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly ingestedAt: RelayTimestamp;
}

export interface RelayVoiceTranscriptionRequest extends RelayIdempotentRequest {
  readonly attachment: RelayIngestedAttachment;
  readonly languageHint?: string;
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

export interface RelaySessionCreateRequest extends RelayIdempotentRequest {
  readonly group: RelayAddress;
  readonly kind: RelaySessionKind;
  readonly title: string;
  readonly priority: RelaySessionPriority;
  readonly fixedAgentId?: string;
}

export interface RelaySessionQuery {
  readonly account: RelayAccountScope;
  readonly sessionId?: string;
  readonly group?: RelayAddress;
  readonly kind?: RelaySessionKind;
  readonly statuses?: readonly RelaySessionStatus[];
}

export interface RelaySessionInput {
  readonly text?: string;
  readonly attachments: readonly RelayIngestedAttachment[];
  readonly transcripts: readonly RelayVoiceTranscript[];
}

export interface RelaySessionSteerRequest extends RelayIdempotentRequest {
  readonly source: RelayAddress;
  readonly providerMessageId: RelayMessageId;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly priority: RelaySessionPriority;
  readonly deliveryMode: RelaySessionDeliveryMode;
  readonly input: RelaySessionInput;
}

export interface RelaySessionSteerReceipt {
  readonly sessionId: string;
  readonly correlationId: string;
  readonly deliveryMode: RelaySessionDeliveryMode;
  readonly acceptedAt: RelayTimestamp;
  readonly queuePosition?: number;
}

export type RelayProgressState = "update" | "completed" | "failed";

export interface RelayProgressCorrelation {
  readonly progressId: string;
  readonly sequence: number;
  readonly state: RelayProgressState;
}

export interface RelayPublicationIntent extends RelayIdempotentRequest {
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

export interface RelayInboundAuthorizationRequest {
  readonly address: RelayAddress;
  readonly providerMessageId: RelayMessageId;
  readonly sender: RelayIdentity;
  readonly receivedAt: RelayTimestamp;
}

export type RelayInboundAllowReason = "trusted-sender" | "managed-group";
export type RelayInboundDenyReason =
  | "sender-not-authorized"
  | "conversation-not-managed"
  | "account-disabled";

interface RelayInboundAuthorizationDecisionBase {
  readonly address: RelayAddress;
  readonly providerMessageId: RelayMessageId;
  readonly senderPrimaryId: string;
  readonly policyId: string;
  readonly decidedAt: RelayTimestamp;
}

export type RelayInboundAuthorizationDecision =
  | (RelayInboundAuthorizationDecisionBase & {
      readonly decision: "allow";
      readonly reason: RelayInboundAllowReason;
    })
  | (RelayInboundAuthorizationDecisionBase & {
      readonly decision: "deny";
      readonly reason: RelayInboundDenyReason;
    });
