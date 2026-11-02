import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../../common/marshal-default-settings";
import type { MSettings } from "../../common/marshal-ipc-contract";
import { normalizeProviderSelectionSettings } from "../../common/provider-config";
import { parseRelayAccountId, parseRelayProviderId } from "../../common/relay-contract";
import type { RelayAccountScope, RelaySetupState } from "../../common/relay-experience-contract";
import type {
  RelayProviderRuntimeSnapshot,
  RelayProviderSetupEvent,
  RelaySetupSnapshot,
} from "../../common/relay-provider-settings";
import type { RelayProviderSettingsService } from "../relay/provider-settings-service";
import { registerRelayProviderSettingsHandlers } from "./relay-provider-settings-ipc";

const CAPABILITIES = {
  inbound: true,
  quotedReplies: true,
  attachments: false,
  voice: false,
  managedGroups: false,
  communities: false,
  renameConversation: false,
  retireConversation: false,
  remotePermissionApproval: false,
} as const;

function runtimeSnapshot(providerKey: "whatsapp"): RelayProviderRuntimeSnapshot {
  return {
    providerKey,
    runtimeProviderId: "whatsapp-baileys",
    available: true,
    accountId: "primary",
    connection: { state: "disconnected" },
    capabilities: CAPABILITIES,
  };
}

function setup() {
  type CapturedHandler = (...args: unknown[]) => Promise<unknown>;
  const handlers = new Map<string, CapturedHandler>();
  const ipcHandle = vi.fn<(channel: string, handler: CapturedHandler) => void>(
    (channel, handler) => {
      handlers.set(channel, handler);
    },
  );
  let settings: MSettings = structuredClone(DEFAULT_SETTINGS);
  const settingsManager = {
    get: vi.fn<() => MSettings>(() => settings),
    update: vi.fn<(partial: Partial<MSettings>) => void>((partial) => {
      settings = normalizeProviderSelectionSettings({ ...settings, ...partial });
    }),
  };
  let changedListener: ((snapshot: RelayProviderRuntimeSnapshot) => void) | undefined;
  let setupListener: ((snapshot: RelaySetupSnapshot) => void) | undefined;
  const service: RelayProviderSettingsService = {
    list: vi.fn<RelayProviderSettingsService["list"]>(async () => [runtimeSnapshot("whatsapp")]),
    setupStatus: {
      getStatus: vi.fn<RelayProviderSettingsService["setupStatus"]["getStatus"]>(
        async (account) => ({ ok: true, value: setupSnapshot(account) }),
      ),
      subscribe: vi.fn<RelayProviderSettingsService["setupStatus"]["subscribe"]>(() =>
        vi.fn<() => void>(),
      ),
    },
    pairingControl: {
      beginPairing: vi.fn<RelayProviderSettingsService["pairingControl"]["beginPairing"]>(
        async (request) => ({ ok: true, value: setupSnapshot(request, "pairing") }),
      ),
      cancelPairing: vi.fn<RelayProviderSettingsService["pairingControl"]["cancelPairing"]>(
        async (request) => ({ ok: true, value: setupSnapshot(request) }),
      ),
    },
    connectionControl: {
      connect: vi.fn<RelayProviderSettingsService["connectionControl"]["connect"]>(
        async (request) => ({ ok: true, value: setupSnapshot(request, "connected") }),
      ),
      disconnect: vi.fn<RelayProviderSettingsService["connectionControl"]["disconnect"]>(
        async (request) => ({ ok: true, value: setupSnapshot(request) }),
      ),
    },
    resetAndRelink: vi.fn<RelayProviderSettingsService["resetAndRelink"]>(async (request) => ({
      ok: true,
      value: setupSnapshot(request, "pairing"),
    })),
    provision: vi.fn<RelayProviderSettingsService["provision"]>(async (request) => ({
      ok: true,
      value: setupSnapshot(request, "connected"),
    })),
    subscribeChanged: vi.fn<RelayProviderSettingsService["subscribeChanged"]>((listener) => {
      changedListener = listener;
      return vi.fn<() => void>();
    }),
    subscribeSetup: vi.fn<RelayProviderSettingsService["subscribeSetup"]>((listener) => {
      setupListener = listener;
      return vi.fn<() => void>();
    }),
  };
  const broadcast =
    vi.fn<
      (
        channel: "relay-provider-settings:changed" | "relay-provider-settings:setup-changed",
        payload: RelayProviderRuntimeSnapshot | RelayProviderSetupEvent,
      ) => void
    >();

  registerRelayProviderSettingsHandlers({
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test captures typed IPC handlers in a generic map
    ipcHandle: ipcHandle as Parameters<
      typeof registerRelayProviderSettingsHandlers
    >[0]["ipcHandle"],
    settingsManager,
    service,
    broadcast,
  });

  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`Missing handler ${channel}`);
    return handler({}, ...args);
  };

  return {
    invoke,
    service,
    settingsManager,
    getSettings: () => settings,
    changedListener: () => changedListener,
    setupListener: () => setupListener,
    broadcast,
  };
}

function setupSnapshot(
  account: RelayAccountScope,
  state: RelaySetupState = "disconnected",
): RelaySetupSnapshot {
  return {
    account,
    state,
    updatedAt: "2026-08-07T09:00:00.000Z",
  };
}

function configureWhatsAppAccount(harness: ReturnType<typeof setup>, accountId: string): void {
  const settings = harness.getSettings();
  const relay = settings.relay!;
  harness.settingsManager.update({
    relay: {
      ...relay,
      providers: {
        ...relay.providers,
        whatsapp: {
          enabled: true,
          accountId,
          connectionIntent: relay.providers.whatsapp?.connectionIntent ?? "disconnect",
        },
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("relay provider settings IPC", () => {
  it("lists provider runtime snapshots through the injected service", async () => {
    const harness = setup();

    await expect(harness.invoke("relay-provider-settings:list")).resolves.toMatchObject({
      success: true,
      providers: [{ providerKey: "whatsapp", runtimeProviderId: "whatsapp-baileys" }],
    });
  });

  it("maps canonical runtime IDs to compatibility keys before persisting connect intent", async () => {
    const harness = setup();

    await expect(
      harness.invoke("relay-provider-settings:connect", {
        runtimeProviderId: "whatsapp-baileys",
        accountId: "marshal-primary",
      }),
    ).resolves.toMatchObject({ success: true });

    expect(harness.service.connectionControl.connect).toHaveBeenCalledWith({
      providerId: "whatsapp-baileys",
      accountId: "primary",
      idempotencyKey: expect.any(String),
      requestedAt: expect.any(String),
    });
    expect(harness.getSettings().relay?.providers.whatsapp).toEqual({
      enabled: true,
      accountId: "primary",
      connectionIntent: "connect",
    });
    expect(harness.getSettings().relay?.providers["whatsapp-baileys"]).toBeUndefined();
  });

  it("uses the registered runtime account when the UI omits one", async () => {
    const harness = setup();

    await expect(
      harness.invoke("relay-provider-settings:connect", {
        providerKey: "whatsapp",
      }),
    ).resolves.toMatchObject({ success: true });

    expect(harness.service.connectionControl.connect).toHaveBeenCalledWith({
      providerId: "whatsapp-baileys",
      accountId: "primary",
      idempotencyKey: expect.any(String),
      requestedAt: expect.any(String),
    });
  });

  it("persists reset as disconnect intent without clearing the app-owned account ID", async () => {
    const harness = setup();
    configureWhatsAppAccount(harness, "marshal-primary");

    await harness.invoke("relay-provider-settings:reset", {
      providerKey: "whatsapp",
      runtimeProviderId: "whatsapp-baileys",
      accountId: "marshal-primary",
    });

    expect(harness.service.pairingControl.cancelPairing).toHaveBeenCalledWith({
      providerId: "whatsapp-baileys",
      accountId: "primary",
      idempotencyKey: expect.any(String),
      requestedAt: expect.any(String),
    });
    expect(harness.getSettings().relay?.providers.whatsapp).toMatchObject({
      accountId: "marshal-primary",
      connectionIntent: "disconnect",
    });
  });

  it("retries provisioning without changing connection intent or account ID", async () => {
    const harness = setup();
    await harness.invoke("relay-provider-settings:connect", {
      providerKey: "whatsapp",
      accountId: "marshal-primary",
    });
    const before = harness.getSettings().relay?.providers.whatsapp;

    await expect(
      harness.invoke("relay-provider-settings:provision", {
        providerKey: "whatsapp",
        accountId: "marshal-primary",
      }),
    ).resolves.toMatchObject({ success: true });

    expect(harness.service.provision).toHaveBeenCalledOnce();
    expect(harness.getSettings().relay?.providers.whatsapp).toEqual(before);
  });

  it("uses explicit Reset & Relink without routing through cancelPairing", async () => {
    const harness = setup();
    configureWhatsAppAccount(harness, "marshal-primary");

    await expect(
      harness.invoke("relay-provider-settings:relink", {
        providerKey: "whatsapp",
        accountId: "marshal-primary",
      }),
    ).resolves.toMatchObject({ success: true });

    expect(harness.service.resetAndRelink).toHaveBeenCalledOnce();
    expect(harness.service.pairingControl.cancelPairing).not.toHaveBeenCalled();
    expect(harness.getSettings().relay?.providers.whatsapp).toMatchObject({
      accountId: "marshal-primary",
      connectionIntent: "connect",
    });
  });

  it("does not replace the configured account when disconnecting an active runtime account", async () => {
    const harness = setup();
    configureWhatsAppAccount(harness, "configured-account");

    await harness.invoke("relay-provider-settings:connect", {
      providerKey: "whatsapp",
      accountId: "active-runtime-account",
    });
    expect(harness.service.connectionControl.connect).toHaveBeenCalledWith({
      providerId: "whatsapp-baileys",
      accountId: "primary",
      idempotencyKey: expect.any(String),
      requestedAt: expect.any(String),
    });
    expect(harness.getSettings().relay?.providers.whatsapp).toMatchObject({
      accountId: "configured-account",
      connectionIntent: "connect",
    });

    await harness.invoke("relay-provider-settings:disconnect", {
      providerKey: "whatsapp",
      accountId: "active-runtime-account",
    });

    expect(harness.service.connectionControl.disconnect).toHaveBeenCalledWith({
      providerId: "whatsapp-baileys",
      accountId: "primary",
      idempotencyKey: expect.any(String),
      requestedAt: expect.any(String),
    });
    expect(harness.getSettings().relay?.providers.whatsapp).toMatchObject({
      accountId: "configured-account",
      connectionIntent: "disconnect",
    });
  });

  it("broadcasts the canonical setup snapshot verbatim without persisting QR data", () => {
    const harness = setup();
    const snapshot: RelaySetupSnapshot = {
      account: {
        providerId: parseRelayProviderId("whatsapp-baileys"),
        accountId: parseRelayAccountId("marshal-primary"),
      },
      state: "qr",
      updatedAt: "2026-08-07T00:00:00.000Z",
      pairingAttemptId: "pairing:1",
      qr: {
        payload: "ephemeral-qr-payload",
      },
    };
    const event: RelayProviderSetupEvent = {
      providerKey: "whatsapp",
      runtimeProviderId: "whatsapp-baileys",
      snapshot,
    };

    harness.setupListener()?.(snapshot);

    expect(harness.broadcast).toHaveBeenCalledWith("relay-provider-settings:setup-changed", event);
    const payload = harness.broadcast.mock.calls[0]?.[1];
    expect(payload).toStrictEqual(event);
    expect(payload && "snapshot" in payload ? payload.snapshot : undefined).toBe(snapshot);
    expect(JSON.stringify(harness.getSettings())).not.toContain("ephemeral-qr-payload");
  });

  it("rejects references that name no supported provider", async () => {
    const harness = setup();

    await expect(
      harness.invoke("relay-provider-settings:connect", {
        providerKey: "unsupported-chat",
        runtimeProviderId: "unsupported-chat",
      }),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("supported relay provider key"),
    });
    expect(harness.service.connectionControl.connect).not.toHaveBeenCalled();
  });
});
