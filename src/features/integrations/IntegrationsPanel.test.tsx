import type { RelayProviderSettingsAPI } from "@common/marshal-ipc-contract";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs, render, screen, waitFor, userEvent } from "@/test-utils";

import { IntegrationsPanel } from "./IntegrationsPanel";
import type { BotStatus } from "./RelayProviderSettingsSection";

const CONNECTED_WHATSAPP = {
  providerKey: "whatsapp",
  runtimeProviderId: "whatsapp-baileys",
  available: true,
  accountId: "primary",
  connection: { state: "connected" },
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
} as const;

describe("IntegrationsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
  });

  it("returns null when isOpen is false", () => {
    const { container } = render(<IntegrationsPanel isOpen={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the relay provider section when the runtime is unavailable", async () => {
    render(<IntegrationsPanel isOpen={true} />);

    expect(await screen.findByTestId("integrations-panel")).toBeInTheDocument();
    expect(screen.getByText("WhatsApp")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Unavailable")).toBeInTheDocument();
    });
  });

  it("reports the primary provider status to the host", async () => {
    installMockAPIs({
      relayProviderSettingsAPI: {
        list: vi
          .fn<RelayProviderSettingsAPI["list"]>()
          .mockResolvedValue({ success: true, providers: [CONNECTED_WHATSAPP] }),
      },
    });
    const onStatusChange = vi.fn<(status: BotStatus) => void>();

    render(<IntegrationsPanel isOpen={true} onStatusChange={onStatusChange} />);

    await waitFor(() => {
      expect(onStatusChange).toHaveBeenCalledWith("connected");
    });
  });

  it("navigates to Settings when the power management link is clicked", async () => {
    installMockAPIs({
      relayProviderSettingsAPI: {
        list: vi
          .fn<RelayProviderSettingsAPI["list"]>()
          .mockResolvedValue({ success: true, providers: [CONNECTED_WHATSAPP] }),
      },
    });
    const user = userEvent.setup();
    const onOpenSettings = vi.fn<() => void>();

    render(<IntegrationsPanel isOpen={true} onOpenSettings={onOpenSettings} />);
    await user.click(await screen.findByText(/Settings → Power Management/));

    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("keeps provider settings available without remote configuration", async () => {
    render(<IntegrationsPanel isOpen={true} />);

    expect(await screen.findByTestId("integrations-panel")).toBeInTheDocument();
    expect(screen.getByText("WhatsApp")).toBeInTheDocument();
  });
});

describe("IntegrationsPanel dismiss button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
  });

  it("renders Close button when onClose is provided", async () => {
    render(<IntegrationsPanel isOpen={true} onClose={vi.fn<() => void>()} />);
    expect(await screen.findByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("calls onClose when Close button is clicked", async () => {
    const onClose = vi.fn<() => void>();
    const user = userEvent.setup();
    render(<IntegrationsPanel isOpen={true} onClose={onClose} />);
    await user.click(await screen.findByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
