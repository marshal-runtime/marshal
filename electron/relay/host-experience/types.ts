import type { RelayAddress, RelayMessageId } from "../../../common/relay-contract";
import type {
  RelayAccountScope,
  RelayExperienceErrorCode,
  RelayExperienceResult,
  RelayFixedAgentRole,
  RelayFixedAgentSpecification,
  RelayGroupSessionBinding,
  RelayIdempotentRequest,
  RelayManagedGroupDescriptor,
  RelayPublicationEnqueueReceipt,
  RelayPublicationIntent,
  RelaySessionDeliveryMode,
  RelaySessionDescriptor,
  RelaySessionErrorCode,
  RelaySessionInput,
  RelaySessionPriority,
  RelaySessionQuery,
  RelaySessionSteerReceipt,
} from "../../../common/relay-experience-contract";
import type {
  RelayClock,
  RelayCommunityProvisioningPort,
  RelayFixedAgentCatalogPort,
  RelayGroupActivityPort,
  RelayGroupSessionBindingReader,
  RelayGroupSessionBindingWriter,
  RelayManagedGroupAdministrationPort,
  RelayManagedGroupQueryPort,
  RelayPublicationCommandPort,
  RelayPublicationCorrelationReader,
  RelaySessionCreationPort,
  RelaySessionQueryPort,
  RelaySessionSteeringPort,
} from "../experience-ports";

export const RELAY_FIXED_AGENT_ROLE_ORDER = [
  "new-chats",
  "progress",
  "information-control",
] as const satisfies readonly RelayFixedAgentRole[];

export const RELAY_REMOTE_PERMISSION_APPROVAL_TOOL_ID = "requestPermissionEscalation";

export type RelayHostExperienceLifecycleState = "stopped" | "starting" | "running" | "stopping";

export interface RelayHostExperienceConfig {
  readonly account: RelayAccountScope;
  readonly communityDisplayName: string;
  readonly mode?: "managed-experience" | "access-points-only";
}

export interface RelayHostFixedAgentActivationRequest {
  readonly session: RelaySessionDescriptor;
  readonly group: RelayManagedGroupDescriptor;
  readonly specification: RelayFixedAgentSpecification;
}

export type RelayHostFixedAgentSuspensionRequest = RelayHostFixedAgentActivationRequest;

export interface RelayHostSessionReopenRequest extends RelayIdempotentRequest {
  readonly session: RelaySessionDescriptor;
  readonly group: RelayManagedGroupDescriptor;
}

export interface RelayHostSessionRetireRequest extends RelayIdempotentRequest {
  readonly sessionId: string;
  readonly group: RelayManagedGroupDescriptor;
  readonly reason: "inactive-session-group";
}

/**
 * The later wiring layer implements this over ordinary Marshal sessions. It is
 * deliberately command-only: transcript events are not a relay publication source.
 */
export interface RelayHostSessionAdapter
  extends RelaySessionCreationPort, RelaySessionQueryPort, RelaySessionSteeringPort {
  activateFixedAgent(request: RelayHostFixedAgentActivationRequest): Promise<void>;
  suspendFixedAgent(request: RelayHostFixedAgentSuspensionRequest): Promise<void>;
  reopen(
    request: RelayHostSessionReopenRequest,
  ): Promise<RelayExperienceResult<RelaySessionDescriptor, RelaySessionErrorCode>>;
  retire(request: RelayHostSessionRetireRequest): Promise<void>;
}

export interface RelayHostFixedAgentToolPolicy {
  readonly mode: "default-deny";
  readonly allowedToolIds: readonly string[];
  readonly remotePermissionApproval: "deny";
}

export interface RelayHostFixedAgentToolPolicyInstallRequest {
  readonly sessionId: string;
  readonly agentId: string;
  readonly role: RelayFixedAgentRole;
  readonly specVersion: number;
  readonly policy: RelayHostFixedAgentToolPolicy;
}

export interface RelayHostFixedAgentToolPolicyRemoveRequest {
  readonly sessionId: string;
  readonly agentId: string;
  readonly role: RelayFixedAgentRole;
}

/** The adapter must filter the ordinary self-tool registry before a fixed session is activated. */
export interface RelayHostSelfToolAdapter {
  installFixedAgentPolicy(request: RelayHostFixedAgentToolPolicyInstallRequest): Promise<void>;
  removeFixedAgentPolicy(request: RelayHostFixedAgentToolPolicyRemoveRequest): Promise<void>;
}

export interface RelayHostExperiencePorts {
  readonly clock: RelayClock;
  readonly fixedAgents: RelayFixedAgentCatalogPort;
  readonly topology: RelayCommunityProvisioningPort &
    RelayManagedGroupQueryPort &
    RelayManagedGroupAdministrationPort;
  readonly bindings: RelayGroupSessionBindingReader & RelayGroupSessionBindingWriter;
  readonly activity: RelayGroupActivityPort;
  readonly sessions: RelayHostSessionAdapter;
  readonly selfTools: RelayHostSelfToolAdapter;
  readonly publication: RelayPublicationCommandPort;
  readonly correlations: RelayPublicationCorrelationReader;
}

export interface RelayHostFixedAgentRuntimeBinding {
  readonly specification: RelayFixedAgentSpecification;
  readonly group: RelayManagedGroupDescriptor;
  readonly binding: RelayGroupSessionBinding;
  readonly session: RelaySessionDescriptor;
}

export interface RelayHostExperienceSnapshot {
  readonly account: RelayAccountScope;
  readonly state: RelayHostExperienceLifecycleState;
  readonly fixedAgents: readonly RelayHostFixedAgentRuntimeBinding[];
}

export type RelayHostToolAuthorizationDecision =
  | {
      readonly allowed: true;
      readonly reason: "allowlisted";
    }
  | {
      readonly allowed: false;
      readonly reason:
        | "runtime-not-running"
        | "not-fixed-agent-session"
        | "invalid-tool-id"
        | "not-allowlisted"
        | "remote-permission-approval-disabled";
    };

export interface RelayEnsureSessionGroupRequest extends RelayIdempotentRequest {
  readonly requesterSessionId: string;
  readonly displayName: string;
  readonly sessionTitle: string;
  readonly source: RelayAddress;
  readonly providerMessageId: RelayMessageId;
  readonly correlationId: string;
  readonly priority?: RelaySessionPriority;
  readonly input: RelaySessionInput;
}

export interface RelayEnsuredSessionGroup {
  readonly group: RelayManagedGroupDescriptor;
  readonly binding: RelayGroupSessionBinding;
  readonly session: RelaySessionDescriptor;
  readonly steer: RelaySessionSteerReceipt;
}

export interface RelayEnsureSessionAccessPointRequest extends RelayIdempotentRequest {
  readonly sessionId: string;
  readonly displayName: string;
}

export interface RelayEnsuredSessionAccessPoint {
  readonly group: RelayManagedGroupDescriptor;
  readonly binding: RelayGroupSessionBinding;
  readonly session: RelaySessionDescriptor;
  readonly disposition: "existing" | "created" | "reopened";
}

export interface RelayReopenSessionGroupRequest extends RelayIdempotentRequest {
  readonly group: RelayAddress;
}

export interface RelayReopenedSessionGroup {
  readonly group: RelayManagedGroupDescriptor;
  readonly binding: RelayGroupSessionBinding;
  readonly session: RelaySessionDescriptor;
  readonly disposition: "already-open" | "reopened";
}

export interface RelaySteerSessionGroupRequest extends RelayIdempotentRequest {
  readonly group: RelayAddress;
  readonly providerMessageId: RelayMessageId;
  readonly correlationId: string;
  readonly priority: RelaySessionPriority;
  readonly deliveryMode: RelaySessionDeliveryMode;
  readonly input: RelaySessionInput;
}

export interface RelayProgressReplyRequest extends RelayIdempotentRequest {
  readonly source: RelayAddress;
  readonly providerMessageId: RelayMessageId;
  readonly correlationId: string;
  readonly priority?: RelaySessionPriority;
  readonly deliveryMode?: RelaySessionDeliveryMode;
  readonly input: RelaySessionInput;
}

export interface RelayInformationSessionQueryRequest {
  readonly requesterSessionId: string;
  readonly query: Omit<RelaySessionQuery, "account">;
}

export interface RelayControlSessionRequest extends RelayIdempotentRequest {
  readonly requesterSessionId: string;
  readonly source: RelayAddress;
  readonly providerMessageId: RelayMessageId;
  readonly targetSessionId: string;
  readonly correlationId: string;
  readonly input: RelaySessionInput;
}

export interface RelayCleanupSessionGroupsRequest extends RelayIdempotentRequest {
  readonly requesterSessionId: string;
  readonly inactiveBefore: string;
}

export interface RelayCleanupSessionGroupsResult {
  readonly retired: readonly RelayManagedGroupDescriptor[];
  readonly skipped: readonly RelayManagedGroupDescriptor[];
}

export interface RelayHostExperienceRuntimeApi {
  start(): Promise<RelayHostExperienceSnapshot>;
  stop(): Promise<void>;
  getSnapshot(): RelayHostExperienceSnapshot;
  authorizeFixedAgentTool(sessionId: string, toolId: string): RelayHostToolAuthorizationDecision;
  ensureSessionGroup(request: RelayEnsureSessionGroupRequest): Promise<RelayEnsuredSessionGroup>;
  ensureSessionAccessPoint(
    request: RelayEnsureSessionAccessPointRequest,
  ): Promise<RelayEnsuredSessionAccessPoint>;
  reopenSessionGroup(request: RelayReopenSessionGroupRequest): Promise<RelayReopenedSessionGroup>;
  steerSessionGroup(request: RelaySteerSessionGroupRequest): Promise<RelaySessionSteerReceipt>;
  steerProgressReply(request: RelayProgressReplyRequest): Promise<RelaySessionSteerReceipt>;
  querySessions(
    request: RelayInformationSessionQueryRequest,
  ): Promise<readonly RelaySessionDescriptor[]>;
  controlSession(request: RelayControlSessionRequest): Promise<RelaySessionSteerReceipt>;
  publish(intent: RelayPublicationIntent): Promise<RelayPublicationEnqueueReceipt>;
  cleanupSessionGroups(
    request: RelayCleanupSessionGroupsRequest,
  ): Promise<RelayCleanupSessionGroupsResult>;
}

export class RelayHostExperienceError extends Error {
  readonly name = "RelayHostExperienceError";

  constructor(
    readonly code: RelayExperienceErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
