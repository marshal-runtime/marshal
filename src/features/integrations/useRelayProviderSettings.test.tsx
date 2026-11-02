import type { RelayProviderSettingsAPI } from "@common/marshal-ipc-contract";
import { parseRelayAccountId, parseRelayProviderId } from "@common/relay-contract";
import type { RelayProviderSetupEvent, RelaySetupSnapshot } from "@common/relay-provider-settings";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { act, installMockAPIs, renderHook, waitFor } from "@/test-utils";

import {
  addRelayProviderSetupEvent,
  findRelayProviderSetupEvent,
  RELAY_PROVIDER_SETUP_QUERY_KEY,
  type RelayProviderSetupEvents,
} from "./relayProviderQueryKeys";
import { useRelayProviderSettings } from "./useRelayProviderSettings";

describe("useRelayProviderSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
  });

  it("loads provider runtime snapshots", async () => {
    const { result } = renderHook(() => useRelayProviderSettings());

    await waitFor(() => {
      expect(result.current.providers.map((provider) => provider.providerKey)).toEqual([
        "whatsapp",
      ]);
    });
  });

  it("stores canonical setup snapshots and replaces them with action results", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    installMockAPIs({
      relayProviderSettingsAPI: {
        connect: vi.fn<RelayProviderSettingsAPI["connect"]>().mockResolvedValue({
          success: true,
          setup: {
            providerKey: "whatsapp",
            runtimeProviderId: "whatsapp-baileys",
            snapshot: {
              account: {
                providerId: parseRelayProviderId("whatsapp-baileys"),
                accountId: parseRelayAccountId("marshal-primary"),
              },
              state: "connected",
              updatedAt: "2026-08-07T09:00:00.000Z",
            },
          },
        }),
      },
    });
    const { result } = renderHook(() => useRelayProviderSettings(), { wrapper });
    const snapshot: RelaySetupSnapshot = {
      account: {
        providerId: parseRelayProviderId("whatsapp-baileys"),
        accountId: parseRelayAccountId("marshal-primary"),
      },
      state: "qr",
      updatedAt: "2026-08-07T00:00:00.000Z",
      qr: { payload: "qr-payload" },
    };
    const event: RelayProviderSetupEvent = {
      providerKey: "whatsapp",
      runtimeProviderId: "whatsapp-baileys",
      snapshot,
    };

    act(() => {
      queryClient.setQueryData<RelayProviderSetupEvents>(
        RELAY_PROVIDER_SETUP_QUERY_KEY,
        addRelayProviderSetupEvent({}, event),
      );
    });

    await waitFor(() => {
      expect(
        findRelayProviderSetupEvent(result.current.setupEvents, "whatsapp", "marshal-primary")
          ?.snapshot,
      ).toBe(snapshot);
    });

    await act(async () => {
      await result.current.runAction("connect", "whatsapp", "marshal-primary");
    });

    await waitFor(() => {
      expect(
        findRelayProviderSetupEvent(result.current.setupEvents, "whatsapp", "marshal-primary")
          ?.snapshot,
      ).toMatchObject({ state: "connected" });
    });
  });
});
