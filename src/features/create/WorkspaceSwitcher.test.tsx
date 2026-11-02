import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, userEvent, waitFor } from "@/test-utils";

import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

describe("WorkspaceSwitcher", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  it("passes the folder picker token, not the display path, when creating an external workspace", async () => {
    vi.mocked(window.workspaceAPI.pickFolder).mockResolvedValue({
      success: true,
      folderPath: "C:\\Users\\me\\Projects\\picked-folder",
      folderToken: "folder-token-123",
    });

    render(
      <WorkspaceSwitcher activeWorkspace="Scratchpad" onSwitch={vi.fn<(name: string) => void>()} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /workspace marshal's workspace/i }));
    await userEvent.click(screen.getByRole("button", { name: /select existing folder/i }));
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(window.workspaceAPI.createWorkspace).toHaveBeenCalledWith(
        "picked-folder",
        "folder-token-123",
      );
    });
    expect(window.workspaceAPI.createWorkspace).not.toHaveBeenCalledWith(
      "picked-folder",
      "C:\\Users\\me\\Projects\\picked-folder",
    );
  });

  it("shows an error when folder picker succeeds without a folder token", async () => {
    vi.mocked(window.workspaceAPI.pickFolder).mockResolvedValue({
      success: true,
      folderPath: "C:\\Users\\me\\Projects\\picked-folder",
    });

    render(
      <WorkspaceSwitcher activeWorkspace="Scratchpad" onSwitch={vi.fn<(name: string) => void>()} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /workspace marshal's workspace/i }));
    await userEvent.click(screen.getByRole("button", { name: /select existing folder/i }));

    expect(
      await screen.findByText("Folder selection did not return a workspace path token"),
    ).toBeInTheDocument();
    expect(window.workspaceAPI.createWorkspace).not.toHaveBeenCalled();
  });

  it("clears the selected folder token after external workspace creation fails", async () => {
    vi.mocked(window.workspaceAPI.pickFolder).mockResolvedValue({
      success: true,
      folderPath: "C:\\Users\\me\\Projects\\picked-folder",
      folderToken: "folder-token-123",
    });
    vi.mocked(window.workspaceAPI.createWorkspace).mockResolvedValue({
      success: false,
      error: "Folder is unavailable",
    });

    render(
      <WorkspaceSwitcher activeWorkspace="Scratchpad" onSwitch={vi.fn<(name: string) => void>()} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /workspace marshal's workspace/i }));
    await userEvent.click(screen.getByRole("button", { name: /select existing folder/i }));
    expect(await screen.findByText("Selected: picked-folder")).toBeInTheDocument();

    await userEvent.keyboard("{Enter}");

    expect(await screen.findByText("Folder is unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Selected: picked-folder")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /select existing folder/i })).toBeInTheDocument();
  });
});
