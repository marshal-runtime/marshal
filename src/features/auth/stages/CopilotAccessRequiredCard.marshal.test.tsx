// marshal-owned renderer test
import { describe, it, expect, vi } from "vitest";

import { render, screen, userEvent } from "@/test-utils";

import { CopilotAccessRequiredCard } from "./CopilotAccessRequiredCard";

describe("CopilotAccessRequiredCard", () => {
  it("displays the error message and sign-out button", async () => {
    const onSignOut = vi.fn<() => void>();
    const user = userEvent.setup();
    render(<CopilotAccessRequiredCard login="baduser" onSignOut={onSignOut} />);
    expect(
      screen.getByRole("heading", { name: /GitHub Copilot Business or Enterprise required/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/does not have a GitHub Copilot Business or Enterprise license/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/switch to your organizational GitHub account or request GitHub Copilot/),
    ).toBeInTheDocument();
    // The account name is rendered as its own bold element.
    expect(screen.getByText("baduser").tagName).toBe("STRONG");

    await user.click(screen.getByRole("button", { name: /^Sign out$/i }));
    expect(onSignOut).toHaveBeenCalled();
  });

  it("renders a generic message without a bold account when login is undefined", () => {
    render(<CopilotAccessRequiredCard login={undefined} onSignOut={vi.fn<() => void>()} />);
    expect(
      screen.getByText(
        /^Your GitHub account does not have a GitHub Copilot Business or Enterprise license\.$/,
      ),
    ).toBeInTheDocument();
    expect(document.querySelector("strong")).toBeNull();
  });
});
