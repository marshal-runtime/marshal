import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayMessageId,
} from "../../../../common/relay-contract";
import type {
  RelayAccountId,
  RelayAttachmentKind,
  RelayConversationId,
  RelayIdentity,
  RelayMessageId,
} from "../../../../common/relay-contract";
import type {
  RelayTimestamp,
  RelayAttachmentLocalSource,
  RelayVoiceMetadata,
} from "../../../../common/relay-experience-contract";

export interface WhatsAppProtocolAttachment {
  readonly attachmentId: string;
  readonly kind: RelayAttachmentKind;
  readonly mimeType: string;
  readonly fileName?: string;
  readonly sizeBytes?: number;
  readonly sha256?: string;
  readonly voice?: RelayVoiceMetadata;
  readonly source?: RelayAttachmentLocalSource;
}

export interface WhatsAppProtocolContent {
  readonly text?: string;
  readonly attachments: readonly WhatsAppProtocolAttachment[];
}

export interface WhatsAppProtocolReplyContext {
  readonly providerMessageId: RelayMessageId;
  readonly sender?: RelayIdentity;
}

export interface WhatsAppProtocolMessageEnvelope {
  readonly accountId: RelayAccountId;
  readonly conversationId: RelayConversationId;
  readonly providerMessageId: RelayMessageId;
  readonly sender: RelayIdentity;
  readonly sentAt: RelayTimestamp;
  readonly receivedAt: RelayTimestamp;
  readonly replyTo?: WhatsAppProtocolReplyContext;
  readonly loadContent: (authorization: {
    readonly acceptanceToken: string;
  }) => Promise<WhatsAppProtocolContent>;
}

export interface NormalizedWhatsAppProtocolMessageEnvelope extends Omit<
  WhatsAppProtocolMessageEnvelope,
  "loadContent"
> {
  readonly loadContent: WhatsAppProtocolMessageEnvelope["loadContent"];
}

export function normalizeWhatsAppProtocolEnvelope(
  envelope: WhatsAppProtocolMessageEnvelope,
): NormalizedWhatsAppProtocolMessageEnvelope {
  if (typeof envelope.loadContent !== "function") {
    throw new TypeError("WhatsApp protocol envelope requires a lazy content loader");
  }

  const loadContent = envelope.loadContent;
  return {
    accountId: parseRelayAccountId(envelope.accountId),
    conversationId: parseRelayConversationId(envelope.conversationId),
    providerMessageId: parseRelayMessageId(envelope.providerMessageId),
    sender: normalizeIdentity(envelope.sender, "WhatsApp sender"),
    sentAt: normalizeWhatsAppTimestamp(envelope.sentAt, "WhatsApp sentAt"),
    receivedAt: normalizeWhatsAppTimestamp(envelope.receivedAt, "WhatsApp receivedAt"),
    ...(envelope.replyTo
      ? {
          replyTo: {
            providerMessageId: parseRelayMessageId(envelope.replyTo.providerMessageId),
            ...(envelope.replyTo.sender
              ? { sender: normalizeIdentity(envelope.replyTo.sender, "WhatsApp quoted sender") }
              : {}),
          },
        }
      : {}),
    loadContent: async (authorization: { readonly acceptanceToken: string }) =>
      normalizeWhatsAppProtocolContent(await loadContent(authorization)),
  };
}

export function normalizeWhatsAppProtocolContent(
  content: WhatsAppProtocolContent,
): WhatsAppProtocolContent {
  if (!Array.isArray(content.attachments)) {
    throw new TypeError("WhatsApp protocol content attachments must be an array");
  }

  const attachments = content.attachments.map(normalizeAttachment);
  const attachmentIds = new Set<string>();
  for (const attachment of attachments) {
    if (attachmentIds.has(attachment.attachmentId)) {
      throw new TypeError(
        `WhatsApp protocol content contains duplicate attachment "${attachment.attachmentId}"`,
      );
    }
    attachmentIds.add(attachment.attachmentId);
  }

  const text = normalizeOptionalContentText(content.text);
  return {
    ...(text === undefined ? {} : { text }),
    attachments,
  };
}

export function normalizeWhatsAppTimestamp(value: string, label: string): RelayTimestamp {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${label} must be a valid, trimmed timestamp`);
  }
  return value;
}

function normalizeAttachment(
  attachment: WhatsAppProtocolAttachment,
  index: number,
): WhatsAppProtocolAttachment {
  const label = `WhatsApp attachment ${String(index)}`;
  const attachmentId = requireTrimmedText(attachment.attachmentId, `${label} ID`);
  const kind = normalizeAttachmentKind(attachment.kind, label);
  const mimeType = requireTrimmedText(attachment.mimeType, `${label} MIME type`);
  const fileName =
    attachment.fileName === undefined
      ? undefined
      : requireTrimmedText(attachment.fileName, `${label} file name`);
  const sha256 =
    attachment.sha256 === undefined
      ? undefined
      : requireTrimmedText(attachment.sha256, `${label} SHA-256`);
  const sizeBytes =
    attachment.sizeBytes === undefined
      ? undefined
      : requireNonNegativeInteger(attachment.sizeBytes, `${label} size`);
  const voice =
    attachment.voice === undefined ? undefined : normalizeVoice(attachment.voice, label);

  if (voice && kind !== "audio") {
    throw new TypeError(`${label} voice metadata is only valid for audio`);
  }

  return {
    attachmentId,
    kind,
    mimeType,
    ...(fileName === undefined ? {} : { fileName }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(voice === undefined ? {} : { voice }),
    ...(attachment.source === undefined
      ? {}
      : { source: normalizeSource(attachment.source, label) }),
  };
}

function normalizeSource(
  source: RelayAttachmentLocalSource,
  label: string,
): RelayAttachmentLocalSource {
  if (
    source.kind !== "local-file" ||
    typeof source.sourceId !== "string" ||
    !source.sourceId.trim() ||
    typeof source.path !== "string" ||
    !source.path.trim()
  ) {
    throw new TypeError(`${label} source must be a local file`);
  }
  return {
    kind: "local-file",
    sourceId: source.sourceId,
    path: source.path,
  };
}

function normalizeAttachmentKind(kind: RelayAttachmentKind, label: string): RelayAttachmentKind {
  switch (kind) {
    case "image":
    case "audio":
    case "file":
    case "video":
      return kind;
  }
  throw new TypeError(`${label} has an unsupported kind`);
}

function normalizeVoice(voice: RelayVoiceMetadata, label: string): RelayVoiceMetadata {
  const durationMs =
    voice.durationMs === undefined
      ? undefined
      : requireNonNegativeInteger(voice.durationMs, `${label} voice duration`);
  const languageHint =
    voice.languageHint === undefined
      ? undefined
      : requireTrimmedText(voice.languageHint, `${label} voice language hint`);
  return {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(languageHint === undefined ? {} : { languageHint }),
  };
}

function normalizeIdentity(identity: RelayIdentity, label: string): RelayIdentity {
  const primaryId = requireTrimmedText(identity.primaryId, `${label} primary ID`);
  const alternateIds =
    identity.alternateIds === undefined
      ? undefined
      : [
          ...new Set(
            identity.alternateIds.map((id) => requireTrimmedText(id, `${label} alternate ID`)),
          ),
        ];
  const displayName =
    identity.displayName === undefined
      ? undefined
      : requireTrimmedText(identity.displayName, `${label} display name`);

  return {
    primaryId,
    ...(alternateIds === undefined || alternateIds.length === 0 ? {} : { alternateIds }),
    ...(displayName === undefined ? {} : { displayName }),
  };
}

function normalizeOptionalContentText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TypeError("WhatsApp protocol content text must be a string");
  }
  return value.trim().length === 0 ? undefined : value;
}

function requireTrimmedText(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a non-empty, trimmed string`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}
