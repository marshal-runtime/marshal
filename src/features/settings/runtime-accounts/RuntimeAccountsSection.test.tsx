import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, userEvent, waitFor, within } from "@/test-utils";
import type { RuntimeAccountsAPI, RuntimeAccountsView } from "@/types/electron";

import { RuntimeAccountsSection } from "./RuntimeAccountsSection";

const CLAUDE: RuntimeAccountsView = {
  runtimeId: "claude",
  displayName: "Claude Agent",
  authMethods: [{ type: "browser", label: "Sign in with Claude" }],
  accounts: [
    { id: "default", label: "Primary", isOriginal: true, isDefault: true, targetKey: "claude" },
    { id: "work", label: "Work", isOriginal: false, isDefault: false, targetKey: "claude@work" },
  ],
};

const CODEX: RuntimeAccountsView = {
  runtimeId: "codex",
  displayName: "Codex",
  authMethods: [
    { type: "browser", label: "Sign in with ChatGPT" },
    { type: "device-code", label: "Use device code" },
    { type: "api-key", label: "Use API key" },
  ],
  accounts: [
    { id: "default", label: "Primary", isOriginal: true, isDefault: true, targetKey: "codex" },
  ],
};

let api: RuntimeAccountsAPI;

beforeEach(() => {
  installMockAPIs({
    runtimeAccountsAPI: {
      list: vi.fn<RuntimeAccountsAPI["list"]>().mockResolvedValue({
        success: true,
        runtimes: [CLAUDE, CODEX],
      }),
      getStatus: vi
        .fn<RuntimeAccountsAPI["getStatus"]>()
        .mockImplementation(async (_runtimeId, accountId) => ({
          success: true,
          status: { isAuthenticated: accountId === "default", login: "oauth" },
        })),
    },
  });
  api = window.runtimeAccountsAPI!;
});

describe("RuntimeAccountsSection", () => {
  it("lists each runtime's accounts with sign-in state and model prefix", async () => {
    render(<RuntimeAccountsSection isOpen />);

    const claude = await screen.findByTestId("runtime-accounts-claude");
    const original = within(claude).getByTestId("runtime-account-claude");
    const work = within(claude).getByTestId("runtime-account-claude@work");
    await waitFor(() => expect(within(original).getByText(/Signed in \(oauth\)/)).toBeVisible());
    expect(within(original).getByText("Default", { selector: "[data-slot=badge]" })).toBeVisible();
    await waitFor(() => expect(within(work).getByText(/Not signed in/)).toBeVisible());
    expect(within(work).getByText("claude@work:<model>")).toBeVisible();
    expect(within(work).getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  it("adds an account by name", async () => {
    vi.mocked(api.add).mockResolvedValue({
      success: true,
      account: {
        id: "side-project",
        label: "Side project",
        isOriginal: false,
        isDefault: false,
        targetKey: "claude@side-project",
      },
    });
    render(<RuntimeAccountsSection isOpen />);
    const claude = await screen.findByTestId("runtime-accounts-claude");

    await userEvent.click(within(claude).getByRole("button", { name: "Add account" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Account name" }), "Side project");
    await userEvent.click(screen.getByRole("button", { name: "Add account" }));

    await waitFor(() => expect(api.add).toHaveBeenCalledWith("claude", "Side project"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("signs an account in with the browser and closes when done", async () => {
    render(<RuntimeAccountsSection isOpen />);
    const work = await screen.findByTestId("runtime-account-claude@work");

    await userEvent.click(await within(work).findByRole("button", { name: "Sign in" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign in with Claude" }));

    await waitFor(() =>
      expect(api.login).toHaveBeenCalledWith("claude", "work", { type: "browser" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows the device code while a sign-in is pending", async () => {
    vi.mocked(api.login).mockResolvedValue({
      success: true,
      state: {
        status: "pending",
        method: "device-code",
        verificationUri: "https://example.test/device",
        userCode: "ABCD-EFGH",
      },
    });
    render(<RuntimeAccountsSection isOpen />);
    const codex = await screen.findByTestId("runtime-accounts-codex");
    await userEvent.click(within(codex).getByRole("button", { name: "Primary account actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByText("Sign Primary out of Codex?")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    vi.mocked(api.getStatus).mockResolvedValue({
      success: true,
      status: { isAuthenticated: false },
    });
    await userEvent.click(within(codex).getByRole("button", { name: "Primary account actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Check status" }));
    await userEvent.click(await within(codex).findByRole("button", { name: "Sign in" }));
    await userEvent.click(await screen.findByRole("button", { name: "Use device code" }));

    expect(await screen.findByText("ABCD-EFGH")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open sign-in page" })).toBeVisible();
  });

  it("makes an account the default", async () => {
    render(<RuntimeAccountsSection isOpen />);
    const work = await screen.findByTestId("runtime-account-claude@work");

    await userEvent.click(within(work).getByRole("button", { name: "Work account actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Make default" }));

    await waitFor(() => expect(api.setDefault).toHaveBeenCalledWith("claude", "work"));
  });
});

describe("RuntimeAccountsSection usage", () => {
  const hoursFromNow = (hours: number) => Date.now() + hours * 3_600_000;

  it("shows the plan badge with 5-hour, weekly, and model-scoped bars for a signed-in account", async () => {
    vi.mocked(api.getUsage).mockResolvedValue({
      success: true,
      usage: {
        available: true,
        plan: "max",
        fetchedAt: Date.now(),
        windows: [
          {
            kind: "weekly_opus",
            usedPercent: 91,
            resetsAt: hoursFromNow(48),
            source: "fetch",
            fetchedAt: 1,
          },
          {
            kind: "five_hour",
            usedPercent: 9,
            resetsAt: hoursFromNow(2.5),
            source: "fetch",
            fetchedAt: 1,
          },
          { kind: "weekly", usedPercent: 22, source: "fetch", fetchedAt: 1 },
        ],
      },
    });
    render(<RuntimeAccountsSection isOpen />);
    const original = await screen.findByTestId("runtime-account-claude");

    const usage = await within(original).findByTestId("account-usage");
    expect(within(usage).getByText("max plan")).toBeVisible();
    const fiveHour = within(usage).getByTestId("usage-window-five_hour");
    expect(within(fiveHour).getByText("5-hour")).toBeVisible();
    expect(within(fiveHour).getByText("9%")).toBeVisible();
    expect(within(fiveHour).getByText(/^resets in 2h/)).toBeVisible();
    expect(within(usage).getByTestId("usage-window-weekly")).toHaveTextContent("Weekly22%");
    expect(within(usage).getByTestId("usage-window-weekly_opus")).toHaveTextContent("91%");
    expect(api.getUsage).toHaveBeenCalledWith("claude", "default");
  });

  it("asks to sign in again when the login can no longer fetch usage", async () => {
    vi.mocked(api.getUsage).mockImplementation(async () => ({
      success: true,
      usage: {
        available: false,
        reason: "auth_expired",
        message: "Sign in again to restore plan usage",
        fetchedAt: 1,
      },
    }));
    render(<RuntimeAccountsSection isOpen />);
    const original = await screen.findByTestId("runtime-account-claude");

    expect(await within(original).findByRole("button", { name: "Sign in again" })).toBeVisible();
    expect(within(original).getByText(/Sign-in expired/)).toBeVisible();
  });

  it("shows a quiet unavailable state when the usage read fails, and skips signed-out accounts", async () => {
    vi.mocked(api.getUsage).mockResolvedValue({ success: false, error: "boom" });
    render(<RuntimeAccountsSection isOpen />);
    const original = await screen.findByTestId("runtime-account-claude");
    const work = screen.getByTestId("runtime-account-claude@work");

    expect(await within(original).findByText("Usage unavailable")).toBeVisible();
    expect(within(work).queryByText("Usage unavailable")).toBeNull();
    expect(api.getUsage).not.toHaveBeenCalledWith("claude", "work");
  });
});
