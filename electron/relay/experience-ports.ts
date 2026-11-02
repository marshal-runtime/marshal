import type { RelayAddress } from "../../common/relay-contract";
import type {
  RelayAccountOperationRequest,
  RelayAccountScope,
  RelayAttachmentIngestionRequest,
  RelayAuthorizationErrorCode,
  RelayCatalogErrorCode,
  RelayCommunityProvisionRequest,
  RelayExperienceResult,
  RelayFixedAgentSpecification,
  RelayGroupActivityRecordRequest,
  RelayGroupActivitySnapshot,
  RelayGroupSessionBinding,
  RelayGroupSessionBindingRemoveRequest,
  RelayGroupSessionBindingUpsertRequest,
  RelayInboundAuthorizationDecision,
  RelayInboundAuthorizationRequest,
  RelayIngestedAttachment,
  RelayManagedCommunityTopology,
  RelayManagedGroupCreateRequest,
  RelayManagedGroupDescriptor,
  RelayManagedGroupRenameRequest,
  RelayManagedGroupRetireRequest,
  RelayMediaErrorCode,
  RelayPersistenceErrorCode,
  RelayProvisioningErrorCode,
  RelayPublicationCorrelationQuery,
  RelayPublicationCorrelationRecord,
  RelayPublicationEnqueueReceipt,
  RelayPublicationErrorCode,
  RelayPublicationIntent,
  RelaySessionCreateRequest,
  RelaySessionDescriptor,
  RelaySessionErrorCode,
  RelaySessionQuery,
  RelaySessionSteerReceipt,
  RelaySessionSteerRequest,
  RelaySetupErrorCode,
  RelaySetupSnapshot,
  RelayTimestamp,
  RelayVoiceTranscript,
  RelayVoiceTranscriptionRequest,
} from "../../common/relay-experience-contract";

export interface RelayClock {
  now(): RelayTimestamp;
}

export type RelaySetupStatusListener = (snapshot: RelaySetupSnapshot) => void | Promise<void>;

export interface RelaySetupStatusPort {
  getStatus(
    account: RelayAccountScope,
  ): Promise<RelayExperienceResult<RelaySetupSnapshot, RelaySetupErrorCode>>;
  subscribe(account: RelayAccountScope, listener: RelaySetupStatusListener): () => void;
}

export interface RelayPairingControlPort {
  beginPairing(
    request: RelayAccountOperationRequest,
  ): Promise<RelayExperienceResult<RelaySetupSnapshot, RelaySetupErrorCode>>;
  cancelPairing(
    request: RelayAccountOperationRequest,
  ): Promise<RelayExperienceResult<RelaySetupSnapshot, RelaySetupErrorCode>>;
}

export interface RelayConnectionControlPort {
  connect(
    request: RelayAccountOperationRequest,
  ): Promise<RelayExperienceResult<RelaySetupSnapshot, RelaySetupErrorCode>>;
  disconnect(
    request: RelayAccountOperationRequest,
  ): Promise<RelayExperienceResult<RelaySetupSnapshot, RelaySetupErrorCode>>;
}

export interface RelayCommunityProvisioningPort {
  provision(
    request: RelayCommunityProvisionRequest,
  ): Promise<RelayExperienceResult<RelayManagedCommunityTopology, RelayProvisioningErrorCode>>;
}

export interface RelayManagedGroupQueryPort {
  getTopology(
    account: RelayAccountScope,
  ): Promise<RelayExperienceResult<RelayManagedCommunityTopology, RelayProvisioningErrorCode>>;
  getGroup(
    address: RelayAddress,
  ): Promise<RelayExperienceResult<RelayManagedGroupDescriptor, RelayProvisioningErrorCode>>;
}

export interface RelayManagedGroupAdministrationPort {
  createGroup(
    request: RelayManagedGroupCreateRequest,
  ): Promise<RelayExperienceResult<RelayManagedGroupDescriptor, RelayProvisioningErrorCode>>;
  renameGroup(
    request: RelayManagedGroupRenameRequest,
  ): Promise<RelayExperienceResult<RelayManagedGroupDescriptor, RelayProvisioningErrorCode>>;
  retireGroup(
    request: RelayManagedGroupRetireRequest,
  ): Promise<RelayExperienceResult<RelayManagedGroupDescriptor, RelayProvisioningErrorCode>>;
}

export interface RelayGroupSessionBindingReader {
  getByGroup(
    group: RelayAddress,
  ): Promise<RelayExperienceResult<RelayGroupSessionBinding, RelayPersistenceErrorCode>>;
  listBySession(
    account: RelayAccountScope,
    sessionId: string,
  ): Promise<RelayExperienceResult<readonly RelayGroupSessionBinding[], RelayPersistenceErrorCode>>;
}

export interface RelayGroupSessionBindingWriter {
  upsert(
    request: RelayGroupSessionBindingUpsertRequest,
  ): Promise<RelayExperienceResult<RelayGroupSessionBinding, RelayPersistenceErrorCode>>;
  remove(
    request: RelayGroupSessionBindingRemoveRequest,
  ): Promise<RelayExperienceResult<RelayGroupSessionBinding, RelayPersistenceErrorCode>>;
}

export interface RelayGroupActivityPort {
  get(
    group: RelayAddress,
  ): Promise<RelayExperienceResult<RelayGroupActivitySnapshot, RelayPersistenceErrorCode>>;
  record(
    request: RelayGroupActivityRecordRequest,
  ): Promise<RelayExperienceResult<RelayGroupActivitySnapshot, RelayPersistenceErrorCode>>;
}

export interface RelayFixedAgentCatalogPort {
  list(): Promise<
    RelayExperienceResult<readonly RelayFixedAgentSpecification[], RelayCatalogErrorCode>
  >;
  get(
    agentId: string,
  ): Promise<RelayExperienceResult<RelayFixedAgentSpecification, RelayCatalogErrorCode>>;
}

export interface RelaySessionCreationPort {
  create(
    request: RelaySessionCreateRequest,
  ): Promise<RelayExperienceResult<RelaySessionDescriptor, RelaySessionErrorCode>>;
}

export interface RelaySessionQueryPort {
  query(
    request: RelaySessionQuery,
  ): Promise<RelayExperienceResult<readonly RelaySessionDescriptor[], RelaySessionErrorCode>>;
}

export interface RelaySessionSteeringPort {
  steer(
    request: RelaySessionSteerRequest,
  ): Promise<RelayExperienceResult<RelaySessionSteerReceipt, RelaySessionErrorCode>>;
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

export interface RelayInboundAuthorizationPort {
  authorize(
    request: RelayInboundAuthorizationRequest,
  ): Promise<RelayExperienceResult<RelayInboundAuthorizationDecision, RelayAuthorizationErrorCode>>;
}

export interface RelayAttachmentIngestionPort {
  ingest(
    request: RelayAttachmentIngestionRequest,
  ): Promise<RelayExperienceResult<RelayIngestedAttachment, RelayMediaErrorCode>>;
}

export interface RelayAttachmentCleanupPort {
  release(attachment: RelayIngestedAttachment): Promise<void>;
}

export interface RelayVoiceTranscriptionPort {
  transcribe(
    request: RelayVoiceTranscriptionRequest,
  ): Promise<RelayExperienceResult<RelayVoiceTranscript, RelayMediaErrorCode>>;
}
