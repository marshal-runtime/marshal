import { beforeEach, describe, it, expect, vi } from "vitest";

import { installMockAPIs, render, screen } from "@/test-utils";

import { AuthScreen } from "./AuthScreen";
import type { UseAuthFlowResult } from "./useAuthFlow";

function makeActions(): UseAuthFlowResult["actions"] {
  return {
    signInGitHub: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    signOutAll: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    reset: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

describe("AuthScreen", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  it("renders AuthCheckingCard for stage=checking", () => {
    render(<AuthScreen stage={{ kind: "checking" }} actions={makeActions()} />);
    expect(screen.getByText("Checking authentication...")).toBeInTheDocument();
  });

  it("renders SignInStartCard for stage=start", () => {
    render(<AuthScreen stage={{ kind: "start" }} actions={makeActions()} />);
    expect(screen.getByRole("button", { name: "Sign in to GitHub" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with Cursor" })).toBeInTheDocument();
  });

  it("renders GitHubDeviceCodeCard for stage=github-device-code", () => {
    render(
      <AuthScreen
        stage={{ kind: "github-device-code", code: "ABCD-1234", expired: false }}
        actions={makeActions()}
      />,
    );
    expect(screen.getByText("ABCD-1234")).toBeInTheDocument();
  });

  it("renders CopilotAccessRequiredCard for stage=copilot-access-error", () => {
    render(
      <AuthScreen
        stage={{ kind: "copilot-access-error", login: "baduser" }}
        actions={makeActions()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /GitHub Copilot Business or Enterprise required/i }),
    ).toBeInTheDocument();
  });

  it("renders nothing for stage=ready", () => {
    const { container } = render(<AuthScreen stage={{ kind: "ready" }} actions={makeActions()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
