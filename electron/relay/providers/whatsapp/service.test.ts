import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../../../../common/marshal-default-settings";
import type { MSettings, WhatsAppStatus } from "../../../../common/marshal-ipc-contract";
import { WhatsAppService } from "./service";
import {
  getPersistedSessionGroupConversationLookup,
  getPersistedSessionGroupForwardLookup,
} from "./sidecar/managed-message-state";
import type {
  WhatsAppAuthStoreValue,
  WhatsAppConnectionEvent,
  WhatsAppSidecarRequest,
  WhatsAppSidecarRequestResponse,
} from "./sidecar/protocol";

class FakeController {
  readonly startPairing = vi.fn<() => Promise<void>>(async () => undefined);
  readonly stop = vi.fn<() => Promise<void>>(async () => undefined);
  readonly resetAndPair = vi.fn<() => Promise<void>>(async () => undefined);
  readonly retryProvisioning = vi.fn<() => Promise<void>>(async () => undefined);
  readonly sendText = vi.fn<
    (
      request: Extract<WhatsAppSidecarRequest, { type: "send-text" }>,
    ) => Promise<Extract<WhatsAppSidecarRequestResponse, { type: "send-text" }>>
  >(async () => ({
    type: "send-text",
    providerMessageId: "message-1",
    sentAt: "2026-08-08T12:00:00.000Z",
  }));
  readonly ensureSessionGroup = vi.fn<
    (
      request: Extract<WhatsAppSidecarRequest, { type: "ensure-session-group" }>,
    ) => Promise<Extract<WhatsAppSidecarRequestResponse, { type: "ensure-session-group" }>>
  >(async (request) => ({
    type: "ensure-session-group",
    conversationId: request.existingConversationId ?? "session@g.us",
    displayName: request.displayName,
    communityConversationId: request.communityConversationId,
    disposition: request.existingConversationId ? "existing" : "created",
  }));
  readonly retireSessionGroup = vi.fn<
    (
      request: Extract<WhatsAppSidecarRequest, { type: "retire-session-group" }>,
    ) => Promise<Extract<WhatsAppSidecarRequestResponse, { type: "retire-session-group" }>>
  >(async (request) => ({
    type: "retire-session-group" as const,
    conversationId: request.conversationId,
    unlinked: true,
    left: true,
  }));
  readonly shutdown = vi.fn<() => Promise<void>>(async () => undefined);
  private listener: ((event: WhatsAppConnectionEvent) => void) | undefined;

  subscribe(listener: (event: WhatsAppConnectionEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(event: WhatsAppConnectionEvent): void {
    this.listener?.(event);
  }
}

function createHarness(
  options: {
    enabled?: boolean;
    connectionIntent?: "connect" | "disconnect";
    configuredAccountId?: string;
    credentials?: object | null;
    persistedSessionGroupId?: string;
  } = {},
) {
  let settings: MSettings = {
    ...DEFAULT_SETTINGS,
    ...(options.connectionIntent || options.configuredAccountId
      ? {
          relay: {
            providers: {
              whatsapp: {
                enabled: true,
                accountId: options.configuredAccountId ?? "primary",
                connectionIntent: options.connectionIntent ?? "disconnect",
              },
            },
            defaultNotificationDestinations: [],
            progressDestinations: [],
            progressIntervalMinutes: 15,
          },
        }
      : {}),
    whatsapp: {
      enabled: options.enabled ?? false,
      defaultNotificationsEnabled: true,
      progressNotificationsEnabled: true,
    },
  };
  const controller = new FakeController();
  const statuses: WhatsAppStatus[] = [];
  const close = vi.fn<() => void>();
  const resetAfterTerminalDisconnect = vi.fn<() => void>();
  const credentials = options.credentials ?? null;
  const signalKeys = new Map<string, Map<string, WhatsAppAuthStoreValue>>();
  if (options.persistedSessionGroupId) {
    const record = {
      schemaVersion: 1,
      idempotencyDigest: "persisted-session-group",
      conversationId: options.persistedSessionGroupId,
      communityConversationId: "community@g.us",
      displayName: "Persisted session group",
      createdAt: "2026-08-08T12:00:00.000Z",
    };
    const reverse = getPersistedSessionGroupConversationLookup(options.persistedSessionGroupId);
    const forward = getPersistedSessionGroupForwardLookup(record.idempotencyDigest);
    signalKeys.set(reverse.category, new Map([[reverse.id, record]]));
    signalKeys.set(forward.category, new Map([[forward.id, record]]));
  }
  const service = new WhatsAppService({
    databasePath: "C:\\Marshal\\whatsapp-auth.db",
    accountId: "primary",
    launch: {
      mode: "development",
      sidecarPath: "C:\\Marshal\\whatsapp-sidecar.mjs",
      nodeExecutable: "C:\\Marshal\\node.exe",
    },
    loadKey: () => Buffer.alloc(32, 7),
    getSettings: () => settings,
    saveSettings: (next) => {
      settings = next;
    },
    publishStatus: (status) => statuses.push(status),
    openAuthStore: () => ({
      readCredentials: () => credentials,
      readSignalKeys: (category, ids) => {
        const values = signalKeys.get(category);
        const found: Record<string, WhatsAppAuthStoreValue> = {};
        for (const id of ids) {
          const value = values?.get(id);
          if (value !== undefined) found[id] = value;
        }
        return found;
      },
      applyTransaction: (update) => {
        for (const [category, entries] of Object.entries(update.signalKeys ?? {})) {
          const values = signalKeys.get(category) ?? new Map<string, WhatsAppAuthStoreValue>();
          signalKeys.set(category, values);
          for (const [id, value] of Object.entries(entries)) {
            if (value === null) values.delete(id);
            else values.set(id, value);
          }
        }
      },
      resetAfterTerminalDisconnect,
      close,
    }),
    createController: () => controller,
  });

  return {
    service,
    controller,
    statuses,
    close,
    getSettings: () => settings,
    signalKeys,
  };
}

describe("WhatsAppService", () => {
  it("reads persisted session-group membership without reconnecting or recreating it", async () => {
    const harness = createHarness({ persistedSessionGroupId: "session@g.us" });
    await harness.service.initialize();

    expect(harness.service.hasPersistedSessionGroup("session@g.us")).toBe(true);
    expect(harness.service.hasPersistedSessionGroup("retired@g.us")).toBe(false);
  });

  it("prunes a stale reverse session-group mapping whose forward owner moved", async () => {
    const harness = createHarness({ persistedSessionGroupId: "old@g.us" });
    const reverse = getPersistedSessionGroupConversationLookup("old@g.us");
    const forward = getPersistedSessionGroupForwardLookup("persisted-session-group");
    harness.signalKeys.get(forward.category)!.set(forward.id, {
      schemaVersion: 1,
      idempotencyDigest: "persisted-session-group",
      conversationId: "current@g.us",
      communityConversationId: "community@g.us",
      displayName: "Current session group",
      createdAt: "2026-08-08T12:00:00.000Z",
    });
    await harness.service.initialize();

    expect(harness.service.hasPersistedSessionGroup("old@g.us")).toBe(false);
    expect(harness.signalKeys.get(reverse.category)?.has(reverse.id)).toBe(false);
    expect(harness.signalKeys.get(forward.category)?.get(forward.id)).toMatchObject({
      conversationId: "current@g.us",
    });
  });

  it("does not start pairing on initialization without an enabled persisted account", async () => {
    const harness = createHarness({ enabled: false, credentials: { registered: true } });

    await harness.service.initialize();

    expect(harness.controller.startPairing).not.toHaveBeenCalled();
    expect(harness.service.getStatus()).toMatchObject({
      initialized: true,
      connection: "stopped",
    });
  });

  it("reconnects an enabled account when encrypted credentials exist", async () => {
    const harness = createHarness({
      connectionIntent: "connect",
      credentials: { registered: true },
    });

    await harness.service.initialize();

    expect(harness.controller.startPairing).toHaveBeenCalledOnce();
  });

  it("reconnects from canonical connection intent even when the legacy flag is stale", async () => {
    const harness = createHarness({
      enabled: false,
      connectionIntent: "connect",
      credentials: { registered: true },
    });

    await harness.service.initialize();

    expect(harness.controller.startPairing).toHaveBeenCalledOnce();
  });

  it("keeps an explicit canonical disconnect across restart even if the legacy flag is stale", async () => {
    const harness = createHarness({
      enabled: true,
      connectionIntent: "disconnect",
      credentials: { registered: true },
    });

    await harness.service.initialize();

    expect(harness.controller.startPairing).not.toHaveBeenCalled();
  });

  it("starts pairing only after connect and keeps the QR ephemeral", async () => {
    const harness = createHarness();
    await harness.service.initialize();

    await harness.service.connect();
    harness.controller.emit({ type: "setup", phase: "qr", qr: "secret-qr", sequence: 1 });

    expect(harness.controller.startPairing).toHaveBeenCalledOnce();
    expect(harness.getSettings().whatsapp?.enabled).toBe(true);
    expect(harness.service.getStatus().qr).toBe("secret-qr");
    expect(JSON.stringify(harness.getSettings())).not.toContain("secret-qr");

    harness.controller.emit({
      type: "connected",
      identity: {
        id: "15551234567:42@s.whatsapp.net",
        phoneNumber: "+15551234567",
        displayName: "Marshal Test",
      },
    });

    expect(harness.service.getStatus()).toMatchObject({
      connection: "connected",
      account: {
        phoneNumber: "+15551234567",
        displayName: "Marshal Test",
      },
    });
    expect(harness.service.getStatus().qr).toBeUndefined();
    expect(JSON.stringify(harness.service.getStatus())).not.toContain("@s.whatsapp.net");
    expect(JSON.stringify(harness.getSettings())).not.toContain("@s.whatsapp.net");
  });

  it("persists disconnect and reset intent without persisting account state", async () => {
    const harness = createHarness();
    await harness.service.initialize();

    await harness.service.disconnect();
    expect(harness.getSettings().whatsapp?.enabled).toBe(false);
    expect(harness.getSettings().relay?.providers.whatsapp?.connectionIntent).toBe("disconnect");
    expect(harness.controller.stop).toHaveBeenCalledOnce();

    await harness.service.reset();
    expect(harness.getSettings().whatsapp?.enabled).toBe(true);
    expect(harness.getSettings().relay?.providers.whatsapp?.connectionIntent).toBe("connect");
    expect(harness.controller.resetAndPair).toHaveBeenCalledOnce();
  });

  it("preserves a pending next-restart account ID across live runtime actions", async () => {
    const harness = createHarness({
      configuredAccountId: "next-restart-account",
      connectionIntent: "disconnect",
    });
    await harness.service.initialize();

    await harness.service.connect();
    expect(harness.getSettings().relay?.providers.whatsapp).toMatchObject({
      accountId: "next-restart-account",
      connectionIntent: "connect",
    });

    await harness.service.disconnect();
    expect(harness.getSettings().relay?.providers.whatsapp).toMatchObject({
      accountId: "next-restart-account",
      connectionIntent: "disconnect",
    });

    await harness.service.reset();
    expect(harness.getSettings().relay?.providers.whatsapp).toMatchObject({
      accountId: "next-restart-account",
      connectionIntent: "connect",
    });
  });

  it("retries provisioning without clearing paired credentials", async () => {
    const harness = createHarness({ enabled: true, credentials: { registered: true } });
    await harness.service.initialize();

    await harness.service.retryProvisioning();

    expect(harness.controller.retryProvisioning).toHaveBeenCalledOnce();
    expect(harness.getSettings().whatsapp?.enabled).toBe(true);
  });

  it("forwards session access-point retirement without resetting credentials", async () => {
    const harness = createHarness({ enabled: true, credentials: { registered: true } });
    await harness.service.initialize();

    await expect(
      harness.service.retireSessionGroup({
        conversationId: "session@g.us",
        communityConversationId: "community@g.us",
      }),
    ).resolves.toMatchObject({ unlinked: true, left: true });
    expect(harness.controller.retireSessionGroup).toHaveBeenCalledOnce();
  });

  it("cancels pairing without resetting or disconnecting an established account", async () => {
    const harness = createHarness();
    await harness.service.initialize();
    harness.controller.emit({ type: "status", status: "awaiting-qr", attempt: 0 });

    await harness.service.cancelPairing();

    expect(harness.controller.stop).toHaveBeenCalledOnce();
    expect(harness.controller.resetAndPair).not.toHaveBeenCalled();
    expect(harness.getSettings().whatsapp?.enabled).toBe(false);

    harness.controller.emit({
      type: "connected",
      identity: { id: "15551234567@s.whatsapp.net" },
    });
    await harness.service.cancelPairing();
    expect(harness.controller.stop).toHaveBeenCalledOnce();
  });

  it("shuts down the sidecar before closing the encrypted store", async () => {
    const harness = createHarness();
    await harness.service.initialize();

    await harness.service.dispose();

    expect(harness.controller.shutdown).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledOnce();
  });
});
