// marshal-owned renderer test
import { describe, it, expect, beforeEach, vi } from "vitest";

import { installMockAPIs, render, screen, userEvent } from "@/test-utils";

import { GitHubDeviceCodeCard } from "./GitHubDeviceCodeCard";

describe("GitHubDeviceCodeCard", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  it("displays the device code", () => {
    render(<GitHubDeviceCodeCard code="ABCD-1234" />);
    expect(screen.getByText("ABCD-1234")).toBeInTheDocument();
  });

  it("shows the Copied check-mark after the copy button is clicked", async () => {
    const user = userEvent.setup();
    render(<GitHubDeviceCodeCard code="ABCD-1234" />);

    const button = screen.getByRole("button", { name: /copy code/i });
    expect(button).toHaveAttribute("aria-label", "Copy code");
    await user.click(button);

    // After click the button re-renders with aria-label "Copied" and swaps to
    // the check icon. That's the user-visible contract; the clipboard write
    // itself is happy-dom-flaky to assert at this layer.
    await screen.findByRole("button", { name: /copied/i });
  });

  it("reopens the device-flow page when 'Open GitHub again' clicked", async () => {
    const user = userEvent.setup();
    render(<GitHubDeviceCodeCard code="ABCD-1234" />);
    await user.click(screen.getByRole("button", { name: /open github again/i }));
    expect(window.copilotAPI.openDeviceFlowPage).toHaveBeenCalledWith("ABCD-1234");
  });

  it("shows an expired message and retry button when expired=true", async () => {
    const onRetry = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<GitHubDeviceCodeCard code="ABCD-1234" expired onRetry={onRetry} />);

    expect(screen.getByRole("heading", { name: /code expired/i })).toBeInTheDocument();
    expect(screen.queryByText(/waiting for authorization/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
