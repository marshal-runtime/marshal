// marshal-owned renderer test
import { beforeEach, describe, it, expect } from "vitest";

import { installMockAPIs, render, screen } from "@/test-utils";

import { AuthCardShell } from "./AuthCardShell";

describe("AuthCardShell", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  it("renders children inside the centered card chrome", () => {
    render(
      <AuthCardShell ariaLiveLabel="Sign in">
        <p>hello</p>
      </AuthCardShell>,
    );
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("exposes an aria-live region with the current stage label", () => {
    render(
      <AuthCardShell ariaLiveLabel="Checking authentication">
        <span />
      </AuthCardShell>,
    );
    const liveRegion = screen.getByRole("status");
    expect(liveRegion).toHaveAttribute("aria-live", "polite");
    expect(liveRegion).toHaveTextContent("Checking authentication");
  });

  it("renders a window-drag region in the title bar so the window is movable during auth", () => {
    render(
      <AuthCardShell ariaLiveLabel="Sign in">
        <span />
      </AuthCardShell>,
    );
    const header = screen.getByRole("banner");
    expect(
      (header.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion,
    ).toBe("drag");
  });

  it("does not show a powered-by tagline", () => {
    render(
      <AuthCardShell ariaLiveLabel="Sign in">
        <span />
      </AuthCardShell>,
    );
    expect(screen.queryByText(/Powered by/)).not.toBeInTheDocument();
  });

  it("shows the BETA badge when app mode is beta", () => {
    window.appModeAPI = { getLatest: () => "beta", onModeChanged: () => () => {} };
    render(
      <AuthCardShell ariaLiveLabel="Sign in">
        <span />
      </AuthCardShell>,
    );
    expect(screen.getByText("BETA")).toBeInTheDocument();
  });

  it("shows no badge in release mode", () => {
    render(
      <AuthCardShell ariaLiveLabel="Sign in">
        <span />
      </AuthCardShell>,
    );
    expect(screen.queryByText(/BETA|DEV/)).not.toBeInTheDocument();
  });
});
