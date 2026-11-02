import type {
  ExternalOperationIdentity,
  ExternalOperationRecord,
  ExternalOperationRecordUpdate,
  ExternalOperationRequest,
  ExternalOperationSnapshot,
} from "../../common/external-operation-contract";
import type { GoalFence } from "../../common/goal-contract";
import type { IExternalOperationRegistryPort } from "../backend/ports";
import {
  ExternalOperationRegistry,
  type ExternalOperationRegistryOptions,
} from "./registry";

const PORT_PROVIDER_ID = "external-operation-registry-port";

class DurableExternalOperationRegistryPort implements IExternalOperationRegistryPort {
  constructor(private readonly registry: ExternalOperationRegistry) {}

  async reserve(request: ExternalOperationRequest): Promise<{
    record: ExternalOperationRecord;
    created: boolean;
  }> {
    const result = await this.registry.register({
      request,
      provider: {
        kind: "provider",
        provider: PORT_PROVIDER_ID,
        adapterId: PORT_PROVIDER_ID,
      },
      cancellationScope: "none",
      actionSemantics: request.effect === "read" ? "idempotent" : "non-idempotent",
      detached: true,
    });
    return {
      record: structuredClone(result.operation.publicRecord),
      created: result.disposition === "created",
    };
  }

  async get(identity: ExternalOperationIdentity): Promise<ExternalOperationRecord | null> {
    return this.registry.getPublicRecord(identity);
  }

  async listForGoal(fence: GoalFence): Promise<ExternalOperationRecord[]> {
    return this.registry.listPublicRecordsForFence(fence);
  }

  async inspect(identity: ExternalOperationIdentity): Promise<ExternalOperationSnapshot | null> {
    return this.registry.publicSnapshot(identity);
  }

  async listSnapshotsForGoal(fence: GoalFence): Promise<ExternalOperationSnapshot[]> {
    return this.registry.listPublicSnapshotsForFence(fence);
  }

  async update(
    identity: ExternalOperationIdentity,
    update: ExternalOperationRecordUpdate,
  ): Promise<ExternalOperationRecord> {
    const operation = await this.registry.updatePublicRecord(identity, update);
    return structuredClone(operation.publicRecord);
  }
}

export function createDurableExternalOperationRegistry(
  options: ExternalOperationRegistryOptions,
): ExternalOperationRegistry {
  return new ExternalOperationRegistry(options);
}

export function createExternalOperationRegistryPort(
  registry: ExternalOperationRegistry,
): IExternalOperationRegistryPort {
  return new DurableExternalOperationRegistryPort(registry);
}

export type {
  ExternalOperationEffect,
  ExternalOperationIdentity,
  ExternalOperationRecord,
  ExternalOperationRecordUpdate,
  ExternalOperationRequest,
  ExternalOperationSnapshot,
  ExternalOperationStatus,
} from "../../common/external-operation-contract";
export type { GoalFence } from "../../common/goal-contract";
export type { IExternalOperationRegistryPort } from "../backend/ports";
