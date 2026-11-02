import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, userEvent, waitFor } from "@/test-utils";

import { SignInStartCard } from "./SignInStartCard";

describe("SignInStartCard", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  describe("Sanity Tests", () => {
    it("shows GitHub, ChatGPT, and Cursor sign-in on first launch", () => {
      render(<SignInStartCard onSignInGitHub={vi.fn<() => void>()} />);
      expect(screen.getByRole("button", { name: "Sign in to GitHub" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sign in with Cursor" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Use another runtime" })).toBeInTheDocument();
    });

    it("starts GitHub Copilot auth without switching runtimes", async () => {
      const onSignInGitHub = vi.fn<() => void>();
      const user = userEvent.setup();
      render(<SignInStartCard onSignInGitHub={onSignInGitHub} />);
      await user.click(screen.getByRole("button", { name: "Sign in to GitHub" }));
      expect(onSignInGitHub).toHaveBeenCalled();
      expect(window.settingsAPI.switchRuntime).not.toHaveBeenCalled();
    });

    it.each([
      { label: "Sign in with ChatGPT", runtimeId: "codex" },
      { label: "Sign in with Cursor", runtimeId: "cursor" },
    ])("switches to $runtimeId from $label", async ({ label, runtimeId }) => {
      const onSignInGitHub = vi.fn<() => void>();
      const user = userEvent.setup();
      render(<SignInStartCard onSignInGitHub={onSignInGitHub} />);
      await user.click(screen.getByRole("button", { name: label }));
      await waitFor(() => {
        expect(window.settingsAPI.switchRuntime).toHaveBeenCalledWith(runtimeId);
      });
      expect(onSignInGitHub).not.toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("shows a GitHub auth error when provided", () => {
      render(<SignInStartCard onSignInGitHub={vi.fn<() => void>()} error="boom" />);
      expect(screen.getByRole("alert")).toHaveTextContent("boom");
    });

    it("shows a runtime switch failure on the same card", async () => {
      vi.mocked(window.settingsAPI.switchRuntime).mockResolvedValue({
        success: false,
        error: "Codex adapter unavailable",
      });
      const user = userEvent.setup();
      render(<SignInStartCard onSignInGitHub={vi.fn<() => void>()} />);
      await user.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Codex adapter unavailable");
    });
  });

  describe("Edge Cases", () => {
    it("opens the runtime switch dialog for Claude and Gateway", async () => {
      const user = userEvent.setup();
      render(<SignInStartCard onSignInGitHub={vi.fn<() => void>()} />);
      await user.click(screen.getByRole("button", { name: "Use another runtime" }));
      expect(screen.getByRole("heading", { name: "Change AI runtime" })).toBeInTheDocument();
    });

    it("disables sign-in choices while a runtime switch is in flight", async () => {
      vi.mocked(window.settingsAPI.switchRuntime).mockImplementation(
        () => new Promise(() => undefined),
      );
      const user = userEvent.setup();
      render(<SignInStartCard onSignInGitHub={vi.fn<() => void>()} />);
      await user.click(screen.getByRole("button", { name: "Sign in with Cursor" }));
      expect(screen.getByRole("button", { name: "Sign in to GitHub" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Use another runtime" })).toBeDisabled();
    });
  });
});
