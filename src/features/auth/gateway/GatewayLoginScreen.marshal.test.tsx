// marshal-owned renderer test
import type { GatewayAuthIdentity } from "@common/marshal-ipc-contract";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, it, expect, vi } from "vitest";

import { render, screen } from "@/test-utils";

import { GatewayLoginScreen } from "./GatewayLoginScreen";

describe("GatewayLoginScreen", () => {
  beforeEach(() => {
    // HostedOptionsForm persists last node-name to localStorage on submit.
    // Clear between tests so order doesn't matter.
    window.localStorage.clear();
  });

  it("renders the AAD landing card with title, AAD form, and terms footer", () => {
    render(<GatewayLoginScreen onSignIn={() => {}} />);
    expect(screen.getByRole("heading", { name: /^sign in$/i })).toBeInTheDocument();
    expect(screen.getByText(/connect to the lobster runtime/i)).toBeInTheDocument();
    expect(screen.getByTestId("hosted-options-submit")).toBeInTheDocument();
    expect(screen.getByTestId("hosted-options-node-name")).toBeInTheDocument();
    expect(screen.getByText(/terms of service/i)).toBeInTheDocument();
  });

  it("Continue calls onSignIn with mode=aad and roleMode=operator-and-node", async () => {
    const user = userEvent.setup();
    const onSignIn = vi.fn<(cred: GatewayAuthIdentity) => void>();
    render(<GatewayLoginScreen onSignIn={onSignIn} />);
    await user.click(screen.getByTestId("hosted-options-submit"));
    expect(onSignIn).toHaveBeenCalledWith({ mode: "hosted", roleMode: "operator-and-node" });
  });

  it("passes a custom nodeName through on submit", async () => {
    const user = userEvent.setup();
    const onSignIn = vi.fn<(cred: GatewayAuthIdentity) => void>();
    render(<GatewayLoginScreen onSignIn={onSignIn} defaultNodeName="default-host" />);
    const nameInput = screen.getByTestId("hosted-options-node-name");
    await user.clear(nameInput);
    await user.type(nameInput, "harrys-laptop");
    await user.click(screen.getByTestId("hosted-options-submit"));
    expect(onSignIn).toHaveBeenCalledWith({
      mode: "hosted",
      roleMode: "operator-and-node",
      nodeName: "harrys-laptop",
    });
  });

  it("renders inline error and 'Try again' calls onRetry", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn<() => void>();
    render(<GatewayLoginScreen onSignIn={() => {}} error="ECONNREFUSED" onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/ECONNREFUSED/);
    await user.click(screen.getByTestId("gateway-login-retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("busy disables Continue and shows the Connecting label", () => {
    render(<GatewayLoginScreen onSignIn={() => {}} busy />);
    const continueBtn = screen.getByTestId("hosted-options-submit");
    expect(continueBtn).toBeDisabled();
    expect(continueBtn).toHaveTextContent(/connecting/i);
  });

  it("dev gate (default): renders the no-auth debug link and clicking it signs in as no-auth", async () => {
    const user = userEvent.setup();
    const onSignIn = vi.fn<(cred: GatewayAuthIdentity) => void>();
    render(<GatewayLoginScreen onSignIn={onSignIn} />);
    await user.click(screen.getByTestId("gateway-login-no-auth"));
    expect(onSignIn).toHaveBeenCalledWith({ mode: "no-auth" });
  });

  it("__hideDevGate hides the no-auth debug link", () => {
    render(<GatewayLoginScreen onSignIn={() => {}} __hideDevGate />);
    expect(screen.queryByTestId("gateway-login-no-auth")).not.toBeInTheDocument();
  });

  it("remounts HostedOptionsForm so defaultNodeName prop changes pick up after first render", () => {
    // Regression pin for the key={defaultNodeName} remount on GatewayLoginScreen.
    // Without it, HostedOptionsForm's lazy useState initializer captures the
    // initial prop once and ignores later prop changes (e.g. an async-resolved
    // hostname). The input's placeholder is bound to the current
    // defaultNodeName, so we use it as a proxy for "form re-initialized".
    const { rerender } = render(<GatewayLoginScreen onSignIn={() => {}} />);
    expect(screen.getByTestId("hosted-options-node-name")).toHaveAttribute(
      "placeholder",
      "e.g. Harry's MacBook",
    );
    rerender(<GatewayLoginScreen onSignIn={() => {}} defaultNodeName="harry-mbp" />);
    expect(screen.getByTestId("hosted-options-node-name")).toHaveAttribute(
      "placeholder",
      "harry-mbp",
    );
  });
});
