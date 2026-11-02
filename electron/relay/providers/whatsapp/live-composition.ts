import { randomUUID } from "node:crypto";

import type { WhatsAppStatus } from "../../../../common/marshal-ipc-contract";
import { createLogger } from "../../../../common/marshal-logger";
import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayMessageId,
  parseRelayProviderId,
  type RelayAccountId,
  type RelayAddress,
  type RelayInteractionOption,
  type RelayInteractionPrompt,
  type RelayMessageId,
  type RelayProviderCapabilities,
} from "../../../../common/relay-contract";
import type {
  RelayAccountOperationRequest,
  RelayAccountScope,
  RelayCommunityProvisionRequest,
  RelayExperienceResult,
  RelayInboundAuthorizationDecision,
  RelayInboundAuthorizationRequest,
  RelayIngestedAttachment,
  RelayManagedCommunityTopology,
  RelayManagedGroupCreateRequest,
  RelayManagedGroupDescriptor,
  RelayManagedGroupRenameRequest,
  RelayManagedGroupRetireRequest,
  RelayProvisioningErrorCode,
  RelaySetupErrorCode,
  RelaySetupSnapshot,
} from "../../../../common/relay-experience-contract";
import type { RelayManagedGroupQueryPort, RelayPairingControlPort } from "../../experience-ports";
import type { RelayHostMediaAdapter } from "../../host-media-adapter";
import {
  createWhatsAppProviderComposition,
  type WhatsAppGroupLanePort,
  type WhatsAppProviderComposition,
} from "./composition";
import type { WhatsAppProtocolMessageEnvelope } from "./envelope";
import type { WhatsAppBoundedMessageContext, WhatsAppMediaPipelineResult } from "./provider";
import type { WhatsAppService } from "./service";
import type {
  WhatsAppInboundManagedMessage,
  WhatsAppManagedFixedGroupRole,
} from "./sidecar/protocol";
import type { WhatsAppProtocolConversationDescriptor } from "./translation";

const PROVIDER_ID = parseRelayProviderId("whatsapp-baileys");
const log = createLogger("LiveWhatsAppProvider");
const MEDIA_AUTHORIZATION_TTL_MS = 2 * 60 * 1000;
const FIXED_ROLES = ["new-chats", "progress", "information-control"] as const;
const FIXED_TITLES: Readonly<Record<WhatsAppManagedFixedGroupRole, string>> = {
  "new-chats": "New Chats",
  progress: "Progress",
  "information-control": "Information & Control",
};
const LIVE_CAPABILITIES: RelayProviderCapabilities = Object.freeze({
  inbound: true,
  quotedReplies: true,
  attachments: true,
  voice: true,
  managedGroups: true,
  communities: true,
  renameConversation: false,
  retireConversation: true,
  remotePermissionApproval: true,
  interactiveChoices: "native",
});

export interface LiveWhatsAppProviderComposition extends WhatsAppProviderComposition {
  readonly account: RelayAccountScope;
  readonly pairingControl: RelayPairingControlPort;
  readonly topology: RelayManagedGroupQueryPort;
  resetAndRelink(request: RelayAccountOperationRequest): Promise<SetupResult>;
  retryProvisioning(request: RelayAccountOperationRequest): Promise<SetupResult>;
}

export interface LiveWhatsAppProviderCompositionOptions {
  readonly service: WhatsAppService;
  readonly hostMedia: RelayHostMediaAdapter;
  readonly accountId?: RelayAccountId;
  readonly now?: () => string;
  readonly createId?: () => string;
}

type SetupResult = RelayExperienceResult<RelaySetupSnapshot, RelaySetupErrorCode>;

export function createLiveWhatsAppProviderComposition(
  options: LiveWhatsAppProviderCompositionOptions,
): LiveWhatsAppProviderComposition {
  const account: RelayAccountScope = {
    providerId: PROVIDER_ID,
    accountId: parseRelayAccountId(options.accountId ?? "primary"),
  };
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? randomUUID;
  const acceptedMessages = new Map<string, WhatsAppInboundManagedMessage>();
  const sessionGroups = new Map<string, RelayManagedGroupDescriptor>();

  const runSetup = async (
    request: RelayAccountOperationRequest,
    operation: () => Promise<void>,
  ): Promise<SetupResult> => {
    if (!sameAccount(request, account)) return invalidAccount();
    try {
      await operation();
      return { ok: true, value: setupSnapshot(options.service.getStatus(), account, now()) };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "provider-failure",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
    }
  };

  const connection = {
    getStatus: async (requested: RelayAccountScope): Promise<SetupResult> =>
      sameAccount(requested, account)
        ? { ok: true, value: setupSnapshot(options.service.getStatus(), account, now()) }
        : invalidAccount(),
    subscribe: (
      requested: RelayAccountScope,
      listener: (snapshot: RelaySetupSnapshot) => void | Promise<void>,
    ) => {
      if (!sameAccount(requested, account)) return () => undefined;
      return options.service.subscribeStatus((status) => {
        void listener(setupSnapshot(status, account, now()));
      });
    },
    beginPairing: (request: RelayAccountOperationRequest) =>
      runSetup(request, () => options.service.connect()),
    cancelPairing: (request: RelayAccountOperationRequest) =>
      runSetup(request, () => options.service.cancelPairing()),
    connect: (request: RelayAccountOperationRequest) =>
      runSetup(request, () => options.service.connect()),
    disconnect: (request: RelayAccountOperationRequest) =>
      runSetup(request, () => options.service.disconnect()),
    subscribeProtocol: (
      requested: RelayAccountScope,
      listener: Parameters<import("./provider").WhatsAppProtocolPort["subscribeProtocol"]>[1],
    ) => {
      if (!sameAccount(requested, account)) return () => undefined;
      const unsubscribeMessages = options.service.subscribeMessages(async (message) => {
        acceptedMessages.set(message.providerMessageId, message);
        let contentPromise:
          | Promise<Awaited<ReturnType<WhatsAppProtocolMessageEnvelope["loadContent"]>>>
          | undefined;
        try {
          await listener({
            type: "message",
            envelope: {
              accountId: account.accountId,
              conversationId: parseRelayConversationId(message.conversationId),
              providerMessageId: parseRelayMessageId(message.providerMessageId),
              sender: { primaryId: message.senderId },
              sentAt: message.sentAt,
              receivedAt: message.receivedAt,
              ...(message.replyToProviderMessageId
                ? {
                    replyTo: {
                      providerMessageId: parseRelayMessageId(message.replyToProviderMessageId),
                    },
                  }
                : {}),
              loadContent: async (authorization) => {
                contentPromise ??= Promise.all(
                  (message.attachments ?? []).map(async (attachment) => {
                    const downloaded = await options.service.downloadMediaSource(
                      attachment.sourceId,
                      authorization.acceptanceToken,
                    );
                    if (
                      downloaded.attachmentId !== attachment.attachmentId ||
                      downloaded.kind !== attachment.kind ||
                      downloaded.mimeType !== attachment.mimeType ||
                      downloaded.fileName !== attachment.fileName ||
                      downloaded.voiceMemo !== attachment.voiceMemo ||
                      downloaded.durationMs !== attachment.durationMs
                    ) {
                      throw new Error("WhatsApp media download changed its descriptor");
                    }
                    return {
                      attachmentId: downloaded.attachmentId,
                      kind: downloaded.kind,
                      mimeType: downloaded.mimeType,
                      ...(downloaded.fileName ? { fileName: downloaded.fileName } : {}),
                      sizeBytes: downloaded.sizeBytes,
                      sha256: downloaded.sha256,
                      ...(downloaded.voiceMemo
                        ? {
                            voice: {
                              ...(downloaded.durationMs === undefined
                                ? {}
                                : { durationMs: downloaded.durationMs }),
                            },
                          }
                        : {}),
                      source: {
                        kind: "local-file" as const,
                        sourceId: downloaded.sourceId,
                        path: downloaded.localPath,
                      },
                    };
                  }),
                ).then((attachments) => ({
                  ...(message.text === undefined ? {} : { text: message.text }),
                  attachments,
                }));
                return contentPromise;
              },
            },
          });
        } finally {
          acceptedMessages.delete(message.providerMessageId);
          await Promise.all(
            (message.attachments ?? []).map(async (attachment) => {
              await options.service
                .releaseMediaSource(attachment.sourceId)
                .catch((error: unknown) => {
                  log
                    .with({ sourceId: attachment.sourceId })
                    .warn("Failed to release unused WhatsApp media source:", error);
                });
            }),
          );
        }
      });
      const unsubscribeInteractions = options.service.subscribeInteractions(async (selection) => {
        await listener({
          type: "interaction-selection",
          selection: {
            interactionId: selection.interactionId,
            address: relayAddress(account, selection.conversationId),
            providerPromptMessageId: parseRelayMessageId(selection.providerPromptMessageId),
            selectedOptionIds: selection.selectedOptionIds,
            responder: { primaryId: selection.senderId },
            selectedAt: selection.selectedAt,
          },
        });
      });
      return () => {
        unsubscribeMessages();
        unsubscribeInteractions();
      };
    },
    publishText: async (
      request: Parameters<import("./provider").WhatsAppProtocolPort["publishText"]>[0],
    ) => {
      if (!sameAccount(request.account, account)) {
        throw new Error("WhatsApp publication account does not match the configured account");
      }
      const receipt = await options.service.sendText(request.conversationId, request.text);
      return {
        providerMessageId: parseRelayMessageId(receipt.providerMessageId),
        publishedAt: receipt.sentAt,
      };
    },
    listConversations: async (
      requested: RelayAccountScope,
    ): Promise<readonly WhatsAppProtocolConversationDescriptor[]> => {
      if (!sameAccount(requested, account)) return [];
      const managed = options.service.getManagedGroupIds();
      if (!managed) return [...sessionGroups.values()].map(toProtocolConversation);
      return [
        {
          conversationId: parseRelayConversationId(managed.community),
          kind: "community",
          displayName: "Marshal Community",
        },
        ...FIXED_ROLES.map((role) => ({
          conversationId: parseRelayConversationId(managed.fixed[role]),
          kind: "group" as const,
          displayName: FIXED_TITLES[role],
          parentConversationId: parseRelayConversationId(managed.community),
        })),
        ...[...sessionGroups.values()].map(toProtocolConversation),
      ];
    },
    publish: async (prompt: RelayInteractionPrompt) => {
      if (!sameAddressAccount(prompt.address, account)) {
        throw new Error("WhatsApp interaction account does not match the configured account");
      }
      const receipt = await options.service.sendInteraction({
        type: "send-interaction",
        interactionId: prompt.interactionId,
        idempotencyKey: prompt.idempotencyKey,
        conversationId: prompt.address.conversationId,
        sourceSessionId: prompt.source.sessionId,
        ...(prompt.source.turnId ? { sourceTurnId: prompt.source.turnId } : {}),
        ...(prompt.source.requestId ? { sourceRequestId: prompt.source.requestId } : {}),
        correlationId: prompt.source.correlationId,
        kind: prompt.kind,
        title: prompt.title,
        question: prompt.question,
        ...(prompt.body ? { body: prompt.body } : {}),
        options: toWhatsAppPollOptions(prompt.options),
        minSelections: prompt.minSelections,
        maxSelections: prompt.maxSelections,
        createdAt: prompt.createdAt,
        expiresAt: prompt.expiresAt,
      });
      return {
        interactionId: receipt.interactionId,
        providerPromptMessageId: parseRelayMessageId(receipt.providerMessageId),
        publishedAt: receipt.sentAt,
        mode: "native" as const,
      };
    },
    cancel: async (
      interactionId: string,
      target: RelayAddress,
      providerPromptMessageId: RelayMessageId,
    ) => {
      if (!sameAddressAccount(target, account)) return;
      await options.service.cancelInteraction(
        interactionId,
        target.conversationId,
        providerPromptMessageId,
      );
    },
  };

  const groups: WhatsAppGroupLanePort = {
    provision: async (
      request: RelayCommunityProvisionRequest,
    ): Promise<
      RelayExperienceResult<RelayManagedCommunityTopology, RelayProvisioningErrorCode>
    > => {
      if (!sameAccount(request, account)) return provisioningFailure("invalid-request", false);
      try {
        await options.service.retryProvisioning();
        const topology = readTopology(options.service, account, now);
        return topology
          ? { ok: true, value: topology }
          : provisioningFailure("not-found", true, "WhatsApp topology is not ready");
      } catch (error) {
        return provisioningFailure("provider-failure", true, describeError(error));
      }
    },
    createGroup: async (
      request: RelayManagedGroupCreateRequest,
    ): Promise<RelayExperienceResult<RelayManagedGroupDescriptor, RelayProvisioningErrorCode>> => {
      if (!sameAddressAccount(request.communityAddress, account)) {
        return provisioningFailure("invalid-request", false);
      }
      if (request.role !== "session") {
        try {
          await options.service.retryProvisioning();
          const topology = readTopology(options.service, account, now);
          const fixed = topology?.groups.find((group) => group.role === request.role);
          return fixed
            ? { ok: true, value: fixed }
            : provisioningFailure("not-found", true, "WhatsApp managed group is not ready");
        } catch (error) {
          return provisioningFailure("provider-failure", true, describeError(error));
        }
      }
      try {
        const ensured = await options.service.ensureSessionGroup({
          idempotencyKey: request.idempotencyKey,
          displayName: request.displayName,
          communityConversationId: request.communityAddress.conversationId,
          ...(request.existingAddress
            ? { existingConversationId: request.existingAddress.conversationId }
            : {}),
        });
        const descriptor = managedGroup(
          account,
          "session",
          ensured.conversationId,
          ensured.communityConversationId,
          ensured.displayName,
          request.requestedAt,
        );
        sessionGroups.set(ensured.conversationId, descriptor);
        return { ok: true, value: descriptor };
      } catch (error) {
        return provisioningFailure("provider-failure", true, describeError(error));
      }
    },
    renameGroup: async (_request: RelayManagedGroupRenameRequest) =>
      provisioningFailure(
        "unsupported",
        false,
        "The live WhatsApp bridge does not expose rename yet",
      ),
    retireGroup: async (request: RelayManagedGroupRetireRequest) => {
      if (!sameAccount(request.address, account)) {
        return provisioningFailure("not-found", false, "WhatsApp relay account was not found");
      }
      const managed = options.service.getManagedGroupIds();
      if (!managed) {
        return provisioningFailure("not-found", true, "WhatsApp managed topology is not ready");
      }
      if (Object.values(managed.fixed).includes(request.address.conversationId)) {
        return provisioningFailure("conflict", false, "Fixed WhatsApp groups cannot be retired");
      }
      try {
        await options.service.retireSessionGroup({
          conversationId: request.address.conversationId,
          communityConversationId: managed.community,
        });
        const existing =
          sessionGroups.get(request.address.conversationId) ??
          managedGroup(
            account,
            "session",
            request.address.conversationId,
            managed.community,
            "Retired session access point",
            request.requestedAt,
          );
        sessionGroups.delete(request.address.conversationId);
        return {
          ok: true,
          value: {
            ...existing,
            state: "retired",
            updatedAt: request.requestedAt,
          },
        };
      } catch (error) {
        return provisioningFailure("provider-failure", true, describeError(error));
      }
    },
  };

  const authorization = {
    authorize: async (
      request: RelayInboundAuthorizationRequest,
    ): Promise<RelayExperienceResult<RelayInboundAuthorizationDecision, never>> => {
      const message = acceptedMessages.get(request.providerMessageId);
      const matches =
        message?.conversationId === request.address.conversationId &&
        message.senderId === request.sender.primaryId;
      const decisionBase = {
        address: request.address,
        providerMessageId: request.providerMessageId,
        senderPrimaryId: request.sender.primaryId,
        policyId: "whatsapp-sidecar-managed-message-v1",
        decidedAt: now(),
      };
      return {
        ok: true,
        value: matches
          ? { ...decisionBase, decision: "allow", reason: "managed-group" }
          : { ...decisionBase, decision: "deny", reason: "conversation-not-managed" },
      };
    },
    createMediaDownloadAuthorization: async (
      request: RelayInboundAuthorizationRequest,
      decision: Extract<RelayInboundAuthorizationDecision, { decision: "allow" }>,
    ) => {
      const issuedAtMs = Date.parse(now());
      return {
        acceptanceToken: `${request.providerMessageId}:${createId()}`,
        decision,
        expiresAt: new Date(issuedAtMs + MEDIA_AUTHORIZATION_TTL_MS).toISOString(),
      };
    },
  };

  const composition = createWhatsAppProviderComposition({
    accountId: account.accountId,
    capabilities: LIVE_CAPABILITIES,
    connection,
    interactions: connection,
    groups,
    authorization,
    media: {
      processInbound: async (request): Promise<WhatsAppMediaPipelineResult> => {
        const requestedAt = now();
        if (
          !options.service.claimMediaSource(
            request.media.source.sourceId,
            request.media.source.path,
          )
        ) {
          throw new Error("WhatsApp media source is not owned by the active provider");
        }
        let ingested: RelayIngestedAttachment;
        try {
          ingested = await options.hostMedia.ingest({
            idempotencyKey: `whatsapp-media:${request.message.providerMessageId}:${request.media.attachment.attachmentId}`,
            requestedAt,
            attachment: request.media.attachment,
            source: request.media.source,
          });
        } finally {
          await options.service
            .releaseMediaSource(request.media.source.sourceId)
            .catch((error: unknown) => {
              log
                .with({ sourceId: request.media.source.sourceId })
                .warn("Failed to release WhatsApp sidecar media source:", error);
            });
        }
        const { metadata, ...messageWithoutMetadata } = request.message;
        const originalMessage: WhatsAppBoundedMessageContext = {
          ...messageWithoutMetadata,
          ...(metadata === undefined ? {} : { metadata: sanitizeMessageMetadata(metadata) }),
        };
        if (request.media.voiceMemo) {
          try {
            const transcript = await options.hostMedia.transcribe({
              idempotencyKey: `whatsapp-transcript:${request.message.providerMessageId}:${request.media.attachment.attachmentId}`,
              requestedAt,
              attachment: ingested,
              ...(request.media.attachment.voice?.languageHint
                ? { languageHint: request.media.attachment.voice.languageHint }
                : {}),
            });
            return {
              providerId: "whatsapp-baileys" as const,
              kind: "voice-transcript" as const,
              idempotencyKey: `whatsapp-media:${request.message.providerMessageId}:${request.media.attachment.attachmentId}`,
              contentSha256: ingested.sha256,
              processedAt: transcript.transcribedAt,
              originalMessage,
              transcript,
              audio: ingested,
            };
          } catch (error) {
            await options.hostMedia.release(ingested);
            throw error;
          }
        }
        return {
          providerId: "whatsapp-baileys" as const,
          kind: "attachment" as const,
          idempotencyKey: `whatsapp-media:${request.message.providerMessageId}:${request.media.attachment.attachmentId}`,
          contentSha256: ingested.sha256,
          processedAt: ingested.ingestedAt,
          originalMessage,
          attachment: ingested,
        };
      },
      release: async (result) => {
        await options.hostMedia.release(
          result.kind === "voice-transcript" ? result.audio : result.attachment,
        );
      },
    },
    now,
    createOperationId: createId,
  });
  const topology: RelayManagedGroupQueryPort = {
    getTopology: async (requested) => {
      if (!sameAccount(requested, account)) {
        return provisioningFailure("invalid-request", false);
      }
      const current = readTopology(options.service, account, now, sessionGroups.values());
      return current
        ? { ok: true, value: current }
        : provisioningFailure("not-found", true, "WhatsApp topology is not ready");
    },
    getGroup: async (groupAddress) => {
      if (!sameAddressAccount(groupAddress, account)) {
        return provisioningFailure("invalid-request", false);
      }
      const current = readTopology(options.service, account, now, sessionGroups.values());
      const group = current?.groups.find(
        (candidate) => candidate.address.conversationId === groupAddress.conversationId,
      );
      return group
        ? { ok: true, value: group }
        : provisioningFailure("not-found", false, "WhatsApp managed group was not found");
    },
  };

  return {
    ...composition,
    account,
    pairingControl: connection,
    topology,
    resetAndRelink: (request) => runSetup(request, () => options.service.reset()),
    retryProvisioning: (request) => runSetup(request, () => options.service.retryProvisioning()),
  };
}

function readTopology(
  service: WhatsAppService,
  account: RelayAccountScope,
  now: () => string,
  sessionGroups: Iterable<RelayManagedGroupDescriptor> = [],
): RelayManagedCommunityTopology | undefined {
  const managed = service.getManagedGroupIds();
  if (!managed) return undefined;
  const timestamp = now();
  return {
    community: {
      address: relayAddress(account, managed.community),
      displayName: "Marshal Community",
      state: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    groups: [
      ...FIXED_ROLES.map((role) =>
        managedGroup(
          account,
          role,
          managed.fixed[role],
          managed.community,
          FIXED_TITLES[role],
          timestamp,
        ),
      ),
      ...sessionGroups,
    ],
    revision: 1,
  };
}

function managedGroup(
  account: RelayAccountScope,
  role: RelayManagedGroupDescriptor["role"],
  conversationId: string,
  communityConversationId: string,
  displayName: string,
  timestamp: string,
): RelayManagedGroupDescriptor {
  return {
    address: relayAddress(account, conversationId),
    communityAddress: relayAddress(account, communityConversationId),
    role,
    displayName,
    state: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function toProtocolConversation(
  group: RelayManagedGroupDescriptor,
): WhatsAppProtocolConversationDescriptor {
  return {
    conversationId: group.address.conversationId,
    kind: "group",
    displayName: group.displayName,
    parentConversationId: group.communityAddress.conversationId,
  };
}

function setupSnapshot(
  status: WhatsAppStatus,
  account: RelayAccountScope,
  updatedAt: string,
): RelaySetupSnapshot {
  return {
    account,
    state:
      status.error || status.connection === "requires-reset"
        ? "error"
        : status.connection === "connected"
          ? "connected"
          : status.connection === "reconnecting"
            ? "reconnecting"
            : status.connection === "awaiting-qr"
              ? status.qr
                ? "qr"
                : "pairing"
              : status.connection === "starting" || status.connection === "connecting"
                ? "pairing"
                : status.initialized
                  ? "disconnected"
                  : "idle",
    updatedAt,
    ...(status.qr ? { qr: { payload: status.qr } } : {}),
    ...(status.error
      ? {
          failure: {
            code:
              status.connection === "requires-reset" ? ("conflict" as const) : "provider-failure",
            message: status.error,
            retryable: status.connection !== "requires-reset",
          },
        }
      : {}),
  };
}

function relayAddress(account: RelayAccountScope, conversationId: string): RelayAddress {
  return {
    ...account,
    conversationId: parseRelayConversationId(conversationId),
  };
}

function sameAccount(left: RelayAccountScope, right: RelayAccountScope): boolean {
  return left.providerId === right.providerId && left.accountId === right.accountId;
}

function sameAddressAccount(candidateAddress: RelayAddress, account: RelayAccountScope): boolean {
  return (
    candidateAddress.providerId === account.providerId &&
    candidateAddress.accountId === account.accountId
  );
}

function invalidAccount(): SetupResult {
  return {
    ok: false,
    error: {
      code: "invalid-request",
      message: "WhatsApp relay account does not match the configured account",
      retryable: false,
    },
  };
}

function provisioningFailure<Code extends RelayProvisioningErrorCode>(
  code: Code,
  retryable: boolean,
  message = "WhatsApp relay account does not match the configured account",
): RelayExperienceResult<never, Code> {
  return { ok: false, error: { code, message, retryable } };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeMessageMetadata(
  metadata: Readonly<Record<string, string | number | boolean | null | undefined>>,
): Readonly<Record<string, string | number | boolean>> {
  const sanitized: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function toWhatsAppPollOptions(
  options: readonly RelayInteractionOption[],
): Array<{ optionId: string; label: string; description?: string }> {
  const used = new Set<string>();
  return options.map((option) => {
    let label = option.label;
    let sequence = 2;
    while (used.has(label)) {
      const suffix = ` (${sequence})`;
      label = `${option.label.slice(0, 256 - suffix.length)}${suffix}`;
      sequence += 1;
    }
    used.add(label);
    return {
      optionId: option.optionId,
      label,
      ...(option.description === undefined ? {} : { description: option.description }),
    };
  });
}
