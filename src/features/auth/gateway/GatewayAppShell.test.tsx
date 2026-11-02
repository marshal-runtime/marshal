import type { GatewayAuthIdentity } from "@common/marshal-ipc-contract";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GatewayAppShell } from "./GatewayAppShell";

const gatewayAuth = vi.hoisted(() =>
  vi.fn<
    () => {
      identity: GatewayAuthIdentity | undefined;
      signOut: () => Promise<void>;
    }
  >(),
);

vi.mock("./useGatewayDeviceAuth", () => ({
  useGatewayAuth: gatewayAuth,
}));

vi.mock("./GatewayReconnectingBanner", () => ({
  GatewayReconnectingBanner: () => <div data-testid="reconnecting-banner" />,
}));

vi.mock("@/features/gateway-node/shell/GatewayNodeWorkspace", () => ({
  GatewayNodeWorkspace: () => <main data-testid="node-only-shell" />,
}));

vi.mock("@/features/gateway-node/wireGatewayNodeActivity", () => ({
  wireGatewayNodeActivity: vi.fn<() => () => void>(() => () => {}),
}));

describe("GatewayAppShell", () => {
  beforeEach(() => {
    gatewayAuth.mockReset();
  });

  it("does not add a main landmark around operator content", () => {
    gatewayAuth.mockReturnValue({
      identity: { mode: "no-auth" },
      signOut: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });

    render(
      <GatewayAppShell>
        <main data-testid="operator-content" />
      </GatewayAppShell>,
    );

    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByTestId("gateway-app-content")).toHaveClass("min-h-0", "flex-1");
  });

  it("preserves the node shell as the only main landmark and its flex sizing", () => {
    gatewayAuth.mockReturnValue({
      identity: { mode: "hosted", roleMode: "node", nodeName: "test-node" },
      signOut: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });

    render(
      <GatewayAppShell>
        <main data-testid="operator-content" />
      </GatewayAppShell>,
    );

    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByTestId("gateway-app-content")).toHaveClass("flex-1");
    expect(screen.getByTestId("gateway-app-content")).not.toHaveClass("min-h-0");
  });
});
