import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs } from "@/test-utils";

import { GatewayAuthGate } from "./GatewayDeviceAuthGate";

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe("GatewayAuthGate", () => {
  beforeEach(() => {
    installMockAPIs();
    vi.clearAllMocks();
  });

  it("renders login screen when status is picking", async () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    vi.mocked(window.gatewayAuthAPI!.getState).mockResolvedValue({
      success: true,
      state: { status: "picking" },
    });
    const Wrapper = wrap();
    render(
      <Wrapper>
        <GatewayAuthGate>
          <div data-testid="app-body">APP</div>
        </GatewayAuthGate>
      </Wrapper>,
    );
    expect(await screen.findByText(/Sign in to Lobster/i)).toBeInTheDocument();
    expect(screen.queryByTestId("app-body")).not.toBeInTheDocument();
  });

  it("renders children when status is signed-in", async () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    vi.mocked(window.gatewayAuthAPI!.getState).mockResolvedValue({
      success: true,
      state: {
        status: "signed-in",
        identity: { mode: "no-auth" },
      },
    });
    const Wrapper = wrap();
    render(
      <Wrapper>
        <GatewayAuthGate>
          <div data-testid="app-body">APP</div>
        </GatewayAuthGate>
      </Wrapper>,
    );
    expect(await screen.findByTestId("app-body")).toBeInTheDocument();
  });

  it("renders login screen with error when status is error", async () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    vi.mocked(window.gatewayAuthAPI!.getState).mockResolvedValue({
      success: true,
      state: {
        status: "error",
        identity: { mode: "no-auth" },
        error: "ECONNREFUSED",
      },
    });
    const Wrapper = wrap();
    render(
      <Wrapper>
        <GatewayAuthGate>
          <div data-testid="app-body">APP</div>
        </GatewayAuthGate>
      </Wrapper>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/ECONNREFUSED/);
  });
});
