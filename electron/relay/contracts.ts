import type {
  RelayAccountId,
  RelayAddress,
  RelayConversationId,
  RelayInboundMessage,
  RelayInteractionPrompt,
  RelayInteractionPublishReceipt,
  RelayInteractionSelection,
  RelayMessageId,
  RelayProviderCapabilities,
  RelayProviderId,
  RelayPublishRequest,
} from "../../common/relay-contract";

export type RelayConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnecting"
  | "error";

export interface RelayProviderFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface RelayConnectionStatus {
  readonly state: RelayConnectionState;
  readonly updatedAt: string;
  readonly failure?: RelayProviderFailure;
}

export interface RelayPublishReceipt {
  readonly publicationId: string;
  readonly providerMessageId: RelayMessageId;
  readonly publishedAt: string;
}

export type RelayDeliveryState = "sent" | "delivered" | "read" | "failed";

export type RelayConversationKind = "direct" | "group" | "channel" | "community" | "unknown";

export interface RelayConversation {
  readonly address: RelayAddress;
  readonly kind: RelayConversationKind;
  readonly displayName?: string;
  readonly parentConversationId?: RelayConversationId;
}

export interface RelayConversationCreateRequest {
  readonly kind: RelayConversationKind;
  readonly displayName: string;
  readonly parentConversationId?: RelayConversationId;
}

export interface RelayConversationAdministration {
  list(accountId: RelayAccountId): Promise<readonly RelayConversation[]>;
  create?(
    accountId: RelayAccountId,
    request: RelayConversationCreateRequest,
  ): Promise<RelayConversation>;
  rename?(address: RelayAddress, displayName: string): Promise<RelayConversation>;
  retire?(address: RelayAddress): Promise<void>;
}

export interface RelayInteractionAdministration {
  publish(prompt: RelayInteractionPrompt): Promise<RelayInteractionPublishReceipt>;
  cancel?(
    interactionId: string,
    address: RelayAddress,
    providerPromptMessageId: RelayMessageId,
  ): Promise<void>;
}

interface RelayProviderEventBase {
  readonly providerId: RelayProviderId;
  readonly accountId: RelayAccountId;
  readonly occurredAt: string;
}

export interface RelayInboundMessageEvent extends RelayProviderEventBase {
  readonly type: "message-received";
  readonly message: RelayInboundMessage;
}

export interface RelayStatusChangedEvent extends RelayProviderEventBase {
  readonly type: "status-changed";
  readonly status: RelayConnectionStatus;
}

export interface RelayDeliveryUpdatedEvent extends RelayProviderEventBase {
  readonly type: "delivery-updated";
  readonly providerMessageId: RelayMessageId;
  readonly state: RelayDeliveryState;
  readonly failure?: RelayProviderFailure;
}

export interface RelayConversationChangedEvent extends RelayProviderEventBase {
  readonly type: "conversation-changed";
  readonly change: "created" | "updated" | "retired";
  readonly conversation: RelayConversation;
}

export interface RelayInteractionSelectedEvent extends RelayProviderEventBase {
  readonly type: "interaction-selected";
  readonly selection: RelayInteractionSelection;
}

export type RelayProviderEvent =
  | RelayInboundMessageEvent
  | RelayStatusChangedEvent
  | RelayDeliveryUpdatedEvent
  | RelayConversationChangedEvent
  | RelayInteractionSelectedEvent;

export type RelayProviderEventListener = (event: RelayProviderEvent) => Promise<void>;

export interface RelayProvider {
  readonly providerId: RelayProviderId;
  readonly conversations?: RelayConversationAdministration;
  readonly interactions?: RelayInteractionAdministration;

  capabilities(accountId: RelayAccountId): RelayProviderCapabilities;
  connect(accountId: RelayAccountId): Promise<void>;
  disconnect(accountId: RelayAccountId): Promise<void>;
  status(accountId: RelayAccountId): Promise<RelayConnectionStatus>;
  publish(request: RelayPublishRequest): Promise<RelayPublishReceipt>;
  subscribe(listener: RelayProviderEventListener): () => void;
}
