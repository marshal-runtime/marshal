import { CLAUDE_BROWSER_SIGN_IN_LABEL } from "@common/runtime-config";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { act, installMockAPIs, render, screen, userEvent, waitFor } from "@/test-utils";

import { RuntimeAuthGate } from "./RuntimeAuthGate";
import { useRuntimeAuth } from "./useRuntimeAuth";

function TestRuntimeAuthGate({ runtimeId }: { runtimeId: string }) {
  const auth = useRuntimeAuth(runtimeId);
  return (
    <RuntimeAuthGate auth={auth}>
      <p>Runtime ready</p>
    </RuntimeAuthGate>
  );
}

describe("RuntimeAuthGate", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  it("renders the app immediately when Claude credentials are available", async () => {
    vi.mocked(window.runtimeAuthAPI!.getStatus).mockResolvedValue({
      success: true,
      status: { isAuthenticated: true, login: "api-key" },
    });

    render(<TestRuntimeAuthGate runtimeId="claude" />);

    expect(await screen.findByText("Runtime ready")).toBeInTheDocument();
    expect(screen.queryByText(/Copilot access/i)).not.toBeInTheDocument();
  });

  it("offers Claude browser sign-in and an API key entry when credentials are absent", async () => {
    vi.mocked(window.runtimeAuthAPI!.getStatus).mockResolvedValue({
      success: true,
      status: { isAuthenticated: false },
    });

    render(<TestRuntimeAuthGate runtimeId="claude" />);

    expect(
      await screen.findByRole("heading", { name: "Sign in to Claude Agent" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CLAUDE_BROWSER_SIGN_IN_LABEL })).toBeInTheDocument();
    expect(screen.getByLabelText("Claude Agent API key")).toBeInTheDocument();
    expect(window.runtimeAuthAPI!.login).not.toHaveBeenCalled();
  });

  it("lets an unauthenticated Claude user switch runtimes before app access", async () => {
    vi.mocked(window.runtimeAuthAPI!.getStatus).mockResolvedValue({
      success: true,
      status: { isAuthenticated: false },
    });
    const user = userEvent.setup();
    render(<TestRuntimeAuthGate runtimeId="claude" />);

    await user.click(await screen.findByRole("button", { name: "Change runtime" }));
    expect(screen.getByRole("heading", { name: "Change AI runtime" })).toBeInTheDocument();
    const saveRuntime = screen.getByRole("button", { name: "Switch now" });
    await waitFor(() => expect(saveRuntime).toBeEnabled());
    await user.click(saveRuntime);

    await waitFor(() => {
      expect(window.settingsAPI.switchRuntime).toHaveBeenCalledWith("copilot");
    });
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Change AI runtime" })).toBeNull(),
    );
  });

  it("renders generic Codex auth choices without a renderer adapter downcast", async () => {
    vi.mocked(window.runtimeAuthAPI!.getStatus).mockResolvedValue({
      success: true,
      status: { isAuthenticated: false },
    });

    render(<TestRuntimeAuthGate runtimeId="codex" />);

    expect(await screen.findByRole("button", { name: "Sign in with ChatGPT" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use device code" })).toBeInTheDocument();
    expect(screen.getByLabelText("Codex API key")).toHaveAttribute("type", "password");
    await waitFor(() => expect(screen.getByRole("button", { name: "Use API key" })).toBeDisabled());
  });

  it("clears a transient API key after sending the typed request", async () => {
    vi.mocked(window.runtimeAuthAPI!.getStatus).mockResolvedValue({
      success: true,
      status: { isAuthenticated: false },
    });
    const user = userEvent.setup();
    render(<TestRuntimeAuthGate runtimeId="codex" />);

    const input = await screen.findByLabelText("Codex API key");
    await user.type(input, "codex-test-key");
    await user.click(screen.getByRole("button", { name: "Use API key" }));

    expect(window.runtimeAuthAPI!.login).toHaveBeenCalledWith({
      type: "api-key",
      apiKey: "codex-test-key",
    });
    expect(await screen.findByText("Runtime ready")).toBeInTheDocument();
  });

  it("lets an unauthenticated Cursor user sign in or paste an API key", async () => {
    vi.mocked(window.runtimeAuthAPI!.getStatus).mockResolvedValue({
      success: true,
      status: { isAuthenticated: false },
    });
    const user = userEvent.setup();
    render(<TestRuntimeAuthGate runtimeId="cursor" />);

    expect(await screen.findByRole("button", { name: "Sign in with Cursor" })).toBeInTheDocument();
    expect(screen.getByLabelText("Cursor API key")).toHaveAttribute("type", "password");
    await user.type(screen.getByLabelText("Cursor API key"), "cursor-test-key");
    await user.click(screen.getByRole("button", { name: "Use existing API key" }));

    expect(window.runtimeAuthAPI!.login).toHaveBeenCalledWith({
      type: "api-key",
      apiKey: "cursor-test-key",
    });
    expect(await screen.findByText("Runtime ready")).toBeInTheDocument();
  });

  it("returns a failed pending login to the generic sign-in choices", async () => {
    let loginFailed: ((reason: string) => void) | null = null;
    vi.mocked(window.runtimeAuthAPI!.onLoginFailed).mockImplementation((callback) => {
      loginFailed = callback;
      return () => {};
    });
    vi.mocked(window.runtimeAuthAPI!.getStatus).mockResolvedValue({
      success: true,
      status: { isAuthenticated: false },
    });
    vi.mocked(window.runtimeAuthAPI!.login).mockResolvedValue({
      success: true,
      state: {
        status: "pending",
        method: "device-code",
        verificationUri: "https://example.test/device",
        userCode: "ABCD-EFGH",
      },
    });
    const user = userEvent.setup();
    render(<TestRuntimeAuthGate runtimeId="codex" />);

    await user.click(await screen.findByRole("button", { name: "Use device code" }));
    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();

    act(() => loginFailed?.("Device code expired"));

    expect(await screen.findByRole("button", { name: "Use device code" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Device code expired");
  });
});
