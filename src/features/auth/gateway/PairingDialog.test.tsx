import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";

import { PairingDialog } from "./PairingDialog";

describe("PairingDialog", () => {
  it("shows the headline, waiting indicator, and a small request-id footer for support copy", () => {
    render(<PairingDialog requestId="req-abc-123" onCancel={() => {}} />);
    expect(screen.getByText(/Pairing your device/i)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Waiting for approval/i);
    expect(screen.getByTestId("gateway-pairing-request-id")).toHaveTextContent("req-abc-123");
    // Approval is automatic now — the screen no longer surfaces a CLI command.
    expect(screen.queryByText(/marshal nodes approve/i)).not.toBeInTheDocument();
  });

  it("renders a 'Connecting…' placeholder when requestId is briefly null (status push race)", () => {
    render(<PairingDialog requestId={null} onCancel={() => {}} />);
    expect(screen.getByTestId("gateway-pairing-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("gateway-pairing-request-id")).toHaveTextContent(/Connecting/i);
  });

  it("Cancel button fires onCancel", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn<() => void>();
    render(<PairingDialog requestId="req-1" onCancel={onCancel} />);
    await user.click(screen.getByTestId("gateway-pairing-cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("disables Cancel when cancelPending is true", () => {
    render(<PairingDialog requestId="req-1" onCancel={() => {}} cancelPending />);
    expect(screen.getByTestId("gateway-pairing-cancel")).toBeDisabled();
  });

  it("shows the cancel error inline when the cancelPairing IPC fails", () => {
    render(
      <PairingDialog
        requestId="req-1"
        onCancel={() => {}}
        cancelError="gatewayAuthAPI unavailable"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/gatewayAuthAPI unavailable/);
  });

  it("copies the request id to the clipboard when the copy button is clicked", () => {
    // happy-dom exposes navigator.clipboard as a getter-only property, so plain
    // assignment fails. defineProperty replaces the descriptor outright.
    const writeText = vi.fn<(s: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<PairingDialog requestId="req-copy-1" onCancel={() => {}} />);
    // userEvent.click on this size="icon" Button under Radix Dialog +
    // happy-dom does not reliably reach the onClick handler; fireEvent.click
    // exercises the same React onClick wiring without going through
    // userEvent's pointer-event sequence.
    // oxlint-disable-next-line testing-library/prefer-user-event -- see comment
    fireEvent.click(screen.getByRole("button", { name: /copy request id/i }));
    expect(writeText).toHaveBeenCalledWith("req-copy-1");
  });

  it("places the request id inside the atomic role=status region so rotated ids are re-announced as a unit", () => {
    render(<PairingDialog requestId="req-live-1" onCancel={() => {}} />);
    const statusRegion = screen.getByRole("status");
    expect(statusRegion).toHaveAttribute("aria-live", "polite");
    expect(statusRegion).toHaveAttribute("aria-atomic", "true");
    expect(statusRegion).toHaveTextContent("req-live-1");
  });
});
