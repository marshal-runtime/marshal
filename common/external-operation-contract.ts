import type { GoalFence } from "./goal-contract";

export type ExternalOperationStatus =
  | "planned"
  | "running"
  | "succeeded"
  | "reconciled"
  | "failed"
  | "cancelled"
  | "surrendered"
  | "superseded"
  | "unknown";

export type ExternalOperationEffect = "read" | "write" | "side-effect";

export interface ExternalOperationIdentity {
  readonly operationId: string;
  readonly fence: GoalFence;
  readonly idempotencyKey: string;
  readonly assignmentId?: string;
}

export interface ExternalOperationRequest extends ExternalOperationIdentity {
  kind: string;
  effect: ExternalOperationEffect;
  requestedAt: string;
  criterionIds?: string[];
  inputFingerprint?: string;
}

export interface ExternalOperationRecord extends ExternalOperationRequest {
  status: ExternalOperationStatus;
  attempt: number;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  externalReference?: string;
  durableReceiptId?: string;
  resultSummary?: string;
  errorDigest?: string;
  supersededBy?: string;
}

export interface ExternalOperationSnapshot extends ExternalOperationRecord {
  observedAt: string;
}

export interface ExternalOperationRecordUpdate {
  status: ExternalOperationStatus;
  updatedAt: string;
  attempt?: number;
  startedAt?: string;
  completedAt?: string;
  externalReference?: string;
  durableReceiptId?: string;
  resultSummary?: string;
  errorDigest?: string;
  supersededBy?: string;
}

export function externalOperationIdentityFor(
  operation: ExternalOperationIdentity,
): ExternalOperationIdentity {
  return {
    operationId: operation.operationId,
    fence: { ...operation.fence },
    idempotencyKey: operation.idempotencyKey,
    ...(operation.assignmentId !== undefined ? { assignmentId: operation.assignmentId } : {}),
  };
}
