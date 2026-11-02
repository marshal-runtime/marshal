import type { PermissionAction } from "@common/marshal-constants";
import { describe, expect, it, vi } from "vitest";

import { render, screen, userEvent, within } from "@/test-utils";
import type { PermissionCardData } from "@/types/electron";

import { PermissionDecisionTray } from "./PermissionDecisionTray";

function request(id: string, overrides: Partial<PermissionCardData> = {}): PermissionCardData {
  return {
    id,
    kind: "shell",
    title: "Run a command",
    message: "Marshal needs to run the test suite",
    detail: "pnpm test",
    buttons: ["Allow", "Allow for session", "Always allow", "Deny"],
    category: "writes",
    ...overrides,
  };
}

describe("PermissionDecisionTray", () => {
  it("renders pending requests in a stable, labelled decision region", () => {
    render(
      <PermissionDecisionTray
        requests={[request("one"), request("two", { kind: "write", title: "Update a file" })]}
        onRespond={() => {}}
      />,
    );

    const tray = screen.getByRole("region", { name: "Action needed" });
    expect(tray).toHaveAttribute("data-testid", "permission-decision-tray");
    expect(within(tray).getByText("2 actions are waiting for your decisions")).toBeInTheDocument();
    const cards = within(tray).getAllByTestId("permission-card");
    expect(cards).toHaveLength(2);
    expect(screen.getByTestId("permission-decision-list")).toHaveClass("divide-y");
    for (const card of cards) {
      expect(card).toHaveAttribute("data-surface", "tray");
      expect(card).not.toHaveClass("border", "shadow-xs");
    }
  });

  it("offers allow-once, not-now, and explicit scope actions", async () => {
    const user = userEvent.setup();
    const onRespond =
      vi.fn<(requestId: string, action: PermissionAction, overridePattern?: string) => void>();
    render(<PermissionDecisionTray requests={[request("one")]} onRespond={onRespond} />);

    await user.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onRespond).toHaveBeenCalledWith("one", "allow");

    await user.click(screen.getByRole("button", { name: "Choose access scope" }));
    await user.click(screen.getByRole("menuitem", { name: /This session/ }));
    expect(onRespond).toHaveBeenCalledWith("one", "allow-session", undefined);

    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(onRespond).toHaveBeenCalledWith("one", "deny");
  });

  it("keeps technical details collapsed and keyboard reachable", async () => {
    const user = userEvent.setup();
    render(<PermissionDecisionTray requests={[request("one")]} onRespond={() => {}} />);

    expect(screen.queryByText("pnpm test")).not.toBeInTheDocument();

    await user.tab();
    expect(screen.getByRole("button", { name: "Review technical details" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    expect(screen.getByText("Command")).toBeInTheDocument();
  });

  it("reflects asynchronous risk and broader-scope enrichment", async () => {
    const user = userEvent.setup();
    const initialRequest = request("one", {
      category: "unknown",
      primaryPattern: "npm install --save-dev *",
      suggestedPattern: undefined,
    });
    const { rerender } = render(
      <PermissionDecisionTray requests={[initialRequest]} onRespond={() => {}} />,
    );

    expect(screen.queryByText("Writes files")).not.toBeInTheDocument();

    rerender(
      <PermissionDecisionTray
        requests={[
          {
            ...initialRequest,
            category: "writes",
            suggestedPattern: "npm install *",
          },
        ]}
        onRespond={() => {}}
      />,
    );

    expect(screen.getByText("Writes files")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Choose access scope" }));
    expect(screen.getByTestId("allow-broader-pattern")).toHaveTextContent(
      "Similar actions in all chats",
    );
  });
});
