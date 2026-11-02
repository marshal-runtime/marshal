import type {
  MSettings,
  WhatsAppSettings,
  WhatsAppStatus,
} from "../../../../common/marshal-ipc-contract";
import { createLogger } from "../../../../common/marshal-logger";
import {
  normalizeRelaySettings,
  WHATSAPP_RELAY_PROVIDER_ID,
} from "../../../../common/provider-config";
import { EncryptedWhatsAppAuthStore } from "./auth-store";
import {
  WhatsAppConnectionController,
  type WhatsAppConnectionControllerOptions,
} from "./connection-controller";
import {
  getPersistedSessionGroupConversationLookup,
  getPersistedSessionGroupForwardLookup,
  parsePersistedSessionGroupConversation,
  parsePersistedSessionGroupForward,
} from "./sidecar/managed-message-state";
import type {
  WhatsAppConnectedIdentity,
  WhatsAppConnectionEvent,
  WhatsAppConnectionStatus,
  WhatsAppInboundManagedMessage,
  WhatsAppInteractionSelection,
  WhatsAppManagedFixedGroupRole,
  WhatsAppSidecarRequest,
  WhatsAppSidecarRequestResponse,
} from "./sidecar/protocol";

const log = createLogger("WhatsAppService");

export const WHATSAPP_RUNTIME_ID = "whatsapp-baileys" as const;

const DEFAULT_WHATSAPP_SETTINGS: WhatsAppSettings = {
  enabled: false,
  defaultNotificationsEnabled: true,
  progressNotificationsEnabled: true,
};

interface WhatsAppAuthStorePort {
  readCredentials(): object | string | number | boolean | bigint | null;
  readSignalKeys(
    category: string,
    ids: readonly string[],
  ): Record<string, object | string | number | boolean | bigint>;
  applyTransaction(update: {
    credentials?: object | string | number | boolean | bigint | null;
    signalKeys?: Readonly<
      Record<string, Readonly<Record<string, object | string | number | boolean | bigint | null>>>
    >;
  }): void;
  resetAfterTerminalDisconnect(): void;
  close(): void;
}

interface WhatsAppConnectionControllerPort {
  subscribe(listener: (event: WhatsAppConnectionEvent) => void): () => void;
  startPairing(): Promise<void>;
  stop(): Promise<void>;
  resetAndPair(): Promise<void>;
  retryProvisioning(): Promise<void>;
  sendText(
    request: Extract<WhatsAppSidecarRequest, { type: "send-text" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "send-text" }>>;
  sendInteraction?(
    request: Extract<WhatsAppSidecarRequest, { type: "send-interaction" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "send-interaction" }>>;
  downloadMedia?(
    request: Extract<WhatsAppSidecarRequest, { type: "download-media" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "download-media" }>>;
  releaseMedia?(
    request: Extract<WhatsAppSidecarRequest, { type: "release-media" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "release-media" }>>;
  cancelInteraction?(
    request: Extract<WhatsAppSidecarRequest, { type: "cancel-interaction" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "cancel-interaction" }>>;
  ensureSessionGroup(
    request: Extract<WhatsAppSidecarRequest, { type: "ensure-session-group" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "ensure-session-group" }>>;
  retireSessionGroup(
    request: Extract<WhatsAppSidecarRequest, { type: "retire-session-group" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "retire-session-group" }>>;
  shutdown(): Promise<void>;
}

export interface WhatsAppManagedGroupIds {
  readonly community: string;
  readonly fixed: Readonly<Record<WhatsAppManagedFixedGroupRole, string>>;
}

export interface WhatsAppServiceOptions {
  readonly databasePath: string;
  readonly launch: WhatsAppConnectionControllerOptions["launch"];
  readonly loadKey: () => Uint8Array | null;
  readonly getSettings: () => MSettings;
  readonly saveSettings: (settings: MSettings) => void;
  readonly publishStatus: (status: WhatsAppStatus) => void;
  readonly accountId: string;
  readonly openAuthStore?: (databasePath: string, keyMaterial: Uint8Array) => WhatsAppAuthStorePort;
  readonly createController?: (
    options: WhatsAppConnectionControllerOptions,
  ) => WhatsAppConnectionControllerPort;
}

export class WhatsAppService {
  private readonly statusListeners = new Set<(status: WhatsAppStatus) => void>();
  private readonly messageListeners = new Set<
    (message: WhatsAppInboundManagedMessage) => void | Promise<void>
  >();
  private readonly interactionListeners = new Set<
    (selection: WhatsAppInteractionSelection) => void | Promise<void>
  >();
  private readonly mediaSources = new Map<string, string>();
  private readonly pendingInteractionSelections = new Map<string, WhatsAppInteractionSelection>();
  private interactionDeliveryQueue: Promise<void> = Promise.resolve();
  private authStore: WhatsAppAuthStorePort | undefined;
  private controller: WhatsAppConnectionControllerPort | undefined;
  private unsubscribeController: (() => void) | undefined;
  private connectedIdentityId: string | undefined;
  private initialized = false;
  private disposed = false;
  private status: WhatsAppStatus = {
    runtimeId: WHATSAPP_RUNTIME_ID,
    connection: "stopped",
    initialized: false,
    settings: DEFAULT_WHATSAPP_SETTINGS,
  };

  constructor(private readonly options: WhatsAppServiceOptions) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.disposed) throw new Error("WhatsApp service is disposed");

    const key = this.options.loadKey();
    if (key === null) {
      throw new Error("OS-backed encryption is unavailable for WhatsApp authentication");
    }

    const authStore = (
      this.options.openAuthStore ??
      ((databasePath, keyMaterial) =>
        EncryptedWhatsAppAuthStore.open({ databasePath, keyMaterial }))
    )(this.options.databasePath, key);
    const controller = (
      this.options.createController ??
      ((controllerOptions) => new WhatsAppConnectionController(controllerOptions))
    )({
      launch: this.options.launch,
      authStore,
    });

    this.authStore = authStore;
    this.controller = controller;
    this.unsubscribeController = controller.subscribe((event) => {
      this.handleConnectionEvent(event);
    });
    this.initialized = true;
    this.updateStatus({
      initialized: true,
      settings: this.readSettings(),
    });

    const settings = this.readSettings();
    if (settings.enabled && authStore.readCredentials() !== null) {
      await controller.startPairing();
    }
  }

  getStatus(): WhatsAppStatus {
    return {
      ...this.status,
      settings: this.readSettings(),
    };
  }

  getConnectedIdentityId(): string | undefined {
    return this.connectedIdentityId;
  }

  hasPersistedSessionGroup(conversationId: string): boolean {
    if (!this.authStore) return false;
    const reverseLookup = getPersistedSessionGroupConversationLookup(conversationId);
    const reverseValue = this.authStore.readSignalKeys(reverseLookup.category, [reverseLookup.id])[
      reverseLookup.id
    ];
    let reverse;
    try {
      reverse = parsePersistedSessionGroupConversation(reverseValue, conversationId);
    } catch {
      this.prunePersistedSessionGroupReverse(reverseLookup);
      return false;
    }
    if (!reverse) return false;
    const forwardLookup = getPersistedSessionGroupForwardLookup(reverse.idempotencyDigest);
    const forwardValue = this.authStore.readSignalKeys(forwardLookup.category, [forwardLookup.id])[
      forwardLookup.id
    ];
    let forward;
    try {
      forward = parsePersistedSessionGroupForward(forwardValue, reverse.idempotencyDigest);
    } catch {
      this.prunePersistedSessionGroupReverse(reverseLookup);
      return false;
    }
    if (!forward || forward.conversationId !== conversationId) {
      this.prunePersistedSessionGroupReverse(reverseLookup);
      return false;
    }
    if (JSON.stringify(reverse) !== JSON.stringify(forward)) {
      this.authStore.applyTransaction({
        signalKeys: {
          [reverseLookup.category]: {
            [reverseLookup.id]: forward,
          },
        },
      });
    }
    return true;
  }

  private prunePersistedSessionGroupReverse(lookup: {
    readonly category: string;
    readonly id: string;
  }): void {
    this.authStore?.applyTransaction({
      signalKeys: {
        [lookup.category]: {
          [lookup.id]: null,
        },
      },
    });
  }

  subscribeStatus(listener: (status: WhatsAppStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  subscribeMessages(
    listener: (message: WhatsAppInboundManagedMessage) => void | Promise<void>,
  ): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  subscribeInteractions(
    listener: (selection: WhatsAppInteractionSelection) => void | Promise<void>,
  ): () => void {
    this.interactionListeners.add(listener);
    this.scheduleInteractionDelivery();
    return () => {
      this.interactionListeners.delete(listener);
    };
  }

  async connect(): Promise<void> {
    const controller = this.requireController();
    this.saveConnectionIntent("connect");
    await controller.startPairing();
  }

  async disconnect(): Promise<void> {
    const controller = this.requireController();
    this.saveConnectionIntent("disconnect");
    await controller.stop();
  }

  async cancelPairing(): Promise<void> {
    if (
      this.status.connection !== "starting" &&
      this.status.connection !== "connecting" &&
      this.status.connection !== "awaiting-qr"
    ) {
      return;
    }
    const controller = this.requireController();
    this.saveConnectionIntent("disconnect");
    await controller.stop();
  }

  async reset(): Promise<void> {
    const controller = this.requireController();
    this.saveConnectionIntent("connect");
    this.updateStatus({ account: undefined, error: undefined, qr: undefined });
    await controller.resetAndPair();
  }

  async retryProvisioning(): Promise<void> {
    const controller = this.requireController();
    this.updateStatus({ error: undefined });
    await controller.retryProvisioning();
  }

  sendText(
    conversationId: string,
    text: string,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "send-text" }>> {
    return this.requireController().sendText({
      type: "send-text",
      conversationId,
      text,
    });
  }

  sendInteraction(
    request: Extract<WhatsAppSidecarRequest, { type: "send-interaction" }>,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "send-interaction" }>> {
    const controller = this.requireController();
    if (!controller.sendInteraction) {
      throw new Error("WhatsApp interactive prompts are unavailable");
    }
    return controller.sendInteraction(request);
  }

  async downloadMediaSource(
    sourceId: string,
    authorizationToken: string,
  ): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "download-media" }>["attachment"]> {
    const controller = this.requireController();
    if (!controller.downloadMedia) {
      throw new Error("WhatsApp media download is unavailable");
    }
    const response = await controller.downloadMedia({
      type: "download-media",
      sourceId,
      authorizationToken,
    });
    if (response.attachment.sourceId !== sourceId) {
      throw new Error("WhatsApp media download returned a mismatched source");
    }
    this.mediaSources.set(sourceId, response.attachment.localPath);
    return response.attachment;
  }

  claimMediaSource(sourceId: string, localPath: string): boolean {
    return this.mediaSources.get(sourceId) === localPath;
  }

  async releaseMediaSource(sourceId: string): Promise<void> {
    const controller = this.requireController();
    this.mediaSources.delete(sourceId);
    if (!controller.releaseMedia) {
      throw new Error("WhatsApp media release is unavailable");
    }
    await controller.releaseMedia({ type: "release-media", sourceId });
  }

  async cancelInteraction(
    interactionId: string,
    conversationId: string,
    providerMessageId: string,
  ): Promise<void> {
    const controller = this.requireController();
    if (!controller.cancelInteraction) {
      throw new Error("WhatsApp interaction cancellation is unavailable");
    }
    await controller.cancelInteraction({
      type: "cancel-interaction",
      interactionId,
      conversationId,
      providerMessageId,
    });
  }

  ensureSessionGroup(input: {
    readonly idempotencyKey: string;
    readonly displayName: string;
    readonly communityConversationId: string;
    readonly existingConversationId?: string;
  }): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "ensure-session-group" }>> {
    return this.requireController().ensureSessionGroup({
      type: "ensure-session-group",
      ...input,
    });
  }

  retireSessionGroup(input: {
    readonly conversationId: string;
    readonly communityConversationId: string;
  }): Promise<Extract<WhatsAppSidecarRequestResponse, { type: "retire-session-group" }>> {
    return this.requireController().retireSessionGroup({
      type: "retire-session-group",
      ...input,
    });
  }

  getManagedGroupIds(): WhatsAppManagedGroupIds | undefined {
    if (!this.authStore) return undefined;
    const roles = ["community", "new-chats", "progress", "information-control"] as const;
    const stored = this.authStore.readSignalKeys("marshal-managed-groups-v1", roles);
    const ids = new Map<string, string>();
    for (const role of roles) {
      const value = stored[role];
      const conversationId = readStoredMappingConversationId(value, role);
      if (!conversationId) return undefined;
      ids.set(role, conversationId);
    }
    return {
      community: ids.get("community")!,
      fixed: {
        "new-chats": ids.get("new-chats")!,
        progress: ids.get("progress")!,
        "information-control": ids.get("information-control")!,
      },
    };
  }

  updatePreferences(
    updates: Pick<WhatsAppSettings, "defaultNotificationsEnabled" | "progressNotificationsEnabled">,
  ): void {
    this.saveSettings(updates);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeController?.();
    this.unsubscribeController = undefined;
    await this.interactionDeliveryQueue;
    const controller = this.controller;
    this.controller = undefined;
    try {
      await controller?.shutdown();
    } finally {
      this.authStore?.close();
      this.authStore = undefined;
      this.connectedIdentityId = undefined;
      this.initialized = false;
      this.messageListeners.clear();
      this.interactionListeners.clear();
      this.pendingInteractionSelections.clear();
      this.mediaSources.clear();
    }
  }

  private requireController(): WhatsAppConnectionControllerPort {
    if (!this.initialized || !this.controller) {
      throw new Error("WhatsApp service is not initialized");
    }
    if (this.disposed) throw new Error("WhatsApp service is disposed");
    return this.controller;
  }

  private readSettings(): WhatsAppSettings {
    const settings = this.options.getSettings();
    const legacy = settings.whatsapp;
    const relay = normalizeRelaySettings(settings.relay, {
      whatsappDefaultNotificationsEnabled: legacy?.defaultNotificationsEnabled,
      whatsappProgressNotificationsEnabled: legacy?.progressNotificationsEnabled,
    });
    const provider = relay.providers[WHATSAPP_RELAY_PROVIDER_ID];
    return {
      ...DEFAULT_WHATSAPP_SETTINGS,
      ...legacy,
      enabled:
        (provider?.enabled ?? false) &&
        provider?.connectionIntent === "connect" &&
        (provider?.accountId ?? this.options.accountId) === this.options.accountId,
    };
  }

  private saveSettings(updates: Partial<WhatsAppSettings>): void {
    const settings = {
      ...this.readSettings(),
      ...updates,
    };
    this.options.saveSettings({
      ...this.options.getSettings(),
      whatsapp: settings,
    });
    this.updateStatus({ settings });
  }

  private saveConnectionIntent(connectionIntent: "connect" | "disconnect"): void {
    const current = this.options.getSettings();
    const legacy = {
      ...DEFAULT_WHATSAPP_SETTINGS,
      ...current.whatsapp,
      enabled: connectionIntent === "connect",
    };
    const relay = normalizeRelaySettings(current.relay, {
      whatsappEnabled: current.whatsapp?.enabled,
      whatsappDefaultNotificationsEnabled: current.whatsapp?.defaultNotificationsEnabled,
      whatsappProgressNotificationsEnabled: current.whatsapp?.progressNotificationsEnabled,
    });
    const configuredAccountId =
      relay.providers[WHATSAPP_RELAY_PROVIDER_ID]?.accountId ?? this.options.accountId;
    relay.providers[WHATSAPP_RELAY_PROVIDER_ID] = {
      enabled: true,
      accountId: configuredAccountId,
      connectionIntent,
    };
    this.options.saveSettings({
      ...current,
      relay,
      whatsapp: legacy,
    });
    this.updateStatus({ settings: legacy });
  }

  private handleConnectionEvent(event: WhatsAppConnectionEvent): void {
    switch (event.type) {
      case "status":
        this.handleConnectionStatus(event.status);
        return;
      case "setup":
        if (event.phase === "qr") {
          this.updateStatus({
            connection: "awaiting-qr",
            qr: event.qr,
            error: undefined,
          });
        } else {
          this.updateStatus({ qr: undefined });
        }
        return;
      case "connected":
        this.connectedIdentityId = event.identity.id;
        this.updateStatus({
          connection: "connected",
          account: sanitizeIdentity(event.identity),
          error: undefined,
          qr: undefined,
        });
        return;
      case "provisioned":
        log.info("WhatsApp managed groups provisioned");
        this.updateStatus({
          provisioning: event.provisioning,
          error: undefined,
        });
        return;
      case "message":
        if (this.messageListeners.size === 0) {
          for (const attachment of event.message.attachments ?? []) {
            void this.releaseMediaSource(attachment.sourceId).catch((error: unknown) => {
              log
                .with({ sourceId: attachment.sourceId })
                .warn("Failed to release unhandled WhatsApp media source:", error);
            });
          }
          return;
        }
        for (const listener of this.messageListeners) {
          void Promise.resolve(listener(event.message)).catch((error: unknown) => {
            log.error("WhatsApp managed message listener failed:", error);
          });
        }
        return;
      case "interaction-selection":
        this.pendingInteractionSelections.set(
          interactionSelectionKey(event.selection),
          event.selection,
        );
        this.scheduleInteractionDelivery();
        return;
      case "disconnected":
        if (event.classification === "terminal") this.connectedIdentityId = undefined;
        this.updateStatus({
          connection: event.classification === "terminal" ? "requires-reset" : "reconnecting",
          error:
            event.classification === "terminal"
              ? "WhatsApp signed out. Reset the account to relink it."
              : undefined,
          qr: undefined,
        });
        return;
      case "error":
        log.with({ code: event.code }).error(event.message);
        this.updateStatus({ error: event.message, qr: undefined });
    }
  }

  private scheduleInteractionDelivery(): void {
    const delivery = this.interactionDeliveryQueue.then(
      () => this.flushInteractionSelections(),
      () => this.flushInteractionSelections(),
    );
    this.interactionDeliveryQueue = delivery.catch((error: unknown) => {
      log.error("WhatsApp interaction delivery failed:", error);
    });
  }

  private async flushInteractionSelections(): Promise<void> {
    if (this.interactionListeners.size === 0) return;
    for (const [key, selection] of this.pendingInteractionSelections) {
      // Preserve the durable sidecar replay order.
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.allSettled(
        [...this.interactionListeners].map((listener) => Promise.resolve(listener(selection))),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        log.error(
          "WhatsApp interaction listener failed:",
          failures.length === 1
            ? failures[0]
            : new AggregateError(failures, "WhatsApp interaction listeners failed"),
        );
        continue;
      }
      if (this.pendingInteractionSelections.get(key) === selection) {
        this.pendingInteractionSelections.delete(key);
      }
    }
  }

  private handleConnectionStatus(connection: WhatsAppConnectionStatus): void {
    if (connection === "stopped") this.connectedIdentityId = undefined;
    this.updateStatus({
      connection,
      ...(connection === "awaiting-qr" ? {} : { qr: undefined }),
      ...(connection === "stopped" ? { account: undefined } : {}),
    });
  }

  private updateStatus(update: Partial<WhatsAppStatus>): void {
    this.status = {
      ...this.status,
      ...update,
      runtimeId: WHATSAPP_RUNTIME_ID,
    };
    this.options.publishStatus(this.status);
    for (const listener of this.statusListeners) listener(this.status);
  }
}

function interactionSelectionKey(selection: WhatsAppInteractionSelection): string {
  return `${selection.interactionId}\u0000${selection.providerPromptMessageId}`;
}

function readStoredMappingConversationId(value: unknown, expectedRole: string): string | undefined {
  if (!isRecord(value) || value.role !== expectedRole || !isRecord(value.ref)) return undefined;
  const conversationId = value.ref.conversationId;
  return typeof conversationId === "string" && conversationId.length > 0
    ? conversationId
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeIdentity(
  identity: WhatsAppConnectedIdentity,
): NonNullable<WhatsAppStatus["account"]> {
  return {
    ...(identity.phoneNumber ? { phoneNumber: identity.phoneNumber } : {}),
    ...(identity.displayName ? { displayName: identity.displayName } : {}),
    ...(identity.username ? { username: identity.username } : {}),
  };
}
