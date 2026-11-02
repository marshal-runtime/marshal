import { createHash, randomUUID } from "node:crypto";

import { createLogger } from "../../common/marshal-logger";
import type { ExternalOperationStore } from "./store";
import {
  isExternalOperationFollowThroughComplete,
  isExternalOperationTerminalState,
  type AdoptExternalOperationInput,
  type AttachExternalOperationInput,
  type CancelExternalOperationInput,
  type ClaimExternalOperationDispatchInput,
  type CompleteExternalOperationInput,
  type ExternalOperationAdapter,
  type ExternalOperationCancellationProviderResult,
  type ExternalOperationCancelResult,
  type ExternalOperationDispatchClaimResult,
  type ExternalOperationExactProcessAttachment,
  type ExternalOperationExactProcessIdentity,
  type ExternalOperationIdentity,
  type ExternalOperationJson,
  type ExternalOperationListFilter,
  type ExternalOperationNotificationOutbox,
  type ExternalOperationObservation,
  type ExternalOperationProcessQuery,
  type ExternalOperationRecordUpdate,
  type ExternalOperationSnapshot,
  type ExternalOperationState,
  type StoredExternalOperationRecord as ExternalOperationRecord,
  type ExternalOperationTerminalState,
  type ExternalOperationWaitResult,
  type FailExternalOperationInput,
  type HeartbeatExternalOperationInput,
  type RegisterExternalOperationInput,
  type RegisterExternalOperationResult,
} from "./types";

const log = createLogger("ExternalOperationRegistry");
const DEFAULT_WATCH_INTERVAL_MS = 5_000;
const DEFAULT_WATCH_LEASE_MS = 60_000;
const DEFAULT_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAX_TERMINAL_RECORDS = 1_000;
const DEFAULT_DISPATCH_LEASE_MS = 10 * 60_000;
const DEFAULT_CANCELLATION_RETRY_MS = 1_000;
const MAX_CANCELLATION_RETRY_MS = 60_000;
const MAX_CANCELLATION_DELIVERY_ATTEMPTS = 20;
const MAX_STRING_LENGTH = 4_000;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_ENTRIES = 100;
const SENSITIVE_FIELD_RE =
  /(?:token|secret|password|authorization|cookie|body|content|command|stdout|stderr|log)/i;

export interface ExternalOperationRegistryOptions {
  store: ExternalOperationStore;
  adapters?: Iterable<ExternalOperationAdapter>;
  notificationOutbox?: ExternalOperationNotificationOutbox;
  defaultTerminalRetentionMs?: number;
  maxTerminalRecords?: number;
  now?: () => number;
  createId?: () => string;
}

export class ExternalOperationRegistry {
  private readonly store: ExternalOperationStore;
  private readonly adapters = new Map<string, ExternalOperationAdapter>();
  private readonly records = new Map<string, ExternalOperationRecord>();
  private readonly listeners = new Map<string, Set<(operation: ExternalOperationRecord) => void>>();
  private readonly notificationFlights = new Map<string, Promise<void>>();
  private readonly cancellationFlights = new Map<string, Promise<ExternalOperationRecord>>();
  private readonly cancellationRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly defaultTerminalRetentionMs: number;
  private readonly maxTerminalRecords: number;
  private readonly now: () => number;
  private readonly createId: () => string;

  private notificationOutbox?: ExternalOperationNotificationOutbox;
  private mutationTail: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;
  private stopping = false;

  constructor(options: ExternalOperationRegistryOptions) {
    this.store = options.store;
    this.notificationOutbox = options.notificationOutbox;
    const configuredTerminalRetentionMs =
      options.defaultTerminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
    const maxTerminalRecords = options.maxTerminalRecords ?? DEFAULT_MAX_TERMINAL_RECORDS;
    this.defaultTerminalRetentionMs = Math.max(
      0,
      Number.isFinite(configuredTerminalRetentionMs)
        ? configuredTerminalRetentionMs
        : DEFAULT_TERMINAL_RETENTION_MS,
    );
    this.maxTerminalRecords = Math.max(
      0,
      Math.floor(
        Number.isFinite(maxTerminalRecords) ? maxTerminalRecords : DEFAULT_MAX_TERMINAL_RECORDS,
      ),
    );
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    for (const adapter of options.adapters ?? []) this.registerAdapter(adapter);
  }

  assertGoalFence(
    operationId: string,
    fence: ExternalOperationRecord["goalFence"],
  ): ExternalOperationRecord {
    const operation = this.inspect(operationId);
    if (!operation) throw new Error(`Unknown external operation: ${operationId}`);
    if (!sameGoalFence(operation.goalFence, fence)) {
      throw new Error(
        `Stale external-operation goal fence for ${operationId}: expected epoch ${operation.goalFence.epoch}; received epoch ${fence.epoch}`,
      );
    }
    return operation;
  }

  registerAdapter(adapter: ExternalOperationAdapter): void {
    const existing = this.adapters.get(adapter.adapterId);
    if (existing && existing !== adapter) {
      throw new Error(`External-operation adapter already registered: ${adapter.adapterId}`);
    }

    this.adapters.set(adapter.adapterId, adapter);
  }

  setNotificationOutbox(outbox: ExternalOperationNotificationOutbox): void {
    this.notificationOutbox = outbox;
    if (!this.started || this.stopped) return;
    for (const operation of this.records.values()) {
      if (operation.terminalEvent && operation.notification.state === "pending") {
        void this.ensureTerminalNotification(operation.operationId).catch(() => {
          log
            .with({ operationId: operation.operationId })
            .warn("Terminal notification retry failed");
        });
      }
    }
  }

  async start(): Promise<void> {
    try {
      await this.runExclusive(async () => {
        if (this.started && !this.stopped) return;
        const loaded = await this.store.load();
        this.records.clear();
        for (const operation of loaded) {
          this.records.set(operation.operationId, operation);
        }
        this.started = true;
        this.stopped = false;
        this.stopping = false;

        let changed = false;
        const now = this.nowIso();
        for (const operation of this.records.values()) {
          if (isExternalOperationTerminalState(operation.state)) continue;
          let operationChanged = false;
          if (operation.watcherLease) {
            delete operation.watcherLease;
            operationChanged = true;
          }
          if (operation.state === "running") {
            operation.state = "unknown";
            operation.publicRecord.status = "unknown";
            operation.lastError =
              "Application restarted before provider terminal state was observed";
            operationChanged = true;
          }
          if (
            operation.dispatchClaim &&
            operation.state === "registered" &&
            !operation.receipt &&
            Date.parse(operation.dispatchClaim.leaseExpiresAt) <= this.now()
          ) {
            if (operation.actionSemantics === "non-idempotent") {
              operation.state = "unknown";
              operation.publicRecord.status = "unknown";
              operation.lastError =
                "Expired non-idempotent dispatch claim requires manual recovery";
            } else {
              delete operation.dispatchClaim;
            }
            operationChanged = true;
          }
          if (operationChanged) {
            this.touch(operation, now);
            changed = true;
          }
        }
        changed = this.pruneTerminalLocked() || changed;
        if (changed) await this.persistLocked();
      });
    } catch (error) {
      this.started = false;
      this.stopped = true;
      this.records.clear();
      throw error;
    }

    const terminalIds = [...this.records.values()]
      .filter(
        (operation) =>
          operation.terminalEvent !== undefined && operation.notification.state === "pending",
      )
      .map((operation) => operation.operationId);
    await Promise.all(
      terminalIds.map((operationId) => this.ensureTerminalNotification(operationId)),
    );
    const cancellationRequests = [...this.records.values()].filter(
      (operation) =>
        operation.cancellation?.state === "requested" &&
        !isExternalOperationTerminalState(operation.state),
    );
    await Promise.allSettled(
      cancellationRequests.map((operation) => {
        const cancellation = operation.cancellation;
        if (!cancellation) return Promise.resolve(operation);
        return this.deliverCancellationRequest(
          cloneOperation(operation),
          identityOf(operation),
          cancellation.requestId,
        );
      }),
    );
    await this.reconcileAll();
  }

  async initialize(): Promise<void> {
    await this.start();
  }

  async reconcileStartup(): Promise<ExternalOperationRecord[]> {
    if (!this.started || this.stopped) {
      await this.start();
      return this.list();
    }
    return await this.reconcileAll();
  }

  async checkpoint(): Promise<void> {
    await this.runExclusive(async () => {
      this.assertStarted();
      await this.persistLocked();
    });
  }

  async shutdown(): Promise<void> {
    if (!this.started || this.stopped || this.stopping) return;
    this.stopping = true;
    await Promise.allSettled([...this.notificationFlights.values()]);
    for (const timer of this.cancellationRetryTimers.values()) clearTimeout(timer);
    this.cancellationRetryTimers.clear();
    await Promise.allSettled([...this.cancellationFlights.values()]);
    this.stopped = true;
    await this.runExclusive(async () => {
      let changed = false;
      const now = this.nowIso();
      for (const operation of this.records.values()) {
        if (!operation.watcherLease || isExternalOperationTerminalState(operation.state)) continue;
        delete operation.watcherLease;
        operation.updatedAt = now;
        changed = true;
      }
      if (changed) await this.persistLocked();
    });
    await this.mutationTail;
    this.listeners.clear();
    this.notificationFlights.clear();
    this.cancellationFlights.clear();
    this.stopping = false;
  }

  async register(input: RegisterExternalOperationInput): Promise<RegisterExternalOperationResult> {
    return await this.runExclusive(async () => {
      this.assertWritable();
      validateRegisterInput(input);
      const request = input.request;
      const duplicate = [...this.records.values()].find(
        (operation) => operation.idempotencyKey === request.idempotencyKey,
      );
      if (duplicate) {
        assertRegistrationCompatible(duplicate, input);
        return {
          disposition: "existing",
          operation: cloneOperation(duplicate),
        };
      }

      const operationId = request.operationId;
      if (this.records.has(operationId)) {
        throw new Error(`External operation identity collision: ${operationId}`);
      }
      const now = this.nowIso();
      const metadata = sanitizeMetadata(input.metadata);
      const operation: ExternalOperationRecord = {
        publicRecord: {
          ...structuredClone(request),
          status: "planned",
          attempt: 0,
          updatedAt: now,
        },
        operationId,
        idempotencyKey: request.idempotencyKey,
        goalFence: structuredClone(request.fence),
        metadata: {
          ...metadata,
          provider: metadata.provider
            ? metadata.provider
            : {
                kind: input.provider.kind,
                provider: input.provider.provider,
                adapterId: input.provider.adapterId,
              },
          capturedAt: metadata.capturedAt ?? now,
        },
        contract: {},
        provider: structuredClone(input.provider),
        identity: structuredClone(input.runtimeIdentity ?? {}),
        cancellationScope: input.cancellationScope,
        actionSemantics: input.actionSemantics,
        detached: input.detached ?? true,
        state: "registered",
        watcher: normalizeWatcher(input.watcher),
        retention: structuredClone(input.retention ?? {}),
        terminalNotification: input.terminalNotification
          ? {
              ...structuredClone(input.terminalNotification),
              target: requireBoundedString(
                input.terminalNotification.target,
                "terminalNotification.target",
              ),
              content:
                boundedOptionalString(input.terminalNotification.content) ??
                "External operation reached a terminal state.",
            }
          : undefined,
        notification: {
          state: "not-required",
          idempotencyKey: input.terminalNotification?.idempotencyKey,
        },
        createdAt: now,
        updatedAt: now,
      };
      this.assertAdapterCompatibility(operation);
      this.records.set(operationId, operation);
      try {
        await this.persistLocked();
      } catch (error) {
        this.records.delete(operationId);
        throw error;
      }
      this.notify(operation);
      return {
        disposition: "created",
        operation: cloneOperation(operation),
      };
    });
  }

  async claimDispatch(
    input: ClaimExternalOperationDispatchInput,
  ): Promise<ExternalOperationDispatchClaimResult> {
    return await this.runExclusive(async () => {
      this.assertWritable();
      const operation = this.requireIdentityLocked(input.identity);
      const nowMs = this.now();
      const existing = operation.dispatchClaim;
      if (isExternalOperationTerminalState(operation.state)) {
        throw new Error(`External operation is not claimable: ${operation.operationId}`);
      }
      if (existing?.claimedBy === input.claimedBy) {
        return {
          disposition: "existing",
          claim: structuredClone(existing),
          operation: cloneOperation(operation),
        };
      }
      if (existing && (operation.receipt || Date.parse(existing.leaseExpiresAt) > nowMs)) {
        throw new Error(`External operation dispatch is already claimed: ${operation.operationId}`);
      }
      if (operation.state !== "registered" || operation.receipt) {
        throw new Error(`External operation is not claimable: ${operation.operationId}`);
      }
      const previous = cloneOperation(operation);
      const now = new Date(nowMs).toISOString();
      const claim = {
        claimToken: this.createId(),
        claimedBy: requireBoundedString(input.claimedBy, "claimedBy"),
        claimedAt: now,
        leaseExpiresAt: new Date(
          nowMs + normalizeLeaseDuration(input.leaseDurationMs, DEFAULT_DISPATCH_LEASE_MS),
        ).toISOString(),
      };
      operation.dispatchClaim = claim;
      this.touch(operation, now);
      try {
        await this.persistLocked();
      } catch (error) {
        this.records.set(operation.operationId, previous);
        throw error;
      }
      this.notify(operation);
      return {
        disposition: "claimed",
        claim: structuredClone(claim),
        operation: cloneOperation(operation),
      };
    });
  }

  async attach(input: AttachExternalOperationInput): Promise<ExternalOperationRecord> {
    return await this.mutateIdentity(input.identity, (operation, now) => {
      this.assertNonTerminal(operation);
      const recoveringNonIdempotent =
        operation.state === "unknown" &&
        operation.actionSemantics === "non-idempotent" &&
        !operation.receipt;
      this.assertDispatchClaim(operation, input.claimToken, !recoveringNonIdempotent);
      if (Object.keys(input.receipt).length === 0) {
        throw new Error("Provider receipt must contain at least one field");
      }
      const firstAttachment =
        !operation.receipt && (operation.state === "registered" || recoveringNonIdempotent);
      if (!firstAttachment && operation.state !== "running") {
        throw new Error(
          `External operation cannot accept a provider attachment: ${operation.operationId}`,
        );
      }
      if (input.adapterId) operation.provider.adapterId = input.adapterId;
      operation.receipt = sanitizeJsonObject(
        { ...(operation.receipt ?? {}), ...input.receipt },
        "receipt",
      );
      operation.identity = {
        ...operation.identity,
        ...(input.runtimeIdentity ? structuredClone(input.runtimeIdentity) : {}),
      };
      if (input.exactProcess) {
        this.setExactProcessIdentity(operation, input.exactProcess);
      }
      if (input.cancellationScope) {
        operation.cancellationScope = input.cancellationScope;
      }
      operation.watcher = {
        ...operation.watcher,
        ...normalizeWatcher(input.watcher, operation.watcher),
      };
      operation.state = operation.cancellation ? "cancelling" : "running";
      operation.publicRecord.status = "running";
      if (firstAttachment) operation.publicRecord.attempt += 1;
      operation.publicRecord.startedAt ??= now;
      operation.publicRecord.updatedAt = now;
      operation.publicRecord.externalReference =
        operation.publicRecord.externalReference ?? receiptReference(operation.receipt);
      delete operation.lastError;
      if (input.ownerId) {
        operation.watcherLease = this.createWatcherLease(
          input.ownerId,
          operation.watcher.leaseDurationMs,
          now,
        );
      }
      this.assertAdapterCompatibility(operation);
      this.touch(operation, now);
    });
  }

  async attachExactProcessIdentity(
    identity: ExternalOperationIdentity,
    processIdentity: ExternalOperationExactProcessIdentity,
    claimToken: string,
  ): Promise<ExternalOperationRecord> {
    validateExactProcessIdentity(processIdentity);
    return await this.mutateIdentity(identity, (operation, now) => {
      this.assertNonTerminal(operation);
      this.assertDispatchClaim(operation, claimToken, true);
      if (!operation.receipt) throw new Error("Exact process identity requires a provider receipt");
      if (!this.setExactProcessIdentity(operation, processIdentity)) return;
      this.touch(operation, now);
    });
  }

  async heartbeat(input: HeartbeatExternalOperationInput): Promise<ExternalOperationRecord> {
    return await this.mutateIdentity(input.identity, (operation, now) => {
      this.assertNonTerminal(operation);
      if (input.leaseId && operation.watcherLease?.leaseId !== input.leaseId) {
        throw new Error(`External-operation watcher lease mismatch: ${operation.operationId}`);
      }
      const ownerId = input.ownerId ?? operation.watcherLease?.ownerId;
      if (
        input.ownerId &&
        operation.watcherLease &&
        operation.watcherLease.ownerId !== input.ownerId &&
        !input.leaseId
      ) {
        throw new Error(
          `External operation ${operation.operationId} is leased by ${operation.watcherLease.ownerId}; adopt it before heartbeating as ${input.ownerId}`,
        );
      }
      if (ownerId) {
        operation.watcherLease = this.createWatcherLease(
          ownerId,
          input.leaseDurationMs ?? operation.watcher.leaseDurationMs,
          now,
          input.leaseId ?? operation.watcherLease?.leaseId,
        );
      }
      if (input.receipt) {
        if (!operation.receipt) throw new Error("Heartbeat cannot create a provider receipt");
        operation.receipt = sanitizeJsonObject(
          { ...operation.receipt, ...input.receipt },
          "receipt",
        );
      }
      operation.lastHeartbeatAt = now;
      this.touch(operation, now);
    });
  }

  async adopt(input: AdoptExternalOperationInput): Promise<ExternalOperationRecord> {
    const adopted = await this.mutateIdentity(input.identity, (operation, now) => {
      this.assertNonTerminal(operation);
      if (!operation.receipt) throw new Error("Cannot adopt without a provider receipt");
      if (input.adapterId) operation.provider.adapterId = input.adapterId;
      if (input.receipt) {
        operation.receipt = sanitizeJsonObject(
          { ...operation.receipt, ...input.receipt },
          "receipt",
        );
      }
      operation.adoptedBy = requireBoundedString(input.ownerId, "ownerId");
      operation.watcherLease = this.createWatcherLease(
        input.ownerId,
        input.leaseDurationMs ?? operation.watcher.leaseDurationMs,
        now,
      );
      this.assertAdapterCompatibility(operation);
      this.touch(operation, now);
    });
    if (!adopted.receipt) return adopted;

    const adapter = this.adapters.get(adopted.provider.adapterId);
    if (!adapter?.adopt) return await this.reconcile(adopted.operationId);
    try {
      const observation = await adapter.adopt(
        { operation: adopted, receipt: adopted.receipt },
        input.ownerId,
      );
      return observation
        ? await this.applyObservation(adopted.operationId, observation, adopted)
        : await this.reconcile(adopted.operationId);
    } catch (error) {
      return await this.markUnknown(
        adopted.operationId,
        `Adoption failed: ${formatError(error)}`,
        adopted,
      );
    }
  }

  async complete(input: CompleteExternalOperationInput): Promise<ExternalOperationRecord> {
    return await this.finalizeTerminal(input.identity, "succeeded", {
      result: input.result,
      claimToken: input.claimToken,
      preDispatch: input.preDispatch,
    });
  }

  async fail(input: FailExternalOperationInput): Promise<ExternalOperationRecord> {
    return await this.finalizeTerminal(input.identity, "failed", {
      error: input.error,
      claimToken: input.claimToken,
      preDispatch: input.preDispatch,
    });
  }

  async cancel(input: CancelExternalOperationInput): Promise<ExternalOperationRecord> {
    const requestId = input.cancellationRequestId ?? this.createId();
    const current = this.inspect(input.identity.operationId);
    if (!current) throw new Error(`Unknown external operation: ${input.identity.operationId}`);
    assertIdentityMatches(current, input.identity);
    if (current.cancellation) {
      if (current.cancellation.requestId === requestId) {
        if (
          current.cancellation.state !== "requested" ||
          isExternalOperationTerminalState(current.state)
        ) {
          return current;
        }
        return await this.deliverCancellationRequest(current, input.identity, requestId);
      }
      throw new Error(`Cancellation is already owned by ${current.cancellation.requestId}`);
    }
    let createdRequest = false;
    const requested = await this.mutateIdentity(input.identity, (operation, now) => {
      this.assertNonTerminal(operation);
      if (operation.cancellation) {
        if (operation.cancellation.requestId === requestId) return;
        throw new Error(`Cancellation is already owned by ${operation.cancellation.requestId}`);
      }
      const scope = input.scope ?? operation.cancellationScope;
      createdRequest = true;
      operation.state = "cancelling";
      operation.cancellation = {
        requestId,
        requestedAt: now,
        requestedBy: boundedOptionalString(input.requestedBy),
        scope,
        reason: boundedOptionalString(input.reason),
        state: "requested",
        deliveryAttempts: 0,
      };
      this.touch(operation, now);
    });
    if (!createdRequest) return requested;
    return await this.deliverCancellationRequest(requested, input.identity, requestId);
  }

  private async deliverCancellationRequest(
    requested: ExternalOperationRecord,
    identity: ExternalOperationIdentity,
    requestId: string,
  ): Promise<ExternalOperationRecord> {
    const flightKey = `${identity.operationId}:${requestId}`;
    const existingFlight = this.cancellationFlights.get(flightKey);
    if (existingFlight) return await existingFlight;
    const flight = this.deliverCancellationRequestUncoalesced(
      requested,
      identity,
      requestId,
    ).finally(() => {
      if (this.cancellationFlights.get(flightKey) === flight) {
        this.cancellationFlights.delete(flightKey);
      }
    });
    this.cancellationFlights.set(flightKey, flight);
    return await flight;
  }

  private async deliverCancellationRequestUncoalesced(
    requested: ExternalOperationRecord,
    identity: ExternalOperationIdentity,
    requestId: string,
  ): Promise<ExternalOperationRecord> {
    if (!requested.receipt) {
      if (requested.publicRecord.status === "planned") {
        return await this.finalizeTerminal(identity, "cancelled", {
          preDispatch: true,
          error: requested.cancellation?.reason,
          allowDuringStopping: true,
        });
      }
      return await this.recordCancellationProviderResult({
        identity,
        cancellationRequestId: requestId,
        accepted: false,
        error: "Cancellation could not be sent because no external receipt is attached",
      });
    }
    const adapter = this.adapters.get(requested.provider.adapterId);
    if (!adapter) {
      return await this.recordCancellationDeliveryFailure({
        identity,
        cancellationRequestId: requestId,
        error: `Cancellation adapter is unavailable: ${requested.provider.adapterId}`,
      });
    }

    let providerResult: ExternalOperationCancelResult;
    try {
      providerResult = await adapter.cancel(
        { operation: requested, receipt: requested.receipt },
        requested.cancellation?.scope ?? requested.cancellationScope,
        requestId,
      );
    } catch (error) {
      return await this.recordCancellationDeliveryFailure({
        identity,
        cancellationRequestId: requestId,
        error: formatError(error),
      });
    }
    return await this.recordCancellationProviderResult({
      identity,
      cancellationRequestId: requestId,
      accepted: providerResult.accepted,
      error: providerResult.error,
      observation: providerResult.observation,
    });
  }

  private async recordCancellationDeliveryFailure(result: {
    identity: ExternalOperationIdentity;
    cancellationRequestId: string;
    error: string;
  }): Promise<ExternalOperationRecord> {
    const recorded = await this.mutateIdentity(
      result.identity,
      (operation, now) => {
        const cancellation = operation.cancellation;
        if (
          !cancellation ||
          cancellation.requestId !== result.cancellationRequestId ||
          cancellation.state !== "requested" ||
          isExternalOperationTerminalState(operation.state)
        ) {
          return;
        }
        cancellation.lastError = boundedOptionalString(result.error);
        cancellation.deliveryAttempts += 1;
        cancellation.retryAt =
          cancellation.deliveryAttempts < MAX_CANCELLATION_DELIVERY_ATTEMPTS
            ? new Date(
                this.now() +
                  Math.min(
                    DEFAULT_CANCELLATION_RETRY_MS *
                      2 ** Math.max(0, cancellation.deliveryAttempts - 1),
                    MAX_CANCELLATION_RETRY_MS,
                  ),
              ).toISOString()
            : undefined;
        operation.lastError = cancellation.lastError;
        this.touch(operation, now);
      },
      true,
    );
    this.scheduleCancellationRetry(recorded);
    return recorded;
  }

  async reconcile(operationId: string): Promise<ExternalOperationRecord> {
    this.assertStarted();
    let snapshot = this.inspect(operationId);
    if (!snapshot) throw new Error(`Unknown external operation: ${operationId}`);
    if (isExternalOperationTerminalState(snapshot.state)) {
      await this.ensureTerminalNotification(operationId);
      return this.requireOperationOr(snapshot);
    }
    if (snapshot.watcherLease && Date.parse(snapshot.watcherLease.expiresAt) <= this.now()) {
      snapshot = await this.mutate(operationId, (operation, now) => {
        if (isExternalOperationTerminalState(operation.state)) return;
        delete operation.watcherLease;
        if (!operation.cancellation && operation.state !== "registered") {
          operation.state = "unknown";
          operation.publicRecord.status = "unknown";
        }
        operation.lastError = "External-operation watcher lease expired";
        this.touch(operation, now);
      });
    }
    if (!snapshot.receipt) {
      return snapshot.state === "registered"
        ? snapshot
        : await this.markUnknown(
            operationId,
            "External operation has no durable provider receipt; the action was not rerun",
            snapshot,
          );
    }
    const adapter = this.adapters.get(snapshot.provider.adapterId);
    if (!adapter) {
      return await this.markUnknown(
        operationId,
        `External-operation adapter is unavailable: ${snapshot.provider.adapterId}`,
        snapshot,
      );
    }
    if (!adapter.providerKinds.has(snapshot.provider.kind)) {
      return await this.markUnknown(
        operationId,
        `Adapter ${adapter.adapterId} does not support provider kind ${snapshot.provider.kind}`,
        snapshot,
      );
    }

    try {
      const observation = await adapter.inspect({
        operation: snapshot,
        receipt: snapshot.receipt,
      });
      return await this.applyObservation(operationId, observation, snapshot);
    } catch (error) {
      return await this.markUnknown(
        operationId,
        `Reconciliation failed: ${formatError(error)}`,
        snapshot,
      );
    }
  }

  async reconcileAll(): Promise<ExternalOperationRecord[]> {
    this.assertStarted();
    const operationIds = this.list({ includeTerminal: false }).map(
      (operation) => operation.operationId,
    );
    return await Promise.all(operationIds.map((operationId) => this.reconcile(operationId)));
  }

  async recoverAfterRuntimeReset(options?: {
    adapterIds?: readonly string[];
    reason?: string;
  }): Promise<void> {
    const selectedAdapters = options?.adapterIds ? new Set(options.adapterIds) : undefined;
    const affected = await this.runExclusive(async () => {
      this.assertWritable();
      const operationIds: string[] = [];
      const now = this.nowIso();
      const previous = new Map<string, ExternalOperationRecord>();
      for (const operation of this.records.values()) {
        if (
          isExternalOperationTerminalState(operation.state) ||
          (selectedAdapters && !selectedAdapters.has(operation.provider.adapterId))
        ) {
          continue;
        }
        const expiredUnreceiptedClaim =
          operation.dispatchClaim &&
          !operation.receipt &&
          Date.parse(operation.dispatchClaim.leaseExpiresAt) <= this.now();
        if (
          operation.state === "registered" &&
          !operation.watcherLease &&
          !expiredUnreceiptedClaim &&
          operation.cancellation?.state !== "requested"
        ) {
          continue;
        }
        previous.set(operation.operationId, cloneOperation(operation));
        operationIds.push(operation.operationId);
        delete operation.watcherLease;
        if (expiredUnreceiptedClaim && operation.actionSemantics === "non-idempotent") {
          operation.state = "unknown";
          operation.publicRecord.status = "unknown";
          operation.lastError = "Expired non-idempotent dispatch claim requires manual recovery";
        } else if (expiredUnreceiptedClaim && operation.actionSemantics === "idempotent") {
          delete operation.dispatchClaim;
        } else if (!operation.cancellation && operation.state !== "registered") {
          operation.state = "unknown";
          operation.publicRecord.status = "unknown";
        }
        operation.lastError =
          options?.reason ?? "Provider runtime reset; awaiting receipt reconciliation";
        this.touch(operation, now);
      }
      try {
        if (operationIds.length > 0) await this.persistLocked();
      } catch (error) {
        for (const [operationId, operation] of previous) {
          this.records.set(operationId, operation);
        }
        throw error;
      }
      for (const operationId of operationIds) {
        const operation = this.records.get(operationId);
        if (operation) this.notify(operation);
      }
      return operationIds;
    });
    await Promise.all(affected.map((operationId) => this.reconcile(operationId)));
    const requestedCancellations = affected
      .map((operationId) => this.inspect(operationId))
      .filter(
        (operation): operation is ExternalOperationRecord =>
          operation !== undefined &&
          operation.cancellation?.state === "requested" &&
          !isExternalOperationTerminalState(operation.state),
      );
    await Promise.allSettled(
      requestedCancellations.map((operation) => {
        const cancellation = operation.cancellation;
        if (!cancellation) return Promise.resolve(operation);
        return this.deliverCancellationRequest(
          operation,
          identityOf(operation),
          cancellation.requestId,
        );
      }),
    );
  }

  inspect(operationId: string): ExternalOperationRecord | undefined {
    const operation = this.records.get(operationId);
    return operation ? cloneOperation(operation) : undefined;
  }

  getPublicRecord(
    identity: ExternalOperationIdentity,
  ): ExternalOperationRecord["publicRecord"] | null {
    const operation = this.records.get(identity.operationId);
    if (!operation) return null;
    assertIdentityMatches(operation, identity);
    return structuredClone(operation.publicRecord);
  }

  listPublicRecordsForFence(
    fence: ExternalOperationIdentity["fence"],
  ): ExternalOperationRecord["publicRecord"][] {
    return [...this.records.values()]
      .filter((operation) => sameGoalFence(operation.goalFence, fence))
      .map((operation) => structuredClone(operation.publicRecord))
      .sort(
        (left, right) =>
          Date.parse(left.requestedAt) - Date.parse(right.requestedAt) ||
          left.operationId.localeCompare(right.operationId),
      );
  }

  snapshot(operationId: string): ExternalOperationSnapshot | undefined {
    const operation = this.records.get(operationId);
    if (!operation) return undefined;
    return {
      ...structuredClone(operation.publicRecord),
      observedAt: this.nowIso(),
    };
  }

  publicSnapshot(identity: ExternalOperationIdentity): ExternalOperationSnapshot | null {
    const record = this.getPublicRecord(identity);
    if (!record) return null;
    return {
      ...record,
      observedAt: this.nowIso(),
    };
  }

  listPublicSnapshotsForFence(
    fence: ExternalOperationIdentity["fence"],
  ): ExternalOperationSnapshot[] {
    const observedAt = this.nowIso();
    return this.listPublicRecordsForFence(fence).map((record) => ({
      ...record,
      observedAt,
    }));
  }

  async updatePublicRecord(
    identity: ExternalOperationIdentity,
    update: ExternalOperationRecordUpdate,
  ): Promise<ExternalOperationRecord> {
    return await this.mutateIdentity(identity, (operation, now) => {
      if (
        isExternalOperationTerminalState(operation.state) &&
        update.status !== operation.publicRecord.status
      ) {
        throw new Error(
          `External operation is already terminal as ${operation.publicRecord.status}`,
        );
      }
      if (
        update.attempt !== undefined &&
        (!Number.isInteger(update.attempt) || update.attempt < 0)
      ) {
        throw new Error("update.attempt must be a non-negative integer");
      }
      const durableReceiptId =
        boundedOptionalString(update.durableReceiptId) ?? operation.publicRecord.durableReceiptId;
      if (
        (update.status === "running" ||
          update.status === "reconciled" ||
          update.status === "succeeded") &&
        !durableReceiptId
      ) {
        throw new Error(`A ${update.status} external operation requires durableReceiptId`);
      }
      operation.publicRecord = {
        ...operation.publicRecord,
        ...structuredClone(update),
        updatedAt: requireBoundedString(update.updatedAt, "update.updatedAt"),
        startedAt: boundedOptionalString(update.startedAt),
        completedAt: boundedOptionalString(update.completedAt),
        externalReference: boundedOptionalString(update.externalReference),
        resultSummary: boundedOptionalString(update.resultSummary),
        durableReceiptId,
        errorDigest: boundedOptionalString(update.errorDigest),
        supersededBy: boundedOptionalString(update.supersededBy),
      };
      operation.state = internalStateForPublicStatus(update.status);
      if (durableReceiptId) {
        operation.receipt = sanitizeJsonObject(
          {
            ...(operation.receipt ?? {}),
            durableReceiptId,
            ...(operation.publicRecord.externalReference
              ? { externalReference: operation.publicRecord.externalReference }
              : {}),
          },
          "receipt",
        );
      }
      if (isExternalOperationTerminalState(operation.state) && !operation.terminalEvent) {
        const terminalState = operation.state;
        operation.terminalEvent = {
          eventId: this.createId(),
          idempotencyKey: `external-operation-terminal:${operation.operationId}:${terminalState}`,
          state: terminalState,
          occurredAt: operation.publicRecord.completedAt ?? operation.publicRecord.updatedAt,
          result: operation.publicRecord.resultSummary
            ? { summary: operation.publicRecord.resultSummary }
            : undefined,
        };
        operation.notification = { state: "not-required" };
        delete operation.dispatchClaim;
        delete operation.watcherLease;
        operation.retention.retainUntil ??= new Date(
          this.now() + terminalRetentionMs(terminalState, this.defaultTerminalRetentionMs),
        ).toISOString();
      }
      const canonicalUpdatedAt = operation.publicRecord.updatedAt;
      this.touch(operation, now);
      operation.publicRecord.updatedAt = canonicalUpdatedAt;
    });
  }

  list(filter: ExternalOperationListFilter = {}): ExternalOperationRecord[] {
    return [...this.records.values()]
      .filter((operation) => matchesFilter(operation, filter))
      .map(cloneOperation)
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.operationId.localeCompare(right.operationId),
      );
  }

  listExactProcessAttachments(
    query: ExternalOperationProcessQuery = {},
  ): ExternalOperationExactProcessAttachment[] {
    return this.list({
      goalId: query.goalId,
      states: query.states,
      includeTerminal: query.includeTerminal,
    })
      .filter(
        (
          operation,
        ): operation is ExternalOperationRecord & {
          exactProcess: ExternalOperationExactProcessIdentity;
        } =>
          operation.exactProcess !== undefined &&
          (!query.ownerSessionId || operation.exactProcess.ownerSessionId === query.ownerSessionId),
      )
      .map((operation) => ({
        operationId: operation.operationId,
        idempotencyKey: operation.idempotencyKey,
        goalFence: structuredClone(operation.goalFence),
        provider: structuredClone(operation.provider),
        process: structuredClone(operation.exactProcess),
        state: operation.state,
        terminalState: isExternalOperationTerminalState(operation.state)
          ? operation.state
          : undefined,
        updatedAt: operation.updatedAt,
      }));
  }

  /**
   * Compatibility view for session-scoped callers. Detached records remain
   * visible after the launcher session is switched or deleted because the
   * application-scoped registry never derives lifetime from session storage.
   */
  listCompatibility(relatedSessionId?: string): ExternalOperationRecord[] {
    return this.list({
      relatedSessionId,
      includeTerminal: true,
    });
  }

  async waitForTerminal(
    operationId: string,
    timeoutMs: number,
    options: { requireNotificationAcceptance?: boolean } = {},
  ): Promise<ExternalOperationWaitResult> {
    const requireFollowThrough = options.requireNotificationAcceptance !== false;
    const current = this.records.get(operationId);
    if (!current) throw new Error(`Unknown external operation: ${operationId}`);
    if (
      isExternalOperationTerminalState(current.state) &&
      (!requireFollowThrough || isExternalOperationFollowThroughComplete(current))
    ) {
      return {
        operation: cloneOperation(current),
        timedOut: false,
        followThroughComplete: isExternalOperationFollowThroughComplete(current),
      };
    }

    return await new Promise((resolve) => {
      const listener = (operation: ExternalOperationRecord): void => {
        if (!isExternalOperationTerminalState(operation.state)) return;
        if (requireFollowThrough && !isExternalOperationFollowThroughComplete(operation)) return;
        cleanup();
        resolve({
          operation,
          timedOut: false,
          followThroughComplete: isExternalOperationFollowThroughComplete(operation),
        });
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        const operationListeners = this.listeners.get(operationId);
        operationListeners?.delete(listener);
        if (operationListeners?.size === 0) this.listeners.delete(operationId);
      };
      const timer = setTimeout(
        () => {
          cleanup();
          const latest = this.records.get(operationId);
          if (!latest) throw new Error(`Unknown external operation: ${operationId}`);
          resolve({
            operation: cloneOperation(latest),
            timedOut: true,
            followThroughComplete: isExternalOperationFollowThroughComplete(latest),
          });
        },
        Math.max(0, timeoutMs),
      );
      const operationListeners = this.listeners.get(operationId) ?? new Set();
      operationListeners.add(listener);
      this.listeners.set(operationId, operationListeners);
    });
  }

  subscribeToProvider(operationId: string): (() => void) | null {
    if (this.stopping || this.stopped) return null;
    const operation = this.inspect(operationId);
    if (!operation?.receipt || isExternalOperationTerminalState(operation.state)) return null;
    const adapter = this.adapters.get(operation.provider.adapterId);
    if (!adapter?.subscribe) return null;
    if (!adapter.providerKinds.has(operation.provider.kind)) return null;
    return adapter.subscribe({ operation, receipt: operation.receipt }, (observation) => {
      void this.applyObservation(operationId, observation, operation).catch(() => {
        log.with({ operationId }).warn("Provider terminal watcher update failed");
      });
    });
  }

  async prune(): Promise<number> {
    return await this.runExclusive(async () => {
      this.assertStarted();
      const before = this.records.size;
      const previous = new Map(
        [...this.records.entries()].map(([operationId, operation]) => [
          operationId,
          cloneOperation(operation),
        ]),
      );
      if (this.pruneTerminalLocked()) {
        try {
          await this.persistLocked();
        } catch (error) {
          this.records.clear();
          for (const [operationId, operation] of previous) {
            this.records.set(operationId, operation);
          }
          throw error;
        }
      }
      return before - this.records.size;
    });
  }

  private async applyObservation(
    operationId: string,
    observation: ExternalOperationObservation,
    inspectedSnapshot?: ExternalOperationRecord,
    allowDuringStopping = false,
  ): Promise<ExternalOperationRecord> {
    if (inspectedSnapshot) {
      const current = this.inspect(operationId);
      if (!current) throw new Error(`Unknown external operation: ${operationId}`);
      if (isExternalOperationTerminalState(current.state)) return current;
      if (!sameInspectionTarget(current, inspectedSnapshot)) {
        return cloneOperation(this.requireRecord(operationId));
      }
    }
    if (observation.state === "succeeded") {
      return await this.finalizeTerminal(
        identityOf(inspectedSnapshot ?? this.requireRecord(operationId)),
        "succeeded",
        {
          result: observation.result,
          error: observation.error,
          receipt: observation.receipt,
          exactProcess: observation.exactProcess,
          claimToken: (inspectedSnapshot ?? this.requireRecord(operationId)).dispatchClaim
            ?.claimToken,
          allowDuringStopping,
        },
      );
    }
    if (observation.state === "failed" || observation.state === "cancelled") {
      return await this.finalizeTerminal(
        identityOf(inspectedSnapshot ?? this.requireRecord(operationId)),
        observation.state,
        {
          result: observation.result,
          error: observation.error,
          receipt: observation.receipt,
          exactProcess: observation.exactProcess,
          claimToken: (inspectedSnapshot ?? this.requireRecord(operationId)).dispatchClaim
            ?.claimToken,
          allowDuringStopping,
        },
      );
    }
    return await this.mutate(
      operationId,
      (operation, now) => {
        if (isExternalOperationTerminalState(operation.state)) return;
        if (inspectedSnapshot && !sameInspectionTarget(operation, inspectedSnapshot)) return;
        if (observation.receipt) {
          operation.receipt = sanitizeJsonObject(
            { ...(operation.receipt ?? {}), ...observation.receipt },
            "receipt",
          );
        }
        if (observation.exactProcess) {
          this.setExactProcessIdentity(operation, observation.exactProcess);
        }
        operation.lastObservedAt = now;
        operation.watcher.lastCheckedAt = now;
        operation.watcher.nextCheckAt = new Date(
          this.now() + operation.watcher.intervalMs,
        ).toISOString();
        if (observation.state === "running") {
          if (!operation.cancellation) {
            operation.state = "running";
            operation.publicRecord.status = "running";
          }
          operation.lastHeartbeatAt = boundedOptionalString(observation.heartbeatAt) ?? now;
          delete operation.lastError;
        } else {
          if (!operation.cancellation) {
            operation.state = "unknown";
            operation.publicRecord.status = "unknown";
          }
          operation.lastError = boundedOptionalString(
            "reason" in observation ? observation.reason : undefined,
          );
        }
        this.touch(operation, now);
      },
      allowDuringStopping,
    );
  }

  private async markUnknown(
    operationId: string,
    reason: string,
    inspectedSnapshot?: ExternalOperationRecord,
  ): Promise<ExternalOperationRecord> {
    return await this.mutate(operationId, (operation, now) => {
      if (isExternalOperationTerminalState(operation.state)) return;
      if (inspectedSnapshot && !sameInspectionTarget(operation, inspectedSnapshot)) return;
      if (!operation.cancellation) {
        operation.state = "unknown";
        operation.publicRecord.status = "unknown";
      }
      operation.lastObservedAt = now;
      operation.lastError = boundedOptionalString(reason);
      operation.watcher.lastCheckedAt = now;
      operation.watcher.nextCheckAt = new Date(
        this.now() + operation.watcher.intervalMs,
      ).toISOString();
      this.touch(operation, now);
    });
  }

  async recordCancellationProviderResult(
    result: ExternalOperationCancellationProviderResult,
  ): Promise<ExternalOperationRecord> {
    const current = this.inspect(result.identity.operationId);
    if (current && !sameGoalFence(current.goalFence, result.identity.fence)) {
      return current;
    }
    const recorded = await this.mutateIdentity(
      result.identity,
      (operation, now) => {
        const cancellation = operation.cancellation;
        if (!cancellation || cancellation.requestId !== result.cancellationRequestId) {
          return;
        }
        if (isExternalOperationTerminalState(operation.state)) {
          return;
        }
        cancellation.accepted = result.accepted;
        cancellation.state = result.accepted ? "accepted" : "rejected";
        delete cancellation.retryAt;
        cancellation.acknowledgedAt = now;
        cancellation.lastError = boundedOptionalString(result.error);
        operation.lastError = cancellation.lastError;
        this.touch(operation, now);
      },
      true,
    );
    this.clearCancellationRetry(result.identity.operationId);
    if (result.observation && recorded.cancellation?.requestId === result.cancellationRequestId) {
      return await this.applyObservation(recorded.operationId, result.observation, recorded, true);
    }
    return recorded;
  }

  private scheduleCancellationRetry(operation: ExternalOperationRecord): void {
    const cancellation = operation.cancellation;
    if (
      this.stopping ||
      this.stopped ||
      !cancellation ||
      cancellation.state !== "requested" ||
      cancellation.deliveryAttempts >= MAX_CANCELLATION_DELIVERY_ATTEMPTS
    ) {
      return;
    }
    this.clearCancellationRetry(operation.operationId);
    const retryAt = cancellation.retryAt ? Date.parse(cancellation.retryAt) : this.now();
    const timer = setTimeout(
      () => {
        this.cancellationRetryTimers.delete(operation.operationId);
        const current = this.inspect(operation.operationId);
        if (
          !current?.cancellation ||
          current.cancellation.state !== "requested" ||
          isExternalOperationTerminalState(current.state) ||
          this.stopping ||
          this.stopped
        ) {
          return;
        }
        void this.deliverCancellationRequest(
          current,
          identityOf(current),
          current.cancellation.requestId,
        ).catch(() => {
          log
            .with({ operationId: operation.operationId })
            .warn("Cancellation retry delivery failed");
        });
      },
      Math.max(0, retryAt - this.now()),
    );
    timer.unref?.();
    this.cancellationRetryTimers.set(operation.operationId, timer);
  }

  private clearCancellationRetry(operationId: string): void {
    const timer = this.cancellationRetryTimers.get(operationId);
    if (timer) clearTimeout(timer);
    this.cancellationRetryTimers.delete(operationId);
  }

  private async finalizeTerminal(
    identity: ExternalOperationIdentity,
    state: ExternalOperationTerminalState,
    options: {
      result?: ExternalOperationJson;
      error?: string;
      receipt?: Record<string, ExternalOperationJson>;
      exactProcess?: ExternalOperationExactProcessIdentity;
      claimToken?: string;
      preDispatch?: boolean;
      allowDuringStopping?: boolean;
    } = {},
  ): Promise<ExternalOperationRecord> {
    const terminal = await this.mutateIdentity(
      identity,
      (operation, now) => {
        if (operation.terminalEvent) {
          if (operation.terminalEvent.state !== state) {
            throw new Error(
              `External operation ${operation.operationId} is already terminal as ${operation.terminalEvent.state}`,
            );
          }
          return;
        }
        const preDispatch = !operation.receipt && operation.publicRecord.status === "planned";
        if (preDispatch) {
          if (!options.preDispatch || state === "succeeded") {
            throw new Error(
              `External operation ${operation.operationId} cannot terminalize before dispatch`,
            );
          }
        } else {
          if (!operation.receipt) {
            throw new Error(`External operation ${operation.operationId} has no provider receipt`);
          }
          this.assertDispatchClaim(operation, options.claimToken);
        }
        if (options.receipt) {
          if (!operation.receipt) throw new Error("Terminal observation cannot create a receipt");
          operation.receipt = sanitizeJsonObject(
            { ...operation.receipt, ...options.receipt },
            "receipt",
          );
        }
        if (options.exactProcess) {
          this.setExactProcessIdentity(operation, options.exactProcess);
        }
        operation.state = state;
        operation.lastObservedAt = now;
        operation.lastError = boundedOptionalString(options.error);
        delete operation.watcherLease;
        delete operation.dispatchClaim;
        const terminalIdempotencyKey = `external-operation-terminal:${operation.operationId}:${state}`;
        operation.terminalEvent = {
          eventId: this.createId(),
          idempotencyKey: terminalIdempotencyKey,
          state,
          occurredAt: now,
          result: compactResult(options.result),
          error: operation.lastError,
        };
        operation.publicRecord.status = state;
        operation.publicRecord.updatedAt = now;
        operation.publicRecord.completedAt = now;
        operation.publicRecord.resultSummary = resultSummary(operation.terminalEvent.result);
        operation.publicRecord.errorDigest = digestOptionalText(operation.lastError);
        if (state === "cancelled" && operation.cancellation) {
          operation.cancellation.state = "accepted";
          operation.cancellation.accepted = true;
          operation.cancellation.acknowledgedAt = now;
        }
        if (!operation.retention.retainUntil) {
          operation.retention.retainUntil = new Date(
            this.now() +
              Math.max(
                0,
                operation.retention.retentionMs ??
                  terminalRetentionMs(state, this.defaultTerminalRetentionMs),
              ),
          ).toISOString();
        }
        if (operation.terminalNotification) {
          operation.notification = {
            state: "pending",
            idempotencyKey: operation.terminalNotification.idempotencyKey ?? terminalIdempotencyKey,
          };
        } else {
          operation.notification = { state: "not-required" };
        }
        this.touch(operation, now);
      },
      options.allowDuringStopping,
    );
    await this.ensureTerminalNotification(identity.operationId);
    await this.prune();
    return this.requireOperationOr(terminal);
  }

  private async ensureTerminalNotification(operationId: string): Promise<void> {
    const existingFlight = this.notificationFlights.get(operationId);
    if (existingFlight) return await existingFlight;
    const flight = this.deliverTerminalNotification(operationId).finally(() => {
      if (this.notificationFlights.get(operationId) === flight) {
        this.notificationFlights.delete(operationId);
      }
    });
    this.notificationFlights.set(operationId, flight);
    await flight;
  }

  private async deliverTerminalNotification(operationId: string): Promise<void> {
    const operation = this.inspect(operationId);
    if (
      !operation?.terminalEvent ||
      !operation.terminalNotification ||
      operation.notification.state !== "pending"
    ) {
      return;
    }
    const outbox = this.notificationOutbox;
    if (!outbox) return;
    const notification = operation.terminalNotification;
    const idempotencyKey =
      operation.notification.idempotencyKey ?? operation.terminalEvent.idempotencyKey;
    const attemptedAt = this.nowIso();
    try {
      const acceptance = await outbox.enqueue({
        idempotencyKey,
        source: `external-operation:${operation.operationId}`,
        target: notification.target,
        kind: notification.kind ?? "goal-terminal",
        deliveryMode: notification.deliveryMode ?? "queue",
        priority: notification.priority ?? 50,
        content: notification.content,
      });
      await this.mutate(
        operationId,
        (current, now) => {
          if (
            current.notification.state !== "pending" ||
            current.terminalEvent?.eventId !== operation.terminalEvent?.eventId
          ) {
            return;
          }
          current.notification = {
            state: "accepted",
            idempotencyKey,
            messageId: acceptance.messageId,
            acceptedAt: now,
            lastAttemptAt: attemptedAt,
          };
          this.touch(current, now);
        },
        true,
      );
    } catch (error) {
      await this.mutate(
        operationId,
        (current, now) => {
          if (current.notification.state !== "pending") return;
          current.notification.lastAttemptAt = attemptedAt;
          current.notification.lastError = boundedOptionalString(formatError(error));
          current.updatedAt = now;
        },
        true,
      );
      return;
    }
    await this.prune();
  }

  private async mutate(
    operationId: string,
    mutation: (operation: ExternalOperationRecord, now: string) => void,
    allowDuringStopping = false,
  ): Promise<ExternalOperationRecord> {
    return await this.runExclusive(async () => {
      this.assertWritable(allowDuringStopping);
      const operation = this.records.get(operationId);
      if (!operation) throw new Error(`Unknown external operation: ${operationId}`);
      const previous = cloneOperation(operation);
      try {
        mutation(operation, this.nowIso());
        await this.persistLocked();
      } catch (error) {
        this.records.set(operationId, previous);
        throw error;
      }
      this.notify(operation);
      return cloneOperation(operation);
    });
  }

  private async mutateIdentity(
    identity: ExternalOperationIdentity,
    mutation: (operation: ExternalOperationRecord, now: string) => void,
    allowDuringStopping = false,
  ): Promise<ExternalOperationRecord> {
    return await this.runExclusive(async () => {
      this.assertWritable(allowDuringStopping);
      const operation = this.requireIdentityLocked(identity);
      const previous = cloneOperation(operation);
      try {
        mutation(operation, this.nowIso());
        await this.persistLocked();
      } catch (error) {
        this.records.set(operation.operationId, previous);
        throw error;
      }
      this.notify(operation);
      return cloneOperation(operation);
    });
  }

  private requireIdentityLocked(identity: ExternalOperationIdentity): ExternalOperationRecord {
    const operation = this.records.get(identity.operationId);
    if (!operation) throw new Error(`Unknown external operation: ${identity.operationId}`);
    assertIdentityMatches(operation, identity);
    return operation;
  }

  private requireRecord(operationId: string): ExternalOperationRecord {
    const operation = this.records.get(operationId);
    if (!operation) throw new Error(`Unknown external operation: ${operationId}`);
    return operation;
  }

  private assertDispatchClaim(
    operation: ExternalOperationRecord,
    claimToken: string | undefined,
    requireFresh = false,
  ): void {
    const claim = operation.dispatchClaim;
    if (!claim || !claimToken || claim.claimToken !== claimToken) {
      throw new Error(`External operation dispatch claim mismatch: ${operation.operationId}`);
    }
    if (requireFresh && Date.parse(claim.leaseExpiresAt) <= this.now()) {
      throw new Error(`External operation dispatch claim expired: ${operation.operationId}`);
    }
  }

  private touch(operation: ExternalOperationRecord, now: string): void {
    operation.updatedAt = now;
    operation.publicRecord.updatedAt = now;
  }

  private createWatcherLease(
    ownerId: string,
    leaseDurationMs: number,
    acquiredAt: string,
    leaseId = this.createId(),
  ) {
    return {
      leaseId,
      ownerId: requireBoundedString(ownerId, "ownerId"),
      acquiredAt,
      expiresAt: new Date(this.now() + Math.max(1, leaseDurationMs)).toISOString(),
    };
  }

  private setExactProcessIdentity(
    operation: ExternalOperationRecord,
    identity: ExternalOperationExactProcessIdentity,
  ): boolean {
    validateExactProcessIdentity(identity);
    if (!operation.exactProcess) {
      operation.exactProcess = structuredClone(identity);
      return true;
    }
    if (sameExactProcessIdentity(operation.exactProcess, identity)) return false;
    throw new Error(
      `External operation ${operation.operationId} already has a different exact process identity`,
    );
  }

  private assertAdapterCompatibility(operation: ExternalOperationRecord): void {
    const adapter = this.adapters.get(operation.provider.adapterId);
    if (adapter && !adapter.providerKinds.has(operation.provider.kind)) {
      throw new Error(
        `Adapter ${adapter.adapterId} does not support provider kind ${operation.provider.kind}`,
      );
    }
  }

  private assertNonTerminal(operation: ExternalOperationRecord): void {
    if (isExternalOperationTerminalState(operation.state)) {
      throw new Error(
        `External operation ${operation.operationId} is already terminal as ${operation.state}`,
      );
    }
  }

  private assertWritable(allowDuringStopping = false): void {
    this.assertStarted();
    if (this.stopped || (this.stopping && !allowDuringStopping)) {
      throw new Error("External-operation registry is shutting down");
    }
  }

  private assertStarted(): void {
    if (!this.started) throw new Error("External-operation registry has not started");
  }

  private requireOperationOr(fallback: ExternalOperationRecord): ExternalOperationRecord {
    return this.inspect(fallback.operationId) ?? fallback;
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private async persistLocked(): Promise<void> {
    await this.store.save([...this.records.values()]);
  }

  private notify(operation: ExternalOperationRecord): void {
    const snapshot = cloneOperation(operation);
    for (const listener of this.listeners.get(operation.operationId) ?? []) {
      listener(snapshot);
    }
  }

  private pruneTerminalLocked(): boolean {
    const now = this.now();
    let changed = false;
    const removable = [...this.records.values()]
      .filter(
        (operation) =>
          isExternalOperationTerminalState(operation.state) &&
          isExternalOperationFollowThroughComplete(operation),
      )
      .sort(
        (left, right) =>
          Date.parse(left.terminalEvent?.occurredAt ?? left.updatedAt) -
          Date.parse(right.terminalEvent?.occurredAt ?? right.updatedAt),
      );

    for (const operation of removable) {
      const retainUntil = operation.retention.retainUntil;
      if (retainUntil && Date.parse(retainUntil) > now) continue;
      this.records.delete(operation.operationId);
      changed = true;
    }

    const retainedTerminal = removable.filter((operation) =>
      this.records.has(operation.operationId),
    );
    const overflow = Math.max(0, retainedTerminal.length - this.maxTerminalRecords);
    for (const operation of retainedTerminal.slice(0, overflow)) {
      this.records.delete(operation.operationId);
      changed = true;
    }
    return changed;
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function normalizeWatcher(
  watcher?: Partial<ExternalOperationRecord["watcher"]>,
  fallback?: ExternalOperationRecord["watcher"],
): ExternalOperationRecord["watcher"] {
  const intervalMs = watcher?.intervalMs ?? fallback?.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  const leaseDurationMs =
    watcher?.leaseDurationMs ?? fallback?.leaseDurationMs ?? DEFAULT_WATCH_LEASE_MS;
  return {
    strategy: watcher?.strategy ?? fallback?.strategy ?? "poll",
    intervalMs: Math.max(
      100,
      Math.floor(Number.isFinite(intervalMs) ? intervalMs : DEFAULT_WATCH_INTERVAL_MS),
    ),
    leaseDurationMs: Math.max(
      1_000,
      Math.floor(Number.isFinite(leaseDurationMs) ? leaseDurationMs : DEFAULT_WATCH_LEASE_MS),
    ),
    lastCheckedAt: watcher?.lastCheckedAt ?? fallback?.lastCheckedAt,
    nextCheckAt: watcher?.nextCheckAt ?? fallback?.nextCheckAt,
  };
}

function matchesFilter(
  operation: ExternalOperationRecord,
  filter: ExternalOperationListFilter,
): boolean {
  if (filter.includeTerminal === false && isExternalOperationTerminalState(operation.state)) {
    return false;
  }
  if (filter.goalId && operation.goalFence.goalId !== filter.goalId) return false;
  if (filter.providerKind && operation.provider.kind !== filter.providerKind) return false;
  if (filter.states && !filter.states.includes(operation.state)) return false;
  if (filter.relatedSessionId && !isRelatedToSession(operation, filter.relatedSessionId)) {
    return false;
  }
  return true;
}

function isRelatedToSession(operation: ExternalOperationRecord, sessionId: string): boolean {
  return (
    operation.metadata.launcherSessionId === sessionId ||
    operation.metadata.sessionId === sessionId ||
    operation.identity.sessionId === sessionId ||
    operation.identity.subagentSessionId === sessionId ||
    operation.terminalNotification?.target === sessionId
  );
}

function sameInspectionTarget(
  current: ExternalOperationRecord,
  inspected: ExternalOperationRecord,
): boolean {
  return (
    sameGoalFence(current.goalFence, inspected.goalFence) &&
    current.provider.adapterId === inspected.provider.adapterId &&
    JSON.stringify(current.receipt) === JSON.stringify(inspected.receipt)
  );
}

function sameGoalFence(
  left: ExternalOperationRecord["goalFence"],
  right: ExternalOperationRecord["goalFence"],
): boolean {
  return left.goalId === right.goalId && left.epoch === right.epoch;
}

function cloneOperation(operation: ExternalOperationRecord): ExternalOperationRecord {
  return structuredClone(operation);
}

function formatError(error: unknown): string {
  const formatted = error instanceof Error ? error.message : String(error);
  return formatted.trim() || "Unknown external-operation error";
}

function validateRegisterInput(input: RegisterExternalOperationInput): void {
  const request = input.request;
  requireBoundedString(request.operationId, "request.operationId");
  requireBoundedString(request.idempotencyKey, "request.idempotencyKey");
  requireBoundedString(request.kind, "request.kind");
  requireBoundedString(request.requestedAt, "request.requestedAt");
  requireBoundedString(request.fence.goalId, "request.fence.goalId");
  if (!Number.isInteger(request.fence.epoch) || request.fence.epoch < 0) {
    throw new Error("request.fence.epoch must be a non-negative integer");
  }
  requireBoundedString(input.provider.provider, "provider.provider");
  requireBoundedString(input.provider.adapterId, "provider.adapterId");
  if (request.inputFingerprint !== undefined) {
    requireBoundedString(request.inputFingerprint, "request.inputFingerprint");
  }
  if (request.assignmentId !== undefined) {
    requireBoundedString(request.assignmentId, "request.assignmentId");
  }
  if (request.criterionIds && request.criterionIds.length > MAX_JSON_ENTRIES) {
    throw new Error("request.criterionIds exceeds the maximum item count");
  }
  for (const [index, criterionId] of (request.criterionIds ?? []).entries()) {
    requireBoundedString(criterionId, `request.criterionIds[${index}]`);
  }
  if (
    input.runtimeIdentity?.processId !== undefined &&
    (!Number.isInteger(input.runtimeIdentity.processId) || input.runtimeIdentity.processId < 1)
  ) {
    throw new Error("runtimeIdentity.processId must be a positive integer");
  }
  if (input.metadata) sanitizeJsonObject(metadataAsJson(input.metadata), "metadata");
  if (input.terminalNotification) {
    requireBoundedString(input.terminalNotification.target, "terminalNotification.target");
    requireBoundedString(input.terminalNotification.content, "terminalNotification.content");
    if (input.terminalNotification.idempotencyKey !== undefined) {
      requireBoundedString(
        input.terminalNotification.idempotencyKey,
        "terminalNotification.idempotencyKey",
      );
    }
  }
}

function validateExactProcessIdentity(identity: ExternalOperationExactProcessIdentity): void {
  requireBoundedString(identity.ownerSessionId, "exactProcess.ownerSessionId");
  if (!Number.isInteger(identity.rootPid) || identity.rootPid < 1) {
    throw new Error("exactProcess.rootPid must be a positive integer");
  }
  if (!Number.isFinite(identity.spawnedAtMs) || identity.spawnedAtMs < 0) {
    throw new Error("exactProcess.spawnedAtMs must be a non-negative finite number");
  }
  if (identity.startIdentity !== undefined) {
    requireBoundedString(identity.startIdentity, "exactProcess.startIdentity");
  }
  if (identity.processGroupId !== undefined) {
    requireBoundedString(identity.processGroupId, "exactProcess.processGroupId");
  }
}

function sameExactProcessIdentity(
  left: ExternalOperationExactProcessIdentity,
  right: ExternalOperationExactProcessIdentity,
): boolean {
  return (
    left.ownerSessionId === right.ownerSessionId &&
    left.rootPid === right.rootPid &&
    left.spawnedAtMs === right.spawnedAtMs &&
    left.startIdentity === right.startIdentity &&
    left.processGroupId === right.processGroupId
  );
}

function assertRegistrationCompatible(
  operation: ExternalOperationRecord,
  input: RegisterExternalOperationInput,
): void {
  const request = input.request;
  if (
    operation.operationId !== request.operationId ||
    !sameGoalFence(operation.goalFence, request.fence) ||
    operation.provider.kind !== input.provider.kind ||
    operation.provider.provider !== input.provider.provider ||
    operation.provider.adapterId !== input.provider.adapterId ||
    operation.publicRecord.kind !== request.kind ||
    operation.publicRecord.effect !== request.effect ||
    operation.publicRecord.inputFingerprint !== request.inputFingerprint ||
    operation.publicRecord.assignmentId !== request.assignmentId
  ) {
    throw new Error(`External operation idempotency conflict: ${request.idempotencyKey}`);
  }
}

function assertIdentityMatches(
  operation: ExternalOperationRecord,
  identity: ExternalOperationIdentity,
): void {
  if (
    operation.operationId !== identity.operationId ||
    operation.idempotencyKey !== identity.idempotencyKey ||
    !sameGoalFence(operation.goalFence, identity.fence) ||
    operation.publicRecord.assignmentId !== identity.assignmentId
  ) {
    throw new Error(`External operation identity conflict: ${identity.operationId}`);
  }
}

function identityOf(operation: ExternalOperationRecord): ExternalOperationIdentity {
  return {
    operationId: operation.operationId,
    fence: structuredClone(operation.goalFence),
    idempotencyKey: operation.idempotencyKey,
    assignmentId: operation.publicRecord.assignmentId,
  };
}

function normalizeLeaseDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error("leaseDurationMs must be positive");
  return Math.floor(value);
}

function receiptReference(receipt: Record<string, ExternalOperationJson>): string {
  const explicit = receipt.externalReference;
  return typeof explicit === "string"
    ? requireBoundedString(explicit, "receipt.externalReference")
    : "attached";
}

function resultSummary(result: ExternalOperationJson | undefined): string | undefined {
  if (result === undefined) return undefined;
  if (typeof result === "string") return result.slice(0, MAX_STRING_LENGTH);
  if (result === null || typeof result === "boolean" || typeof result === "number") {
    return String(result);
  }
  return "[structured result]";
}

function terminalRetentionMs(state: ExternalOperationTerminalState, fallback: number): number {
  if (state === "failed") return Math.max(fallback, 14 * 24 * 60 * 60_000);
  if (state === "cancelled") return Math.min(fallback, 3 * 24 * 60 * 60_000);
  if (state === "superseded") return Math.min(fallback, 24 * 60 * 60_000);
  if (state === "surrendered") return Math.max(fallback, 14 * 24 * 60 * 60_000);
  return fallback;
}

function internalStateForPublicStatus(
  status: ExternalOperationRecord["publicRecord"]["status"],
): ExternalOperationState {
  if (status === "planned") return "registered";
  return status;
}

function digestOptionalText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function boundedOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const redacted = value
    .replace(/bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:token|secret|password)=\S+/gi, "[redacted]");
  return requireBoundedString(redacted, "string");
}

function requireBoundedString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  if (normalized.length > MAX_STRING_LENGTH) {
    throw new Error(`${label} exceeds ${MAX_STRING_LENGTH} characters`);
  }
  return normalized;
}

function metadataAsJson(
  metadata: RegisterExternalOperationInput["metadata"],
): Record<string, ExternalOperationJson> {
  return {
    ...(metadata?.sessionId ? { sessionId: metadata.sessionId } : {}),
    ...(metadata?.launcherSessionId ? { launcherSessionId: metadata.launcherSessionId } : {}),
    ...(metadata?.runId ? { runId: metadata.runId } : {}),
    ...(metadata?.provider ? { provider: metadata.provider } : {}),
    ...(metadata?.capturedAt ? { capturedAt: metadata.capturedAt } : {}),
    ...(metadata?.values ? { values: metadata.values } : {}),
  };
}

function sanitizeMetadata(
  metadata: RegisterExternalOperationInput["metadata"],
): NonNullable<RegisterExternalOperationInput["metadata"]> {
  if (!metadata) return {};
  const sanitized = sanitizeJsonObject(metadataAsJson(metadata), "metadata");
  return {
    sessionId: readSanitizedString(sanitized.sessionId),
    launcherSessionId: readSanitizedString(sanitized.launcherSessionId),
    runId: readSanitizedString(sanitized.runId),
    provider: readSanitizedObject(sanitized.provider),
    capturedAt: readSanitizedString(sanitized.capturedAt),
    values: readSanitizedObject(sanitized.values),
  };
}

function readSanitizedString(value: ExternalOperationJson | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readSanitizedObject(
  value: ExternalOperationJson | undefined,
): Record<string, ExternalOperationJson> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function sanitizeJsonObject(
  value: Record<string, ExternalOperationJson>,
  label: string,
): Record<string, ExternalOperationJson> {
  const sanitized = sanitizeJson(value, label, 0);
  if (sanitized === null || Array.isArray(sanitized) || typeof sanitized !== "object") {
    throw new Error(`${label} must be an object`);
  }
  return sanitized;
}

function sanitizeJson(
  value: ExternalOperationJson,
  label: string,
  depth: number,
): ExternalOperationJson {
  if (depth > MAX_JSON_DEPTH) throw new Error(`${label} exceeds maximum JSON depth`);
  if (typeof value === "string") return requireBoundedString(value, label);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ENTRIES) throw new Error(`${label} has too many entries`);
    return value.map((item, index) => sanitizeJson(item, `${label}[${index}]`, depth + 1));
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_JSON_ENTRIES) throw new Error(`${label} has too many fields`);
  return Object.fromEntries(
    entries.map(([key, item]) => [
      requireBoundedString(key, `${label} key`),
      SENSITIVE_FIELD_RE.test(key)
        ? "[redacted]"
        : sanitizeJson(item, `${label}.${key}`, depth + 1),
    ]),
  );
}

function compactResult(
  value: ExternalOperationJson | undefined,
): ExternalOperationJson | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return { type: "text", length: value.length };
  if (Array.isArray(value)) return { type: "array", length: value.length };
  return {
    type: "object",
    keys: Object.keys(value)
      .filter((key) => !SENSITIVE_FIELD_RE.test(key))
      .slice(0, 20),
  };
}
