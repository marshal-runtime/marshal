import { DEFAULT_SETTINGS } from "@common/marshal-default-settings";
import type { MSettings, RelayProviderSettingsAPI } from "@common/marshal-ipc-contract";
import { parseRelayAccountId, parseRelayProviderId } from "@common/relay-contract";
import type {
  RelayProviderRuntimeSnapshot,
  RelayProviderSetupEvent,
} from "@common/relay-provider-settings";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, userEvent, waitFor, within } from "@/test-utils";

import {
  addRelayProviderSetupEvent,
  RELAY_PROVIDER_SETUP_QUERY_KEY,
  type RelayProviderSetupEvents,
} from "./relayProviderQueryKeys";
import { setRelayProviderAccountId, setRelayProviderEnabled } from "./relayProviderSettingsModel";
import { RelayProviderSettingsSection } from "./RelayProviderSettingsSection";

const WHATSAPP_RUNTIME: RelayProviderRuntimeSnapshot = {
  providerKey: "whatsapp",
  runtimeProviderId: "whatsapp-baileys",
  available: true,
  accountId: "primary",
  connection: { state: "disconnected" },
  capabilities: {
    inbound: true,
    quotedReplies: true,
    attachments: true,
    voice: true,
    managedGroups: true,
    communities: true,
    renameConversation: true,
    retireConversation: true,
    remotePermissionApproval: false,
  },
};

function setupEvent(
  accountId: string,
  state: RelayProviderSetupEvent["snapshot"]["state"],
): RelayProviderSetupEvent {
  return {
    providerKey: "whatsapp",
    runtimeProviderId: "whatsapp-baileys",
    snapshot: {
      account: {
        providerId: parseRelayProviderId("whatsapp-baileys"),
        accountId: parseRelayAccountId(accountId),
      },
      state,
      updatedAt: "2026-08-07T09:00:00.000Z",
    },
  };
}

describe("RelayProviderSettingsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
  });

  it("lists each registered relay provider once", async () => {
    render(
      <RelayProviderSettingsSection
        settings={DEFAULT_SETTINGS}
        persist={vi.fn<(settings: MSettings) => void>()}
      />,
    );

    expect(await screen.findByText("WhatsApp")).toBeInTheDocument();
    expect(screen.getAllByTestId(/^relay-provider-/)).toHaveLength(1);
  });

  it("enables a provider without touching the other relay destinations", async () => {
    const persist = vi.fn<(settings: MSettings) => void>();
    const user = userEvent.setup();
    render(
      <RelayProviderSettingsSection
        settings={setRelayProviderEnabled(DEFAULT_SETTINGS, "whatsapp", false)}
        persist={persist}
      />,
    );

    await user.click(await screen.findByLabelText("WhatsApp enabled"));

    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        relay: expect.objectContaining({
          providers: expect.objectContaining({
            whatsapp: expect.objectContaining({ enabled: true }),
          }),
        }),
      }),
    );
  });

  it("selects notification and progress destinations per provider", async () => {
    const settings = setRelayProviderEnabled(DEFAULT_SETTINGS, "whatsapp", true);
    const persist = vi.fn<(settings: MSettings) => void>();
    const user = userEvent.setup();
    render(<RelayProviderSettingsSection settings={settings} persist={persist} />);
    const whatsapp = await screen.findByTestId("relay-provider-whatsapp");

    await user.click(within(whatsapp).getByLabelText("Default notifications"));
    await user.click(within(whatsapp).getByLabelText("Progress updates"));

    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        relay: expect.objectContaining({
          defaultNotificationDestinations: ["whatsapp"],
        }),
      }),
    );
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        relay: expect.objectContaining({
          progressDestinations: [],
        }),
      }),
    );
  });

  it("persists the bounded relay progress cadence", async () => {
    const persist = vi.fn<(settings: MSettings) => void>();
    const user = userEvent.setup();
    render(<RelayProviderSettingsSection settings={DEFAULT_SETTINGS} persist={persist} />);

    const interval = await screen.findByLabelText("Relay progress interval");
    await user.clear(interval);
    await user.type(interval, "30");
    await user.tab();

    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        relay: expect.objectContaining({ progressIntervalMinutes: 30 }),
      }),
    );
  });

  it("keeps using the loaded WhatsApp account until an edited ID is applied by restart", async () => {
    const settings = setRelayProviderAccountId(
      setRelayProviderEnabled(DEFAULT_SETTINGS, "whatsapp", true),
      "whatsapp",
      "marshal-primary",
    );
    const connect = vi.fn<RelayProviderSettingsAPI["connect"]>().mockResolvedValue({
      success: true,
      setup: setupEvent("primary", "connected"),
    });
    installMockAPIs({
      relayProviderSettingsAPI: {
        list: vi.fn<RelayProviderSettingsAPI["list"]>().mockResolvedValue({
          success: true,
          providers: [WHATSAPP_RUNTIME],
        }),
        connect,
      },
    });
    const user = userEvent.setup();
    render(
      <RelayProviderSettingsSection
        settings={settings}
        persist={vi.fn<(settings: MSettings) => void>()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Connect WhatsApp" }));

    expect(
      within(await screen.findByTestId("relay-provider-whatsapp")).getByText(
        /Account ID changes take effect after restart/,
      ),
    ).toBeInTheDocument();
    expect(connect).toHaveBeenCalledWith({
      providerKey: "whatsapp",
      runtimeProviderId: "whatsapp-baileys",
      accountId: "primary",
    });
  });

  it("retries managed-group provisioning without resetting the paired account", async () => {
    const settings = setRelayProviderAccountId(
      setRelayProviderEnabled(DEFAULT_SETTINGS, "whatsapp", true),
      "whatsapp",
      "marshal-primary",
    );
    const provision = vi.fn<RelayProviderSettingsAPI["provision"]>().mockResolvedValue({
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
          updatedAt: "2026-08-07T13:00:00.000Z",
        },
      },
    });
    installMockAPIs({
      relayProviderSettingsAPI: {
        list: vi.fn<RelayProviderSettingsAPI["list"]>().mockResolvedValue({
          success: true,
          providers: [
            {
              ...WHATSAPP_RUNTIME,
              accountId: "marshal-primary",
              connection: { state: "connected" },
            },
          ],
        }),
        provision,
      },
    });
    const user = userEvent.setup();
    render(
      <RelayProviderSettingsSection
        settings={settings}
        persist={vi.fn<(settings: MSettings) => void>()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Retry provisioning" }));

    expect(provision).toHaveBeenCalledWith({
      providerKey: "whatsapp",
      runtimeProviderId: "whatsapp-baileys",
      accountId: "marshal-primary",
    });
    expect(window.relayProviderSettingsAPI?.reset).not.toHaveBeenCalled();
  });

  it("keeps Reset & Relink separate from canonical pairing cancellation", async () => {
    const settings = setRelayProviderAccountId(
      setRelayProviderEnabled(DEFAULT_SETTINGS, "whatsapp", true),
      "whatsapp",
      "marshal-primary",
    );
    const relink = vi.fn<RelayProviderSettingsAPI["relink"]>().mockResolvedValue({
      success: true,
      setup: {
        providerKey: "whatsapp",
        runtimeProviderId: "whatsapp-baileys",
        snapshot: {
          account: {
            providerId: parseRelayProviderId("whatsapp-baileys"),
            accountId: parseRelayAccountId("marshal-primary"),
          },
          state: "pairing",
          updatedAt: "2026-08-07T13:00:00.000Z",
        },
      },
    });
    installMockAPIs({
      relayProviderSettingsAPI: {
        list: vi.fn<RelayProviderSettingsAPI["list"]>().mockResolvedValue({
          success: true,
          providers: [
            {
              ...WHATSAPP_RUNTIME,
              accountId: "marshal-primary",
              connection: { state: "connected" },
            },
          ],
        }),
        relink,
      },
    });
    const user = userEvent.setup();
    render(
      <RelayProviderSettingsSection
        settings={settings}
        persist={vi.fn<(settings: MSettings) => void>()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Reset & Relink" }));

    expect(relink).toHaveBeenCalledWith({
      providerKey: "whatsapp",
      runtimeProviderId: "whatsapp-baileys",
      accountId: "marshal-primary",
    });
    expect(window.relayProviderSettingsAPI?.reset).not.toHaveBeenCalled();
  });

  it("renders ephemeral setup QR detail from the canonical event", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<RelayProviderSetupEvents>(
      RELAY_PROVIDER_SETUP_QUERY_KEY,
      addRelayProviderSetupEvent(
        {},
        {
          providerKey: "whatsapp",
          runtimeProviderId: "whatsapp-baileys",
          snapshot: {
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
          },
        },
      ),
    );
    render(
      <RelayProviderSettingsSection
        settings={DEFAULT_SETTINGS}
        persist={vi.fn<(settings: MSettings) => void>()}
      />,
      { queryClient },
    );

    expect(await screen.findByText("Setup: qr")).toBeInTheDocument();
    expect(screen.getByText("ephemeral-qr-payload")).toBeInTheDocument();
    expect(screen.getByText("Pairing reference: pairing:1")).toBeInTheDocument();
  });

  it("shows setup state only for the configured account", async () => {
    const queryClient = new QueryClient();
    const eventFor = (accountId: string, payload: string) => ({
      providerKey: "whatsapp" as const,
      runtimeProviderId: "whatsapp-baileys" as const,
      snapshot: {
        account: {
          providerId: parseRelayProviderId("whatsapp-baileys"),
          accountId: parseRelayAccountId(accountId),
        },
        state: "qr" as const,
        updatedAt: "2026-08-07T00:00:00.000Z",
        qr: { payload },
      },
    });
    queryClient.setQueryData<RelayProviderSetupEvents>(
      RELAY_PROVIDER_SETUP_QUERY_KEY,
      addRelayProviderSetupEvent(
        addRelayProviderSetupEvent({}, eventFor("account-a", "qr-for-account-a")),
        eventFor("account-b", "qr-for-account-b"),
      ),
    );
    const settings = setRelayProviderAccountId(
      setRelayProviderEnabled(DEFAULT_SETTINGS, "whatsapp", true),
      "whatsapp",
      "account-b",
    );

    render(
      <RelayProviderSettingsSection
        settings={settings}
        persist={vi.fn<(updated: MSettings) => void>()}
      />,
      { queryClient },
    );

    expect(await screen.findByText("qr-for-account-b")).toBeInTheDocument();
    expect(screen.queryByText("qr-for-account-a")).not.toBeInTheDocument();
  });

  it("disables provider actions when the relay runtime is unavailable", async () => {
    render(
      <RelayProviderSettingsSection
        settings={DEFAULT_SETTINGS}
        persist={vi.fn<(settings: MSettings) => void>()}
      />,
    );

    expect(await screen.findByRole("button", { name: "Connect WhatsApp" })).toBeDisabled();
  });

  it("locks account edits during an active connection and targets the runtime account", async () => {
    const settings = setRelayProviderAccountId(
      setRelayProviderEnabled(DEFAULT_SETTINGS, "whatsapp", true),
      "whatsapp",
      "configured-account",
    );
    const connectedRuntime: RelayProviderRuntimeSnapshot = {
      ...WHATSAPP_RUNTIME,
      accountId: "active-account",
      connection: { state: "connected" },
    };
    const disconnect = vi.fn<RelayProviderSettingsAPI["disconnect"]>().mockResolvedValue({
      success: true,
      setup: setupEvent("active-account", "disconnected"),
    });
    installMockAPIs({
      relayProviderSettingsAPI: {
        list: vi.fn<RelayProviderSettingsAPI["list"]>().mockResolvedValue({
          success: true,
          providers: [connectedRuntime],
        }),
        disconnect,
      },
    });
    const user = userEvent.setup();
    render(
      <RelayProviderSettingsSection
        settings={settings}
        persist={vi.fn<(settings: MSettings) => void>()}
      />,
    );
    const whatsapp = await screen.findByTestId("relay-provider-whatsapp");
    const disconnectButton = await within(whatsapp).findByRole("button", {
      name: "Disconnect WhatsApp",
    });

    expect(within(whatsapp).getByLabelText("WhatsApp account ID")).toBeDisabled();
    await user.click(disconnectButton);

    expect(disconnect).toHaveBeenCalledWith({
      providerKey: "whatsapp",
      runtimeProviderId: "whatsapp-baileys",
      accountId: "active-account",
    });
  });

  it("uses the loaded account when reconnecting before an account edit is applied by restart", async () => {
    const settings = setRelayProviderAccountId(
      setRelayProviderEnabled(DEFAULT_SETTINGS, "whatsapp", true),
      "whatsapp",
      "configured-account",
    );
    const disconnectedRuntime: RelayProviderRuntimeSnapshot = {
      ...WHATSAPP_RUNTIME,
      accountId: "previous-account",
      connection: { state: "disconnected" },
    };
    const connect = vi.fn<RelayProviderSettingsAPI["connect"]>().mockResolvedValue({
      success: true,
      setup: setupEvent("previous-account", "connected"),
    });
    installMockAPIs({
      relayProviderSettingsAPI: {
        list: vi.fn<RelayProviderSettingsAPI["list"]>().mockResolvedValue({
          success: true,
          providers: [disconnectedRuntime],
        }),
        connect,
      },
    });
    const user = userEvent.setup();
    render(
      <RelayProviderSettingsSection
        settings={settings}
        persist={vi.fn<(settings: MSettings) => void>()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Connect WhatsApp" }));

    expect(connect).toHaveBeenCalledWith({
      providerKey: "whatsapp",
      runtimeProviderId: "whatsapp-baileys",
      accountId: "previous-account",
    });
  });

  it("locks provider enablement while the relay is reconnecting", async () => {
    installMockAPIs({
      relayProviderSettingsAPI: {
        list: vi.fn<RelayProviderSettingsAPI["list"]>().mockResolvedValue({
          success: true,
          providers: [
            {
              ...WHATSAPP_RUNTIME,
              accountId: "active-account",
              connection: { state: "reconnecting" },
            },
          ],
        }),
      },
    });
    render(
      <RelayProviderSettingsSection
        settings={DEFAULT_SETTINGS}
        persist={vi.fn<(settings: MSettings) => void>()}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("WhatsApp enabled")).toBeDisabled());
  });

  it("keeps an active provider visible and retries disconnect before persisting disablement", async () => {
    const settings = setRelayProviderEnabled(DEFAULT_SETTINGS, "whatsapp", true);
    const connectedRuntime: RelayProviderRuntimeSnapshot = {
      ...WHATSAPP_RUNTIME,
      accountId: "active-account",
      connection: { state: "connected" },
    };
    const disconnect = vi
      .fn<RelayProviderSettingsAPI["disconnect"]>()
      .mockResolvedValue({ success: false, error: "Disconnect failed" });
    const persist = vi.fn<(settings: MSettings) => void>();
    installMockAPIs({
      relayProviderSettingsAPI: {
        list: vi.fn<RelayProviderSettingsAPI["list"]>().mockResolvedValue({
          success: true,
          providers: [connectedRuntime],
        }),
        disconnect,
      },
    });
    const user = userEvent.setup();
    render(<RelayProviderSettingsSection settings={settings} persist={persist} />);
    const whatsapp = await screen.findByTestId("relay-provider-whatsapp");

    await user.click(within(whatsapp).getByLabelText("WhatsApp enabled"));

    expect(disconnect).toHaveBeenCalledWith({
      providerKey: "whatsapp",
      runtimeProviderId: "whatsapp-baileys",
      accountId: "active-account",
    });
    expect(persist).not.toHaveBeenCalled();
    expect(await within(whatsapp).findByText("Connected")).toBeInTheDocument();
  });

  it("disables duplicate disconnect and reset actions while disconnecting", async () => {
    const disconnectingRuntime: RelayProviderRuntimeSnapshot = {
      ...WHATSAPP_RUNTIME,
      accountId: "active-account",
      connection: { state: "disconnecting" },
    };
    installMockAPIs({
      relayProviderSettingsAPI: {
        list: vi.fn<RelayProviderSettingsAPI["list"]>().mockResolvedValue({
          success: true,
          providers: [disconnectingRuntime],
        }),
      },
    });
    render(
      <RelayProviderSettingsSection
        settings={setRelayProviderEnabled(DEFAULT_SETTINGS, "whatsapp", true)}
        persist={vi.fn<(settings: MSettings) => void>()}
      />,
    );
    const whatsapp = await screen.findByTestId("relay-provider-whatsapp");
    const disconnectButton = await within(whatsapp).findByRole("button", {
      name: "Disconnect WhatsApp",
    });

    expect(disconnectButton).toBeDisabled();
    expect(within(whatsapp).getByRole("button", { name: "Reset & Relink" })).toBeDisabled();
  });
});
