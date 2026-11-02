import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render } from "@/test-utils";

import { AppNoticeRailView } from "./AppNoticeRail";
import { useEncryptionResetNotice } from "./encryptionNotice";

function EncryptionHarness() {
  return <AppNoticeRailView notices={[useEncryptionResetNotice()]} />;
}

beforeEach(() => {
  installMockAPIs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useEncryptionResetNotice", () => {
  it("keeps session dismissal and exposes the full explanation in details", async () => {
    installMockAPIs({
      encryptionAPI: { wasKeyReset: vi.fn<() => Promise<boolean>>().mockResolvedValue(true) },
    });
    const user = userEvent.setup();
    render(<EncryptionHarness />);

    expect(await screen.findByText("Local history was reset")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show notice details and actions" }));
    expect(
      screen.getByText("This happens after a machine reprovision or OS reinstall."),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Dismiss Local history was reset" }));
    expect(screen.queryByText("Local history was reset")).not.toBeInTheDocument();
  });
});
