import type { GatewayAuthIdentity } from "@common/marshal-ipc-contract";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { GatewayNodeWorkspace } from "./GatewayNodeWorkspace";

vi.mock("../GatewayNodeActivityList", () => ({
  GatewayNodeActivityList: () => <div data-testid="gateway-node-activity" />,
}));

describe("GatewayNodeWorkspace", () => {
  it.each([
    [{ mode: "hosted", roleMode: "node", nodeName: "  kitchen-node  " }, "kitchen-node"],
    [{ mode: "no-auth", roleMode: "node" }, "this device"],
  ] satisfies [GatewayAuthIdentity, string][])(
    "renders the trimmed or fallback node identity",
    (identity, expectedName) => {
      render(<GatewayNodeWorkspace identity={identity} onSignOut={vi.fn<() => void>()} />);

      expect(screen.getByRole("heading", { name: expectedName })).toBeInTheDocument();
    },
  );

  it("renders activity and invokes sign out", async () => {
    const onSignOut = vi.fn<() => void>();
    const user = userEvent.setup();
    render(
      <GatewayNodeWorkspace
        identity={{ mode: "hosted", roleMode: "node", nodeName: "node" }}
        onSignOut={onSignOut}
      />,
    );

    expect(screen.getByTestId("gateway-node-activity")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Gateway node workspace" })).toBeInTheDocument();
    expect(screen.getByText("Node activity")).toBeInTheDocument();
    expect(screen.getByText("Activity history")).toBeInTheDocument();
    expect(screen.queryByText(/paired surfaces can invoke/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/ready|online|live|available|connected|inbound request handling/i),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
