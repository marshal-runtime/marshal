import type { UserIdentity } from "@common/marshal-ipc-contract";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  createAvailableRelayProviderSettingsAPI,
  installMockAPIs,
  render,
  screen,
  waitFor,
} from "@/test-utils";

import { PersonContextMenu } from "./PersonContextMenu";

function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    isAuthenticated: true,
    displayName: "Jane Smith",
    subtitle: "janesmith",
    accountName: null,
    avatarUrl: null,
    statusColor: "warning",
    statusText: "Integrations not connected",
    integrations: [
      { id: "mail", name: "Mail", connected: false },
      { id: "chat", name: "Chat", connected: false },
    ],
    signOut: {
      title: "Sign out?",
      description: "Signing out will also sign out of the GitHub Copilot CLI.",
      confirmLabel: "Sign out",
    },
    ...overrides,
  };
}

function installIdentity(next: UserIdentity) {
  installMockAPIs({
    relayProviderSettingsAPI: createAvailableRelayProviderSettingsAPI(),
    identityAPI: {
      get: vi
        .fn<() => Promise<{ success: true; identity: UserIdentity }>>()
        .mockResolvedValue({ success: true, identity: next }),
    },
  });
}

describe("PersonContextMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
  });

  it("renders the trigger button with aria-label", () => {
    render(<PersonContextMenu />);
    expect(screen.getByRole("button", { name: "User menu" })).toBeInTheDocument();
  });

  it("shows displayName from the composed identity", async () => {
    installIdentity(identity({ displayName: "Jane Smith" }));
    render(<PersonContextMenu />);
    expect(await screen.findByText("Jane Smith")).toBeInTheDocument();
  });

  it("shows subtitle under the name in the popup header", async () => {
    installIdentity(identity({ displayName: "Jane Smith", subtitle: "janesmith_github" }));
    const user = userEvent.setup();
    render(<PersonContextMenu />);
    await user.click(screen.getByRole("button", { name: "User menu" }));
    expect(await screen.findByText("janesmith_github")).toBeInTheDocument();
  });

  it("shows avatar image when identity supplies a url", async () => {
    installIdentity(identity({ avatarUrl: "https://example.com/avatar.png" }));
    render(<PersonContextMenu />);
    const img = await screen.findByTestId("user-avatar");
    expect(img).toHaveAttribute("src", "https://example.com/avatar.png");
  });

  it("falls back to the 👤 placeholder when identity has no avatar", () => {
    render(<PersonContextMenu />);
    expect(screen.getByText("👤")).toBeInTheDocument();
  });

  it("shows identity.statusText beside the dot", async () => {
    installIdentity(identity({ statusText: "Connected", statusColor: "success" }));
    render(<PersonContextMenu />);
    expect(await screen.findByText("Connected")).toBeInTheDocument();
  });

  it("renders integrations from identity.integrations", async () => {
    installIdentity(
      identity({
        integrations: [
          { id: "mail", name: "Mail", connected: true },
          { id: "chat", name: "Chat", connected: false },
        ],
      }),
    );
    const user = userEvent.setup();
    render(<PersonContextMenu />);
    await user.click(screen.getByRole("button", { name: "User menu" }));

    expect(await screen.findByText("Integrations")).toBeInTheDocument();
    expect(screen.getByText("Mail")).toBeInTheDocument();
    expect(screen.getByText("Chat")).toBeInTheDocument();
    // Mail connected, Chat disconnected.
    expect(screen.getAllByText("Connected").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Disconnected").length).toBeGreaterThan(0);
  });

  it("hides the Integrations section when identity.integrations is empty (gateway mode)", async () => {
    installIdentity(identity({ integrations: [] }));
    const user = userEvent.setup();
    render(<PersonContextMenu />);
    await user.click(screen.getByRole("button", { name: "User menu" }));
    await screen.findByText("Sign out");
    expect(screen.queryByText("Integrations")).not.toBeInTheDocument();
    expect(screen.queryByText("Mail")).not.toBeInTheDocument();
    expect(screen.queryByText("Chat")).not.toBeInTheDocument();
  });

  it("uses identity.signOut copy in the confirm dialog", async () => {
    installIdentity(
      identity({
        signOut: {
          title: "Disconnect from Lobster?",
          description: "Disconnecting will sign you out of the Lobster gateway.",
          confirmLabel: "Disconnect",
        },
      }),
    );
    const user = userEvent.setup();
    render(<PersonContextMenu />);
    await user.click(screen.getByRole("button", { name: "User menu" }));
    await user.click(screen.getByText("Sign out"));
    expect(await screen.findByText("Disconnect from Lobster?")).toBeInTheDocument();
    expect(
      screen.getByText(/Disconnecting will sign you out of the Lobster gateway/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
  });

  it("cancel in sign-out dialog closes dialog without signing out", async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn<() => void>();
    render(<PersonContextMenu onSignOut={onSignOut} />);
    await user.click(screen.getByRole("button", { name: "User menu" }));
    await user.click(screen.getByText("Sign out"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Sign out?")).not.toBeInTheDocument());
    expect(onSignOut).not.toHaveBeenCalled();
  });

  it("confirm in sign-out dialog calls onSignOut", async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn<() => void>();
    render(<PersonContextMenu onSignOut={onSignOut} />);
    await user.click(screen.getByRole("button", { name: "User menu" }));
    await user.click(screen.getByText("Sign out"));
    const confirmBtn = await screen.findByRole("button", { name: "Sign out" });
    await user.click(confirmBtn);
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("closes popup on Escape key", async () => {
    const user = userEvent.setup();
    render(<PersonContextMenu />);
    await user.click(screen.getByRole("button", { name: "User menu" }));
    expect(screen.getByText("Sign out")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByText("Sign out")).not.toBeInTheDocument();
    });
  });

  describe("status dot color", () => {
    it("'connected=false' prop overrides the identity's color with danger", () => {
      installIdentity(identity({ statusColor: "success" }));
      render(<PersonContextMenu connected={false} />);
      expect(screen.getByTestId("status-dot")).toHaveClass("bg-[var(--color-danger)]");
    });

    it("'connected=null' (connecting) renders the muted dot", () => {
      installIdentity(identity({ statusColor: "success" }));
      render(<PersonContextMenu connected={null} />);
      expect(screen.getByTestId("status-dot")).toHaveClass("bg-muted-foreground");
    });

    it("honors the identity's warning color when connected=true", async () => {
      installIdentity(identity({ statusColor: "warning" }));
      render(<PersonContextMenu connected={true} />);
      await waitFor(() =>
        expect(screen.getByTestId("status-dot")).toHaveClass("bg-[var(--color-warning-primary)]"),
      );
    });

    it("honors the identity's success color when connected=true", async () => {
      installIdentity(identity({ statusColor: "success" }));
      render(<PersonContextMenu connected={true} />);
      await waitFor(() =>
        expect(screen.getByTestId("status-dot")).toHaveClass("bg-[var(--color-success)]"),
      );
    });
  });
});
