import { describe, expect, it, vi } from "vitest";

import type { WhatsAppStatus } from "../../common/marshal-ipc-contract";
import { parseRelayAccountId, parseRelayProviderId } from "../../common/relay-contract";
import type { RelayProviderCapabilities } from "../../common/relay-contract";
import { testDouble } from "../testing/harness";
import {
  createRelayProviderSettingsService,
  createRelayProviderSettingsServiceSkeleton,
  type RelayProviderSettingsBinding,
} from "./provider-settings-service";
import { RelayProviderRegistry } from "./registry";

const ACCOUNT = {
  providerId: parseRelayProviderId("whatsapp-baileys"),
  accountId: parseRelayAccountId("marshal-primary"),
};

describe("RelayProviderSettingsService skeleton", () => {
  it("exposes canonical setup, pairing, and connection ports", async () => {
    const service = createRelayProviderSettingsServiceSkeleton();
    const request = {
      ...ACCOUNT,
      idempotencyKey: "settings-test",
      requestedAt: "2026-08-07T09:00:00.000Z",
    };

    await expect(service.setupStatus.getStatus(ACCOUNT)).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });

    await expect(service.pairingControl.beginPairing(request)).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    await expect(service.connectionControl.connect(request)).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });

  describe("RelayProviderSettingsService WhatsApp adapter", () => {
    it("keeps cancel pairing separate from Reset & Relink", async () => {
      const status: WhatsAppStatus = {
        runtimeId: "whatsapp-baileys",
        initialized: true,
        connection: "awaiting-qr",
        settings: {
          enabled: true,
          defaultNotificationsEnabled: true,
          progressNotificationsEnabled: true,
        },
      };
      const cancelPairing = vi.fn<() => Promise<void>>(async () => undefined);
      const reset = vi.fn<() => Promise<void>>(async () => undefined);
      const service = createRelayProviderSettingsService({
        whatsapp: {
          getStatus: () => status,
          connect: vi.fn<() => Promise<void>>(async () => undefined),
          disconnect: vi.fn<() => Promise<void>>(async () => undefined),
          cancelPairing,
          reset,
          retryProvisioning: vi.fn<() => Promise<void>>(async () => undefined),
          subscribeStatus: () => () => undefined,
        },
        getWhatsAppAccountId: () => "marshal-primary",
      });
      const request = {
        ...ACCOUNT,
        idempotencyKey: "settings-test",
        requestedAt: "2026-08-07T13:00:00.000Z",
      };

      await service.pairingControl.cancelPairing(request);
      await service.resetAndRelink(request);

      expect(cancelPairing).toHaveBeenCalledOnce();
      expect(reset).toHaveBeenCalledOnce();
    });

    it("targets only the provider account currently registered in the live service", async () => {
      const liveAccount = {
        providerId: parseRelayProviderId("whatsapp-baileys"),
        accountId: parseRelayAccountId("primary"),
      };
      const connect = vi.fn<() => Promise<void>>(async () => undefined);
      const registry = new RelayProviderRegistry();
      registry.register(
        {
          providerId: liveAccount.providerId,
          capabilities: () =>
            testDouble<RelayProviderCapabilities>({
              inbound: true,
              quotedReplies: true,
              attachments: true,
              voice: true,
              managedGroups: true,
              communities: true,
              renameConversation: false,
              retireConversation: true,
              remotePermissionApproval: true,
            }),
          connect: async () => connect(),
          disconnect: async () => undefined,
          status: async () => ({
            state: "disconnected",
            updatedAt: "2026-08-08T12:00:00.000Z",
          }),
          publish: async () => {
            throw new Error("not used");
          },
          subscribe: () => () => undefined,
        },
        liveAccount.accountId,
      );
      const binding = testDouble<RelayProviderSettingsBinding>({
        providerKey: "whatsapp",
        account: liveAccount,
        setupStatus: {
          getStatus: async () => ({
            ok: true,
            value: {
              account: liveAccount,
              state: "disconnected",
              updatedAt: "2026-08-08T12:00:00.000Z",
            },
          }),
          subscribe: () => () => undefined,
        },
      });
      const service = createRelayProviderSettingsService({
        registry,
        getBindings: () => [binding],
      });

      await expect(
        service.connectionControl.connect({
          ...liveAccount,
          idempotencyKey: "connect-live",
          requestedAt: "2026-08-08T12:00:00.000Z",
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        service.connectionControl.connect({
          providerId: liveAccount.providerId,
          accountId: parseRelayAccountId("edited-until-restart"),
          idempotencyKey: "connect-edited",
          requestedAt: "2026-08-08T12:00:00.000Z",
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(connect).toHaveBeenCalledOnce();
    });
  });
});
