// marshal-owned renderer test
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render as rtlRender } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs, render, screen, waitFor, userEvent } from "@/test-utils";
import type { WorkspaceAPI } from "@/types/electron";

import { FileTree, FileIcon } from "./FileTree";

/**
 * FileTree tests.
 *
 * Note: Radix ContextMenu `onSelect` does not fire in happy-dom/JSDOM,
 * so create-folder and rename flows are tested only through E2E tests
 * (see e2e/cocreate-multisession.marshal.test.ts and e2e/editor-selection.marshal.test.ts).
 * The handleNewFolderSubmit / handleRenameSubmit handlers are structurally
 * identical to patterns exercised by FilePreview.test.tsx (44 tests).
 */
describe("FileTree", () => {
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

  it("renders directory entries from workspace root", async () => {
    setupEntries([
      { name: "docs", type: "directory" },
      { name: "readme.md", type: "file" },
    ]);

    render(<FileTree onFileSelect={vi.fn<(path: string) => void>()} />);

    await waitFor(() => {
      expect(screen.getByText("docs")).toBeInTheDocument();
      expect(screen.getByText("readme.md")).toBeInTheDocument();
    });
  });

  it("calls onFileSelect when a file is clicked", async () => {
    setupEntries([{ name: "notes.md", type: "file" }]);
    const onFileSelect = vi.fn<(path: string) => void>();

    render(<FileTree onFileSelect={onFileSelect} />);
    await screen.findByText("notes.md");

    await user.click(screen.getByText("notes.md"));

    expect(onFileSelect).toHaveBeenCalledWith("/tmp/workspace/notes.md");
  });

  it("deselects file when clicking the selected file again", async () => {
    setupEntries([{ name: "notes.md", type: "file" }]);
    const onFileSelect = vi.fn<(path: string) => void>();

    render(<FileTree onFileSelect={onFileSelect} selectedFile="/tmp/workspace/notes.md" />);
    await screen.findByText("notes.md");

    await user.click(screen.getByText("notes.md"));

    expect(onFileSelect).toHaveBeenCalledWith("");
  });

  it("expands directory on click and fetches children", async () => {
    setupEntries([{ name: "docs", type: "directory" }]);

    // Second call returns children of "docs"
    const listDir = vi.fn<WorkspaceAPI["listDir"]>();
    listDir.mockResolvedValueOnce({
      success: true,
      entries: [{ name: "docs", type: "directory" }],
    });
    listDir.mockResolvedValueOnce({ success: true, entries: [{ name: "guide.md", type: "file" }] });
    window.workspaceAPI.listDir = listDir;

    render(<FileTree onFileSelect={vi.fn<(path: string) => void>()} />);
    await screen.findByText("docs");

    await user.click(screen.getByText("docs"));

    await waitFor(() => {
      expect(screen.getByText("guide.md")).toBeInTheDocument();
    });
  });

  it("shows empty state for empty workspace", async () => {
    setupEntries([]);

    render(<FileTree onFileSelect={vi.fn<(path: string) => void>()} />);

    await waitFor(() => {
      expect(screen.getByText("This workspace is empty.")).toBeInTheDocument();
    });
  });

  it("resolves workspace root from API", async () => {
    window.workspaceAPI.getRoot = vi.fn<WorkspaceAPI["getRoot"]>().mockResolvedValue({
      success: true,
      root: "/home/user/my-project",
    });
    setupEntries([{ name: "src", type: "directory" }]);

    render(<FileTree onFileSelect={vi.fn<(path: string) => void>()} workspaceName="my-project" />);

    expect(window.workspaceAPI.getRoot).toHaveBeenCalledWith("my-project");
    await screen.findByText("src");
  });

  it("persists expanded folders to disk via debounced IPC", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const timerUser = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    setupEntries([{ name: "docs", type: "directory" }]);
    const listDir = vi.fn<WorkspaceAPI["listDir"]>();
    listDir.mockResolvedValueOnce({
      success: true,
      entries: [{ name: "docs", type: "directory" }],
    });
    listDir.mockResolvedValueOnce({ success: true, entries: [{ name: "guide.md", type: "file" }] });
    window.workspaceAPI.listDir = listDir;

    render(
      <FileTree onFileSelect={vi.fn<(path: string) => void>()} workspaceName="persist-test" />,
    );
    await screen.findByText("docs");

    // Expand the directory
    await timerUser.click(screen.getByText("docs"));
    await screen.findByText("guide.md");

    // Flush the 300ms debounce
    vi.advanceTimersByTime(300);

    // Verify setExpandedPaths was called with relative paths
    expect(window.workspaceAPI.setExpandedPaths).toHaveBeenCalledWith("persist-test", ["docs"]);

    vi.useRealTimers();
  });

  it("debounces multiple rapid expand/collapse into a single IPC call", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const timerUser = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    const listDirMock = vi.fn<WorkspaceAPI["listDir"]>();
    listDirMock.mockResolvedValueOnce({
      success: true,
      entries: [{ name: "docs", type: "directory" }],
    });
    listDirMock.mockResolvedValueOnce({
      success: true,
      entries: [{ name: "guide.md", type: "file" }],
    });
    // After collapse, root is re-fetched
    listDirMock.mockResolvedValueOnce({
      success: true,
      entries: [{ name: "docs", type: "directory" }],
    });
    window.workspaceAPI.listDir = listDirMock;

    render(
      <FileTree onFileSelect={vi.fn<(path: string) => void>()} workspaceName="debounce-test" />,
    );
    await screen.findByText("docs");

    // Rapidly expand then collapse (without advancing time between)
    await timerUser.click(screen.getByText("docs"));
    await screen.findByText("guide.md");
    await timerUser.click(screen.getByText("docs"));

    // Flush the debounce — should have exactly 1 call (the final collapsed state)
    vi.advanceTimersByTime(300);

    const calls = vi
      .mocked(window.workspaceAPI.setExpandedPaths)
      .mock.calls.filter(([workspaceName]) => workspaceName === "debounce-test");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("debounce-test");
    // After expand+collapse, nothing is expanded
    expect(calls[0][1]).toEqual([]);

    vi.useRealTimers();
  });

  it("restores expanded folders from disk on mount", async () => {
    // Set up getUIState to return expanded paths for this workspace
    window.workspaceAPI.getUIState = vi.fn<WorkspaceAPI["getUIState"]>().mockResolvedValue({
      success: true,
      state: { activeWorkspace: "Scratchpad", expandedPaths: { "restore-test": ["docs"] } },
    });

    const listDir2 = vi.fn<WorkspaceAPI["listDir"]>();
    listDir2.mockResolvedValueOnce({
      success: true,
      entries: [{ name: "docs", type: "directory" }],
    });
    listDir2.mockResolvedValueOnce({
      success: true,
      entries: [{ name: "guide.md", type: "file" }],
    });
    window.workspaceAPI.listDir = listDir2;

    render(
      <FileTree onFileSelect={vi.fn<(path: string) => void>()} workspaceName="restore-test" />,
    );

    // The directory should auto-expand from disk state without clicking
    expect(await screen.findByText("guide.md")).toBeInTheDocument();
  });

  it("refetches directory listing on remount (does not serve stale cache)", async () => {
    // Use a shared QueryClient across both mounts with the production staleTime
    // (5s). This mimics the real app: without staleTime: 0 on the query itself,
    // a remount within 5s would serve the cached deleted entry.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 5_000 } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const listDir = vi.fn<WorkspaceAPI["listDir"]>().mockResolvedValue({
      success: true,
      entries: [{ name: "old-file.md", type: "file" }],
    });
    window.workspaceAPI.listDir = listDir;

    const view = rtlRender(<FileTree onFileSelect={vi.fn<(path: string) => void>()} />, {
      wrapper,
    });
    await screen.findByText("old-file.md");
    view.unmount();

    // Simulate: file was deleted while the component was unmounted
    listDir.mockResolvedValue({ success: true, entries: [] });

    rtlRender(<FileTree onFileSelect={vi.fn<(path: string) => void>()} />, { wrapper });

    await waitFor(() => {
      expect(screen.queryByText("old-file.md")).not.toBeInTheDocument();
      expect(screen.getByText("This workspace is empty.")).toBeInTheDocument();
    });
  });

  it("passes dropped files as a plain File array to copyExternalFiles for root drops", async () => {
    setupEntries([]);
    render(<FileTree onFileSelect={vi.fn<(path: string) => void>()} />);
    await screen.findByText("This workspace is empty.");
    const file = new File(["root"], "root.txt");
    const files = [file];

    fireEvent.drop(screen.getByText("This workspace is empty."), {
      dataTransfer: {
        files,
        types: ["Files"],
        getData: () => "",
      },
    });

    await waitFor(() => {
      expect(window.workspaceAPI.copyExternalFiles).toHaveBeenCalledWith([file], "/tmp/workspace");
    });
    expect(window.workspaceAPI.getPathForFile).not.toHaveBeenCalled();
  });

  it("refreshes the tree after a successful root file drop", async () => {
    const listDir = vi.fn<WorkspaceAPI["listDir"]>();
    listDir.mockResolvedValueOnce({ success: true, entries: [] });
    listDir.mockResolvedValueOnce({
      success: true,
      entries: [{ name: "secret.txt", type: "file" }],
    });
    window.workspaceAPI.listDir = listDir;
    window.workspaceAPI.copyExternalFiles = vi
      .fn<WorkspaceAPI["copyExternalFiles"]>()
      .mockResolvedValue({ success: true, copied: 1 });

    render(<FileTree onFileSelect={vi.fn<(path: string) => void>()} />);
    await screen.findByText("This workspace is empty.");

    const file = new File(["root"], "secret.txt");
    fireEvent.drop(screen.getByText("This workspace is empty."), {
      dataTransfer: {
        files: [file],
        types: ["Files"],
        getData: () => "",
      },
    });

    expect(await screen.findByText("secret.txt")).toBeInTheDocument();
    expect(listDir).toHaveBeenCalledTimes(2);
  });

  it("passes dropped files as a plain File array to copyExternalFiles for folder drops", async () => {
    setupEntries([{ name: "docs", type: "directory" }]);
    render(<FileTree onFileSelect={vi.fn<(path: string) => void>()} />);
    const folder = await screen.findByText("docs");
    const file = new File(["folder"], "folder.txt");
    const files = [file];

    fireEvent.drop(folder, {
      dataTransfer: {
        files,
        types: ["Files"],
        getData: () => "",
      },
    });

    await waitFor(() => {
      expect(window.workspaceAPI.copyExternalFiles).toHaveBeenCalledWith(
        [file],
        "/tmp/workspace/docs",
      );
    });
    expect(window.workspaceAPI.getPathForFile).not.toHaveBeenCalled();
  });
});

describe("FileIcon", () => {
  it.each([
    ["report.docx", "icon-word"],
    ["report.doc", "icon-word"],
    ["budget.xlsx", "icon-excel"],
    ["budget.xls", "icon-excel"],
    ["slides.pptx", "icon-powerpoint"],
    ["slides.ppt", "icon-powerpoint"],
    ["manual.pdf", "icon-pdf"],
    ["data.csv", "icon-csv"],
  ])("renders the correct document icon for %s", (filename, expectedTestId) => {
    render(<FileIcon name={filename} />);
    expect(screen.getByTestId(expectedTestId)).toBeInTheDocument();
  });

  it.each([["readme.md"], ["notes.markdown"], ["blog.mdx"]])(
    "renders a markdown icon for %s",
    (filename) => {
      render(<FileIcon name={filename} />);
      expect(screen.getByTestId("icon-markdown")).toBeInTheDocument();
    },
  );

  it.each([
    ["app.ts"],
    ["index.js"],
    ["styles.css"],
    ["config.json"],
    ["data.yaml"],
    ["page.html"],
  ])("renders a code icon for %s", (filename) => {
    render(<FileIcon name={filename} />);
    expect(screen.getByTestId("icon-code")).toBeInTheDocument();
  });

  it.each([["photo.png"], ["banner.jpg"], ["icon.svg"], ["animation.gif"]])(
    "renders an image icon for %s",
    (filename) => {
      render(<FileIcon name={filename} />);
      expect(screen.getByTestId("icon-image")).toBeInTheDocument();
    },
  );

  it("renders a generic file icon for unknown extensions", () => {
    render(<FileIcon name="archive.zip" />);
    expect(screen.getByTestId("icon-generic")).toBeInTheDocument();
  });

  it("handles files without extensions", () => {
    render(<FileIcon name="Makefile" />);
    expect(screen.getByTestId("icon-generic")).toBeInTheDocument();
  });

  it("is case-insensitive for extensions", () => {
    const { unmount } = render(<FileIcon name="doc.PDF" />);
    expect(screen.getByTestId("icon-pdf")).toBeInTheDocument();
    unmount();
    render(<FileIcon name="doc.pdf" />);
    expect(screen.getByTestId("icon-pdf")).toBeInTheDocument();
  });
});
