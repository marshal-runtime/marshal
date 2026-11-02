// marshal-owned renderer test
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs, userEvent } from "@/test-utils";
import type { AutomationData } from "@/types/electron";

import { GithubImportView } from "./GithubImportView";

function stubAutomation(
  overrides: Partial<AutomationData> & { id: string; name: string },
): AutomationData {
  return {
    steps: [],
    schedule: { naturalLanguage: "", days: [], hour: 0, minute: 0 },
    enabled: true,
    createdAt: "",
    updatedAt: "",
    triggerType: "schedule",
    ...overrides,
  };
}

describe("GithubImportView", () => {
  const onBack = vi.fn<() => void>();
  const onImported = vi.fn<(summary: string) => void>();
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
    user = userEvent.setup();
  });

  function renderView() {
    return render(<GithubImportView onBack={onBack} onImported={onImported} />);
  }

  it("renders the form with URL input and buttons", () => {
    renderView();
    expect(screen.getByText("Import from GitHub")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/github\.com/)).toBeInTheDocument();
    expect(screen.getByText("GitHub import warning")).toBeInTheDocument();
    expect(
      screen.getByText(/Only import automations and skills from GitHub sources you trust/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Import")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("disables Import button when URL is empty", () => {
    renderView();
    expect(screen.getByText("Import")).toBeDisabled();
  });

  it("enables Import button when URL is entered", async () => {
    renderView();
    const urlInput = screen.getByPlaceholderText(/github\.com/);
    await user.clear(urlInput);
    await user.type(urlInput, "https://github.com/org/repo");
    expect(screen.getByText("Import")).toBeEnabled();
  });

  it("calls onBack when Cancel button is clicked", async () => {
    renderView();
    await user.click(screen.getByText("Cancel"));
    expect(onBack).toHaveBeenCalled();
  });

  it("calls importFromGithub with trimmed URL on submit", async () => {
    renderView();
    const urlInput = screen.getByPlaceholderText(/github\.com/);
    await user.clear(urlInput);
    await user.type(urlInput, "  https://github.com/org/repo  ");
    await user.click(screen.getByText("Import"));
    await waitFor(() => {
      expect(window.automationsAPI.importFromGithub).toHaveBeenCalledWith(
        "https://github.com/org/repo",
        undefined,
      );
    });
  });

  it("shows fetching state during import", async () => {
    let resolveImport!: (
      value: Awaited<ReturnType<typeof window.automationsAPI.importFromGithub>>,
    ) => void;
    vi.mocked(window.automationsAPI.importFromGithub).mockReturnValue(
      new Promise((r) => {
        resolveImport = r;
      }),
    );

    renderView();
    const urlInput = screen.getByPlaceholderText(/github\.com/);
    await user.clear(urlInput);
    await user.type(urlInput, "https://github.com/org/repo");
    await user.click(screen.getByText("Import"));

    expect(await screen.findByText("Fetching from GitHub...")).toBeInTheDocument();
    expect(screen.getByText("Importing...")).toBeDisabled();

    resolveImport({ success: true, automations: [], skillsInstalled: [] });
  });

  it("calls onImported with summary on success", async () => {
    vi.mocked(window.automationsAPI.importFromGithub).mockResolvedValue({
      success: true,
      automations: [
        stubAutomation({ id: "1", name: "WF1" }),
        stubAutomation({ id: "2", name: "WF2" }),
      ],
      skillsInstalled: [
        {
          id: "1",
          name: "skill-a",
          description: "Does A",
          instructions: "Does A",
          enabled: true,
          createdAt: "",
          scope: "local",
        },
      ],
    });

    renderView();
    const urlInput = screen.getByPlaceholderText(/github\.com/);
    await user.clear(urlInput);
    await user.type(urlInput, "https://github.com/org/repo");
    await user.click(screen.getByText("Import"));

    await waitFor(() => {
      expect(onImported).toHaveBeenCalledWith("Imported 2 automations and 1 skill");
    });
  });

  it("calls onImported with singular form for 1 automation", async () => {
    vi.mocked(window.automationsAPI.importFromGithub).mockResolvedValue({
      success: true,
      automations: [stubAutomation({ id: "1", name: "WF1" })],
      skillsInstalled: [],
    });

    renderView();
    const urlInput = screen.getByPlaceholderText(/github\.com/);
    await user.clear(urlInput);
    await user.type(urlInput, "https://github.com/org/repo");
    await user.click(screen.getByText("Import"));

    await waitFor(() => {
      expect(onImported).toHaveBeenCalledWith("Imported 1 automation");
    });
  });

  it("shows token input when needsToken is returned", async () => {
    vi.mocked(window.automationsAPI.importFromGithub).mockResolvedValue({
      success: false,
      needsToken: true,
      error: "GitHub auth failed",
    });

    renderView();
    const urlInput = screen.getByPlaceholderText(/github\.com/);
    await user.clear(urlInput);
    await user.type(urlInput, "https://github.com/org/repo");
    await user.click(screen.getByText("Import"));

    expect(await screen.findByText("GitHub token required")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/ghp_/)).toBeInTheDocument();
  });

  it("disables Import when needsToken but token is empty", async () => {
    vi.mocked(window.automationsAPI.importFromGithub).mockResolvedValue({
      success: false,
      needsToken: true,
      error: "Auth required",
    });

    renderView();
    const urlInput = screen.getByPlaceholderText(/github\.com/);
    await user.clear(urlInput);
    await user.type(urlInput, "https://github.com/org/repo");
    await user.click(screen.getByText("Import"));

    await screen.findByText("GitHub token required");
    expect(screen.getByText("Import")).toBeDisabled();
  });

  it("sends token on retry after needsToken", async () => {
    vi.mocked(window.automationsAPI.importFromGithub)
      .mockResolvedValueOnce({ success: false, needsToken: true, error: "Auth" })
      .mockResolvedValueOnce({ success: true, automations: [], skillsInstalled: [] });

    renderView();
    const urlInput = screen.getByPlaceholderText(/github\.com/);
    await user.clear(urlInput);
    await user.type(urlInput, "https://github.com/org/repo");
    await user.click(screen.getByText("Import"));

    await screen.findByText("GitHub token required");
    const tokenInput = screen.getByPlaceholderText(/ghp_/);
    await user.clear(tokenInput);
    await user.type(tokenInput, "ghp_test123");
    await user.click(screen.getByText("Import"));

    await waitFor(() => {
      expect(window.automationsAPI.importFromGithub).toHaveBeenCalledWith(
        "https://github.com/org/repo",
        "ghp_test123",
      );
    });
  });

  it("shows error on non-token failure", async () => {
    vi.mocked(window.automationsAPI.importFromGithub).mockResolvedValue({
      success: false,
      error: "Directory not found",
    });

    renderView();
    const urlInput = screen.getByPlaceholderText(/github\.com/);
    await user.clear(urlInput);
    await user.type(urlInput, "https://github.com/org/repo/tree/main/bad");
    await user.click(screen.getByText("Import"));

    expect(await screen.findByText("Directory not found")).toBeInTheDocument();
  });

  it("clears needsToken and error when URL changes", async () => {
    vi.mocked(window.automationsAPI.importFromGithub).mockResolvedValue({
      success: false,
      needsToken: true,
      error: "Auth required",
    });

    renderView();
    const urlInput = screen.getByPlaceholderText(/github\.com/);
    await user.clear(urlInput);
    await user.type(urlInput, "https://github.com/org/repo");
    await user.click(screen.getByText("Import"));

    await screen.findByText("GitHub token required");

    // Change URL — token prompt should disappear
    await user.clear(urlInput);
    await user.type(urlInput, "https://github.com/org/other");
    expect(screen.queryByText("GitHub token required")).not.toBeInTheDocument();
  });

  it("calls onImported with fallback message when no items", async () => {
    vi.mocked(window.automationsAPI.importFromGithub).mockResolvedValue({
      success: true,
      automations: [],
      skillsInstalled: [],
    });

    renderView();
    const urlInput = screen.getByPlaceholderText(/github\.com/);
    await user.clear(urlInput);
    await user.type(urlInput, "https://github.com/org/repo");
    await user.click(screen.getByText("Import"));

    await waitFor(() => {
      expect(onImported).toHaveBeenCalledWith("Import complete");
    });
  });
});
