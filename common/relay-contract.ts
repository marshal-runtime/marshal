declare const relayIdentifierBrand: unique symbol;

type RelayIdentifier<Kind extends string> = string & {
  readonly [relayIdentifierBrand]: Kind;
};

export type RelayProviderId = RelayIdentifier<"provider">;
export type RelayAccountId = RelayIdentifier<"account">;
export type RelayConversationId = RelayIdentifier<"conversation">;
export type RelayMessageId = RelayIdentifier<"message">;

type RelayIdentifierKind = "provider" | "account" | "conversation" | "message";

const RELAY_IDENTIFIER_LABELS: Record<RelayIdentifierKind, string> = {
  provider: "Relay provider ID",
  account: "Relay account ID",
  conversation: "Relay conversation ID",
  message: "Relay message ID",
};

function parseRelayIdentifier<Kind extends RelayIdentifierKind>(
  value: unknown,
  kind: Kind,
): RelayIdentifier<Kind> {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${RELAY_IDENTIFIER_LABELS[kind]} must be a non-empty, trimmed string`);
  }
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the runtime checks above establish the branded non-empty identifier invariant
  return value as RelayIdentifier<Kind>;
}

export function parseRelayProviderId(value: unknown): RelayProviderId {
  return parseRelayIdentifier(value, "provider");
}

export function parseRelayAccountId(value: unknown): RelayAccountId {
  return parseRelayIdentifier(value, "account");
}

export function parseRelayConversationId(value: unknown): RelayConversationId {
  return parseRelayIdentifier(value, "conversation");
}

export function parseRelayMessageId(value: unknown): RelayMessageId {
  return parseRelayIdentifier(value, "message");
}

export interface RelayAddress {
  readonly providerId: RelayProviderId;
  readonly accountId: RelayAccountId;
  readonly conversationId: RelayConversationId;
}

export interface RelayIdentity {
  readonly primaryId: string;
  readonly alternateIds?: readonly string[];
  readonly displayName?: string;
}

export type RelayAttachmentKind = "image" | "audio" | "file" | "video";

export interface RelayAttachment {
  readonly id: string;
  readonly kind: RelayAttachmentKind;
  readonly mimeType: string;
  readonly fileName?: string;
  readonly sizeBytes?: number;
  readonly localPath?: string;
  readonly storageKey?: string;
  readonly sha256?: string;
  readonly voiceMemo?: boolean;
  readonly durationMs?: number;
}

export interface RelayReplyContext {
  readonly providerMessageId: RelayMessageId;
  readonly sender?: RelayIdentity;
}

export interface RelayInboundMessage {
  readonly address: RelayAddress;
  readonly providerMessageId: RelayMessageId;
  readonly sender: RelayIdentity;
  readonly sentAt: string;
  readonly receivedAt: string;
  readonly text?: string;
  readonly attachments: readonly RelayAttachment[];
  readonly replyTo?: RelayReplyContext;
}

export type RelayInteractionKind = "permission" | "choice";

export interface RelayInteractionOption {
  readonly optionId: string;
  readonly label: string;
  readonly description?: string;
}

export interface RelayInteractionSource {
  readonly sessionId: string;
  readonly correlationId: string;
  readonly turnId?: string;
  readonly requestId?: string;
}

export interface RelayInteractionPrompt {
  readonly interactionId: string;
  readonly idempotencyKey: string;
  readonly address: RelayAddress;
  readonly source: RelayInteractionSource;
  readonly kind: RelayInteractionKind;
  readonly title: string;
  readonly question: string;
  readonly body?: string;
  readonly options: readonly RelayInteractionOption[];
  readonly minSelections: number;
  readonly maxSelections: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface RelayInteractionSelection {
  readonly interactionId: string;
  readonly address: RelayAddress;
  readonly providerPromptMessageId: RelayMessageId;
  readonly selectedOptionIds: readonly string[];
  readonly responder: RelayIdentity;
  readonly selectedAt: string;
}

export type RelayInteractionTerminalOutcome =
  | {
      readonly state: "resolved";
      readonly selection: RelayInteractionSelection;
    }
  | {
      readonly state: "cancelled";
      readonly reason: string;
      readonly completedAt: string;
    }
  | {
      readonly state: "expired";
      readonly completedAt: string;
    }
  | {
      readonly state: "unsupported";
      readonly reason: string;
      readonly completedAt: string;
    }
  | {
      readonly state: "failed";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly completedAt: string;
    };

export interface RelayInteractionPublishReceipt {
  readonly interactionId: string;
  readonly providerPromptMessageId: RelayMessageId;
  readonly publishedAt: string;
  readonly mode: "native" | "text-fallback";
}

export type RelayPublishKind = "reply" | "progress" | "notification" | "permission-attention";

export interface RelayPublishRequest {
  readonly publicationId: string;
  readonly address: RelayAddress;
  readonly kind: RelayPublishKind;
  readonly text: string;
  readonly replyToProviderMessageId?: RelayMessageId;
  readonly sourceSessionId?: string;
  readonly sourceTurnId?: string;
}

export interface RelayProviderCapabilities {
  readonly inbound: boolean;
  readonly quotedReplies: boolean;
  readonly attachments: boolean;
  readonly voice: boolean;
  readonly managedGroups: boolean;
  readonly communities: boolean;
  readonly renameConversation: boolean;
  readonly retireConversation: boolean;
  readonly remotePermissionApproval: boolean;
  readonly interactiveChoices?: "native" | "text-fallback" | "unsupported";
}
