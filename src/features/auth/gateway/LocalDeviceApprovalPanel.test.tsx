import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs } from "@/test-utils";

import { LocalDeviceApprovalPanel } from "./LocalDeviceApprovalPanel";

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe("LocalDeviceApprovalPanel", () => {
  beforeEach(() => {
    installMockAPIs();
    vi.clearAllMocks();
  });

  it("renders nothing on a non-local gateway (success:false with not-supported sentinel)", async () => {
    // The renderer must NOT leak this surface into hosted deployments — the
    // test pins the no-render branch on the exact sentinel string the IPC
    // handler returns. Wording drift here would silently expose the panel.
    vi.mocked(window.gatewayAuthAPI!.listPendingDevices).mockResolvedValue({
      success: false,
      error: "not-supported-non-local",
    });
    const Wrapper = wrap();
    render(
      <Wrapper>
        <LocalDeviceApprovalPanel />
      </Wrapper>,
    );
    // Wait one microtask so the query resolves before we assert empty render.
    await waitFor(() => expect(window.gatewayAuthAPI!.listPendingDevices).toHaveBeenCalled());
    expect(screen.queryByTestId("local-device-approval-panel")).toBeNull();
  });

  it("renders nothing when local but no pending approvals", async () => {
    vi.mocked(window.gatewayAuthAPI!.listPendingDevices).mockResolvedValue({
      success: true,
      pending: [],
      paired: [],
    });
    const Wrapper = wrap();
    render(
      <Wrapper>
        <LocalDeviceApprovalPanel />
      </Wrapper>,
    );
    await waitFor(() => expect(window.gatewayAuthAPI!.listPendingDevices).toHaveBeenCalled());
    expect(screen.queryByTestId("local-device-approval-panel")).toBeNull();
  });

  it("lists pending requests and approves on click", async () => {
    vi.mocked(window.gatewayAuthAPI!.listPendingDevices).mockResolvedValue({
      success: true,
      pending: [
        {
          requestId: "req-001",
          deviceId: "dev-alpha",
          displayName: "Alpha Container",
          role: "operator.admin",
          scopes: ["cron.*", "sessions_spawn"],
          ts: 1_700_000_000,
        },
      ],
      paired: [],
    });
    vi.mocked(window.gatewayAuthAPI!.approveDevice).mockResolvedValue({ success: true });
    const Wrapper = wrap();
    render(
      <Wrapper>
        <LocalDeviceApprovalPanel />
      </Wrapper>,
    );

    const panel = await screen.findByTestId("local-device-approval-panel");
    expect(panel).toBeInTheDocument();
    expect(screen.getByText("Alpha Container")).toBeInTheDocument();
    expect(screen.getByText("req-001")).toBeInTheDocument();
    expect(screen.getByText(/cron\.\*/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByTestId("approve-device-req-001"));
    expect(window.gatewayAuthAPI!.approveDevice).toHaveBeenCalledWith("req-001");
  });

  it("falls back to deviceId when displayName is absent", async () => {
    // Pending requests from marshal before a device has set its displayName
    // arrive without one — show the deviceId so the user has something stable
    // to identify the row.
    vi.mocked(window.gatewayAuthAPI!.listPendingDevices).mockResolvedValue({
      success: true,
      pending: [
        {
          requestId: "req-002",
          deviceId: "dev-bare",
          ts: 1_700_000_000,
        },
      ],
      paired: [],
    });
    const Wrapper = wrap();
    render(
      <Wrapper>
        <LocalDeviceApprovalPanel />
      </Wrapper>,
    );
    expect(await screen.findByText("dev-bare")).toBeInTheDocument();
  });
});
