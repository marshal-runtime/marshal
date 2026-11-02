import { parseRelayConversationId, parseRelayMessageId } from "../../../../common/relay-contract";
import type {
  RelayAccountId,
  RelayAddress,
  RelayAttachment,
  RelayConversationId,
  RelayInboundMessage,
  RelayProviderId,
} from "../../../../common/relay-contract";
import type {
  RelayCommunityDescriptor,
  RelayIngestedAttachment,
  RelayManagedGroupDescriptor,
  RelaySetupSnapshot,
} from "../../../../common/relay-experience-contract";
import type {
  RelayConnectionState,
  RelayConnectionStatus,
  RelayConversation,
  RelayConversationKind,
} from "../../contracts";
import type {
  NormalizedWhatsAppProtocolMessageEnvelope,
  WhatsAppProtocolContent,
} from "./envelope";
import { normalizeWhatsAppTimestamp } from "./envelope";

export interface WhatsAppProtocolConversationDescriptor {
  readonly conversationId: RelayConversationId;
  readonly kind: RelayConversationKind;
  readonly displayName?: string;
  readonly parentConversationId?: RelayConversationId;
}

export function relayConnectionStatusFromSetup(
  snapshot: RelaySetupSnapshot,
): RelayConnectionStatus {
  return {
    state: relayConnectionStateFromSetup(snapshot.state),
    updatedAt: normalizeWhatsAppTimestamp(snapshot.updatedAt, "WhatsApp setup updatedAt"),
    ...(snapshot.failure
      ? {
          failure: {
            code: snapshot.failure.code,
            message: snapshot.failure.message,
            retryable: snapshot.failure.retryable,
          },
        }
      : {}),
  };
}

export function relayConversationFromProtocol(
  providerId: RelayProviderId,
  accountId: RelayAccountId,
  descriptor: WhatsAppProtocolConversationDescriptor,
): RelayConversation {
  const conversationId = parseRelayConversationId(descriptor.conversationId);
  const displayName = normalizeOptionalLabel(descriptor.displayName, "WhatsApp conversation name");
  const parentConversationId =
    descriptor.parentConversationId === undefined
      ? undefined
      : parseRelayConversationId(descriptor.parentConversationId);
  return {
    address: { providerId, accountId, conversationId },
    kind: normalizeConversationKind(descriptor.kind),
    ...(displayName === undefined ? {} : { displayName }),
    ...(parentConversationId === undefined ? {} : { parentConversationId }),
  };
}

export function relayConversationFromCommunity(
  community: RelayCommunityDescriptor,
): RelayConversation {
  return {
    address: community.address,
    kind: "community",
    displayName: community.displayName,
  };
}

export function relayConversationFromManagedGroup(
  group: RelayManagedGroupDescriptor,
): RelayConversation {
  return {
    address: group.address,
    kind: "group",
    displayName: group.displayName,
    parentConversationId: group.communityAddress.conversationId,
  };
}

export function relayAttachmentFromIngested(attachment: RelayIngestedAttachment): RelayAttachment {
  return {
    id: attachment.metadata.attachmentId,
    kind: attachment.metadata.kind,
    mimeType: attachment.metadata.mimeType,
    ...(attachment.metadata.fileName === undefined
      ? {}
      : { fileName: attachment.metadata.fileName }),
    sizeBytes: attachment.sizeBytes,
    localPath: attachment.localPath,
    ...(attachment.storageKey === undefined ? {} : { storageKey: attachment.storageKey }),
    sha256: attachment.sha256,
    ...(attachment.metadata.voice ? { voiceMemo: true } : {}),
    ...(attachment.metadata.voice?.durationMs === undefined
      ? {}
      : { durationMs: attachment.metadata.voice.durationMs }),
  };
}

export function relayInboundMessageFromProtocol(
  providerId: RelayProviderId,
  envelope: NormalizedWhatsAppProtocolMessageEnvelope,
  content: WhatsAppProtocolContent,
  attachments: readonly RelayAttachment[],
  transcripts: readonly string[],
): RelayInboundMessage {
  const textParts = [...(content.text === undefined ? [] : [content.text]), ...transcripts];
  const text = textParts.length === 0 ? undefined : textParts.join("\n\n");

  return {
    address: {
      providerId,
      accountId: envelope.accountId,
      conversationId: envelope.conversationId,
    },
    providerMessageId: parseRelayMessageId(envelope.providerMessageId),
    sender: envelope.sender,
    sentAt: envelope.sentAt,
    receivedAt: envelope.receivedAt,
    ...(text === undefined ? {} : { text }),
    attachments,
    ...(envelope.replyTo
      ? {
          replyTo: {
            providerMessageId: envelope.replyTo.providerMessageId,
            ...(envelope.replyTo.sender ? { sender: envelope.replyTo.sender } : {}),
          },
        }
      : {}),
  };
}

export function relayAddressesEqual(left: RelayAddress, right: RelayAddress): boolean {
  return (
    left.providerId === right.providerId &&
    left.accountId === right.accountId &&
    left.conversationId === right.conversationId
  );
}

function relayConnectionStateFromSetup(state: RelaySetupSnapshot["state"]): RelayConnectionState {
  switch (state) {
    case "idle":
    case "disconnected":
      return "disconnected";
    case "pairing":
    case "qr":
      return "connecting";
    case "connected":
      return "connected";
    case "reconnecting":
      return "reconnecting";
    case "error":
      return "error";
  }
  return unreachable(state);
}

function normalizeConversationKind(kind: RelayConversationKind): RelayConversationKind {
  switch (kind) {
    case "direct":
    case "group":
    case "channel":
    case "community":
    case "unknown":
      return kind;
  }
  return unreachable(kind);
}

function normalizeOptionalLabel(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a non-empty, trimmed string`);
  }
  return value;
}

function unreachable(value: never): never {
  throw new TypeError(`Unexpected WhatsApp protocol value: ${String(value)}`);
}
