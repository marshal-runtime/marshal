// Marshal-owned module.
import { fireEvent } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs, render, screen, waitFor } from "@/test-utils";

import type { ImportResult } from "./ImportDialog";
import { ImportDialog } from "./ImportDialog";

function makeSkillFile(name: string) {
  return {
    content: `---\nname: ${name}\ndescription: test\n---\ninstructions`,
    name: `${name}.md`,
  };
}

describe("ImportDialog", () => {
  const onClose = vi.fn<() => void>();
  const onImportFiles =
    vi.fn<(files: Array<{ content: string; name: string }>) => Promise<ImportResult>>();
  const onUrlImport = vi.fn<() => Promise<void>>();
  const onImportBundle = vi.fn<(dirPath?: string) => Promise<void>>().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
    onImportFiles.mockResolvedValue({ succeeded: [], errors: [] });
    onUrlImport.mockResolvedValue(undefined);
  });

  it("renders the import dialog", () => {
    render(
      <ImportDialog
        onClose={onClose}
        onImportFiles={onImportFiles}
        onUrlImport={onUrlImport}
        onImportBundle={onImportBundle}
      />,
    );
    expect(screen.getByText("Import Skill")).toBeInTheDocument();
    expect(screen.getByText("Drop .md skill files here")).toBeInTheDocument();
    expect(screen.getByText("Skill import warning")).toBeInTheDocument();
    expect(screen.getByText(/Only import skills from sources you trust/i)).toBeInTheDocument();
  });

  it("closes dialog when all files succeed", async () => {
    const user = userEvent.setup();
    onImportFiles.mockResolvedValue({
      succeeded: ["skill-a"],
      errors: [],
    });

    render(
      <ImportDialog
        onClose={onClose}
        onImportFiles={onImportFiles}
        onUrlImport={onUrlImport}
        onImportBundle={onImportBundle}
      />,
    );

    const input = screen.getByTestId("file-input");
    const file = new File([makeSkillFile("skill-a").content], "skill-a.md", {
      type: "text/markdown",
    });
    await user.upload(input, file);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("stays open and shows summary when some files fail", async () => {
    const user = userEvent.setup();
    onImportFiles.mockResolvedValue({
      succeeded: ["skill-a"],
      errors: [{ fileName: "BAD.md", error: "Missing frontmatter" }],
    });

    render(
      <ImportDialog
        onClose={onClose}
        onImportFiles={onImportFiles}
        onUrlImport={onUrlImport}
        onImportBundle={onImportBundle}
      />,
    );

    const input = screen.getByTestId("file-input");
    const files = [
      new File([makeSkillFile("skill-a").content], "skill-a.md", { type: "text/markdown" }),
      new File(["not a skill"], "BAD.md", { type: "text/markdown" }),
    ];
    await user.upload(input, files);

    await waitFor(() => {
      expect(screen.getByTestId("import-result-summary")).toBeInTheDocument();
    });

    expect(screen.getByText("Imported 1 of 2 skills")).toBeInTheDocument();
    expect(screen.getByTestId("import-success-list")).toBeInTheDocument();
    expect(screen.getByText("skill-a")).toBeInTheDocument();
    expect(screen.getByTestId("import-error-list")).toBeInTheDocument();
    expect(screen.getByText("Missing frontmatter")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not call onImportFiles for empty file list", () => {
    render(
      <ImportDialog
        onClose={onClose}
        onImportFiles={onImportFiles}
        onUrlImport={onUrlImport}
        onImportBundle={onImportBundle}
      />,
    );

    // No upload action — just verify initial state has no import triggered
    expect(onImportFiles).not.toHaveBeenCalled();
  });

  it("renders the bundle import zone", () => {
    render(
      <ImportDialog
        onClose={onClose}
        onImportFiles={onImportFiles}
        onUrlImport={onUrlImport}
        onImportBundle={onImportBundle}
      />,
    );
    expect(screen.getByText("Drop a skill folder here")).toBeInTheDocument();
  });

  it("calls onImportBundle and closes on success when bundle zone is clicked", async () => {
    const user = userEvent.setup();
    render(
      <ImportDialog
        onClose={onClose}
        onImportFiles={onImportFiles}
        onUrlImport={onUrlImport}
        onImportBundle={onImportBundle}
      />,
    );

    await user.click(screen.getByText("Drop a skill folder here"));
    await waitFor(() => expect(onImportBundle).toHaveBeenCalledWith(undefined));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("stays open and shows error when bundle import fails", async () => {
    const user = userEvent.setup();
    onImportBundle.mockRejectedValueOnce(new Error("Directory does not contain a SKILL.md file."));

    render(
      <ImportDialog
        onClose={onClose}
        onImportFiles={onImportFiles}
        onUrlImport={onUrlImport}
        onImportBundle={onImportBundle}
      />,
    );

    await user.click(screen.getByText("Drop a skill folder here"));
    await waitFor(() => {
      expect(screen.getByText("Directory does not contain a SKILL.md file.")).toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each(["Cancelled", "Import cancelled", "Skipped existing skill"])(
    "does not show error for dismissed bundle import: %s",
    async (msg) => {
      const user = userEvent.setup();
      onImportBundle.mockRejectedValueOnce(new Error(msg));

      render(
        <ImportDialog
          onClose={onClose}
          onImportFiles={onImportFiles}
          onUrlImport={onUrlImport}
          onImportBundle={onImportBundle}
        />,
      );

      await user.click(screen.getByText("Drop a skill folder here"));
      await waitFor(() => expect(onImportBundle).toHaveBeenCalled());
      // Should not show error for user-initiated dismissals
      expect(screen.queryByText(msg)).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it("shows error when a non-folder is dropped on the bundle zone", () => {
    render(
      <ImportDialog
        onClose={onClose}
        onImportFiles={onImportFiles}
        onUrlImport={onUrlImport}
        onImportBundle={onImportBundle}
      />,
    );

    const bundleBtn = screen.getByRole("button", { name: /drop a skill folder/i });
    // DataTransfer in happy-dom has no webkitGetAsEntry, so getDroppedDirPath returns null
    fireEvent.drop(bundleBtn, { dataTransfer: new DataTransfer() });

    expect(screen.getByText("Please drop a folder, not a file.")).toBeInTheDocument();
    expect(onImportBundle).not.toHaveBeenCalled();
  });

  it("resolves dropped folder path via workspaceAPI.getPathForFile (sandbox-safe)", async () => {
    // Under sandbox: true, File.path is not populated on dropped-directory entries.
    // getDroppedDirPath must fall back to webUtils.getPathForFile (via preload).
    vi.mocked(window.workspaceAPI.getPathForFile).mockReturnValue("/tmp/skills/my-bundle");

    render(
      <ImportDialog
        onClose={onClose}
        onImportFiles={onImportFiles}
        onUrlImport={onUrlImport}
        onImportBundle={onImportBundle}
      />,
    );

    const bundleBtn = screen.getByRole("button", { name: /drop a skill folder/i });
    const fakeFile = new File([""], "my-bundle");
    // happy-dom's DataTransfer has no webkitGetAsEntry; stub the subset getDroppedDirPath reads.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const fakeDataTransfer = {
      items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }],
      files: [fakeFile],
      types: ["Files"],
    } as unknown as DataTransfer;

    fireEvent.drop(bundleBtn, { dataTransfer: fakeDataTransfer });

    await waitFor(() => {
      expect(onImportBundle).toHaveBeenCalledWith("/tmp/skills/my-bundle");
    });
    expect(window.workspaceAPI.getPathForFile).toHaveBeenCalledWith(fakeFile);
  });

  it("has accessible result summary with role=status and aria-live", async () => {
    const user = userEvent.setup();
    onImportFiles.mockResolvedValue({
      succeeded: ["skill-a"],
      errors: [{ fileName: "BAD.md", error: "Bad file" }],
    });

    render(
      <ImportDialog
        onClose={onClose}
        onImportFiles={onImportFiles}
        onUrlImport={onUrlImport}
        onImportBundle={onImportBundle}
      />,
    );

    const input = screen.getByTestId("file-input");
    const file = new File(["content"], "skill-a.md", { type: "text/markdown" });
    await user.upload(input, [file, new File(["bad"], "BAD.md")]);

    await waitFor(() => {
      expect(screen.getByTestId("import-result-summary")).toBeInTheDocument();
    });
    expect(screen.getByTestId("import-result-summary")).toHaveAttribute("role", "status");
    expect(screen.getByTestId("import-result-summary")).toHaveAttribute("aria-live", "polite");
  });
});
