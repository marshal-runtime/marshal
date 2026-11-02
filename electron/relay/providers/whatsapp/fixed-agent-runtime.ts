import { createHash, randomUUID } from "node:crypto";

import { DEFAULT_PERMISSIONS } from "../../../../common/marshal-default-settings";
import type { SessionMetadata } from "../../../../common/marshal-ipc-contract";
import { createLogger } from "../../../../common/marshal-logger";
import {
  parseRelayConversationId,
  parseRelayMessageId,
  type RelayAddress,
  type RelayInteractionSelection,
  type RelayPublishRequest,
} from "../../../../common/relay-contract";
import type { RuntimeTool } from "../../../backend/runtime-contract";
import type { PermissionPolicy } from "../../../permission-policy";
import type { SessionManager } from "../../../sessions";
import { wrapUntrusted } from "../../../untrusted-wrap";
import type { RelayBindingStore } from "../../bindings";
import type { RelayInboundMessageEvent, RelayPublishReceipt } from "../../contracts";
import type {
  RelayInboundRouteContext,
  RelayInboundRouteResult,
} from "../../experience-coordinator";
import {
  RELAY_FIXED_AGENT_SPECIFICATIONS,
  RELAY_FIXED_AGENT_TOOL_NAMES,
  RelayFixedAgentHost,
  createRelayFixedAgentCatalog,
  type RelayAccountScope,
  type RelayExperienceResult,
  type RelayFixedAgentManagedGroupPort,
  type RelayFixedAgentRole,
  type RelayFixedAgentRuntimePort,
  type RelayFixedAgentToolRegistration,
  type RelayFixedAgentTurn,
  type RelayFixedAgentTurnResult,
  type RelayGroupSessionBinding,
  type RelayHostSessionCreateRequest,
  type RelayHostSessionDescriptor,
  type RelayHostSessionQuery,
  type RelayIngestedAttachment,
  type RelayManagedGroupDescriptor,
  type RelayPersistenceErrorCode,
  type RelayPublicationCommandPort,
  type RelayPublicationCorrelationQuery,
  type RelayPublicationCorrelationReader,
  type RelayPublicationCorrelationRecord,
  type RelayPublicationEnqueueReceipt,
  type RelayPublicationErrorCode,
  type RelayProvisioningErrorCode,
  type RelaySessionCreationPort,
  type RelaySessionErrorCode,
  type RelaySessionQueryPort,
  type RelaySessionSteeringPort,
  type RelaySessionSteerReceipt,
} from "../../fixed-agents";
import { RelayHostExperienceRuntime } from "../../host-experience/runtime";
import type {
  RelayEnsuredSessionAccessPoint,
  RelayEnsureSessionAccessPointRequest,
  RelayHostExperiencePorts,
} from "../../host-experience/types";
import type { RelayHostMediaAdapter, RelayStoredAttachment } from "../../host-media-adapter";
import {
  WhatsAppFixedAgentStore,
  type StoredWhatsAppRelayBinding,
  type StoredWhatsAppRelaySession,
} from "./fixed-agent-store";
import type { WhatsAppManagedGroupIds, WhatsAppService } from "./service";
import type { WhatsAppManagedFixedGroupRole } from "./sidecar/protocol";

const log = createLogger("WhatsAppFixedAgentRuntime");
const FIXED_GROUP_TITLES: Readonly<Record<WhatsAppManagedFixedGroupRole, string>> = {
  "new-chats": "New Chats",
  progress: "Progress",
  "information-control": "Information & Control",
};
const TURN_TIMEOUT_MS = 5 * 60_000;

interface WhatsAppRoutedMessage {
  readonly eventVersion: 1;
  readonly providerMessageId: string;
  readonly conversationId: string;
  readonly role: WhatsAppManagedFixedGroupRole | "session";
  readonly senderId: string;
  readonly origin: "same-account-human";
  readonly sentAt: string;
  readonly receivedAt: string;
  readonly text: string;
  readonly attachments: readonly RelayIngestedAttachment[];
  readonly replyToProviderMessageId?: string;
}

interface RetainedAttachmentTurn {
  readonly sessionId: string;
  delivery: (() => Promise<void>) | undefined;
  started: boolean;
}

export interface WhatsAppFixedAgentRuntimeOptions {
  readonly databasePath: string;
  readonly account: RelayAccountScope;
  readonly service: WhatsAppService;
  readonly sessionManager: SessionManager;
  readonly permissionPolicy: PermissionPolicy;
  readonly bindings: RelayBindingStore;
  readonly topology: RelayHostExperiencePorts["topology"];
  readonly media: Pick<RelayHostMediaAdapter, "release" | "restore">;
  readonly publication: {
    enqueue(
      intent: Parameters<RelayPublicationCommandPort["enqueue"]>[0],
    ): ReturnType<RelayPublicationCommandPort["enqueue"]>;
    publishNow(
      intent: Parameters<RelayPublicationCommandPort["enqueue"]>[0],
    ): Promise<RelayPublishReceipt>;
  };
}

export class WhatsAppFixedAgentRuntime {
  private readonly store: WhatsAppFixedAgentStore;
  private readonly accessPointHost: RelayHostExperienceRuntime;
  private readonly account: RelayAccountScope;
  private readonly registrations = new Map<string, RelayFixedAgentToolRegistration>();
  private readonly activeTurns = new Map<string, RelayFixedAgentTurn>();
  private readonly retainedAttachmentTurns = new Map<string, RetainedAttachmentTurn>();
  private readonly toolResults = new Map<
    string,
    Array<{ readonly toolName: string; readonly result: unknown }>
  >();
  private unsubscribeStatus: (() => void) | undefined;
  private host: RelayFixedAgentHost | undefined;
  private startPromise: Promise<boolean> | undefined;
  private messageQueue: Promise<void> = Promise.resolve();
  private initialized = false;
  private disposed = false;

  constructor(private readonly options: WhatsAppFixedAgentRuntimeOptions) {
    this.store = new WhatsAppFixedAgentStore(options.databasePath);
    this.account = options.account;
    this.accessPointHost = new RelayHostExperienceRuntime(
      {
        account: this.account,
        communityDisplayName: "Marshal Community",
        mode: "access-points-only",
      },
      this.createAccessPointPorts(),
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.disposed) throw new Error("WhatsApp fixed-agent runtime is disposed");
    this.initialized = true;
    await this.accessPointHost.start();
    this.unsubscribeStatus = this.options.service.subscribeStatus((status) => {
      if (status.connection === "connected") {
        void Promise.resolve()
          .then(() => this.reconcileSharedBindings())
          .then(() => this.refreshSessionGroupRegistrations())
          .then(() => this.ensureStarted())
          .catch((error: unknown) => {
            log.error("WhatsApp fixed-agent startup failed:", error);
          });
      }
    });
    if (this.options.service.getStatus().connection === "connected") {
      this.reconcileSharedBindings();
      await this.refreshSessionGroupRegistrations();
    }
    await this.ensureStarted();
  }

  private reconcileSharedBindings(): void {
    const managedGroups = this.options.service.getManagedGroupIds();
    const migrated = new Set<string>();
    for (const session of this.store.listSessions()) {
      const retiringRoles = new Set(
        this.options.bindings
          .listRetirements({
            provider: this.account.providerId,
            localConversationId: session.sessionId,
          })
          .map((retirement) => retirement.role),
      );
      const sharedRoles = new Set(
        this.options.bindings
          .listByLocalConversation(session.sessionId)
          .filter(
            (binding) =>
              binding.provider === this.account.providerId &&
              binding.accountId === this.account.accountId,
          )
          .map((binding) => binding.role),
      );
      for (const binding of this.store.listBindingsBySession(session.sessionId)) {
        if (migrated.has(binding.bindingId)) continue;
        migrated.add(binding.bindingId);
        if (retiringRoles.has(binding.role)) continue;
        if (sharedRoles.has(binding.role)) continue;
        const active =
          binding.role === "session"
            ? this.options.service.hasPersistedSessionGroup(binding.groupId)
            : managedGroups?.fixed[binding.role] === binding.groupId;
        if (!active) continue;
        this.options.bindings.upsert({
          bindingId: binding.bindingId,
          provider: this.account.providerId,
          accountId: this.account.accountId,
          externalConversationId: binding.groupId,
          localConversationId: binding.sessionId,
          role: binding.role,
          updatedAtMs: Number.isFinite(Date.parse(binding.updatedAt))
            ? Date.parse(binding.updatedAt)
            : Date.now(),
        });
      }
    }
  }

  private async refreshSessionGroupRegistrations(): Promise<void> {
    const managedGroups = this.options.service.getManagedGroupIds();
    if (!managedGroups) return;
    const fixedGroupIds = new Set(Object.values(managedGroups.fixed));
    for (const session of this.store.listSessions()) {
      if (session.kind !== "conversation" || fixedGroupIds.has(session.groupId)) continue;
      const activeBinding = this.options.bindings
        .listByLocalConversation(session.sessionId)
        .find(
          (binding) =>
            binding.provider === this.account.providerId &&
            binding.accountId === this.account.accountId &&
            binding.role === "session",
        );
      if (!activeBinding) {
        this.store.deleteSessionAccessPoint(session.sessionId);
        continue;
      }
      const activeGroupId = activeBinding.externalConversationId;
      try {
        // Re-register persisted groups sequentially to avoid competing group mutations.
        // eslint-disable-next-line no-await-in-loop
        const ensuredResult = await this.options.topology.createGroup({
          idempotencyKey: `relay-session-group:${session.sessionId}`,
          requestedAt: new Date().toISOString(),
          communityAddress: address(this.account, managedGroups.community),
          role: "session",
          displayName: normalizeGroupDisplayName(session.title),
          existingAddress: address(this.account, activeGroupId),
        });
        if (!ensuredResult.ok) throw new Error(ensuredResult.error.message);
        const ensured = ensuredResult.value;
        if (
          ensured.role !== "session" ||
          ensured.state !== "active" ||
          !sameAccount(ensured.address, this.account) ||
          !sameAccount(ensured.communityAddress, this.account) ||
          ensured.communityAddress.conversationId !== managedGroups.community
        ) {
          throw new Error("WhatsApp session-group registration returned an invalid group");
        }
        if (ensured.address.conversationId === activeGroupId) {
          if (session.groupId !== activeGroupId) {
            const staleBinding = this.store.getBindingByGroup(session.groupId);
            if (staleBinding) this.store.deleteBinding(staleBinding.bindingId);
            this.store.upsertSession({
              ...session,
              groupId: activeGroupId,
              updatedAt: new Date().toISOString(),
            });
            this.store.upsertBinding({
              bindingId: activeBinding.bindingId,
              groupId: activeGroupId,
              role: "session",
              sessionId: session.sessionId,
              createdAt: new Date(activeBinding.createdAtMs).toISOString(),
              updatedAt: new Date(activeBinding.updatedAtMs).toISOString(),
            });
          }
          continue;
        }

        const existingBinding = this.store.getBindingByGroup(session.groupId);
        const updatedAt = new Date().toISOString();
        this.options.bindings.upsert({
          bindingId: activeBinding.bindingId,
          provider: this.account.providerId,
          accountId: this.account.accountId,
          externalConversationId: ensured.address.conversationId,
          localConversationId: session.sessionId,
          role: "session",
          updatedAtMs: Date.parse(updatedAt),
        });
        if (existingBinding) {
          this.store.deleteBinding(existingBinding.bindingId);
          if (existingBinding.bindingId !== activeBinding.bindingId) {
            this.options.bindings.remove(existingBinding.bindingId);
          }
        }
        this.store.upsertSession({
          ...session,
          groupId: ensured.address.conversationId,
          title: ensured.displayName,
          updatedAt,
        });
        this.store.upsertBinding({
          bindingId: activeBinding.bindingId,
          groupId: ensured.address.conversationId,
          role: "session",
          sessionId: session.sessionId,
          createdAt:
            existingBinding?.createdAt ?? new Date(activeBinding.createdAtMs).toISOString(),
          updatedAt,
        });
      } catch (error) {
        log
          .with({ sessionId: session.sessionId, conversationId: session.groupId })
          .warn("Failed to refresh WhatsApp session-group registration:", error);
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = undefined;
    await this.messageQueue;
    await this.accessPointHost.stop();
    for (const sessionId of this.registrations.keys()) {
      this.options.sessionManager.clearExclusiveSessionRuntime(sessionId);
      this.options.permissionPolicy.unregisterSessionPermissions(sessionId);
      this.options.permissionPolicy.clearDenyPrompt(sessionId);
    }
    this.registrations.clear();
    this.retainedAttachmentTurns.clear();
    this.store.close();
  }

  async routeInbound(
    event: RelayInboundMessageEvent,
    context: RelayInboundRouteContext,
  ): Promise<RelayInboundRouteResult> {
    const message = await this.toManagedMessage(event);
    if (!message) {
      return {
        localMessageId: `whatsapp-unmanaged:${event.message.providerMessageId}`,
        ...(event.message.attachments.length === 0
          ? {}
          : {
              afterCommit: () => this.discardInbound(event),
            }),
      };
    }

    const sessionId =
      message.role === "session"
        ? (this.store.getBindingByGroup(message.conversationId)?.sessionId ??
          this.options.bindings.getByExternalConversation(
            this.account.providerId,
            this.account.accountId,
            message.conversationId,
          )?.localConversationId)
        : undefined;
    await this.enqueueMessage(message);
    return {
      localMessageId: `${context.correlationId}:${event.message.providerMessageId}`,
      ...(sessionId ? { sessionId } : {}),
      ...(message.attachments.length === 0
        ? {}
        : {
            afterCommit: async () => {
              await Promise.all(
                message.attachments.map((attachment) => this.options.media.release(attachment)),
              );
            },
          }),
    };
  }

  authorizeInteractionSelection(selection: RelayInteractionSelection): boolean {
    if (
      selection.address.providerId !== this.account.providerId ||
      selection.address.accountId !== this.account.accountId
    ) {
      return false;
    }
    const managedGroups = this.options.service.getManagedGroupIds();
    const managed =
      !!managedGroups &&
      (Object.values(managedGroups.fixed).includes(selection.address.conversationId) ||
        this.store.getBindingByGroup(selection.address.conversationId)?.role === "session" ||
        this.options.bindings.getByExternalConversation(
          this.account.providerId,
          this.account.accountId,
          selection.address.conversationId,
        ) !== undefined);
    const ownerId = this.options.service.getConnectedIdentityId();
    return (
      managed &&
      ownerId !== undefined &&
      normalizeWhatsAppIdentity(ownerId) ===
        normalizeWhatsAppIdentity(selection.responder.primaryId)
    );
  }

  async discardInbound(event: RelayInboundMessageEvent): Promise<void> {
    await Promise.all(
      event.message.attachments.map(async (attachment) => {
        const restored = await this.options.media.restore(toStoredAttachment(event, attachment));
        await this.options.media.release(restored);
      }),
    );
  }

  async ensureSessionAccessPoint(
    request: RelayEnsureSessionAccessPointRequest,
  ): Promise<RelayEnsuredSessionAccessPoint> {
    return this.accessPointHost.ensureSessionAccessPoint(request);
  }

  private enqueueMessage(message: WhatsAppRoutedMessage): Promise<void> {
    const result = this.messageQueue.then(
      () => this.handleMessage(message),
      () => this.handleMessage(message),
    );
    this.messageQueue = result.catch(() => undefined);
    return result;
  }

  private async toManagedMessage(
    event: RelayInboundMessageEvent,
  ): Promise<WhatsAppRoutedMessage | undefined> {
    if (
      event.providerId !== this.account.providerId ||
      event.accountId !== this.account.accountId ||
      event.message.address.providerId !== this.account.providerId ||
      event.message.address.accountId !== this.account.accountId
    ) {
      return undefined;
    }
    const managedGroups = this.options.service.getManagedGroupIds();
    if (!managedGroups) return undefined;
    const conversationId = event.message.address.conversationId;
    const fixedRole = (["new-chats", "progress", "information-control"] as const).find(
      (role) => managedGroups.fixed[role] === conversationId,
    );
    const binding = fixedRole ? undefined : this.store.getBindingByGroup(conversationId);
    const sharedBinding = fixedRole
      ? undefined
      : this.options.bindings.getByExternalConversation(
          this.account.providerId,
          this.account.accountId,
          conversationId,
        );
    const role =
      fixedRole ?? (binding?.role === "session" || sharedBinding ? "session" : undefined);
    if (!role || (!event.message.text?.trim() && event.message.attachments.length === 0)) {
      return undefined;
    }
    const text =
      event.message.text?.trim() ||
      (event.message.attachments.some((attachment) => attachment.kind === "image")
        ? "The user sent an image."
        : "The user sent an attachment.");
    const attachments = await Promise.all(
      event.message.attachments.map((attachment) =>
        this.options.media.restore(toStoredAttachment(event, attachment)),
      ),
    );
    return {
      eventVersion: 1,
      providerMessageId: event.message.providerMessageId,
      conversationId,
      role,
      senderId: event.message.sender.primaryId,
      origin: "same-account-human",
      sentAt: event.message.sentAt,
      receivedAt: event.message.receivedAt,
      text,
      attachments,
      ...(event.message.replyTo
        ? { replyToProviderMessageId: event.message.replyTo.providerMessageId }
        : {}),
    };
  }

  private async handleMessage(message: WhatsAppRoutedMessage): Promise<void> {
    if (this.disposed || message.origin !== "same-account-human") return;
    const managedGroups = this.options.service.getManagedGroupIds();
    if (!managedGroups) return;
    const sessionBinding =
      message.role === "session" ? this.store.getBindingByGroup(message.conversationId) : undefined;
    const sharedSessionBinding =
      message.role === "session" && !sessionBinding
        ? this.options.bindings.getByExternalConversation(
            this.account.providerId,
            this.account.accountId,
            message.conversationId,
          )
        : undefined;
    const sessionId =
      sessionBinding?.role === "session"
        ? sessionBinding.sessionId
        : sharedSessionBinding?.localConversationId;
    if (
      (message.role === "session" && !sessionId) ||
      (message.role !== "session" && managedGroups.fixed[message.role] !== message.conversationId)
    ) {
      return;
    }
    if (!(await this.ensureStarted()) || !this.host) {
      throw new Error("WhatsApp fixed-agent runtime is not ready");
    }
    if (
      this.store.beginMessageProcessing(
        message.providerMessageId,
        message.conversationId,
        message.receivedAt,
      ) === "completed"
    ) {
      return;
    }

    if (message.role === "session") {
      await this.handleSessionGroupMessage(message, sessionId!);
      this.store.completeMessageProcessing(message.providerMessageId, new Date().toISOString());
      return;
    }

    try {
      log
        .with({ role: message.role, providerMessageId: message.providerMessageId })
        .info("Routing WhatsApp fixed-agent message");
      const progressCorrelation = message.replyToProviderMessageId
        ? this.store.getCorrelationByProviderMessageId(
            message.replyToProviderMessageId,
            message.conversationId,
          )
        : undefined;
      const turn: RelayFixedAgentTurn = {
        turnId: `whatsapp:${message.providerMessageId}`,
        correlationId: `whatsapp-inbound:${message.providerMessageId}`,
        text: message.text,
        attachments: message.attachments,
        receivedAt: message.receivedAt,
        origin: {
          address: address(this.account, message.conversationId),
          providerMessageId: parseRelayMessageId(message.providerMessageId),
        },
        ...(progressCorrelation
          ? {
              replyToProgressCorrelationId: progressCorrelation.correlationId,
              replyToProviderMessageId: parseRelayMessageId(progressCorrelation.providerMessageId),
            }
          : {}),
      };
      const informationSession =
        message.role === "information-control"
          ? await this.resolveInformationSession(message)
          : undefined;
      if (informationSession) {
        this.store.upsertMessageSessionRoute({
          groupId: message.conversationId,
          providerMessageId: message.providerMessageId,
          sessionId: informationSession.sessionId,
          direction: "inbound",
          createdAt: message.receivedAt,
        });
      }
      const result = informationSession
        ? await this.submitNaturalLanguageTurn(informationSession.sessionId, turn)
        : await this.host.submitTurn(message.role, turn);
      const routedSession = informationSession ?? this.store.getSessionById(result.sessionId);
      if (!informationSession && routedSession) {
        this.store.upsertMessageSessionRoute({
          groupId: message.conversationId,
          providerMessageId: message.providerMessageId,
          sessionId: routedSession.sessionId,
          direction: "inbound",
          createdAt: message.receivedAt,
        });
      }
      const reply = selectAgentReply(result);
      if (reply) {
        const receipt = await this.publishText(
          message.conversationId,
          formatRelayAgentMessage(reply, message.role, routedSession),
          message.providerMessageId,
          "success",
          routedSession?.sessionId,
        );
        if (routedSession) {
          this.store.upsertMessageSessionRoute({
            groupId: message.conversationId,
            providerMessageId: receipt.providerMessageId,
            sessionId: routedSession.sessionId,
            direction: "outbound",
            createdAt: receipt.publishedAt,
          });
        }
        log
          .with({
            role: message.role,
            providerMessageId: receipt.providerMessageId,
          })
          .info("Published WhatsApp fixed-agent reply");
      }
      this.store.completeMessageProcessing(message.providerMessageId, new Date().toISOString());
    } catch (error) {
      await this.publishText(
        message.conversationId,
        formatRelayAgentMessage(
          "Marshal could not process that message. Please send it again.",
          message.role,
        ),
        message.providerMessageId,
        "error",
      ).catch((publishError: unknown) => {
        log.error("Failed to publish WhatsApp turn failure:", publishError);
      });
      throw error;
    }
  }

  private async handleSessionGroupMessage(
    message: WhatsAppRoutedMessage,
    sessionId: string,
  ): Promise<void> {
    let session = this.store.getSessionById(sessionId);
    const metadata =
      this.options.sessionManager.getSession(sessionId) ??
      (await this.options.sessionManager.getSessionAsync(sessionId));
    if (!metadata) return;
    if (!session) {
      const sharedBinding = this.options.bindings.getByExternalConversation(
        this.account.providerId,
        this.account.accountId,
        message.conversationId,
      );
      const now = message.receivedAt;
      session = {
        idempotencyKey: `relay-existing-session:${sessionId}`,
        sessionId,
        kind: "conversation",
        groupId: message.conversationId,
        title: metadata.name || `Session ${sessionId}`,
        priority: "foreground",
        createdAt: metadata.createdAt ?? now,
        updatedAt: metadata.updatedAt ?? now,
      };
      this.store.upsertSession(session);
      this.store.upsertBinding({
        bindingId: sharedBinding?.bindingId ?? randomUUID(),
        groupId: message.conversationId,
        role: "session",
        sessionId,
        createdAt: sharedBinding ? new Date(sharedBinding.createdAtMs).toISOString() : now,
        updatedAt: sharedBinding ? new Date(sharedBinding.updatedAtMs).toISOString() : now,
      });
    }
    if (session.kind !== "conversation") return;
    log
      .with({ sessionId, providerMessageId: message.providerMessageId })
      .info("Routing WhatsApp session-group message");
    this.store.upsertMessageSessionRoute({
      groupId: message.conversationId,
      providerMessageId: message.providerMessageId,
      sessionId: session.sessionId,
      direction: "inbound",
      createdAt: message.receivedAt,
    });
    const correlationId = `whatsapp-session-inbound:${message.conversationId}:${message.providerMessageId}`;
    // Stage attachment delivery inside host validation, then start it after the host queue releases.
    const retainedAttachmentTurn =
      message.attachments.length > 0
        ? this.reserveRetainedAttachmentTurn(correlationId, session.sessionId)
        : undefined;
    try {
      const steering = await this.accessPointHost.steerSessionGroup({
        group: address(this.account, message.conversationId),
        providerMessageId: parseRelayMessageId(message.providerMessageId),
        correlationId,
        priority: "foreground",
        deliveryMode: "interrupt",
        idempotencyKey: correlationId,
        requestedAt: message.receivedAt,
        input: {
          text: message.text,
          attachments: message.attachments,
          transcripts: [],
        },
      });
      if (steering.sessionId !== session.sessionId) {
        throw new Error(
          `WhatsApp session-group route resolved to ${steering.sessionId}, expected ${session.sessionId}`,
        );
      }
      if (retainedAttachmentTurn) {
        const delivery = retainedAttachmentTurn.delivery;
        if (!delivery || retainedAttachmentTurn.started) {
          throw new Error("WhatsApp attachment turn was not staged exactly once");
        }
        retainedAttachmentTurn.started = true;
        await delivery();
      }
    } finally {
      if (
        retainedAttachmentTurn &&
        this.retainedAttachmentTurns.get(correlationId) === retainedAttachmentTurn
      ) {
        this.retainedAttachmentTurns.delete(correlationId);
      }
    }
  }

  private reserveRetainedAttachmentTurn(
    correlationId: string,
    sessionId: string,
  ): RetainedAttachmentTurn {
    if (this.retainedAttachmentTurns.has(correlationId)) {
      throw new Error(`WhatsApp attachment turn is already retained: ${correlationId}`);
    }
    const retained: RetainedAttachmentTurn = {
      sessionId,
      delivery: undefined,
      started: false,
    };
    this.retainedAttachmentTurns.set(correlationId, retained);
    return retained;
  }

  private ensureStarted(): Promise<boolean> {
    if (this.host) return Promise.resolve(true);
    if (this.startPromise) return this.startPromise;
    const pending = this.startHost();
    this.startPromise = pending;
    void pending.then(
      () => {
        if (this.startPromise === pending) this.startPromise = undefined;
      },
      () => {
        if (this.startPromise === pending) this.startPromise = undefined;
      },
    );
    return pending;
  }

  private async startHost(): Promise<boolean> {
    const managedGroups = this.options.service.getManagedGroupIds();
    if (!managedGroups) return false;
    const ports = this.createPorts(managedGroups);
    const host = new RelayFixedAgentHost({
      account: this.account,
      communityAddress: address(this.account, managedGroups.community),
      defaultTaskAgentId: "default",
      catalog: createRelayFixedAgentCatalog(),
      sessionCreation: ports.sessionCreation,
      sessionQuery: ports.sessionQuery,
      sessionSteering: ports.sessionSteering,
      sessionRuntime: ports.sessionRuntime,
      managedGroups: ports.managedGroups,
      sessionAccessPoints: {
        ensure: (request) => this.accessPointHost.ensureSessionAccessPoint(request),
      },
      publicationCommands: ports.publicationCommands,
      publicationCorrelations: ports.publicationCorrelations,
      clock: { now: () => new Date().toISOString() },
    });
    await host.initialize();
    for (const session of this.store.listSessions()) {
      if (
        session.kind !== "conversation" ||
        session.role !== "information-control" ||
        !this.options.sessionManager.getSession(session.sessionId)
      ) {
        continue;
      }
      // Fixed-agent runtime registration mutates one session at a time.
      // eslint-disable-next-line no-await-in-loop
      await host.registerConversationSession("information-control", session.sessionId);
    }
    this.host = host;
    log.info("WhatsApp fixed agents ready");
    return true;
  }

  private createAccessPointPorts(): RelayHostExperiencePorts {
    return {
      clock: { now: () => new Date().toISOString() },
      fixedAgents: {
        list: async () => success([]),
        get: async () => failure("not-found", "Fixed-agent catalog is not used here", false),
      },
      topology: this.options.topology,
      bindings: {
        getByGroup: async (group) => {
          const stored = this.store.getBindingByGroup(group.conversationId);
          if (stored) return success(storedBinding(stored, group));
          const shared = this.options.bindings.getByExternalConversation(
            group.providerId,
            group.accountId,
            group.conversationId,
          );
          if (!shared) return failure("not-found", "Relay access point is not bound", false);
          return success({
            bindingId: shared.bindingId,
            group,
            role: "session",
            sessionId: shared.localConversationId,
            createdAt: new Date(shared.createdAtMs).toISOString(),
            updatedAt: new Date(shared.updatedAtMs).toISOString(),
          });
        },
        listBySession: async (account, sessionId) => {
          if (!sameAccount(account, this.account)) {
            return failure("not-found", "Relay account was not found", false);
          }
          const stored = this.store
            .listBindingsBySession(sessionId)
            .map((binding) => storedBinding(binding, address(this.account, binding.groupId)));
          const known = new Set(stored.map((binding) => binding.bindingId));
          for (const shared of this.options.bindings.listByLocalConversation(sessionId)) {
            if (
              known.has(shared.bindingId) ||
              shared.provider !== this.account.providerId ||
              shared.accountId !== this.account.accountId
            ) {
              continue;
            }
            stored.push({
              bindingId: shared.bindingId,
              group: address(this.account, shared.externalConversationId),
              role: "session",
              sessionId: shared.localConversationId,
              createdAt: new Date(shared.createdAtMs).toISOString(),
              updatedAt: new Date(shared.updatedAtMs).toISOString(),
            });
          }
          return success(stored);
        },
        upsert: async (request) => {
          if (request.bindingId) {
            const stored = this.store.getBindingById(request.bindingId);
            if (stored && stored.groupId !== request.group.conversationId) {
              this.store.deleteBinding(stored.bindingId);
            }
            const shared = this.options.bindings.getById(request.bindingId);
            if (shared && shared.externalConversationId !== request.group.conversationId) {
              this.options.bindings.remove(shared.bindingId);
            }
          }
          return this.bindManagedGroup(request);
        },
        remove: async (request) => {
          const stored = this.store.getBindingByGroup(request.group.conversationId);
          const shared = this.options.bindings.getById(request.bindingId);
          if (!stored && !shared) {
            return failure("not-found", "Relay access point binding was not found", false);
          }
          if (stored?.role === "session") this.store.deleteSessionAccessPoint(stored.sessionId);
          else if (shared?.role === "session") {
            this.store.deleteSessionAccessPoint(shared.localConversationId);
          } else if (stored) this.store.deleteBinding(stored.bindingId);
          this.options.bindings.remove(request.bindingId);
          return success(
            stored
              ? storedBinding(stored, request.group)
              : {
                  bindingId: shared!.bindingId,
                  group: request.group,
                  role: "session",
                  sessionId: shared!.localConversationId,
                  createdAt: new Date(shared!.createdAtMs).toISOString(),
                  updatedAt: new Date(shared!.updatedAtMs).toISOString(),
                },
          );
        },
      },
      activity: {
        get: async (group) => {
          const binding = this.options.bindings.getByExternalConversation(
            group.providerId,
            group.accountId,
            group.conversationId,
          );
          if (!binding) return failure("not-found", "Relay access point is not bound", false);
          const activity = this.options.bindings.getActivity(binding.bindingId);
          if (!activity) {
            return failure("not-found", "Relay access point has no activity yet", false);
          }
          return success({
            group,
            bindingId: binding.bindingId,
            ...(activity.lastInboundAtMs === undefined
              ? {}
              : { lastInboundAt: new Date(activity.lastInboundAtMs).toISOString() }),
            ...(activity.lastPublicationAtMs === undefined
              ? {}
              : { lastPublicationAt: new Date(activity.lastPublicationAtMs).toISOString() }),
            ...(activity.lastSessionActivityAtMs === undefined
              ? {}
              : {
                  lastSessionActivityAt: new Date(activity.lastSessionActivityAtMs).toISOString(),
                }),
            updatedAt: new Date(activity.updatedAtMs).toISOString(),
          });
        },
        record: async (request) => {
          const retirement = request.bindingId
            ? this.options.bindings.getRetirement(request.bindingId)
            : undefined;
          if (retirement) {
            return success({
              group: request.group,
              bindingId: retirement.bindingId,
              ...(request.kind === "inbound"
                ? { lastInboundAt: request.occurredAt }
                : request.kind === "publication"
                  ? { lastPublicationAt: request.occurredAt }
                  : request.kind === "session"
                    ? { lastSessionActivityAt: request.occurredAt }
                    : { lastProgressPromptAt: request.occurredAt }),
              updatedAt: request.occurredAt,
            });
          }
          const binding =
            (request.bindingId && this.options.bindings.getById(request.bindingId)) ||
            this.options.bindings.getByExternalConversation(
              request.group.providerId,
              request.group.accountId,
              request.group.conversationId,
            );
          if (!binding) return failure("not-found", "Relay access point is not bound", false);
          const occurredAtMs = Date.parse(request.occurredAt);
          if (!Number.isFinite(occurredAtMs)) {
            return failure("invalid-request", "Relay activity timestamp is invalid", false);
          }
          const activity = this.options.bindings.recordActivity(
            binding.bindingId,
            request.kind,
            occurredAtMs,
          );
          return success({
            group: request.group,
            bindingId: binding.bindingId,
            ...(activity.lastInboundAtMs === undefined
              ? {}
              : { lastInboundAt: new Date(activity.lastInboundAtMs).toISOString() }),
            ...(activity.lastPublicationAtMs === undefined
              ? {}
              : { lastPublicationAt: new Date(activity.lastPublicationAtMs).toISOString() }),
            ...(activity.lastSessionActivityAtMs === undefined
              ? {}
              : {
                  lastSessionActivityAt: new Date(activity.lastSessionActivityAtMs).toISOString(),
                }),
            updatedAt: new Date(activity.updatedAtMs).toISOString(),
          });
        },
      },
      sessions: {
        create: (request) => this.createSession(request),
        query: (request) => this.querySessions(request),
        steer: (request) => this.steerSession(request),
        activateFixedAgent: async () => undefined,
        suspendFixedAgent: async () => undefined,
        reopen: async (request) => {
          const stored = this.store.getSessionById(request.session.sessionId);
          const metadata = this.options.sessionManager.getSession(request.session.sessionId);
          if (!metadata) return failure("not-found", "Relay session was not found", false);
          return success(
            stored ? this.toSessionDescriptor(stored) : this.toUnboundSessionDescriptor(metadata),
          );
        },
        retire: async () => undefined,
      },
      selfTools: {
        installFixedAgentPolicy: async () => undefined,
        removeFixedAgentPolicy: async () => undefined,
      },
      publication: {
        enqueue: (intent) => this.options.publication.enqueue(intent),
      },
      correlations: {
        get: (query) => this.readCorrelation(query),
      },
    };
  }

  private createPorts(managedGroups: WhatsAppManagedGroupIds): {
    readonly sessionCreation: RelaySessionCreationPort;
    readonly sessionQuery: RelaySessionQueryPort;
    readonly sessionSteering: RelaySessionSteeringPort;
    readonly sessionRuntime: RelayFixedAgentRuntimePort;
    readonly managedGroups: RelayFixedAgentManagedGroupPort;
    readonly publicationCommands: RelayPublicationCommandPort;
    readonly publicationCorrelations: RelayPublicationCorrelationReader;
  } {
    return {
      sessionCreation: {
        create: (request) => this.createSession(request),
      },
      sessionQuery: {
        query: (request) => this.querySessions(request),
      },
      sessionSteering: {
        steer: (request) => this.steerSession(request),
      },
      sessionRuntime: {
        appendHistory: async () => undefined,
        registerTools: (sessionId, registration) =>
          this.registerFixedAgentTools(sessionId, registration),
        submitNaturalLanguageTurn: (sessionId, turn) =>
          this.submitNaturalLanguageTurn(sessionId, turn),
      },
      managedGroups: {
        ensure: (request) => this.ensureManagedGroup(request, managedGroups),
        bind: (request) => this.bindManagedGroup(request),
      },
      publicationCommands: {
        enqueue: (intent) => this.publish(intent),
      },
      publicationCorrelations: {
        get: (query) => this.readCorrelation(query),
      },
    };
  }

  private async createSession(
    request: RelayHostSessionCreateRequest,
  ): Promise<RelayExperienceResult<RelayHostSessionDescriptor, RelaySessionErrorCode>> {
    const fixedRole =
      request.kind === "fixed-agent" ? requireFixedRole(request.fixedAgentId) : undefined;
    const existing =
      this.store.getSessionByIdempotencyKey(request.idempotencyKey) ??
      (fixedRole
        ? this.store
            .listSessions()
            .find((session) => session.kind === "fixed-agent" && session.role === fixedRole)
        : undefined);
    const existingMetadata = existing
      ? (this.options.sessionManager.getSession(existing.sessionId) ??
        (await this.options.sessionManager.getSessionAsync(existing.sessionId)))
      : null;
    if (existing && existingMetadata) {
      const updated = {
        ...existing,
        idempotencyKey: request.idempotencyKey,
        groupId: request.group.conversationId,
        title: request.title,
        priority: request.priority,
        ...(request.agentId ? { agentId: request.agentId } : {}),
        updatedAt: new Date().toISOString(),
      };
      if (!this.store.replaceSessionById(updated)) {
        return failure("unavailable", "Relay fixed-agent session could not be updated", true);
      }
      return success(this.toSessionDescriptor(updated));
    }

    try {
      const metadata = await this.options.sessionManager.createSession(undefined, undefined, {
        name: request.title,
        source: "user",
        setActive: false,
        ...(request.kind === "fixed-agent" ? { skills: [], mcp: [] } : {}),
      });
      const now = new Date().toISOString();
      const stored: StoredWhatsAppRelaySession = {
        idempotencyKey: request.idempotencyKey,
        sessionId: metadata.id,
        kind: request.kind,
        ...(fixedRole ? { role: fixedRole } : {}),
        groupId: request.group.conversationId,
        title: request.title,
        priority: request.priority,
        ...(request.agentId ? { agentId: request.agentId } : {}),
        createdAt: metadata.createdAt ?? now,
        updatedAt: metadata.updatedAt ?? now,
      };
      this.store.upsertSession(stored);
      return success(this.toSessionDescriptor(stored));
    } catch (error) {
      return failure("unavailable", describeError(error), true);
    }
  }

  private async querySessions(
    request: RelayHostSessionQuery,
  ): Promise<RelayExperienceResult<readonly RelayHostSessionDescriptor[], RelaySessionErrorCode>> {
    if (!sameAccount(request.account, this.account)) {
      return failure("not-found", "WhatsApp relay account was not found", false);
    }
    const text = request.text?.toLocaleLowerCase();
    const storedSessions = this.store.listSessions();
    const storedById = new Map(storedSessions.map((session) => [session.sessionId, session]));
    const descriptors = new Map<string, RelayHostSessionDescriptor>();
    for (const metadata of await this.options.sessionManager.listSessions()) {
      const stored = storedById.get(metadata.id);
      descriptors.set(
        metadata.id,
        stored ? this.toSessionDescriptor(stored) : this.toUnboundSessionDescriptor(metadata),
      );
    }
    for (const stored of storedSessions) {
      if (!descriptors.has(stored.sessionId)) {
        descriptors.set(stored.sessionId, this.toSessionDescriptor(stored));
      }
    }
    const sessions = [...descriptors.values()]
      .filter((session) => !request.sessionId || session.sessionId === request.sessionId)
      .filter(
        (session) =>
          !request.group || session.group?.conversationId === request.group.conversationId,
      )
      .filter((session) => !request.kind || session.kind === request.kind)
      .filter(
        (session) =>
          !text ||
          session.title?.toLocaleLowerCase().includes(text) ||
          session.sessionId.toLocaleLowerCase().includes(text),
      )
      .filter((session) => !request.statuses || request.statuses.includes(session.status));
    sessions.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.sessionId.localeCompare(right.sessionId),
    );
    return success(request.limit === undefined ? sessions : sessions.slice(0, request.limit));
  }

  private async steerSession(
    request: Parameters<RelaySessionSteeringPort["steer"]>[0],
  ): Promise<RelayExperienceResult<RelaySessionSteerReceipt, RelaySessionErrorCode>> {
    const text = request.input.text?.trim();
    if (!text) return failure("invalid-request", "Relay session input is empty", false);
    const stored = this.store.getSessionById(request.sessionId);
    if (!stored) return failure("not-found", "Relay session was not found", false);
    try {
      const attachments = request.input.attachments ?? [];
      const sourceIsBoundSessionAccessPoint =
        this.store.getBindingByGroup(request.source.conversationId)?.sessionId ===
          request.sessionId ||
        this.options.bindings.getByExternalConversation(
          request.source.providerId,
          request.source.accountId,
          request.source.conversationId,
        )?.localConversationId === request.sessionId;
      const prompt = buildRelaySessionTurnPrompt({
        text,
        source: request.source,
        providerMessageId: request.providerMessageId,
        sourceIsBoundSessionAccessPoint,
      });
      const retainedAttachmentTurn = this.retainedAttachmentTurns.get(request.correlationId);
      if (retainedAttachmentTurn) {
        if (
          retainedAttachmentTurn.sessionId !== request.sessionId ||
          retainedAttachmentTurn.delivery ||
          attachments.length === 0
        ) {
          throw new Error("WhatsApp retained attachment turn does not match its steering request");
        }
        retainedAttachmentTurn.delivery = () =>
          this.sendRelayAttachmentTurn(
            stored,
            prompt,
            request.providerMessageId,
            attachments,
            request.deliveryMode,
          );
      } else if (attachments.length > 0) {
        await this.sendRelayAttachmentTurn(
          stored,
          prompt,
          request.providerMessageId,
          attachments,
          request.deliveryMode,
        );
      } else {
        const acceptance = await this.options.sessionManager.sendRelayMessageToSession({
          sessionId: request.sessionId,
          source: {
            providerId: request.source.providerId,
            accountId: request.source.accountId,
            conversationId: request.source.conversationId,
            providerMessageId: request.providerMessageId,
          },
          message: prompt,
          idempotencyKey: request.idempotencyKey,
          deliveryMode: request.deliveryMode,
          sourceLabel: "WhatsApp access point",
        });
        if (!acceptance.accepted) {
          return failure(
            "unavailable",
            acceptance.error ?? "Relay message was not accepted for durable delivery",
            true,
          );
        }
      }
      return success({
        sessionId: request.sessionId,
        correlationId: request.correlationId,
        deliveryMode: request.deliveryMode,
        acceptedAt: new Date().toISOString(),
      });
    } catch (error) {
      return failure("unavailable", describeError(error), true);
    }
  }

  private async registerFixedAgentTools(
    sessionId: string,
    registration: RelayFixedAgentToolRegistration,
  ): Promise<void> {
    const session = this.store.getSessionById(sessionId);
    if (!session?.role) throw new Error(`Unknown WhatsApp fixed-agent session: ${sessionId}`);
    const specification = RELAY_FIXED_AGENT_SPECIFICATIONS.find(
      (candidate) => candidate.role === session.role,
    );
    if (!specification)
      throw new Error(`Missing WhatsApp fixed-agent specification: ${session.role}`);
    this.registrations.set(sessionId, registration);
    const tools: RuntimeTool[] = registration.definitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: { ...definition.parameters },
      handler: async (args, invocation) => {
        const turn = this.activeTurns.get(sessionId);
        if (!turn) throw new Error("WhatsApp fixed-agent tool ran outside an authorized turn");
        const result = await registration.invoke(definition.name, args, {
          sessionId,
          toolCallId: invocation.toolCallId,
          turn,
        });
        this.toolResults.get(sessionId)?.push({
          toolName: definition.name,
          result,
        });
        return JSON.stringify(result ?? null);
      },
    }));
    const allowedTools: Record<string, true> = {};
    for (const tool of tools) allowedTools[`tool:${tool.name}`] = true;
    this.options.permissionPolicy.registerSessionPermissions(sessionId, {
      ...DEFAULT_PERMISSIONS,
      allow: [],
      autoApproveReadOnly: false,
      allowModelPermissionsChange: false,
      tools: allowedTools,
      servers: {
        filesystem: { enabled: false, autoApprove: false },
        playwright: { enabled: false, autoApprove: false },
        shell: { enabled: false, autoApprove: false },
      },
    });
    this.options.permissionPolicy.setDenyPrompt(sessionId);
    this.options.permissionPolicy.markUnattended(sessionId);
    try {
      await this.options.sessionManager.configureExclusiveSessionRuntime(sessionId, {
        systemInstructions: specification.instructions,
        tools,
      });
    } catch (error) {
      this.registrations.delete(sessionId);
      this.options.permissionPolicy.unregisterSessionPermissions(sessionId);
      this.options.permissionPolicy.clearDenyPrompt(sessionId);
      throw error;
    }
  }

  private async submitNaturalLanguageTurn(
    sessionId: string,
    turn: RelayFixedAgentTurn,
  ): Promise<RelayFixedAgentTurnResult> {
    if (!this.registrations.has(sessionId)) {
      throw new Error(`WhatsApp fixed-agent tools are not registered for ${sessionId}`);
    }
    const results: Array<{ readonly toolName: string; readonly result: unknown }> = [];
    this.activeTurns.set(sessionId, turn);
    this.toolResults.set(sessionId, results);
    try {
      const prompt = [
        "Handle this authorized WhatsApp owner message as the next natural-language relay turn.",
        wrapUntrusted("whatsapp_relay", turn.text),
      ].join("\n\n");
      const response = await this.options.sessionManager.sendAndCollect(
        prompt,
        TURN_TIMEOUT_MS,
        undefined,
        sessionId,
        toSdkImageAttachments(turn.attachments ?? []),
        { clientMessageId: turn.origin.providerMessageId },
      );
      return {
        sessionId,
        ...(response.text.trim() ? { responseText: response.text.trim() } : {}),
        toolResults: results,
      };
    } finally {
      this.activeTurns.delete(sessionId);
      this.toolResults.delete(sessionId);
    }
  }

  private async resolveInformationSession(
    message: WhatsAppRoutedMessage,
  ): Promise<StoredWhatsAppRelaySession> {
    const replyRoute = message.replyToProviderMessageId
      ? this.store.getMessageSessionRoute(message.conversationId, message.replyToProviderMessageId)
      : undefined;
    if (replyRoute) {
      const session = this.store.getSessionById(replyRoute.sessionId);
      if (
        session?.role === "information-control" &&
        this.options.sessionManager.getSession(session.sessionId)
      ) {
        await this.ensureInformationSessionRegistration(session);
        return session;
      }
    }

    const idempotencyKey = [
      "relay-information-thread",
      message.conversationId,
      message.providerMessageId,
    ].join(":");
    const existing = this.store.getSessionByIdempotencyKey(idempotencyKey);
    if (
      existing?.kind === "conversation" &&
      existing.role === "information-control" &&
      this.options.sessionManager.getSession(existing.sessionId)
    ) {
      await this.ensureInformationSessionRegistration(existing);
      return existing;
    }

    const title = informationThreadTitle(message.text);
    const metadata = await this.options.sessionManager.createSession(undefined, undefined, {
      name: title,
      source: "user",
      setActive: false,
      skills: [],
      mcp: [],
    });
    const now = new Date().toISOString();
    const session: StoredWhatsAppRelaySession = {
      idempotencyKey,
      sessionId: metadata.id,
      kind: "conversation",
      role: "information-control",
      groupId: message.conversationId,
      title,
      priority: "control",
      agentId: "information-control",
      createdAt: metadata.createdAt ?? now,
      updatedAt: metadata.updatedAt ?? now,
    };
    this.store.upsertSession(session);
    await this.ensureInformationSessionRegistration(session);
    return session;
  }

  private async ensureInformationSessionRegistration(
    session: StoredWhatsAppRelaySession,
  ): Promise<void> {
    if (this.registrations.has(session.sessionId)) return;
    if (!this.host) throw new Error("WhatsApp fixed-agent runtime is not ready");
    await this.host.registerConversationSession("information-control", session.sessionId);
  }

  private async ensureManagedGroup(
    request: Parameters<RelayFixedAgentManagedGroupPort["ensure"]>[0],
    managedGroups: WhatsAppManagedGroupIds,
  ): Promise<
    RelayExperienceResult<
      Awaited<ReturnType<RelayFixedAgentManagedGroupPort["ensure"]>> extends RelayExperienceResult<
        infer Value,
        RelayProvisioningErrorCode
      >
        ? Value
        : never,
      RelayProvisioningErrorCode
    >
  > {
    if (!sameAccount(request.account, this.account)) {
      return failure("not-found", "WhatsApp relay account was not found", false);
    }
    if (request.role !== "session") {
      const conversationId = managedGroups.fixed[request.role];
      return success({
        group: managedGroupDescriptor(
          this.account,
          request.role,
          conversationId,
          managedGroups.community,
          FIXED_GROUP_TITLES[request.role],
          request.requestedAt,
        ),
        disposition: "existing",
      });
    }
    try {
      const existingConversationId =
        request.existingGroup &&
        sameAccount(request.existingGroup, this.account) &&
        !Object.values(managedGroups.fixed).includes(request.existingGroup.conversationId)
          ? request.existingGroup.conversationId
          : undefined;
      const ensured = await this.options.service.ensureSessionGroup({
        idempotencyKey: request.groupKey,
        displayName: normalizeGroupDisplayName(request.displayName),
        communityConversationId: managedGroups.community,
        ...(existingConversationId ? { existingConversationId } : {}),
      });
      return success({
        group: managedGroupDescriptor(
          this.account,
          "session",
          ensured.conversationId,
          ensured.communityConversationId,
          ensured.displayName,
          request.requestedAt,
        ),
        disposition: ensured.disposition,
      });
    } catch (error) {
      return failure("provider-failure", describeError(error), true);
    }
  }

  private async bindManagedGroup(
    request: Parameters<RelayFixedAgentManagedGroupPort["bind"]>[0],
  ): Promise<RelayExperienceResult<RelayGroupSessionBinding, RelayPersistenceErrorCode>> {
    const existing = this.store.getBindingByGroup(request.group.conversationId);
    const now = request.requestedAt;
    const binding: RelayGroupSessionBinding = {
      bindingId: request.bindingId ?? existing?.bindingId ?? randomUUID(),
      group: request.group,
      role: request.role,
      sessionId: request.sessionId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (request.role === "session") {
      const metadata = this.options.sessionManager.getSession(request.sessionId);
      if (!metadata) {
        return failure("not-found", "Relay session was not found", false);
      }
      const stored = this.store.getSessionById(request.sessionId);
      this.store.upsertSession({
        idempotencyKey: stored?.idempotencyKey ?? `relay-existing-session:${request.sessionId}`,
        sessionId: request.sessionId,
        kind: "conversation",
        ...(stored?.role ? { role: stored.role } : {}),
        groupId: request.group.conversationId,
        title: metadata.name || stored?.title || `Session ${request.sessionId}`,
        priority: stored?.priority ?? "foreground",
        ...(stored?.agentId ? { agentId: stored.agentId } : {}),
        createdAt: metadata.createdAt ?? stored?.createdAt ?? now,
        updatedAt: metadata.updatedAt ?? now,
      });
    }
    this.store.upsertBinding({
      bindingId: binding.bindingId,
      groupId: binding.group.conversationId,
      role: binding.role,
      sessionId: binding.sessionId,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
    });
    if (!this.options.bindings.getRetirement(binding.bindingId)) {
      this.options.bindings.upsert({
        bindingId: binding.bindingId,
        provider: binding.group.providerId,
        accountId: binding.group.accountId,
        externalConversationId: binding.group.conversationId,
        localConversationId: binding.sessionId,
        role: binding.role,
        updatedAtMs: Date.parse(binding.updatedAt),
      });
    }
    return success(binding);
  }

  private async sendRelayAttachmentTurn(
    session: StoredWhatsAppRelaySession,
    prompt: string,
    clientMessageId: string,
    attachments: readonly RelayIngestedAttachment[],
    deliveryMode: RelaySessionSteerReceipt["deliveryMode"],
  ): Promise<void> {
    await this.options.sessionManager.sendAndCollect(
      prompt,
      TURN_TIMEOUT_MS,
      undefined,
      session.sessionId,
      toSdkImageAttachments(attachments),
      { clientMessageId, deliveryMode },
    );
  }

  private publishText(
    conversationId: string,
    text: string,
    replyToProviderMessageId: string,
    responseKind: "success" | "error",
    sourceSessionId?: string,
  ): Promise<RelayPublishReceipt> {
    const requestedAt = new Date().toISOString();
    const publicationId = fixedAgentPublicationId(
      this.account,
      conversationId,
      replyToProviderMessageId,
      responseKind,
    );
    const request: RelayPublishRequest = {
      publicationId,
      address: address(this.account, conversationId),
      kind: "reply",
      text,
      replyToProviderMessageId: parseRelayMessageId(replyToProviderMessageId),
      ...(sourceSessionId ? { sourceSessionId } : {}),
      sourceTurnId: replyToProviderMessageId,
    };
    return this.options.publication.publishNow({
      intent: "deliberate",
      correlationId: `${publicationId}:correlation`,
      idempotencyKey: publicationId,
      requestedAt,
      request,
    });
  }

  private async publish(
    intent: Parameters<RelayPublicationCommandPort["enqueue"]>[0],
  ): Promise<RelayExperienceResult<RelayPublicationEnqueueReceipt, RelayPublicationErrorCode>> {
    const existing = this.store.getCorrelationByPublicationId(intent.request.publicationId);
    if (existing) {
      return success({
        publicationId: existing.publicationId,
        correlationId: existing.correlationId,
        disposition: "deduplicated",
        acceptedAt: existing.createdAt,
      });
    }
    try {
      const sourceSession = intent.request.sourceSessionId
        ? this.store.getSessionById(intent.request.sourceSessionId)
        : undefined;
      const binding = this.store.getBindingByGroup(intent.request.address.conversationId);
      const routedSession =
        sourceSession ?? (binding ? this.store.getSessionById(binding.sessionId) : undefined);
      const role =
        routedSession?.role ??
        (binding?.role === "new-chats" ||
        binding?.role === "progress" ||
        binding?.role === "information-control"
          ? binding.role
          : undefined);
      const receipt = await this.options.publication.publishNow({
        ...intent,
        request: {
          ...intent.request,
          text: formatRelayAgentMessage(intent.request.text, role, routedSession),
        },
      });
      this.store.upsertCorrelation({
        correlationId: intent.correlationId,
        groupId: intent.request.address.conversationId,
        providerMessageId: receipt.providerMessageId,
        publicationId: intent.request.publicationId,
        sourceSessionId: intent.request.sourceSessionId,
        sourceTurnId: intent.request.sourceTurnId,
        createdAt: receipt.publishedAt,
      });
      if (routedSession) {
        this.store.upsertMessageSessionRoute({
          groupId: intent.request.address.conversationId,
          providerMessageId: receipt.providerMessageId,
          sessionId: routedSession.sessionId,
          direction: "outbound",
          createdAt: receipt.publishedAt,
        });
      }
      return success({
        publicationId: intent.request.publicationId,
        correlationId: intent.correlationId,
        disposition: "queued",
        acceptedAt: receipt.publishedAt,
      });
    } catch (error) {
      return failure("provider-failure", describeError(error), true);
    }
  }

  private async readCorrelation(
    query: RelayPublicationCorrelationQuery,
  ): Promise<RelayExperienceResult<RelayPublicationCorrelationRecord, RelayPublicationErrorCode>> {
    if (!sameAccount(query.account, this.account)) {
      return failure("not-found", "WhatsApp relay account was not found", false);
    }
    const stored = this.store.getCorrelation(query.correlationId);
    if (!stored) return failure("not-found", "Relay publication correlation was not found", false);
    return success({
      address: address(this.account, stored.groupId),
      publicationId: stored.publicationId,
      providerMessageId: parseRelayMessageId(stored.providerMessageId),
      correlationId: stored.correlationId,
      sourceSessionId: stored.sourceSessionId,
      sourceTurnId: stored.sourceTurnId,
      createdAt: stored.createdAt,
      publishedAt: stored.createdAt,
    });
  }

  private toSessionDescriptor(session: StoredWhatsAppRelaySession): RelayHostSessionDescriptor {
    const metadata = this.options.sessionManager.getSession(session.sessionId);
    const status = metadata
      ? this.options.sessionManager.isSessionBusy(session.sessionId)
        ? "busy"
        : metadata.isActive
          ? "ready"
          : "paused"
      : "ended";
    return {
      account: this.account,
      sessionId: session.sessionId,
      kind: session.kind,
      status,
      priority: session.priority,
      group: address(this.account, session.groupId),
      ...(session.kind === "fixed-agent" && session.role ? { fixedAgentId: session.role } : {}),
      createdAt: metadata?.createdAt ?? session.createdAt,
      updatedAt: metadata?.updatedAt ?? session.updatedAt,
      title: metadata?.name ?? session.title,
      ...(session.agentId ? { agentId: session.agentId } : {}),
      persistence: "persistent",
      inspectable: true,
      retention: session.kind === "fixed-agent" ? "fixed" : "ordinary",
      creationDisposition: "deduplicated",
    };
  }

  private toUnboundSessionDescriptor(metadata: SessionMetadata): RelayHostSessionDescriptor {
    return {
      account: this.account,
      sessionId: metadata.id,
      kind: "conversation",
      status: metadata.isBusy ? "busy" : metadata.isActive ? "ready" : "paused",
      priority: "foreground",
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      title: metadata.name,
      persistence: "persistent",
      inspectable: true,
      retention: "ordinary",
      creationDisposition: "deduplicated",
    };
  }
}

function selectAgentReply(result: RelayFixedAgentTurnResult): string | undefined {
  if (
    result.toolResults.some(
      (tool) => tool.toolName === RELAY_FIXED_AGENT_TOOL_NAMES.newChatsClarify,
    )
  ) {
    return undefined;
  }

  const response = result.responseText?.trim();
  if (response) return response.slice(0, 8_000);
  if (
    result.toolResults.some(
      (tool) => tool.toolName === RELAY_FIXED_AGENT_TOOL_NAMES.newChatsStartTask,
    )
  ) {
    return "Started the task in exactly one persistent Marshal session and group.";
  }
  return undefined;
}

function buildRelaySessionTurnPrompt(input: {
  readonly text: string;
  readonly source: RelayAddress;
  readonly providerMessageId: string;
  readonly sourceIsBoundSessionAccessPoint: boolean;
}): string {
  return [
    '<marshal-relay-turn provider="whatsapp-baileys">',
    `Authorized inbound access point: ${input.source.conversationId}.`,
    `Provider message ID: ${input.providerMessageId}.`,
    "Handle this as the next user turn in the existing Marshal session.",
    input.sourceIsBoundSessionAccessPoint
      ? "Use publishRelayMessage for the deliberate reply. Select the active binding for this access point and pass replyToProviderMessageId if quoting this exact message is useful."
      : "Use publishRelayMessage to contact the user deliberately through the active session access point. Do not quote the control conversation message into a different access point.",
    "Do not rely on transcript mirroring.",
    "</marshal-relay-turn>",
    wrapUntrusted("whatsapp_relay", input.text),
  ].join("\n\n");
}

function informationThreadTitle(text: string): string {
  const topic = text.replace(/\s+/g, " ").trim().slice(0, 64);
  return topic ? `Information: ${topic}` : "Information conversation";
}

function formatRelayAgentMessage(
  text: string,
  role?: WhatsAppManagedFixedGroupRole,
  session?: StoredWhatsAppRelaySession,
): string {
  const roleLabel = role
    ? FIXED_GROUP_TITLES[role]
    : session?.kind === "conversation"
      ? "Session"
      : undefined;
  const sessionLabel =
    session?.kind === "conversation" ? sanitizeWhatsAppLabel(session.title) : undefined;
  const label =
    roleLabel && sessionLabel && sessionLabel !== roleLabel
      ? `${roleLabel} | ${sessionLabel}`
      : (sessionLabel ?? roleLabel ?? "Relay");
  const continuation =
    role === "information-control" && session?.kind === "conversation"
      ? "\n\n_Reply to this message to continue this conversation._"
      : "";
  return `*Marshal - ${label}*\n${text.trim()}${continuation}`;
}

function sanitizeWhatsAppLabel(value: string): string {
  const normalized = value
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, 80) || "Relay";
}

function managedGroupDescriptor(
  account: RelayAccountScope,
  role: RelayManagedGroupDescriptor["role"],
  conversationId: string,
  communityConversationId: string,
  displayName: string,
  timestamp: string,
): RelayManagedGroupDescriptor {
  return {
    address: address(account, conversationId),
    communityAddress: address(account, communityConversationId),
    role,
    displayName,
    state: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function fixedAgentPublicationId(
  account: RelayAccountScope,
  conversationId: string,
  providerMessageId: string,
  responseKind: "success" | "error",
): string {
  const digest = createHash("sha256")
    .update(
      [account.providerId, account.accountId, conversationId, providerMessageId, responseKind].join(
        "\0",
      ),
    )
    .digest("hex");
  return `whatsapp-fixed-agent:${responseKind}:${digest}`;
}

function address(account: RelayAccountScope, conversationId: string): RelayAddress {
  return {
    ...account,
    conversationId: parseRelayConversationId(conversationId),
  };
}

function requireFixedRole(value: string | undefined): RelayFixedAgentRole {
  if (value === "new-chats" || value === "progress" || value === "information-control") {
    return value;
  }
  throw new Error(`Invalid WhatsApp fixed-agent role: ${String(value)}`);
}

function sameAccount(left: RelayAccountScope, right: RelayAccountScope): boolean {
  return left.providerId === right.providerId && left.accountId === right.accountId;
}

function normalizeWhatsAppIdentity(value: string): string {
  return value.replace(/:\d+(?=@)/, "");
}

function toStoredAttachment(
  event: RelayInboundMessageEvent,
  attachment: RelayInboundMessageEvent["message"]["attachments"][number],
): RelayStoredAttachment {
  if (attachment.sizeBytes === undefined || !attachment.sha256 || !attachment.storageKey) {
    throw new Error("Relay attachment is missing its bounded storage descriptor");
  }
  return {
    metadata: {
      address: event.message.address,
      providerMessageId: event.message.providerMessageId,
      attachmentId: attachment.id,
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
      ...(attachment.sizeBytes === undefined ? {} : { sizeBytes: attachment.sizeBytes }),
      ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
      ...(attachment.voiceMemo
        ? {
            voice: {
              ...(attachment.durationMs === undefined ? {} : { durationMs: attachment.durationMs }),
            },
          }
        : {}),
    },
    storageKey: attachment.storageKey,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256,
    ingestedAt: event.occurredAt,
  };
}

function toSdkImageAttachments(
  attachments: readonly RelayIngestedAttachment[],
): Array<{ type: "file"; path: string; displayName: string }> | undefined {
  const images = attachments.filter((attachment) => attachment.metadata.kind === "image");
  return images.length === 0
    ? undefined
    : images.map((attachment) => ({
        type: "file",
        path: attachment.localPath,
        displayName: attachment.metadata.fileName ?? `image-${attachment.metadata.attachmentId}`,
      }));
}

function normalizeGroupDisplayName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "Marshal Task";
  return trimmed.slice(0, 80);
}

function success<Value>(value: Value): RelayExperienceResult<Value, never> {
  return { ok: true, value };
}

function storedBinding(
  binding: StoredWhatsAppRelayBinding,
  group: RelayAddress,
): RelayGroupSessionBinding {
  return {
    bindingId: binding.bindingId,
    group,
    role: binding.role,
    sessionId: binding.sessionId,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

function failure<Code extends string>(
  code: Code,
  message: string,
  retryable: boolean,
): RelayExperienceResult<never, Code> {
  return { ok: false, error: { code, message, retryable } };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "WhatsApp relay operation failed";
}
