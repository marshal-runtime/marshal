// marshal-owned renderer test
import { describe, expect, it, vi } from "vitest";

import { render, screen, userEvent } from "@/test-utils";
import type { PermissionsConfig } from "@/types/electron";

import { FolderAccessSection } from "./FolderAccessSection";

const base: PermissionsConfig = {
  autoApproveReadOnly: false,
  allow: [],
  tools: {},
  servers: {},
  allowedReadFolders: ["/Users/me/Downloads"],
  allowedWriteFolders: ["/Users/me/Exports"],
};

describe("FolderAccessSection", () => {
  it("is collapsed by default — folders hidden until expanded", () => {
    render(<FolderAccessSection permissions={base} onUpdate={() => {}} />);
    expect(screen.getByText("Folder access")).toBeInTheDocument();
    expect(screen.queryByText("/Users/me/Downloads")).not.toBeInTheDocument();
  });

  it("lists read and write granted folders once expanded", async () => {
    const user = userEvent.setup();
    render(<FolderAccessSection permissions={base} onUpdate={() => {}} />);
    await user.click(screen.getByText("Folder access"));
    expect(screen.getByText("/Users/me/Downloads")).toBeInTheDocument();
    expect(screen.getByText("/Users/me/Exports")).toBeInTheDocument();
  });

  it("removing a read folder calls onUpdate without it", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn<(p: PermissionsConfig) => void>();
    render(<FolderAccessSection permissions={base} onUpdate={onUpdate} />);
    await user.click(screen.getByText("Folder access"));
    await user.click(screen.getByLabelText("Remove read access to /Users/me/Downloads"));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ allowedReadFolders: [] }));
  });

  it("removing a write folder calls onUpdate without it", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn<(p: PermissionsConfig) => void>();
    render(<FolderAccessSection permissions={base} onUpdate={onUpdate} />);
    await user.click(screen.getByText("Folder access"));
    await user.click(screen.getByLabelText("Remove write access to /Users/me/Exports"));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ allowedWriteFolders: [] }));
  });

  it("does not call onUpdate when disabled, even on a programmatic click", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn<(p: PermissionsConfig) => void>();
    render(<FolderAccessSection permissions={base} onUpdate={onUpdate} disabled />);
    await user.click(screen.getByText("Folder access"));
    // The button is `<Button disabled>` so userEvent won't click it, but the
    // internal `if (disabled) return;` guard must also hold for programmatic paths.
    screen.getByLabelText("Remove read access to /Users/me/Downloads").click();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
