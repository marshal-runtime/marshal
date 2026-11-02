// marshal-owned renderer test
import type { GatewayAuthIdentity } from "@common/marshal-ipc-contract";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, it, expect, vi } from "vitest";

import { HostedOptionsForm } from "./HostedOptionsForm";

describe("HostedOptionsForm", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the node-name input on initial mount", () => {
    render(<HostedOptionsForm onSubmit={() => {}} />);
    expect(screen.getByTestId("hosted-options-node-name")).toBeInTheDocument();
    expect(screen.getByTestId("hosted-options-submit")).toBeInTheDocument();
  });

  it("submits with mode=aad and roleMode='operator-and-node' by default", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(cred: GatewayAuthIdentity) => void>();
    render(<HostedOptionsForm onSubmit={onSubmit} />);
    await user.click(screen.getByTestId("hosted-options-submit"));
    expect(onSubmit).toHaveBeenCalledWith({ mode: "hosted", roleMode: "operator-and-node" });
  });

  it("includes a user-typed (trimmed) nodeName on submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(cred: GatewayAuthIdentity) => void>();
    render(<HostedOptionsForm onSubmit={onSubmit} />);
    const input = screen.getByTestId("hosted-options-node-name");
    await user.type(input, "  Harry's MacBook  ");
    await user.click(screen.getByTestId("hosted-options-submit"));
    expect(onSubmit).toHaveBeenCalledWith({
      mode: "hosted",
      roleMode: "operator-and-node",
      nodeName: "Harry's MacBook",
    });
  });

  it("omits nodeName when the user leaves the input at the pre-filled defaultNodeName (host fallback)", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(cred: GatewayAuthIdentity) => void>();
    render(<HostedOptionsForm onSubmit={onSubmit} defaultNodeName="harry-mbp" />);
    await user.click(screen.getByTestId("hosted-options-submit"));
    expect(onSubmit).toHaveBeenCalledWith({ mode: "hosted", roleMode: "operator-and-node" });
    expect(onSubmit).not.toHaveBeenCalledWith(expect.objectContaining({ nodeName: "harry-mbp" }));
  });

  it("disables the submit and node-name input when disabled is set (mid-sign-in)", () => {
    render(<HostedOptionsForm onSubmit={() => {}} disabled />);
    expect(screen.getByTestId("hosted-options-submit")).toBeDisabled();
    expect(screen.getByTestId("hosted-options-node-name")).toBeDisabled();
  });
});
