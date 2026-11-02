import { randomUUID } from "node:crypto";

import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayMessageId,
  parseRelayProviderId,
} from "../../../../common/relay-contract";
import type {
  RelayAccountId,
  RelayAddress,
  RelayAttachment,
  RelayConversationId,
  RelayInteractionSelection,
  RelayMessageId,
  RelayProviderCapabilities,
  RelayProviderId,
  RelayPublishKind,
  RelayPublishRequest,
} from "../../../../common/relay-contract";
import type {
  RelayAccountOperationRequest,
  RelayAccountScope,
  RelayAttachmentLocalSource,
  RelayAttachmentMetadata,
  RelayExperienceErrorCode,
  RelayExperienceResult,
  RelayInboundAuthorizationDecision,
  RelayInboundAuthorizationRequest,
  RelayIngestedAttachment,
  RelayTimestamp,
  RelayVoiceTranscript,
} from "../../../../common/relay-experience-contract";
import type {
  RelayConversation,
  RelayConversationAdministration,
  RelayConversationCreateRequest,
  RelayDeliveryState,
  RelayInteractionAdministration,
  RelayProvider,
  RelayProviderEvent,
  RelayProviderEventListener,
  RelayProviderFailure,
  RelayPublishReceipt,
} from "../../contracts";
import type {
  RelayCommunityProvisioningPort,
  RelayConnectionControlPort,
  RelayInboundAuthorizationPort,
  RelayManagedGroupAdministrationPort,
  RelaySetupStatusPort,
} from "../../experience-ports";
import { normalizeWhatsAppProtocolEnvelope, normalizeWhatsAppTimestamp } from "./envelope";
import type {
  NormalizedWhatsAppProtocolMessageEnvelope,
  WhatsAppProtocolAttachment,
  WhatsAppProtocolMessageEnvelope,
} from "./envelope";
import {
  relayAddressesEqual,
  relayAttachmentFromIngested,
  relayConnectionStatusFromSetup,
  relayConversationFromCommunity,
  relayConversationFromManagedGroup,
  relayConversationFromProtocol,
  relayInboundMessageFromProtocol,
} from "./translation";
import type { WhatsAppProtocolConversationDescriptor } from "./translation";

export const WHATSAPP_BAILEYS_PROVIDER_ID = parseRelayProviderId("whatsapp-baileys");
export const WHATSAPP_MEDIA_PROVIDER_ID = "whatsapp-baileys" as const;

const WHATSAPP_CAPABILITIES: RelayProviderCapabilities = Object.freeze({
  inbound: true,
  quotedReplies: true,
  attachments: true,
  voice: true,
  managedGroups: true,
  communities: true,
  renameConversation: true,
  retireConversation: true,
  remotePermissionApproval: false,
  interactiveChoices: "unsupported",
});

export interface WhatsAppTextPublicationRequest {
  readonly account: RelayAccountScope;
  readonly conversationId: RelayConversationId;
  readonly publicationId: string;
  readonly kind: RelayPublishKind;
  readonly text: string;
  readonly quotedProviderMessageId?: RelayMessageId;
}

export interface WhatsAppTextPublicationReceipt {
  readonly providerMessageId: RelayMessageId;
  readonly publishedAt: RelayTimestamp;
}

export type WhatsAppProtocolEvent =
  | {
      readonly type: "message";
      readonly envelope: WhatsAppProtocolMessageEnvelope;
    }
  | {
      readonly type: "delivery";
      readonly occurredAt: RelayTimestamp;
      readonly providerMessageId: RelayMessageId;
      readonly state: RelayDeliveryState;
      readonly failure?: RelayProviderFailure;
    }
  | {
      readonly type: "conversation";
      readonly occurredAt: RelayTimestamp;
      readonly change: "created" | "updated" | "retired";
      readonly conversation: WhatsAppProtocolConversationDescriptor;
    }
  | {
      readonly type: "interaction-selection";
      readonly selection: RelayInteractionSelection;
    };

export type WhatsAppProtocolEventListener = (event: WhatsAppProtocolEvent) => Promise<void>;

export interface WhatsAppProtocolPort {
  subscribeProtocol(
    account: RelayAccountScope,
    listener: WhatsAppProtocolEventListener,
  ): () => void;
  publishText(request: WhatsAppTextPublicationRequest): Promise<WhatsAppTextPublicationReceipt>;
  listConversations(
    account: RelayAccountScope,
  ): Promise<readonly WhatsAppProtocolConversationDescriptor[]>;
}

type RelayAllowedInboundAuthorizationDecision = Extract<
  RelayInboundAuthorizationDecision,
  { readonly decision: "allow" }
>;

export interface WhatsAppMediaDownloadAuthorization {
  readonly acceptanceToken: string;
  readonly decision: RelayInboundAuthorizationDecision;
  readonly expiresAt?: RelayTimestamp;
}

export interface WhatsAppMediaDownloadAuthorizationPort {
  createMediaDownloadAuthorization(
    request: RelayInboundAuthorizationRequest,
    decision: RelayAllowedInboundAuthorizationDecision,
  ): Promise<WhatsAppMediaDownloadAuthorization>;
}

export interface WhatsAppInboundAuthorizationPort
  extends RelayInboundAuthorizationPort, WhatsAppMediaDownloadAuthorizationPort {}

export interface WhatsAppOriginalMessageContext {
  readonly account: RelayAccountScope;
  readonly address: RelayAddress;
  readonly providerMessageId: RelayMessageId;
  readonly senderId?: string;
  readonly sentAt?: RelayTimestamp;
  readonly text?: string;
  readonly caption?: string;
  readonly quotedProviderMessageId?: RelayMessageId;
  readonly quotedText?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null | undefined>>;
}

export interface WhatsAppInboundMediaDescriptor {
  readonly attachment: RelayAttachmentMetadata;
  readonly source: RelayAttachmentLocalSource;
  readonly voiceMemo?: boolean;
}

export interface WhatsAppMediaPipelineRequest {
  readonly authorization: WhatsAppMediaDownloadAuthorization;
  readonly message: WhatsAppOriginalMessageContext;
  readonly media: WhatsAppInboundMediaDescriptor;
  readonly signal?: AbortSignal;
}

export interface WhatsAppBoundedMessageContext extends WhatsAppOriginalMessageContext {
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

interface WhatsAppMediaPipelineResultBase {
  readonly providerId: typeof WHATSAPP_MEDIA_PROVIDER_ID;
  readonly idempotencyKey: string;
  readonly contentSha256: string;
  readonly processedAt: RelayTimestamp;
  readonly originalMessage: WhatsAppBoundedMessageContext;
}

export interface WhatsAppVoiceTranscriptResult extends WhatsAppMediaPipelineResultBase {
  readonly kind: "voice-transcript";
  readonly transcript: RelayVoiceTranscript;
  readonly audio: RelayIngestedAttachment;
}

export interface WhatsAppAttachmentResult extends WhatsAppMediaPipelineResultBase {
  readonly kind: "attachment";
  readonly attachment: RelayIngestedAttachment;
}

export type WhatsAppMediaPipelineResult = WhatsAppVoiceTranscriptResult | WhatsAppAttachmentResult;

export interface WhatsAppMediaPipelinePort {
  processInbound(request: WhatsAppMediaPipelineRequest): Promise<WhatsAppMediaPipelineResult>;
  release?(result: WhatsAppMediaPipelineResult): Promise<void>;
}

export interface WhatsAppRelayProviderDependencies {
  readonly accountId: RelayAccountId;
  readonly capabilities?: RelayProviderCapabilities;
  readonly setupStatus: RelaySetupStatusPort;
  readonly connectionControl: RelayConnectionControlPort;
  readonly communityProvisioning: RelayCommunityProvisioningPort;
  readonly groupAdministration: RelayManagedGroupAdministrationPort;
  readonly inboundAuthorization: WhatsAppInboundAuthorizationPort;
  readonly media: WhatsAppMediaPipelinePort;
  readonly protocol: WhatsAppProtocolPort;
  readonly interactions?: RelayInteractionAdministration;
  readonly now?: () => RelayTimestamp;
  readonly createOperationId?: () => string;
}

interface SourceActivation {
  active: boolean;
  readonly abortController: AbortController;
  readonly teardowns: Array<() => void>;
}

interface ProcessedWhatsAppAttachment {
  readonly attachment?: RelayAttachment;
  readonly transcript?: string;
  readonly mediaResult?: WhatsAppMediaPipelineResult;
}

export class WhatsAppRelayProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "WhatsAppRelayProviderError";
  }
}

export class WhatsAppRelayProvider implements RelayProvider {
  readonly providerId: RelayProviderId = WHATSAPP_BAILEYS_PROVIDER_ID;
  readonly conversations: RelayConversationAdministration = {
    list: (accountId) => this.listConversations(accountId),
    create: (accountId, request) => this.createConversation(accountId, request),
    rename: (address, displayName) => this.renameConversation(address, displayName),
    retire: (address) => this.retireConversation(address),
  };
  readonly interactions?: RelayInteractionAdministration;

  private readonly accountId: RelayAccountId;
  private readonly account: RelayAccountScope;
  private readonly providerCapabilities: RelayProviderCapabilities;
  private readonly setupStatus: RelaySetupStatusPort;
  private readonly connectionControl: RelayConnectionControlPort;
  private readonly communityProvisioning: RelayCommunityProvisioningPort;
  private readonly groupAdministration: RelayManagedGroupAdministrationPort;
  private readonly inboundAuthorization: WhatsAppInboundAuthorizationPort;
  private readonly media: WhatsAppMediaPipelinePort;
  private readonly protocol: WhatsAppProtocolPort;
  private readonly now: () => RelayTimestamp;
  private readonly createOperationId: () => string;
  private readonly listeners = new Set<RelayProviderEventListener>();
  private sourceActivation: SourceActivation | undefined;
  private disposed = false;

  constructor(dependencies: WhatsAppRelayProviderDependencies) {
    this.accountId = parseRelayAccountId(dependencies.accountId);
    this.account = { providerId: this.providerId, accountId: this.accountId };
    this.providerCapabilities = dependencies.capabilities ?? WHATSAPP_CAPABILITIES;
    this.setupStatus = dependencies.setupStatus;
    this.connectionControl = dependencies.connectionControl;
    this.communityProvisioning = dependencies.communityProvisioning;
    this.groupAdministration = dependencies.groupAdministration;
    this.inboundAuthorization = dependencies.inboundAuthorization;
    this.media = dependencies.media;
    this.protocol = dependencies.protocol;
    this.interactions = dependencies.interactions;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createOperationId = dependencies.createOperationId ?? randomUUID;
  }

  capabilities(accountId: RelayAccountId): RelayProviderCapabilities {
    this.assertUsable();
    this.assertAccountId(accountId);
    return this.providerCapabilities;
  }

  async connect(accountId: RelayAccountId): Promise<void> {
    this.assertUsable();
    this.assertAccountId(accountId);
    this.unwrap(
      await this.connectionControl.connect(this.accountOperation("connect")),
      "connect WhatsApp account",
    );
  }

  async disconnect(accountId: RelayAccountId): Promise<void> {
    this.assertUsable();
    this.assertAccountId(accountId);
    this.unwrap(
      await this.connectionControl.disconnect(this.accountOperation("disconnect")),
      "disconnect WhatsApp account",
    );
  }

  async status(accountId: RelayAccountId) {
    this.assertUsable();
    this.assertAccountId(accountId);
    const snapshot = this.unwrap(
      await this.setupStatus.getStatus(this.account),
      "read WhatsApp setup status",
    );
    this.assertAccountScope(snapshot.account, "WhatsApp setup status");
    return relayConnectionStatusFromSetup(snapshot);
  }

  async publish(request: RelayPublishRequest): Promise<RelayPublishReceipt> {
    this.assertUsable();
    const address = this.normalizeAddress(request.address, "WhatsApp publication");
    const publicationId = requireTrimmedText(request.publicationId, "WhatsApp publication ID");
    const text = requireNonBlankText(request.text, "WhatsApp publication text");
    const receipt = await this.protocol.publishText({
      account: this.account,
      conversationId: address.conversationId,
      publicationId,
      kind: request.kind,
      text,
      ...(request.replyToProviderMessageId === undefined
        ? {}
        : {
            quotedProviderMessageId: parseRelayMessageId(request.replyToProviderMessageId),
          }),
    });
    return {
      publicationId,
      providerMessageId: parseRelayMessageId(receipt.providerMessageId),
      publishedAt: normalizeWhatsAppTimestamp(
        receipt.publishedAt,
        "WhatsApp publication timestamp",
      ),
    };
  }

  subscribe(listener: RelayProviderEventListener): () => void {
    this.assertUsable();
    this.listeners.add(listener);
    try {
      if (this.listeners.size === 1) this.activateSources();
    } catch (error) {
      this.listeners.delete(listener);
      throw error;
    }

    return once(() => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.deactivateSources();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.deactivateSources();
  }

  private async listConversations(
    accountId: RelayAccountId,
  ): Promise<readonly RelayConversation[]> {
    this.assertUsable();
    this.assertAccountId(accountId);
    const conversations = await this.protocol.listConversations(this.account);
    if (!Array.isArray(conversations)) {
      throw new TypeError("WhatsApp conversation catalog must return an array");
    }
    return conversations.map((conversation) =>
      relayConversationFromProtocol(this.providerId, this.accountId, conversation),
    );
  }

  private async createConversation(
    accountId: RelayAccountId,
    request: RelayConversationCreateRequest,
  ): Promise<RelayConversation> {
    this.assertUsable();
    this.assertAccountId(accountId);
    const displayName = requireTrimmedText(
      request.displayName,
      "WhatsApp conversation display name",
    );

    if (request.kind === "community") {
      if (request.parentConversationId !== undefined) {
        throw this.unsupported("WhatsApp communities cannot have a parent conversation");
      }
      const topology = this.unwrap(
        await this.communityProvisioning.provision({
          ...this.account,
          ...this.idempotentRequest("create-community"),
          displayName,
          groups: [],
        }),
        "create WhatsApp community",
      );
      this.normalizeAddress(topology.community.address, "WhatsApp community result");
      return relayConversationFromCommunity(topology.community);
    }

    if (request.kind === "group") {
      if (request.parentConversationId === undefined) {
        throw this.unsupported("WhatsApp managed groups require a parent community");
      }
      const group = this.unwrap(
        await this.groupAdministration.createGroup({
          ...this.idempotentRequest("create-group"),
          communityAddress: {
            ...this.account,
            conversationId: parseRelayConversationId(request.parentConversationId),
          },
          role: "session",
          displayName,
        }),
        "create WhatsApp managed group",
      );
      this.normalizeAddress(group.address, "WhatsApp managed group result");
      this.normalizeAddress(group.communityAddress, "WhatsApp managed group community");
      return relayConversationFromManagedGroup(group);
    }

    throw this.unsupported(`WhatsApp cannot create ${request.kind} conversations`);
  }

  private async renameConversation(
    address: RelayAddress,
    displayName: string,
  ): Promise<RelayConversation> {
    this.assertUsable();
    const normalizedAddress = this.normalizeAddress(address, "WhatsApp conversation rename");
    const group = this.unwrap(
      await this.groupAdministration.renameGroup({
        ...this.idempotentRequest("rename-group"),
        address: normalizedAddress,
        displayName: requireTrimmedText(displayName, "WhatsApp conversation display name"),
      }),
      "rename WhatsApp managed group",
    );
    this.normalizeAddress(group.address, "WhatsApp managed group rename result");
    this.normalizeAddress(group.communityAddress, "WhatsApp managed group community");
    return relayConversationFromManagedGroup(group);
  }

  private async retireConversation(address: RelayAddress): Promise<void> {
    this.assertUsable();
    const normalizedAddress = this.normalizeAddress(address, "WhatsApp conversation retirement");
    const group = this.unwrap(
      await this.groupAdministration.retireGroup({
        ...this.idempotentRequest("retire-group"),
        address: normalizedAddress,
      }),
      "retire WhatsApp managed group",
    );
    this.normalizeAddress(group.address, "WhatsApp managed group retirement result");
  }

  private activateSources(): void {
    if (this.sourceActivation) return;
    const activation: SourceActivation = {
      active: true,
      abortController: new AbortController(),
      teardowns: [],
    };
    this.sourceActivation = activation;

    try {
      activation.teardowns.push(
        once(
          this.setupStatus.subscribe(this.account, async (snapshot) => {
            if (!this.isActive(activation)) return;
            this.assertAccountScope(snapshot.account, "WhatsApp setup event");
            const status = relayConnectionStatusFromSetup(snapshot);
            await this.emit({
              type: "status-changed",
              providerId: this.providerId,
              accountId: this.accountId,
              occurredAt: status.updatedAt,
              status,
            });
          }),
        ),
      );
      activation.teardowns.push(
        once(
          this.protocol.subscribeProtocol(this.account, async (event) => {
            if (!this.isActive(activation)) return;
            await this.handleProtocolEvent(activation, event);
          }),
        ),
      );
    } catch (error) {
      this.sourceActivation = undefined;
      activation.active = false;
      activation.abortController.abort();
      const teardownErrors = runTeardowns(activation.teardowns);
      if (teardownErrors.length > 0) {
        const activationError = new AggregateError(
          teardownErrors,
          "Failed to activate WhatsApp provider event sources",
          { cause: error },
        );
        throw activationError;
      }
      throw error;
    }
  }

  private deactivateSources(): void {
    const activation = this.sourceActivation;
    if (!activation) return;
    this.sourceActivation = undefined;
    activation.active = false;
    activation.abortController.abort();
    const errors = runTeardowns(activation.teardowns);
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to unsubscribe WhatsApp provider event sources");
    }
  }

  private async handleProtocolEvent(
    activation: SourceActivation,
    event: WhatsAppProtocolEvent,
  ): Promise<void> {
    switch (event.type) {
      case "message":
        await this.handleInboundMessage(activation, event.envelope);
        return;
      case "delivery":
        await this.emitIfActive(activation, {
          type: "delivery-updated",
          providerId: this.providerId,
          accountId: this.accountId,
          occurredAt: normalizeWhatsAppTimestamp(event.occurredAt, "WhatsApp delivery timestamp"),
          providerMessageId: parseRelayMessageId(event.providerMessageId),
          state: event.state,
          ...(event.failure ? { failure: normalizeProviderFailure(event.failure) } : {}),
        });
        return;
      case "conversation":
        await this.emitIfActive(activation, {
          type: "conversation-changed",
          providerId: this.providerId,
          accountId: this.accountId,
          occurredAt: normalizeWhatsAppTimestamp(
            event.occurredAt,
            "WhatsApp conversation timestamp",
          ),
          change: event.change,
          conversation: relayConversationFromProtocol(
            this.providerId,
            this.accountId,
            event.conversation,
          ),
        });
        return;
      case "interaction-selection":
        this.normalizeAddress(
          event.selection.address,
          "WhatsApp interaction selection",
        );
        requireTrimmedText(
          event.selection.interactionId,
          "WhatsApp interaction ID",
        );
        parseRelayMessageId(event.selection.providerPromptMessageId);
        await this.emitIfActive(activation, {
          type: "interaction-selected",
          providerId: this.providerId,
          accountId: this.accountId,
          occurredAt: normalizeWhatsAppTimestamp(
            event.selection.selectedAt,
            "WhatsApp interaction selection timestamp",
          ),
          selection: event.selection,
        });
        return;
    }
  }

  private async handleInboundMessage(
    activation: SourceActivation,
    input: WhatsAppProtocolMessageEnvelope,
  ): Promise<void> {
    const envelope = normalizeWhatsAppProtocolEnvelope(input);
    this.assertAccountId(envelope.accountId);
    const address: RelayAddress = Object.freeze({
      ...this.account,
      conversationId: envelope.conversationId,
    });
    const authorizationRequest: RelayInboundAuthorizationRequest = {
      address,
      providerMessageId: envelope.providerMessageId,
      sender: {
        primaryId: envelope.sender.primaryId,
        ...(envelope.sender.alternateIds === undefined
          ? {}
          : { alternateIds: [...envelope.sender.alternateIds] }),
        ...(envelope.sender.displayName === undefined
          ? {}
          : { displayName: envelope.sender.displayName }),
      },
      receivedAt: envelope.receivedAt,
    };
    const decision = this.unwrap(
      await this.inboundAuthorization.authorize(authorizationRequest),
      "authorize WhatsApp inbound message",
    );
    this.assertAuthorizationDecision(decision, envelope, address);
    if (decision.decision !== "allow" || !this.isActive(activation)) return;
    const mediaAuthorization = this.normalizeMediaDownloadAuthorization(
      await this.inboundAuthorization.createMediaDownloadAuthorization(
        authorizationRequest,
        decision,
      ),
      decision,
    );
    this.assertAuthorizationDecision(decision, envelope, address);
    if (!this.isActive(activation)) return;

    const content = await envelope.loadContent(mediaAuthorization);
    if (!this.isActive(activation)) return;
    const settled = await Promise.allSettled(
      content.attachments.map((attachment) =>
        this.processAttachment(
          activation,
          envelope,
          address,
          content,
          attachment,
          mediaAuthorization,
        ),
      ),
    );
    const processed = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const failures = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      const combined = [...failures, ...(await this.releaseProcessedAttachments(processed))];
      throw combined.length === 1
        ? combined[0]
        : new AggregateError(combined, "One or more WhatsApp attachments failed");
    }
    if (!this.isActive(activation)) {
      const cleanupFailures = await this.releaseProcessedAttachments(processed);
      if (cleanupFailures.length > 0) {
        throw new AggregateError(cleanupFailures, "WhatsApp media cleanup failed");
      }
      return;
    }

    const attachments = processed.flatMap((item) =>
      item.attachment === undefined ? [] : [item.attachment],
    );
    const transcripts = processed.flatMap((item) =>
      item.transcript === undefined ? [] : [item.transcript],
    );
    const message = relayInboundMessageFromProtocol(
      this.providerId,
      envelope,
      content,
      attachments,
      transcripts,
    );
    if (message.text === undefined && message.attachments.length === 0) {
      throw new WhatsAppRelayProviderError(
        "invalid-request",
        "Authorized WhatsApp message has no supported content",
        false,
      );
    }

    try {
      await this.emitIfActive(activation, {
        type: "message-received",
        providerId: this.providerId,
        accountId: this.accountId,
        occurredAt: envelope.receivedAt,
        message,
      });
    } catch (error) {
      const cleanupFailures = await this.releaseProcessedAttachments(processed);
      throw cleanupFailures.length === 0
        ? error
        : new AggregateError(
            [error, ...cleanupFailures],
            "WhatsApp inbound routing and media cleanup failed",
          );
    }
  }

  private async processAttachment(
    activation: SourceActivation,
    envelope: NormalizedWhatsAppProtocolMessageEnvelope,
    address: RelayAddress,
    content: Awaited<ReturnType<NormalizedWhatsAppProtocolMessageEnvelope["loadContent"]>>,
    attachment: WhatsAppProtocolAttachment,
    authorization: WhatsAppMediaDownloadAuthorization,
  ): Promise<ProcessedWhatsAppAttachment> {
    if (!attachment.source) {
      throw new WhatsAppRelayProviderError(
        "invalid-request",
        "Authorized WhatsApp media is missing its bounded local source",
        false,
      );
    }
    let result: WhatsAppMediaPipelineResult;
    try {
      result = await this.media.processInbound({
        authorization,
        message: {
          account: this.account,
          address,
          providerMessageId: envelope.providerMessageId,
          senderId: envelope.sender.primaryId,
          sentAt: envelope.sentAt,
          ...(content.text === undefined ? {} : { caption: content.text }),
          ...(envelope.replyTo === undefined
            ? {}
            : { quotedProviderMessageId: envelope.replyTo.providerMessageId }),
        },
        media: {
          attachment: {
            address,
            providerMessageId: envelope.providerMessageId,
            attachmentId: attachment.attachmentId,
            kind: attachment.kind,
            mimeType: attachment.mimeType,
            ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }),
            ...(attachment.sizeBytes === undefined ? {} : { sizeBytes: attachment.sizeBytes }),
            ...(attachment.sha256 === undefined ? {} : { sha256: attachment.sha256 }),
            ...(attachment.voice === undefined ? {} : { voice: attachment.voice }),
          },
          source: attachment.source,
          ...(attachment.voice === undefined ? {} : { voiceMemo: true }),
        },
        signal: activation.abortController.signal,
      });
    } catch (error) {
      if (!this.isActive(activation) && isMediaCancellation(error)) return {};
      throw error;
    }
    if (!this.isActive(activation)) {
      await this.media.release?.(result);
      return {};
    }
    try {
      return {
        ...this.normalizeMediaResult(result, envelope, address, attachment),
        mediaResult: result,
      };
    } catch (error) {
      await this.media.release?.(result);
      throw error;
    }
  }

  private async releaseProcessedAttachments(
    processed: readonly ProcessedWhatsAppAttachment[],
  ): Promise<readonly unknown[]> {
    if (!this.media.release) return [];
    const release = this.media.release.bind(this.media);
    return (
      await Promise.allSettled(
        processed.flatMap((item) =>
          item.mediaResult === undefined ? [] : [release(item.mediaResult)],
        ),
      )
    ).flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  }

  private assertAuthorizationDecision(
    decision: RelayInboundAuthorizationDecision,
    envelope: NormalizedWhatsAppProtocolMessageEnvelope,
    address: RelayAddress,
  ): void {
    const decisionValue: unknown = decision.decision;
    if (decisionValue !== "allow" && decisionValue !== "deny") {
      throw new WhatsAppRelayProviderError(
        "provider-failure",
        "WhatsApp authorization returned an invalid decision",
        false,
      );
    }
    if (
      !relayAddressesEqual(decision.address, address) ||
      decision.providerMessageId !== envelope.providerMessageId ||
      decision.senderPrimaryId !== envelope.sender.primaryId
    ) {
      throw new WhatsAppRelayProviderError(
        "provider-failure",
        "WhatsApp authorization decision does not match the inbound envelope",
        false,
      );
    }
    requireTrimmedText(decision.policyId, "WhatsApp authorization policy ID");
    normalizeWhatsAppTimestamp(decision.decidedAt, "WhatsApp authorization timestamp");
  }

  private normalizeMediaDownloadAuthorization(
    authorization: WhatsAppMediaDownloadAuthorization,
    decision: RelayAllowedInboundAuthorizationDecision,
  ): WhatsAppMediaDownloadAuthorization {
    if (!isRecord(authorization)) {
      throw new WhatsAppRelayProviderError(
        "provider-failure",
        "WhatsApp authorization did not issue a media download capability",
        false,
      );
    }
    const rawAcceptanceToken = Reflect.get(authorization, "acceptanceToken");
    if (
      typeof rawAcceptanceToken !== "string" ||
      rawAcceptanceToken.length === 0 ||
      rawAcceptanceToken.trim() !== rawAcceptanceToken
    ) {
      throw new WhatsAppRelayProviderError(
        "provider-failure",
        "WhatsApp media download authorization has an invalid acceptance token",
        false,
      );
    }
    const acceptanceToken = rawAcceptanceToken;
    if (authorization.decision !== decision) {
      throw new WhatsAppRelayProviderError(
        "provider-failure",
        "WhatsApp media download authorization replaced the canonical decision",
        false,
      );
    }
    if (decision.decision !== "allow") {
      throw new WhatsAppRelayProviderError(
        "provider-failure",
        "WhatsApp media download authorization mutated the canonical decision",
        false,
      );
    }
    const expiresAt =
      authorization.expiresAt === undefined
        ? undefined
        : normalizeWhatsAppTimestamp(
            authorization.expiresAt,
            "WhatsApp media authorization expiry",
          );
    if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(this.now())) {
      throw new WhatsAppRelayProviderError(
        "provider-failure",
        "WhatsApp media download authorization has expired",
        false,
      );
    }
    return {
      acceptanceToken,
      decision,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  }

  private normalizeMediaResult(
    result: WhatsAppMediaPipelineResult,
    envelope: NormalizedWhatsAppProtocolMessageEnvelope,
    address: RelayAddress,
    requested: WhatsAppProtocolAttachment,
  ): ProcessedWhatsAppAttachment {
    requireTrimmedText(result.idempotencyKey, "WhatsApp media idempotency key");
    requireTrimmedText(result.contentSha256, "WhatsApp media content SHA-256");
    normalizeWhatsAppTimestamp(result.processedAt, "WhatsApp media processed timestamp");
    if (
      result.providerId !== WHATSAPP_MEDIA_PROVIDER_ID ||
      result.originalMessage.account.providerId !== this.providerId ||
      result.originalMessage.account.accountId !== this.accountId ||
      !relayAddressesEqual(result.originalMessage.address, address) ||
      result.originalMessage.providerMessageId !== envelope.providerMessageId
    ) {
      throw new WhatsAppRelayProviderError(
        "provider-failure",
        "WhatsApp media pipeline returned mismatched message context",
        false,
      );
    }

    if (result.kind === "attachment") {
      const attachment = this.normalizeIngestedAttachment(
        result.attachment,
        address,
        envelope,
        requested,
      );
      return { attachment: relayAttachmentFromIngested(attachment) };
    }

    if (result.kind === "voice-transcript") {
      const audio = this.normalizeIngestedAttachment(result.audio, address, envelope, requested);
      this.assertVoiceTranscript(result.transcript, address, envelope, requested);
      return {
        attachment: relayAttachmentFromIngested(audio),
        transcript: result.transcript.text,
      };
    }

    throw new WhatsAppRelayProviderError(
      "provider-failure",
      "WhatsApp media pipeline returned an unsupported result",
      false,
    );
  }

  private normalizeIngestedAttachment(
    attachment: RelayIngestedAttachment,
    address: RelayAddress,
    envelope: NormalizedWhatsAppProtocolMessageEnvelope,
    requested: WhatsAppProtocolAttachment,
  ): RelayIngestedAttachment {
    const metadata = attachment.metadata;
    if (
      !relayAddressesEqual(metadata.address, address) ||
      metadata.providerMessageId !== envelope.providerMessageId ||
      metadata.attachmentId !== requested.attachmentId ||
      metadata.kind !== requested.kind
    ) {
      throw new WhatsAppRelayProviderError(
        "provider-failure",
        "WhatsApp media pipeline returned mismatched attachment metadata",
        false,
      );
    }
    const fileName =
      metadata.fileName === undefined
        ? undefined
        : requireTrimmedText(metadata.fileName, "WhatsApp media attachment file name");
    const metadataSize =
      metadata.sizeBytes === undefined
        ? undefined
        : requireNonNegativeInteger(metadata.sizeBytes, "WhatsApp media attachment metadata size");
    const metadataSha256 =
      metadata.sha256 === undefined
        ? undefined
        : requireTrimmedText(metadata.sha256, "WhatsApp media attachment metadata SHA-256");
    const storageKey =
      attachment.storageKey === undefined
        ? undefined
        : requireTrimmedText(attachment.storageKey, "WhatsApp media attachment storage key");
    const voice =
      metadata.voice === undefined
        ? undefined
        : {
            ...(metadata.voice.durationMs === undefined
              ? {}
              : {
                  durationMs: requireNonNegativeInteger(
                    metadata.voice.durationMs,
                    "WhatsApp voice duration",
                  ),
                }),
            ...(metadata.voice.languageHint === undefined
              ? {}
              : {
                  languageHint: requireTrimmedText(
                    metadata.voice.languageHint,
                    "WhatsApp voice language hint",
                  ),
                }),
          };

    return {
      metadata: {
        address,
        providerMessageId: envelope.providerMessageId,
        attachmentId: requested.attachmentId,
        kind: requested.kind,
        mimeType: requireTrimmedText(metadata.mimeType, "WhatsApp media attachment MIME type"),
        ...(fileName === undefined ? {} : { fileName }),
        ...(metadataSize === undefined ? {} : { sizeBytes: metadataSize }),
        ...(metadataSha256 === undefined ? {} : { sha256: metadataSha256 }),
        ...(voice === undefined ? {} : { voice }),
      },
      localPath: requireTrimmedText(attachment.localPath, "WhatsApp media attachment path"),
      ...(storageKey === undefined ? {} : { storageKey }),
      sizeBytes: requireNonNegativeInteger(attachment.sizeBytes, "WhatsApp media attachment size"),
      sha256: requireTrimmedText(attachment.sha256, "WhatsApp media attachment SHA-256"),
      ingestedAt: normalizeWhatsAppTimestamp(
        attachment.ingestedAt,
        "WhatsApp media ingestion timestamp",
      ),
    };
  }

  private assertVoiceTranscript(
    transcript: RelayVoiceTranscript,
    address: RelayAddress,
    envelope: NormalizedWhatsAppProtocolMessageEnvelope,
    requested: WhatsAppProtocolAttachment,
  ): void {
    if (
      !relayAddressesEqual(transcript.address, address) ||
      transcript.providerMessageId !== envelope.providerMessageId ||
      transcript.attachmentId !== requested.attachmentId ||
      requested.kind !== "audio"
    ) {
      throw new WhatsAppRelayProviderError(
        "provider-failure",
        "WhatsApp media pipeline returned mismatched voice transcript context",
        false,
      );
    }
    requireNonBlankText(transcript.text, "WhatsApp voice transcript");
    normalizeWhatsAppTimestamp(transcript.transcribedAt, "WhatsApp transcription timestamp");
  }

  private assertAccountScope(scope: RelayAccountScope, label: string): void {
    if (scope.providerId !== this.providerId || scope.accountId !== this.accountId) {
      throw new WhatsAppRelayProviderError(
        "provider-failure",
        `${label} targeted a different provider account`,
        false,
      );
    }
  }

  private normalizeAddress(address: RelayAddress, label: string): RelayAddress {
    this.assertAccountScope(address, label);
    return {
      providerId: this.providerId,
      accountId: this.accountId,
      conversationId: parseRelayConversationId(address.conversationId),
    };
  }

  private assertAccountId(accountId: RelayAccountId): void {
    if (parseRelayAccountId(accountId) !== this.accountId) {
      throw new WhatsAppRelayProviderError(
        "invalid-request",
        `WhatsApp provider account "${accountId}" is not composed for this instance`,
        false,
      );
    }
  }

  private accountOperation(operation: string): RelayAccountOperationRequest {
    return {
      ...this.account,
      ...this.idempotentRequest(operation),
    };
  }

  private idempotentRequest(operation: string): {
    readonly idempotencyKey: string;
    readonly requestedAt: RelayTimestamp;
  } {
    const operationId = requireTrimmedText(
      this.createOperationId(),
      "WhatsApp operation identifier",
    );
    return {
      idempotencyKey: `${this.providerId}:${this.accountId}:${operation}:${operationId}`,
      requestedAt: normalizeWhatsAppTimestamp(this.now(), "WhatsApp operation timestamp"),
    };
  }

  private unwrap<Value, Code extends RelayExperienceErrorCode>(
    result: RelayExperienceResult<Value, Code>,
    operation: string,
  ): Value {
    if (result.ok) return result.value;
    throw new WhatsAppRelayProviderError(
      result.error.code,
      `Failed to ${operation}: ${result.error.message}`,
      result.error.retryable,
    );
  }

  private unsupported(message: string): WhatsAppRelayProviderError {
    return new WhatsAppRelayProviderError("unsupported", message, false);
  }

  private isActive(activation: SourceActivation): boolean {
    return activation.active && this.sourceActivation === activation && !this.disposed;
  }

  private async emitIfActive(
    activation: SourceActivation,
    event: RelayProviderEvent,
  ): Promise<void> {
    if (!this.isActive(activation)) return;
    await this.emit(event);
  }

  private async emit(event: RelayProviderEvent): Promise<void> {
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new WhatsAppRelayProviderError(
        "unavailable",
        "WhatsApp relay provider is disposed",
        false,
      );
    }
  }
}

function normalizeProviderFailure(failure: RelayProviderFailure): RelayProviderFailure {
  if (typeof failure.retryable !== "boolean") {
    throw new TypeError("WhatsApp provider failure retryable must be a boolean");
  }
  return {
    code: requireTrimmedText(failure.code, "WhatsApp provider failure code"),
    message: requireTrimmedText(failure.message, "WhatsApp provider failure message"),
    retryable: failure.retryable,
  };
}

function requireTrimmedText(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a non-empty, trimmed string`);
  }
  return value;
}

function requireNonBlankText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must contain non-whitespace text`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMediaCancellation(error: unknown): boolean {
  return isRecord(error) && error.code === "CANCELLED";
}

function runTeardowns(teardowns: readonly (() => void)[]): unknown[] {
  const errors: unknown[] = [];
  for (const teardown of [...teardowns].reverse()) {
    try {
      teardown();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function once(action: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    action();
  };
}
