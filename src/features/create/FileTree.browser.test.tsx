import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs, render, screen, waitFor, userEvent } from "@/test-utils";
import type { WorkspaceAPI } from "@/types/electron";

// Mock telemetry context for the browser test.
// in the vitest browser environment (duplicate React instances).
vi.mock("@/services/telemetry/opensource", () => ({
  TelemetryPath: ({ children }: { children: React.ReactNode }) => children,
  guid: () => "mock-guid",
  withTelemetryPath: (c: unknown) => c,
}));

vi.mock("@/services/telemetry/schema", () => {
  const passthrough = ({ children }: { children: React.ReactNode }) => children;
  const monitor = ({
    callback,
    children,
  }: {
    callback: () => void;
    children: (cb: () => void) => React.ReactNode;
  }) => children(callback);
  return {
    TelemetryPath_FileTree: passthrough,
    TelemetryPath_File: passthrough,
    InteractiveElementMonitor_AddToChat: monitor,
    InteractiveElementMonitor_CreateFolder: monitor,
    InteractiveElementMonitor_SelectFile: monitor,
    InteractiveElementMonitor_RenameItem: monitor,
    InteractiveElementMonitor_DuplicateItem: monitor,
    InteractiveElementMonitor_DeleteItem: monitor,
  };
});

import { FileTree } from "./FileTree";

describe("FileTree keyboard (browser)", () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
  });

  function setupEntries(entries: Array<{ name: string; type: "file" | "directory" }>) {
    window.workspaceAPI.listDir = vi.fn<WorkspaceAPI["listDir"]>().mockResolvedValue({
      success: true,
      entries,
    });
  }

  it("deletes focused file on Delete key", async () => {
    setupEntries([{ name: "readme.md", type: "file" }]);
    const confirmSpy = vi.spyOn<typeof window, "confirm">(window, "confirm").mockReturnValue(true);

    render(<FileTree onFileSelect={vi.fn<(path: string) => void>()} />);
    await screen.findByText("readme.md");

    await user.click(screen.getByText("readme.md"));
    await user.keyboard("{Delete}");

    expect(confirmSpy).toHaveBeenCalledWith('Delete "readme.md"?');
    expect(window.workspaceAPI.deleteItem).toHaveBeenCalledWith("/tmp/workspace/readme.md");
    confirmSpy.mockRestore();
  });

  it("deletes focused folder on Delete key", async () => {
    setupEntries([{ name: "docs", type: "directory" }]);
    const confirmSpy = vi.spyOn<typeof window, "confirm">(window, "confirm").mockReturnValue(true);

    render(<FileTree onFileSelect={vi.fn<(path: string) => void>()} />);
    await screen.findByText("docs");

    await user.click(screen.getByText("docs"));
    await user.keyboard("{Delete}");

    expect(confirmSpy).toHaveBeenCalledWith('Delete folder "docs" and all its contents?');
    expect(window.workspaceAPI.deleteItem).toHaveBeenCalledWith("/tmp/workspace/docs");
    confirmSpy.mockRestore();
  });

  // Regression: when the currently-selected file is deleted, the
  // canvas must fall back to the splash screen. The root cause was a broad
  // `invalidateQueries({ queryKey: ["workspace"] })` that also matched
  // ["workspace", "uiState"] and raced the async setSelectedFile IPC. This
  // test guards both halves of the fix:
  //   1. onFileSelect("") is called (existing behavior).
  //   2. uiState is NOT refetched after delete (prevents the race from
  //      clobbering the optimistic clear with the stale persisted path).
  it("clears selection when the selected file is deleted and does not refetch uiState", async () => {
    setupEntries([{ name: "readme.md", type: "file" }]);
    const confirmSpy = vi.spyOn<typeof window, "confirm">(window, "confirm").mockReturnValue(true);
    const onFileSelect = vi.fn<(path: string) => void>();

    render(<FileTree onFileSelect={onFileSelect} selectedFile="/tmp/workspace/readme.md" />);
    await screen.findByText("readme.md");

    // Baseline: getUIState called exactly once for the initial mount fetch.
    const getUIStateBaseline = vi.mocked(window.workspaceAPI.getUIState).mock.calls.length;

    await user.click(screen.getByText("readme.md"));
    await user.keyboard("{Delete}");

    await waitFor(() => {
      expect(window.workspaceAPI.deleteItem).toHaveBeenCalledWith("/tmp/workspace/readme.md");
    });
    expect(onFileSelect).toHaveBeenCalledWith("");

    // Give any racing refetch a chance to settle, then assert it didn't happen.
    // A broad invalidateQueries({ queryKey: ["workspace"] }) would match the
    // useWorkspaceUIState query (["workspace", "uiState"]) and re-call
    // getUIState, regressing the deleted-file ENOENT fix.
    await expect
      .poll(() => vi.mocked(window.workspaceAPI.getUIState).mock.calls.length, { timeout: 200 })
      .toBe(getUIStateBaseline);

    confirmSpy.mockRestore();
  });

  // Regression: the duplicate flow had the same race — a broad
  // ["workspace"] invalidation in duplicateMutation.onSuccess would refetch
  // uiState and race the onFileSelect(newPath) call. Mirror of the delete
  // test above.
  it("duplicates a file and does not refetch uiState", async () => {
    setupEntries([{ name: "notes.md", type: "file" }]);
    const onFileSelect = vi.fn<(path: string) => void>();

    render(<FileTree onFileSelect={onFileSelect} />);
    const fileText = await screen.findByText("notes.md");

    const getUIStateBaseline = vi.mocked(window.workspaceAPI.getUIState).mock.calls.length;

    await user.pointer({ keys: "[MouseRight]", target: fileText });
    await user.click(await screen.findByText("Duplicate"));

    await screen.findByDisplayValue("notes copy.md");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(window.workspaceAPI.duplicateItem).toHaveBeenCalledWith(
        "/tmp/workspace/notes.md",
        "/tmp/workspace/notes copy.md",
      );
    });

    await expect
      .poll(() => vi.mocked(window.workspaceAPI.getUIState).mock.calls.length, { timeout: 200 })
      .toBe(getUIStateBaseline);
  });

  it("focuses rename input with filename selected (not extension) via context menu", async () => {
    setupEntries([{ name: "hello.txt", type: "file" }]);

    render(<FileTree onFileSelect={vi.fn<(path: string) => void>()} />);
    const fileText = await screen.findByText("hello.txt");

    // Right-click to open node-level context menu
    await user.pointer({ keys: "[MouseRight]", target: fileText });

    // Wait for Radix portal to render, click Rename
    const renameItem = await screen.findByText("Rename");
    await user.click(renameItem);

    // Rename input should appear, focused, with "hello" selected (not ".txt")
    const input = await screen.findByDisplayValue("hello.txt");
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
    if (!(input instanceof HTMLInputElement)) throw new Error("expected HTMLInputElement");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(5); // "hello" length
  });

  it("does not re-select rename input contents on each keystroke", async () => {
    // Regression: the selection-on-mount callback-ref was re-invoked on every
    // render (keystroke), collapsing the caret back to full-select. Guarded by
    // didSelectRenameRef so selection only happens on initial mount.
    setupEntries([{ name: "hello.txt", type: "file" }]);

    render(<FileTree onFileSelect={vi.fn<(path: string) => void>()} />);
    const fileText = await screen.findByText("hello.txt");

    await user.pointer({ keys: "[MouseRight]", target: fileText });
    const renameItem = await screen.findByText("Rename");
    await user.click(renameItem);

    const input = await screen.findByDisplayValue("hello.txt");
    await waitFor(() => expect(input).toHaveFocus());

    // Type a character — selection should collapse, not re-expand to 0..stem on re-render
    await user.keyboard("x");

    if (!(input instanceof HTMLInputElement)) throw new Error("expected HTMLInputElement");
    // After typing, the input value changes and caret should be where the user typed —
    // selectionStart/End are equal (collapsed caret), NOT (0, stemLength).
    expect(input.selectionStart).toBe(input.selectionEnd);
    expect(input.selectionStart).not.toBe(0);
  });

  it("focuses duplicate input with stem pre-selected via context menu", async () => {
    setupEntries([{ name: "notes.md", type: "file" }]);

    render(<FileTree onFileSelect={vi.fn<(path: string) => void>()} />);
    const fileText = await screen.findByText("notes.md");

    await user.pointer({ keys: "[MouseRight]", target: fileText });
    const duplicateItem = await screen.findByText("Duplicate");
    await user.click(duplicateItem);

    // Inline input should appear pre-filled with suggested name, stem selected
    const input = await screen.findByDisplayValue("notes copy.md");
    await waitFor(() => expect(input).toHaveFocus());
    if (!(input instanceof HTMLInputElement)) throw new Error("expected HTMLInputElement");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("notes copy".length);
  });

  it("focuses new folder input via context menu", async () => {
    setupEntries([{ name: "docs", type: "directory" }]);

    render(<FileTree onFileSelect={vi.fn<(path: string) => void>()} />);
    const folderText = await screen.findByText("docs");

    // Right-click folder → open context menu
    await user.pointer({ keys: "[MouseRight]", target: folderText });

    // "New Folder" appears in both root and node menus — click the one in the portal
    const newFolderItem = await screen.findByText("New Folder");
    await user.click(newFolderItem);

    // New folder input should appear and be focused (after rAF — Radix close cleanup)
    const input = await screen.findByPlaceholderText("folder name");
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("does nothing on Delete when no item is focused", async () => {
    setupEntries([{ name: "readme.md", type: "file" }]);

    render(<FileTree onFileSelect={vi.fn<(path: string) => void>()} />);
    await screen.findByText("readme.md");

    // Focus the tree container directly without clicking any item
    const treeContainer = screen.getByText("readme.md").closest<HTMLElement>("[tabindex]")!;
    treeContainer.focus();
    await user.keyboard("{Delete}");

    expect(window.workspaceAPI.deleteItem).not.toHaveBeenCalled();
  });
});
