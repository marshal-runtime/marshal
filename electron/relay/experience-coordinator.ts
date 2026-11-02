import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

import { createLogger } from "../../common/marshal-logger";
import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayMessageId,
  parseRelayProviderId,
  type RelayAddress,
  type RelayAttachment,
  type RelayInteractionSelection,
  type RelayPublishRequest,
} from "../../common/relay-contract";
import type {
  RelayAccountScope,
  RelayExperienceResult,
  RelayPublicationEnqueueReceipt,
  RelayPublicationErrorCode,
  RelayPublicationIntent,
} from "../../common/relay-experience-contract";
import {
  RelayBindingStore,
  type RelayBinding,
  type RelayBindingRetirement,
  type RelayBindingWithActivity,
} from "./bindings";
import type {
  RelayConnectionStatus,
  RelayInboundMessageEvent,
  RelayProviderEvent,
  RelayPublishReceipt,
} from "./contracts";
import type {
  RelayEnsuredSessionAccessPoint,
  RelayEnsureSessionAccessPointRequest,
} from "./host-experience/types";
import { InboundAcceptanceJournal, type AcceptedInboundRecord } from "./inbound-acceptance";
import { RelayInteractionManager } from "./interactions";
import { RelayMessageCorrelationStore } from "./message-correlation";
import { RelayPublicationOutbox, type RelayPublication } from "./publication-outbox";
import { RelayProviderRegistry } from "./registry";
import { RelayDatabase } from "./relay-database";

const log = createLogger("RelayExperienceCoordinator");
const PUBLICATION_LEASE_MS = 60_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 15 * 60_000;
const DEFAULT_STALE_THRESHOLD_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60_000;
const INBOUND_RECOVERY_BATCH_SIZE = 100;

export interface RelayInboundRouteContext {
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly acceptedAt: string;
}

export interface RelayInboundRouteResult {
  readonly localMessageId: string;
  readonly sessionId?: string;
  readonly afterCommit?: () => Promise<void>;
}

export interface RelayAccountExperienceRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  routeInbound(
    event: RelayInboundMessageEvent,
    context: RelayInboundRouteContext,
  ): Promise<string | RelayInboundRouteResult>;
  discardInbound?(event: RelayInboundMessageEvent): Promise<void>;
  statusChanged?(status: RelayConnectionStatus): void | Promise<void>;
  authorizeInteractionSelection?(selection: RelayInteractionSelection): boolean | Promise<boolean>;
  ensureSessionAccessPoint?(
    request: RelayEnsureSessionAccessPointRequest,
  ): Promise<RelayEnsuredSessionAccessPoint>;
}

export interface RelayNotificationTarget {
  readonly providerKey: string;
  readonly address: RelayAddress;
}

export type RelayNotificationKind = "default" | "progress";

export interface RelayNotificationPublisher {
  hasDestinations(kind: RelayNotificationKind): boolean;
  publish(kind: RelayNotificationKind, text: string, sourceSessionId?: string): Promise<void>;
}

export interface RelayExperienceCoordinatorOptions {
  readonly registry: RelayProviderRegistry;
  readonly database: RelayDatabase;
  readonly getNotificationTargets?: (
    kind: RelayNotificationKind,
  ) => readonly RelayNotificationTarget[];
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly getProgressIntervalMs?: () => number;
  readonly isSessionOrDescendantBusy?: (sessionId: string) => boolean;
  readonly requestProgressUpdate?: (request: RelayProgressUpdateRequest) => Promise<boolean>;
  readonly staleThresholdMs?: number;
  readonly maintenanceIntervalMs?: number;
}

export interface RelaySessionAccessPointContext {
  readonly bindingId: string;
  readonly address: RelayAddress;
  readonly lastInboundAt?: string;
  readonly lastPublicationAt?: string;
  readonly lastSessionActivityAt?: string;
}

export interface RelaySessionContext {
  readonly sessionId: string;
  readonly accessPoints: readonly RelaySessionAccessPointContext[];
}

export interface RelaySessionPublicationRequest {
  readonly sessionId: string;
  readonly text: string;
  readonly idempotencyKey: string;
  readonly requestedAt?: string;
  readonly accessPointIds?: readonly string[];
  readonly kind?: RelayPublishRequest["kind"];
  readonly replyToProviderMessageId?: string;
  readonly sourceTurnId?: string;
}

export interface RelaySessionPublicationResult {
  readonly publications: readonly RelayPublicationEnqueueReceipt[];
}

export interface RelayProgressUpdateRequest {
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
  readonly context: RelaySessionContext;
}

interface PublicationCompletion {
  readonly promise: Promise<RelayPublishReceipt>;
  readonly resolve: (receipt: RelayPublishReceipt) => void;
  readonly reject: (error: unknown) => void;
}

interface InboundDispatchOutcome {
  readonly ok: boolean;
  readonly error?: unknown;
}

interface InboundDispatchClaim {
  readonly promise: Promise<InboundDispatchOutcome>;
  readonly settle: (outcome: InboundDispatchOutcome) => void;
}

type PreparedInbound =
  | {
      readonly kind: "discard";
      readonly event: RelayInboundMessageEvent;
      readonly runtime: RelayAccountExperienceRuntime | undefined;
    }
  | {
      readonly kind: "dispatch";
      readonly event: RelayInboundMessageEvent;
      readonly record: AcceptedInboundRecord;
      readonly claim: InboundDispatchClaim;
      readonly owner: boolean;
      readonly runtime: RelayAccountExperienceRuntime | undefined;
    };

export class RelayExperienceCoordinator {
  readonly notifications: RelayNotificationPublisher;
  readonly bindings: RelayBindingStore;
  readonly interactions: RelayInteractionManager;

  private readonly registry: RelayProviderRegistry;
  private readonly database: RelayDatabase;
  private readonly journal: InboundAcceptanceJournal;
  private readonly correlations: RelayMessageCorrelationStore;
  private readonly outbox: RelayPublicationOutbox;
  private readonly runtimes = new Map<string, RelayAccountExperienceRuntime>();
  private readonly runtimeAccounts = new Map<string, RelayAccountScope>();
  private readonly retirementAccountOverrides = new Map<string, string>();
  private readonly readyRuntimeKeys = new Set<string>();
  private readonly sessionOrigins = new Map<string, RelayAddress>();
  private readonly addressQueues = new Map<string, Promise<void>>();
  private readonly addressQueueVersions = new Map<string, number>();
  private readonly addressQueueContext = new AsyncLocalStorage<ReadonlySet<string>>();
  private readonly inboundDispatches = new Map<string, InboundDispatchClaim>();
  private readonly publicationCompletions = new Map<string, PublicationCompletion>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly getProgressIntervalMs: () => number;
  private readonly isSessionOrDescendantBusy: (sessionId: string) => boolean;
  private readonly requestProgressUpdate:
    | ((request: RelayProgressUpdateRequest) => Promise<boolean>)
    | undefined;
  private readonly staleThresholdMs: number;
  private readonly maintenanceIntervalMs: number;
  private readonly getNotificationTargets: NonNullable<
    RelayExperienceCoordinatorOptions["getNotificationTargets"]
  >;
  private unsubscribeRegistry: (() => void) | undefined;
  private publicationPump: Promise<void> | undefined;
  private publicationRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private maintenanceTimer: ReturnType<typeof setTimeout> | undefined;
  private maintenanceRun: Promise<void> | undefined;
  private started = false;
  private stopping = false;

  constructor(options: RelayExperienceCoordinatorOptions) {
    this.registry = options.registry;
    this.database = options.database;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.getProgressIntervalMs =
      options.getProgressIntervalMs ?? (() => DEFAULT_PROGRESS_INTERVAL_MS);
    this.isSessionOrDescendantBusy = options.isSessionOrDescendantBusy ?? (() => false);
    this.requestProgressUpdate = options.requestProgressUpdate;
    this.staleThresholdMs = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
    this.getNotificationTargets = options.getNotificationTargets ?? (() => []);
    this.journal = new InboundAcceptanceJournal(this.database, {
      now: this.now,
      createId: this.createId,
    });
    this.bindings = new RelayBindingStore(this.database, {
      now: this.now,
      createId: this.createId,
    });
    this.correlations = new RelayMessageCorrelationStore(this.database, { now: this.now });
    this.outbox = new RelayPublicationOutbox(this.database, {
      now: this.now,
      createId: this.createId,
    });
    this.interactions = new RelayInteractionManager(this.registry, this.database, this.now);
    this.notifications = {
      hasDestinations: (kind) => this.getNotificationTargets(kind).length > 0,
      publish: (kind, text, sourceSessionId) =>
        this.publishNotification(kind, text, sourceSessionId),
    };
  }

  registerAccountRuntime(
    account: RelayAccountScope,
    runtime: RelayAccountExperienceRuntime,
  ): () => void {
    const key = accountKey(account);
    if (this.runtimes.has(key)) {
      throw new Error(`Relay account runtime is already registered: ${key}`);
    }
    this.runtimes.set(key, runtime);
    this.runtimeAccounts.set(key, account);
    if (this.started && !this.stopping) {
      void runtime.start().then(
        async () => {
          if (this.runtimes.get(key) !== runtime) return;
          this.readyRuntimeKeys.add(key);
          await this.recoverAcceptedForAccount(account);
        },
        (error: unknown) => log.error("Relay account runtime startup failed:", error),
      );
    }
    return () => {
      if (this.runtimes.get(key) === runtime) {
        this.runtimes.delete(key);
        this.runtimeAccounts.delete(key);
        this.readyRuntimeKeys.delete(key);
      }
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.stopping) throw new Error("Relay experience coordinator is stopping");
    this.started = true;
    this.unsubscribeRegistry = this.registry.subscribe((event) => this.handleProviderEvent(event));
    this.outbox.recoverAfterRestart(this.now());
    this.interactions.recoverAfterRestart();
    await this.recoverPendingRetirements();

    const starts = await Promise.allSettled(
      [...this.runtimes.entries()].map(async ([key, runtime]) => {
        await runtime.start();
        return key;
      }),
    );
    for (const result of starts) {
      if (result.status === "fulfilled") {
        this.readyRuntimeKeys.add(result.value);
      } else {
        log.error("Relay account runtime startup failed:", result.reason);
      }
    }

    for (const key of this.readyRuntimeKeys) {
      const account = this.runtimeAccounts.get(key);
      if (!account) continue;
      // eslint-disable-next-line no-await-in-loop -- account recovery preserves each account's journal order
      await this.recoverAcceptedForAccount(account);
    }
    await this.drainPublications();
    this.scheduleMaintenance(0);
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopping) return;
    this.stopping = true;
    this.interactions.cancelAll("coordinator-stopped");
    if (this.publicationRetryTimer) clearTimeout(this.publicationRetryTimer);
    this.publicationRetryTimer = undefined;
    if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer);
    this.maintenanceTimer = undefined;
    this.unsubscribeRegistry?.();
    this.unsubscribeRegistry = undefined;
    await Promise.allSettled(this.addressQueues.values());
    this.addressQueues.clear();
    this.addressQueueVersions.clear();
    await Promise.allSettled([...this.inboundDispatches.values()].map((claim) => claim.promise));
    this.inboundDispatches.clear();
    await this.publicationPump;
    await this.maintenanceRun;
    for (const completion of this.publicationCompletions.values()) {
      completion.reject(new Error("Relay coordinator stopped before publication completed"));
    }
    this.publicationCompletions.clear();
    const stops = await Promise.allSettled(
      [...this.runtimes.values()].map((runtime) => runtime.stop()),
    );
    for (const result of stops) {
      if (result.status === "rejected") {
        log.error("Relay account runtime shutdown failed:", result.reason);
      }
    }
    this.started = false;
    this.stopping = false;
    this.readyRuntimeKeys.clear();
  }

  async startAccount(account: RelayAccountScope): Promise<void> {
    const key = accountKey(account);
    const runtime = this.runtimes.get(key);
    await runtime?.start();
    if (runtime) this.readyRuntimeKeys.add(key);
    await this.registry.connect(account.providerId, account.accountId);
    await this.recoverAcceptedForAccount(account);
  }

  async stopAccount(account: RelayAccountScope): Promise<void> {
    const key = accountKey(account);
    const runtime = this.runtimes.get(key);
    await Promise.allSettled([
      this.registry.disconnect(account.providerId, account.accountId),
      runtime?.stop() ?? Promise.resolve(),
    ]);
    this.readyRuntimeKeys.delete(key);
  }

  async ensureSessionAccessPoint(
    account: RelayAccountScope,
    request: RelayEnsureSessionAccessPointRequest,
  ): Promise<RelayEnsuredSessionAccessPoint> {
    const runtime = this.runtimes.get(accountKey(account));
    const ensureSessionAccessPoint = runtime?.ensureSessionAccessPoint;
    if (!ensureSessionAccessPoint) {
      throw new Error(
        `Relay account ${account.providerId}/${account.accountId} cannot create access points`,
      );
    }
    const existing = this.bindings
      .listSessionAccessPoints(request.sessionId)
      .find(
        ({ binding }) =>
          binding.provider === account.providerId && binding.accountId === account.accountId,
      );
    const retirement = this.bindings
      .listRetirements({
        provider: account.providerId,
        accountId: account.accountId,
        localConversationId: request.sessionId,
      })
      .find((candidate) => candidate.role === "session");
    const current = existing?.binding ?? retirement;
    if (current) {
      return this.runAddressExclusive(addressFromBinding(current), async () => {
        const ensured = await ensureSessionAccessPoint(request);
        if (retirement) {
          if (ensured.binding.bindingId !== retirement.bindingId) {
            throw new Error("Relay access-point reopen changed its durable binding identity");
          }
          const updatedAtMs = timestampMs(request.requestedAt, this.now());
          this.bindings.reactivateRetirement({
            bindingId: retirement.bindingId,
            provider: ensured.group.address.providerId,
            accountId: ensured.group.address.accountId,
            externalConversationId: ensured.group.address.conversationId,
            localConversationId: request.sessionId,
            role: "session",
            updatedAtMs,
          });
          this.bindings.recordActivity(retirement.bindingId, "session", updatedAtMs);
        }
        return ensured;
      });
    }
    return ensureSessionAccessPoint(request);
  }

  listSessionAccessPoints(sessionId: string): readonly RelayAddress[] {
    return this.bindings
      .listSessionAccessPoints(sessionId)
      .map(({ binding }) => addressFromBinding(binding));
  }

  getSessionAccessPointBindingId(sessionId: string, address: RelayAddress): string | undefined {
    const binding = this.bindings.getByExternalConversation(
      address.providerId,
      address.accountId,
      address.conversationId,
    );
    return binding?.role === "session" && binding.localConversationId === sessionId
      ? binding.bindingId
      : undefined;
  }

  noteSessionOrigin(sessionId: string, address: RelayAddress): void {
    this.sessionOrigins.set(sessionId, address);
    const binding = this.bindings.getByExternalConversation(
      address.providerId,
      address.accountId,
      address.conversationId,
    );
    if (binding?.localConversationId === sessionId && binding.role === "session") {
      this.bindings.recordActivity(binding.bindingId, "inbound", this.now());
    }
  }

  getSessionOrigin(sessionId: string): RelayAddress | undefined {
    const active = this.sessionOrigins.get(sessionId);
    if (active) {
      const binding = this.bindings.getByExternalConversation(
        active.providerId,
        active.accountId,
        active.conversationId,
      );
      if (binding?.localConversationId === sessionId && binding.role === "session") return active;
      this.sessionOrigins.delete(sessionId);
    }
    const persisted = this.bindings.getPreferredSessionAccessPoint(sessionId);
    return persisted ? addressFromBinding(persisted) : undefined;
  }

  getSessionContext(sessionId: string): RelaySessionContext | undefined {
    const accessPoints = this.bindings.listSessionAccessPoints(sessionId).map(toSessionAccessPoint);
    return accessPoints.length > 0 ? { sessionId, accessPoints } : undefined;
  }

  getSessionReminder(sessionId: string): string {
    const context = this.getSessionContext(sessionId);
    if (!context) return "";
    const accessPoints = context.accessPoints.map(
      (accessPoint) =>
        `- bindingId=${accessPoint.bindingId}; provider=${accessPoint.address.providerId}; account=${accessPoint.address.accountId}; accessPoint=${accessPoint.address.conversationId}`,
    );
    return [
      '<marshal-system-reminder kind="active-relay-access-points">',
      "This Marshal session has active communication surfaces:",
      ...accessPoints,
      "A user may be listening on one or more of them.",
      "Use the canonical publishRelayMessage tool for deliberate replies and useful progress updates.",
      "Do not mirror the transcript automatically. Choose what is useful to communicate.",
      "</marshal-system-reminder>",
    ].join("\n");
  }

  noteSessionActivity(sessionId: string, occurredAtMs = this.now()): void {
    this.bindings.recordSessionActivity(sessionId, "session", occurredAtMs);
    this.scheduleMaintenance();
  }

  async publishFromSession(
    input: RelaySessionPublicationRequest,
  ): Promise<RelaySessionPublicationResult> {
    const text = input.text.trim();
    if (!text) throw new Error("Relay publication text is required");
    const context = this.getSessionContext(input.sessionId);
    if (!context) throw new Error("This session has no active relay access point");
    const selectedIds =
      input.accessPointIds === undefined ? undefined : new Set(input.accessPointIds);
    const targets = context.accessPoints.filter(
      (accessPoint) => selectedIds === undefined || selectedIds.has(accessPoint.bindingId),
    );
    if (targets.length === 0) throw new Error("No selected relay access point is active");
    if (selectedIds && targets.length !== selectedIds.size) {
      throw new Error("One or more selected relay access points are not bound to this session");
    }
    if (input.replyToProviderMessageId && targets.length !== 1) {
      throw new Error("Quoted relay replies require exactly one selected access point");
    }

    const requestedAt = input.requestedAt ?? new Date(this.now()).toISOString();
    const publications: RelayPublicationEnqueueReceipt[] = [];
    for (const target of targets) {
      const identity = stableIdentity([input.idempotencyKey, target.bindingId]);
      // Preserve the selected access-point order in the durable publication sequence.
      // eslint-disable-next-line no-await-in-loop
      const result = await this.enqueue({
        intent: "deliberate",
        idempotencyKey: `relay-session-publication:${identity}`,
        requestedAt,
        correlationId: `relay-session-publication:${identity}`,
        request: {
          publicationId: `relay-session-publication:${identity}`,
          address: target.address,
          kind: input.kind ?? "reply",
          text,
          sourceSessionId: input.sessionId,
          ...(input.sourceTurnId ? { sourceTurnId: input.sourceTurnId } : {}),
          ...(input.replyToProviderMessageId
            ? { replyToProviderMessageId: parseRelayMessageId(input.replyToProviderMessageId) }
            : {}),
        },
      });
      if (!result.ok) throw new Error(result.error.message);
      publications.push(result.value);
    }
    return { publications };
  }

  async retireSessionAccessPoint(address: RelayAddress): Promise<void> {
    await this.runAddressExclusive(address, (queueVersion) =>
      this.retireSessionAccessPointLocked(address, queueVersion),
    );
  }

  private async retireSessionAccessPointLocked(
    address: RelayAddress,
    queueVersion: number,
    expected?: RelayBindingWithActivity,
    inactiveBeforeMs?: number,
  ): Promise<void> {
    const before = this.getBindingState(address);
    if (!before) return;
    if (expected && !sameBindingState(before, expected)) return;
    if (
      inactiveBeforeMs !== undefined &&
      (latestMeaningfulActivityMs(before) >= inactiveBeforeMs ||
        this.isSessionOrDescendantBusy(before.binding.localConversationId))
    ) {
      return;
    }
    const retirement = this.bindings.prepareRetirement(before.binding.bindingId, this.now());
    await this.executeRetirement(retirement, queueVersion);
  }

  tombstoneSessionAccessPoints(sessionId: string): RelayBindingRetirement[] {
    return this.bindings
      .listByLocalConversation(sessionId)
      .map((binding) => this.bindings.prepareRetirement(binding.bindingId, this.now()));
  }

  tombstoneBindingsOutsideAccount(providerId: string, accountId: string): RelayBindingRetirement[] {
    this.retirementAccountOverrides.set(providerId, accountId);
    return this.bindings
      .listByProviderExceptAccount(providerId, accountId)
      .map((binding) => this.bindings.prepareRetirement(binding.bindingId, this.now()));
  }

  async resumeRetirements(retirements: readonly RelayBindingRetirement[]): Promise<void> {
    for (const retirement of retirements) {
      try {
        // eslint-disable-next-line no-await-in-loop -- provider topology retirement is ordered
        await this.runAddressExclusive(addressFromBinding(retirement), (queueVersion) =>
          this.executeRetirement(retirement, queueVersion),
        );
      } catch (error) {
        log
          .with({
            bindingId: retirement.bindingId,
            providerId: retirement.provider,
            accountId: retirement.accountId,
          })
          .warn("Relay access-point retirement remains pending:", error);
      }
    }
  }

  private async recoverPendingRetirements(): Promise<void> {
    await this.resumeRetirements(this.bindings.listRetirements());
  }

  private async executeRetirement(
    retirement: RelayBindingRetirement,
    queueVersion: number,
  ): Promise<void> {
    const address = addressFromBinding(retirement);
    try {
      const overrideAccountId = this.retirementAccountOverrides.get(retirement.provider);
      const providerAccountId = this.registry.has(address.providerId, address.accountId)
        ? address.accountId
        : overrideAccountId
          ? parseRelayAccountId(overrideAccountId)
          : address.accountId;
      const provider = this.registry.getProvider(address.providerId, providerAccountId);
      if (provider.conversations?.retire) {
        await provider.conversations.retire({
          ...address,
          accountId: providerAccountId,
        });
      }
    } catch (error) {
      this.bindings.recordRetirementError(retirement.bindingId, describeError(error), this.now());
      throw error;
    }
    if (this.addressQueueVersions.get(addressKey(address)) !== queueVersion) {
      return;
    }
    this.bindings.completeRetirement(retirement.bindingId);
    const origin = this.sessionOrigins.get(retirement.localConversationId);
    if (
      origin?.providerId === address.providerId &&
      origin.accountId === address.accountId &&
      origin.conversationId === address.conversationId
    ) {
      this.sessionOrigins.delete(retirement.localConversationId);
    }
  }

  async enqueue(
    intent: RelayPublicationIntent,
  ): Promise<RelayExperienceResult<RelayPublicationEnqueueReceipt, RelayPublicationErrorCode>> {
    try {
      const publication = await this.enqueuePublication(intent);
      void this.drainPublications();
      return {
        ok: true,
        value: {
          publicationId: publication.publicationId,
          correlationId: publication.correlationId,
          disposition: publication.attempts === 0 ? "queued" : "deduplicated",
          acceptedAt: new Date(publication.createdAtMs).toISOString(),
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "storage-failure",
          message: describeError(error),
          retryable: true,
        },
      };
    }
  }

  async publishNow(intent: RelayPublicationIntent): Promise<RelayPublishReceipt> {
    const publication = await this.enqueuePublication(intent);
    if (publication.state === "sent") return receiptFromPublication(publication);
    if (publication.state === "failed" || publication.state === "ambiguous") {
      throw new Error(
        `Relay publication ${publication.publicationId} is ${publication.state}: ${publication.lastError ?? "unknown failure"}`,
      );
    }

    const completion = this.getOrCreatePublicationCompletion(publication.publicationId);
    const current = this.outbox.get(publication.publicationId);
    if (current?.state === "sent") {
      const receipt = receiptFromPublication(current);
      this.resolvePublicationCompletion(publication.publicationId, receipt);
      return receipt;
    }
    if (current?.state === "failed" || current?.state === "ambiguous") {
      const error = new Error(
        `Relay publication ${current.publicationId} is ${current.state}: ${current.lastError ?? "unknown failure"}`,
      );
      this.rejectPublicationCompletion(publication.publicationId, error);
      return completion.promise;
    }
    void this.drainPublications();
    return completion.promise;
  }

  private getOrCreatePublicationCompletion(publicationId: string): PublicationCompletion {
    const existing = this.publicationCompletions.get(publicationId);
    if (existing) return existing;
    let resolvePromise: (receipt: RelayPublishReceipt) => void = () => undefined;
    let rejectPromise: (error: unknown) => void = () => undefined;
    const promise = new Promise<RelayPublishReceipt>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const completion = {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    };
    this.publicationCompletions.set(publicationId, completion);
    return completion;
  }

  private resolvePublicationCompletion(publicationId: string, receipt: RelayPublishReceipt): void {
    const completion = this.publicationCompletions.get(publicationId);
    if (!completion) return;
    this.publicationCompletions.delete(publicationId);
    completion.resolve(receipt);
  }

  private rejectPublicationCompletion(publicationId: string, error: unknown): void {
    const completion = this.publicationCompletions.get(publicationId);
    if (!completion) return;
    this.publicationCompletions.delete(publicationId);
    completion.reject(error);
  }

  private async handleProviderEvent(event: RelayProviderEvent): Promise<void> {
    const runtime = this.runtimes.get(
      accountKey({ providerId: event.providerId, accountId: event.accountId }),
    );
    if (event.type === "status-changed") {
      await runtime?.statusChanged?.(event.status);
      if (event.status.state === "connected") void this.drainPublications();
      return;
    }
    if (event.type === "interaction-selected") {
      if (
        runtime?.authorizeInteractionSelection &&
        !(await runtime.authorizeInteractionSelection(event.selection))
      ) {
        return;
      }
      this.interactions.handleSelection(event.selection);
      return;
    }
    if (event.type !== "message-received") return;

    if (
      !this.readyRuntimeKeys.has(
        accountKey({ providerId: event.providerId, accountId: event.accountId }),
      )
    ) {
      this.acceptInbound(event);
      return;
    }
    const prepared = await this.runAddressExclusive(event.message.address, () =>
      Promise.resolve(this.prepareInbound(event)),
    );
    await this.executePreparedInbound(prepared);
  }

  private async runAddressExclusive<T>(
    address: RelayAddress,
    operation: (queueVersion: number) => Promise<T>,
  ): Promise<T> {
    const key = addressKey(address);
    const inheritedKeys = this.addressQueueContext.getStore();
    if (inheritedKeys?.has(key)) {
      return operation(this.addressQueueVersions.get(key) ?? 0);
    }
    const queueVersion = (this.addressQueueVersions.get(key) ?? 0) + 1;
    this.addressQueueVersions.set(key, queueVersion);
    const previous = this.addressQueues.get(key) ?? Promise.resolve();
    const run = () =>
      this.addressQueueContext.run(new Set(inheritedKeys ? [...inheritedKeys, key] : [key]), () =>
        operation(queueVersion),
      );
    const current = previous.then(
      () => run(),
      () => run(),
    );
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.addressQueues.set(key, settled);
    try {
      return await current;
    } finally {
      if (this.addressQueues.get(key) === settled) {
        this.addressQueues.delete(key);
        if (this.addressQueueVersions.get(key) === queueVersion) {
          this.addressQueueVersions.delete(key);
        }
      }
    }
  }

  private getBindingState(address: RelayAddress): RelayBindingWithActivity | undefined {
    const binding = this.bindings.getByExternalConversation(
      address.providerId,
      address.accountId,
      address.conversationId,
    );
    if (!binding) return undefined;
    return { binding, activity: this.bindings.getActivity(binding.bindingId) };
  }

  private prepareInbound(event: RelayInboundMessageEvent): PreparedInbound {
    const accepted = this.acceptInbound(event);
    const runtime = this.runtimes.get(
      accountKey({ providerId: event.providerId, accountId: event.accountId }),
    );
    if (this.interactions.hasPendingPermissionAt(event.message.address)) {
      if (accepted.record.state === "accepted") {
        const localMessageId = `ignored-permission-pending:${accepted.record.inboundId}`;
        this.database.transaction(() => {
          this.journal.markEnqueued(accepted.record.correlationId, localMessageId, this.now());
          this.correlations.record({
            direction: "inbound",
            correlationId: accepted.record.correlationId,
            provider: accepted.record.provider,
            accountId: accepted.record.accountId,
            conversationId: accepted.record.conversationId,
            providerMessageId: accepted.record.providerMessageId,
            localMessageId,
            inboundId: accepted.record.inboundId,
            createdAtMs: this.now(),
          });
        });
      }
      return { kind: "discard", event, runtime };
    }
    if (!accepted.inserted && accepted.record.state === "enqueued") {
      return { kind: "discard", event, runtime };
    }
    return this.prepareAcceptedDispatch(accepted.record, event, runtime);
  }

  private acceptInbound(event: RelayInboundMessageEvent) {
    const accepted = this.journal.accept({
      provider: event.providerId,
      accountId: event.accountId,
      conversationId: event.message.address.conversationId,
      providerMessageId: event.message.providerMessageId,
      payloadJson: serializeInboundEvent(event),
      acceptedAtMs: timestampMs(event.occurredAt, this.now()),
    });
    const binding = this.bindings.getByExternalConversation(
      event.providerId,
      event.accountId,
      event.message.address.conversationId,
    );
    if (binding?.role === "session") {
      this.bindings.recordActivity(binding.bindingId, "inbound", accepted.record.acceptedAtMs);
    }
    return accepted;
  }

  private async resumeAcceptedSerialized(record: AcceptedInboundRecord): Promise<void> {
    const event = parseInboundEvent(record.payloadJson);
    const prepared = await this.runAddressExclusive(event.message.address, async () => {
      const current = this.journal.getByCorrelationId(record.correlationId);
      if (!current || current.state !== "accepted") return undefined;
      const runtime = this.runtimes.get(
        accountKey({ providerId: event.providerId, accountId: event.accountId }),
      );
      return this.prepareAcceptedDispatch(current, event, runtime);
    });
    if (!prepared) return;
    try {
      await this.executePreparedInbound(prepared);
    } catch (error) {
      log
        .with({
          providerId: record.provider,
          accountId: record.accountId,
          conversationId: record.conversationId,
          providerMessageId: record.providerMessageId,
        })
        .error("Relay inbound recovery remains pending:", error);
    }
  }

  private prepareAcceptedDispatch(
    record: AcceptedInboundRecord,
    event: RelayInboundMessageEvent,
    runtime: RelayAccountExperienceRuntime | undefined,
  ): Extract<PreparedInbound, { kind: "dispatch" }> {
    const existing = this.inboundDispatches.get(record.correlationId);
    if (existing) {
      return { kind: "dispatch", event, record, claim: existing, owner: false, runtime };
    }
    let settle: (outcome: InboundDispatchOutcome) => void = () => undefined;
    const promise = new Promise<InboundDispatchOutcome>((resolve) => {
      settle = resolve;
    });
    const claim: InboundDispatchClaim = { promise, settle };
    this.inboundDispatches.set(record.correlationId, claim);
    return { kind: "dispatch", event, record, claim, owner: true, runtime };
  }

  private async executePreparedInbound(prepared: PreparedInbound): Promise<void> {
    if (prepared.kind === "discard") {
      await prepared.runtime?.discardInbound?.(prepared.event);
      return;
    }
    if (!prepared.owner) {
      const outcome = await prepared.claim.promise;
      await prepared.runtime?.discardInbound?.(prepared.event);
      if (!outcome.ok) throw outcome.error;
      return;
    }
    try {
      await this.dispatchAccepted(prepared.record, prepared.event);
      prepared.claim.settle({ ok: true });
    } catch (error) {
      prepared.claim.settle({ ok: false, error });
      throw error;
    } finally {
      if (this.inboundDispatches.get(prepared.record.correlationId) === prepared.claim) {
        this.inboundDispatches.delete(prepared.record.correlationId);
      }
    }
  }

  private async recoverAcceptedForAccount(account: RelayAccountScope): Promise<void> {
    const key = accountKey(account);
    if (!this.readyRuntimeKeys.has(key)) return;
    let afterSequence = 0;
    for (;;) {
      const records = this.journal.listAcceptedForAccount(
        account.providerId,
        account.accountId,
        afterSequence,
        INBOUND_RECOVERY_BATCH_SIZE,
      );
      if (records.length === 0) return;
      for (const record of records) {
        afterSequence = record.sequence;
        // eslint-disable-next-line no-await-in-loop -- journal sequence is authoritative within an account
        await this.resumeAcceptedSerialized(record);
      }
      if (records.length < INBOUND_RECOVERY_BATCH_SIZE) return;
    }
  }

  private async dispatchAccepted(
    record: AcceptedInboundRecord,
    event: RelayInboundMessageEvent,
  ): Promise<void> {
    const runtime = this.runtimes.get(
      accountKey({ providerId: event.providerId, accountId: event.accountId }),
    );
    if (!runtime) {
      throw new Error(
        `No relay account runtime is registered for ${event.providerId}/${event.accountId}`,
      );
    }
    const routed = await runtime.routeInbound(event, {
      correlationId: record.correlationId,
      idempotencyKey: record.inboundId,
      acceptedAt: new Date(record.acceptedAtMs).toISOString(),
    });
    const localMessageId = typeof routed === "string" ? routed : routed.localMessageId;
    if (typeof routed !== "string" && routed.sessionId) {
      this.noteSessionOrigin(routed.sessionId, event.message.address);
    }
    this.database.transaction(() => {
      this.journal.markEnqueued(record.correlationId, localMessageId, this.now());
      this.correlations.record({
        direction: "inbound",
        correlationId: record.correlationId,
        provider: record.provider,
        accountId: record.accountId,
        conversationId: record.conversationId,
        providerMessageId: record.providerMessageId,
        localMessageId,
        inboundId: record.inboundId,
        createdAtMs: this.now(),
      });
    });
    if (typeof routed !== "string") await routed.afterCommit?.();
  }

  private enqueuePublication(intent: RelayPublicationIntent): Promise<RelayPublication> {
    return this.runAddressExclusive(intent.request.address, () =>
      Promise.resolve(this.enqueuePublicationLocked(intent)),
    );
  }

  private enqueuePublicationLocked(intent: RelayPublicationIntent): RelayPublication {
    if (intent.intent !== "deliberate") {
      throw new Error("Relay publications must be deliberate");
    }
    const publication = this.outbox.enqueue({
      publicationId: intent.request.publicationId,
      correlationId: intent.correlationId,
      provider: intent.request.address.providerId,
      accountId: intent.request.address.accountId,
      conversationId: intent.request.address.conversationId,
      localMessageId:
        intent.request.sourceTurnId ?? intent.request.sourceSessionId ?? intent.correlationId,
      payloadJson: JSON.stringify(intent.request),
      priority:
        intent.request.kind === "reply" ? 100 : intent.request.kind === "progress" ? 50 : 10,
      createdAtMs: timestampMs(intent.requestedAt, this.now()),
    });
    const binding = this.bindings.getByExternalConversation(
      intent.request.address.providerId,
      intent.request.address.accountId,
      intent.request.address.conversationId,
    );
    if (binding?.role === "session") {
      this.bindings.recordActivity(binding.bindingId, "publication", publication.createdAtMs);
    }
    this.scheduleMaintenance();
    return publication;
  }

  private drainPublications(): Promise<void> {
    if (this.publicationPump) return this.publicationPump;
    const pump = this.pumpPublications();
    const tracked = pump.finally(() => {
      if (this.publicationPump === tracked) this.publicationPump = undefined;
    });
    this.publicationPump = tracked;
    return tracked;
  }

  private async pumpPublications(): Promise<void> {
    for (;;) {
      const publication = this.outbox.leaseNext(
        `relay-coordinator:${process.pid}`,
        PUBLICATION_LEASE_MS,
        this.now(),
      );
      if (!publication?.leaseId) return;
      try {
        const request = parsePublishRequest(publication.payloadJson);
        const provider = this.registry.getProvider(
          parseRelayProviderId(publication.provider),
          parseRelayAccountId(publication.accountId),
        );
        // The outbox intentionally serializes each leased destination operation.
        // eslint-disable-next-line no-await-in-loop
        const status = await provider.status(parseRelayAccountId(publication.accountId));
        if (status.state !== "connected") {
          const rescheduled = this.outbox.reschedule(
            publication.publicationId,
            publication.leaseId,
            `Relay destination is ${status.state}`,
            this.now(),
          );
          if (rescheduled.state === "failed") {
            this.rejectPublicationCompletion(
              publication.publicationId,
              new Error(rescheduled.lastError ?? "Relay publication failed"),
            );
          } else {
            this.schedulePublicationRetry();
          }
          continue;
        }
        this.outbox.beginSending(publication.publicationId, publication.leaseId, this.now());
        // Preserve durable publication ordering within this pump.
        // eslint-disable-next-line no-await-in-loop
        const receipt = await provider.publish(request);
        this.outbox.markSent(
          publication.publicationId,
          publication.leaseId,
          receipt.providerMessageId,
          timestampMs(receipt.publishedAt, this.now()),
        );
        this.resolvePublicationCompletion(publication.publicationId, receipt);
      } catch (error) {
        const current = this.outbox.get(publication.publicationId);
        if (current?.state === "sending") {
          this.outbox.markAmbiguous(
            publication.publicationId,
            publication.leaseId,
            describeError(error),
            this.now(),
          );
        } else if (current?.state === "leased") {
          const rescheduled = this.outbox.reschedule(
            publication.publicationId,
            publication.leaseId,
            describeError(error),
            this.now(),
          );
          if (rescheduled.state !== "failed") this.schedulePublicationRetry();
        }
        this.rejectPublicationCompletion(publication.publicationId, error);
      }
    }
  }

  private async publishNotification(
    kind: RelayNotificationKind,
    text: string,
    sourceSessionId?: string,
  ): Promise<void> {
    const normalized = text.trim();
    if (!normalized) return;
    const requestedAt = new Date(this.now()).toISOString();
    const results = await Promise.allSettled(
      this.getNotificationTargets(kind).map((target) =>
        this.publishNow({
          intent: "deliberate",
          idempotencyKey: this.createId(),
          requestedAt,
          correlationId: this.createId(),
          request: {
            publicationId: this.createId(),
            address: target.address,
            kind: kind === "progress" ? "progress" : "notification",
            text: normalized,
            ...(sourceSessionId ? { sourceSessionId } : {}),
          },
        }),
      ),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more relay notification destinations failed");
    }
  }

  private schedulePublicationRetry(): void {
    if (this.stopping || this.publicationRetryTimer) return;
    this.publicationRetryTimer = setTimeout(() => {
      this.publicationRetryTimer = undefined;
      void this.drainPublications();
    }, 1_000);
  }

  async runMaintenanceNow(): Promise<void> {
    if (this.maintenanceRun) return this.maintenanceRun;
    const run = this.performMaintenance().finally(() => {
      if (this.maintenanceRun === run) this.maintenanceRun = undefined;
    });
    this.maintenanceRun = run;
    return run;
  }

  private async performMaintenance(): Promise<void> {
    await this.recoverPendingRetirements();
    await this.cleanupStaleAccessPoints();
    await this.triggerProgressUpdates();
  }

  private async cleanupStaleAccessPoints(): Promise<void> {
    const inactiveBeforeMs = Math.max(0, this.now() - this.staleThresholdMs);
    const stale = this.bindings.listStaleSessionAccessPoints(inactiveBeforeMs);
    for (const { binding } of stale) {
      if (this.isSessionOrDescendantBusy(binding.localConversationId)) continue;
      try {
        const expected = {
          binding,
          activity: this.bindings.getActivity(binding.bindingId),
        };
        const address = addressFromBinding(binding);
        // eslint-disable-next-line no-await-in-loop
        await this.runAddressExclusive(address, (queueVersion) =>
          this.retireSessionAccessPointLocked(address, queueVersion, expected, inactiveBeforeMs),
        );
      } catch (error) {
        log
          .with({
            bindingId: binding.bindingId,
            providerId: binding.provider,
            accountId: binding.accountId,
          })
          .warn("Relay access-point cleanup failed:", error);
      }
    }
  }

  private async triggerProgressUpdates(): Promise<void> {
    if (!this.requestProgressUpdate) return;
    const intervalMs = normalizeProgressIntervalMs(this.getProgressIntervalMs());
    const bySession = new Map<string, RelayBindingWithActivity[]>();
    for (const state of this.bindings.listAllSessionAccessPoints()) {
      const states = bySession.get(state.binding.localConversationId) ?? [];
      states.push(state);
      bySession.set(state.binding.localConversationId, states);
    }
    const now = this.now();
    for (const [sessionId, states] of bySession) {
      if (!this.isSessionOrDescendantBusy(sessionId)) continue;
      const lastMeaningfulActivity = Math.max(...states.map(latestMeaningfulActivityMs));
      const lastProgressPrompt = Math.max(
        0,
        ...states.map(({ activity }) => activity?.lastProgressPromptAtMs ?? 0),
      );
      const cadenceAnchor = Math.max(lastMeaningfulActivity, lastProgressPrompt);
      if (now - cadenceAnchor < intervalMs) continue;
      const context = this.getSessionContext(sessionId);
      if (!context) continue;
      const idempotencyKey = `relay-progress:${stableIdentity([
        sessionId,
        String(cadenceAnchor),
        String(intervalMs),
      ])}`;
      let accepted = false;
      try {
        // Session owners are triggered sequentially to keep wake ordering deterministic.
        // eslint-disable-next-line no-await-in-loop
        accepted = await this.requestProgressUpdate({
          sessionId,
          idempotencyKey,
          requestedAt: new Date(now).toISOString(),
          context,
        });
      } catch (error) {
        log.with({ sessionId }).warn("Relay progress update request failed:", error);
      }
      if (accepted) this.bindings.recordSessionActivity(sessionId, "progress", now);
    }
  }

  private scheduleMaintenance(delayMs = this.maintenanceIntervalMs): void {
    if (!this.started || this.stopping || this.maintenanceTimer) return;
    this.addressQueueContext.exit(() => {
      this.maintenanceTimer = setTimeout(
        () => {
          this.maintenanceTimer = undefined;
          void this.runMaintenanceNow()
            .catch((error: unknown) => log.warn("Relay maintenance failed:", error))
            .finally(() => this.scheduleMaintenance());
        },
        Math.max(0, delayMs),
      );
      this.maintenanceTimer.unref?.();
    });
  }
}

function accountKey(account: RelayAccountScope): string {
  return `${account.providerId}\u0000${account.accountId}`;
}

function addressKey(address: RelayAddress): string {
  return `${accountKey(address)}\u0000${address.conversationId}`;
}

function addressFromBinding(binding: RelayBinding): RelayAddress {
  return {
    providerId: parseRelayProviderId(binding.provider),
    accountId: parseRelayAccountId(binding.accountId),
    conversationId: parseRelayConversationId(binding.externalConversationId),
  };
}

function toSessionAccessPoint({
  binding,
  activity,
}: RelayBindingWithActivity): RelaySessionAccessPointContext {
  return {
    bindingId: binding.bindingId,
    address: addressFromBinding(binding),
    ...(activity?.lastInboundAtMs === undefined
      ? {}
      : { lastInboundAt: new Date(activity.lastInboundAtMs).toISOString() }),
    ...(activity?.lastPublicationAtMs === undefined
      ? {}
      : { lastPublicationAt: new Date(activity.lastPublicationAtMs).toISOString() }),
    ...(activity?.lastSessionActivityAtMs === undefined
      ? {}
      : { lastSessionActivityAt: new Date(activity.lastSessionActivityAtMs).toISOString() }),
  };
}

function latestMeaningfulActivityMs({ binding, activity }: RelayBindingWithActivity): number {
  return Math.max(
    binding.updatedAtMs,
    activity?.lastInboundAtMs ?? 0,
    activity?.lastPublicationAtMs ?? 0,
    activity?.lastSessionActivityAtMs ?? 0,
  );
}

function sameBindingState(
  left: RelayBindingWithActivity,
  right: RelayBindingWithActivity,
): boolean {
  return (
    left.binding.bindingId === right.binding.bindingId &&
    left.binding.provider === right.binding.provider &&
    left.binding.accountId === right.binding.accountId &&
    left.binding.externalConversationId === right.binding.externalConversationId &&
    left.binding.localConversationId === right.binding.localConversationId &&
    left.binding.role === right.binding.role &&
    left.binding.createdAtMs === right.binding.createdAtMs &&
    left.binding.updatedAtMs === right.binding.updatedAtMs &&
    left.activity?.lastInboundAtMs === right.activity?.lastInboundAtMs &&
    left.activity?.lastPublicationAtMs === right.activity?.lastPublicationAtMs &&
    left.activity?.lastSessionActivityAtMs === right.activity?.lastSessionActivityAtMs &&
    left.activity?.lastProgressPromptAtMs === right.activity?.lastProgressPromptAtMs &&
    left.activity?.updatedAtMs === right.activity?.updatedAtMs
  );
}

function normalizeProgressIntervalMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PROGRESS_INTERVAL_MS;
  return Math.max(60_000, Math.floor(value));
}

function stableIdentity(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, "utf8")));
    hash.update(":");
    hash.update(part);
    hash.update("|");
  }
  return hash.digest("hex").slice(0, 24);
}

function parseInboundEvent(payloadJson: string): RelayInboundMessageEvent {
  const value = JSON.parse(payloadJson) as unknown;
  if (!isRecord(value) || value.type !== "message-received" || !isRecord(value.message)) {
    throw new Error("Stored relay inbound event has an invalid shape");
  }
  const message = value.message;
  if (
    !isRecord(message.address) ||
    !isRecord(message.sender) ||
    !Array.isArray(message.attachments)
  ) {
    throw new Error("Stored relay inbound message has an invalid shape");
  }
  return {
    type: "message-received",
    providerId: parseRelayProviderId(value.providerId),
    accountId: parseRelayAccountId(value.accountId),
    occurredAt: requireTimestamp(value.occurredAt),
    message: {
      address: {
        providerId: parseRelayProviderId(message.address.providerId),
        accountId: parseRelayAccountId(message.address.accountId),
        conversationId: parseRelayConversationId(message.address.conversationId),
      },
      providerMessageId: parseRelayMessageId(message.providerMessageId),
      sender: {
        primaryId: requireText(message.sender.primaryId, "relay sender"),
        ...(Array.isArray(message.sender.alternateIds)
          ? {
              alternateIds: message.sender.alternateIds.map((id) =>
                requireText(id, "relay alternate sender"),
              ),
            }
          : {}),
        ...(typeof message.sender.displayName === "string"
          ? { displayName: message.sender.displayName }
          : {}),
      },
      sentAt: requireTimestamp(message.sentAt),
      receivedAt: requireTimestamp(message.receivedAt),
      ...(typeof message.text === "string" ? { text: message.text } : {}),
      attachments: message.attachments.map(parseInboundAttachment),
      ...(isRecord(message.replyTo)
        ? {
            replyTo: {
              providerMessageId: parseRelayMessageId(message.replyTo.providerMessageId),
            },
          }
        : {}),
    },
  };
}

function parsePublishRequest(payloadJson: string): RelayPublishRequest {
  const value = JSON.parse(payloadJson) as unknown;
  if (!isRecord(value) || !isRecord(value.address)) {
    throw new Error("Stored relay publication has an invalid shape");
  }

  const kind = value.kind;
  if (
    kind !== "reply" &&
    kind !== "progress" &&
    kind !== "notification" &&
    kind !== "permission-attention"
  ) {
    throw new Error("Stored relay publication has an invalid kind");
  }
  return {
    publicationId: requireText(value.publicationId, "publication ID"),
    address: {
      providerId: parseRelayProviderId(value.address.providerId),
      accountId: parseRelayAccountId(value.address.accountId),
      conversationId: parseRelayConversationId(value.address.conversationId),
    },
    kind,
    text: requireNonBlankText(value.text, "publication text"),
    ...(value.replyToProviderMessageId === undefined
      ? {}
      : { replyToProviderMessageId: parseRelayMessageId(value.replyToProviderMessageId) }),
    ...(typeof value.sourceSessionId === "string"
      ? { sourceSessionId: value.sourceSessionId }
      : {}),
    ...(typeof value.sourceTurnId === "string" ? { sourceTurnId: value.sourceTurnId } : {}),
  };
}

function parseInboundAttachment(value: unknown): RelayAttachment {
  const sizeBytes = isRecord(value) ? value.sizeBytes : undefined;
  const durationMs = isRecord(value) ? value.durationMs : undefined;
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    (value.kind !== "image" &&
      value.kind !== "audio" &&
      value.kind !== "file" &&
      value.kind !== "video") ||
    typeof value.mimeType !== "string" ||
    (value.localPath !== undefined &&
      (typeof value.localPath !== "string" || value.localPath.trim().length === 0)) ||
    (value.storageKey !== undefined &&
      (typeof value.storageKey !== "string" ||
        !/^[a-f0-9]{64}\/[^/\\]{1,120}$/.test(value.storageKey))) ||
    (value.localPath === undefined && value.storageKey === undefined) ||
    (value.fileName !== undefined && typeof value.fileName !== "string") ||
    (sizeBytes !== undefined &&
      (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 0)) ||
    (value.sha256 !== undefined && typeof value.sha256 !== "string") ||
    (value.voiceMemo !== undefined && typeof value.voiceMemo !== "boolean") ||
    (durationMs !== undefined &&
      (typeof durationMs !== "number" || !Number.isInteger(durationMs) || durationMs < 0))
  ) {
    throw new Error("Stored relay inbound attachment has an invalid shape");
  }
  return {
    id: value.id,
    kind: value.kind,
    mimeType: value.mimeType,
    ...(value.fileName === undefined ? {} : { fileName: value.fileName }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(value.localPath === undefined ? {} : { localPath: value.localPath }),
    ...(value.storageKey === undefined ? {} : { storageKey: value.storageKey }),
    ...(value.sha256 === undefined ? {} : { sha256: value.sha256 }),
    ...(value.voiceMemo === undefined ? {} : { voiceMemo: value.voiceMemo }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function serializeInboundEvent(event: RelayInboundMessageEvent): string {
  return JSON.stringify({
    ...event,
    message: {
      ...event.message,
      attachments: event.message.attachments.map((attachment) => {
        if (!attachment.storageKey) return attachment;
        return { ...attachment, localPath: undefined };
      }),
    },
  });
}

function receiptFromPublication(publication: RelayPublication): RelayPublishReceipt {
  if (!publication.providerMessageId || publication.sentAtMs === undefined) {
    throw new Error(`Relay publication ${publication.publicationId} has no sent receipt`);
  }
  return {
    publicationId: publication.publicationId,
    providerMessageId: parseRelayMessageId(publication.providerMessageId),
    publishedAt: new Date(publication.sentAtMs).toISOString(),
  };
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${label} must be a non-empty, trimmed string`);
  }
  return value;
}

function requireTimestamp(value: unknown): string {
  const timestamp = requireText(value, "relay timestamp");
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error("Relay timestamp is invalid");
  return timestamp;
}

function requireNonBlankText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must contain text`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestampMs(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
