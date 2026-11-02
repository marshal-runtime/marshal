import type {
  ExternalOperationIdentity,
  ExternalOperationRecord,
} from "./external-operation-contract";
import type { GoalFence } from "./goal-contract";

/** Opaque goal correlation carried by generic resource infrastructure. */
export type GoalAuthorityMode = "read-only" | "scoped-worker" | "canonical-owner";

export interface GoalAllowedScope {
  criterionIds?: string[];
  operationKinds?: string[];
  resourceSelectors?: string[];
}

export interface GoalAllowedScopeIdentity {
  readonly criterionIds?: readonly string[];
  readonly operationKinds?: readonly string[];
  readonly resourceSelectors?: readonly string[];
}

export interface GoalWorkAssignmentIdentity {
  readonly assignmentId: string;
  readonly fence: GoalFence;
  readonly authorityMode: GoalAuthorityMode;
  readonly allowedScope: GoalAllowedScopeIdentity;
}

export interface GoalRuntimeLeaseIdentity {
  readonly leaseId: string;
  readonly fence: GoalFence;
  readonly installationId: string;
}

export interface GoalExecutionAccountingIdentity {
  fence: GoalFence;
  lease?: GoalRuntimeLeaseIdentity;
  assignment?: GoalWorkAssignmentIdentity;
  operation?: ExternalOperationIdentity;
}

export type GoalOperationRecord = ExternalOperationRecord;

export type GoalCommandCheckKind =
  | "command"
  | "test"
  | "build"
  | "lint"
  | "typecheck"
  | "inspection";

export interface ReviewerValidationCommandSpec {
  commandId: string;
  validationNodeId: string;
  checkKind: GoalCommandCheckKind;
  description?: string;
  expectedArtifactIds?: string[];
}

export interface ReviewerValidationRequest {
  fence: GoalFence;
  validationNodeId: string;
  commandId: string;
  requestedAt: string;
  idempotencyKey?: string;
}

export interface ReviewerValidationPermissionRequest {
  fence: GoalFence;
  validationNodeId: string;
  commandId: string;
  idempotencyKey: string;
}

export interface ReviewerValidationAuthorized {
  kind: "authorized";
  scopeId: string;
  commandSpecDigest: string;
  expiresAt: string;
}

export interface ReviewerValidationDenied {
  kind: "denied";
  reason: string;
}

export type ReviewerValidationAuthorizationResult =
  | ReviewerValidationAuthorized
  | ReviewerValidationDenied;

export interface ReviewerValidationArtifactRef {
  artifactId: string;
  digest: string;
}

export interface ReviewerValidationReceipt {
  receiptId: string;
  fence: GoalFence;
  validationNodeId: string;
  commandId: string;
  status: "passed" | "failed" | "rejected";
  outputDigest: string;
  startedAt: string;
  completedAt: string;
  artifactRefs: ReviewerValidationArtifactRef[];
}

export type GoalRuntimeOwnershipLease = GoalRuntimeLeaseIdentity;
