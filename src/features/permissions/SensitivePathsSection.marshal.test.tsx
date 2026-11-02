// marshal-owned renderer test
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs, render, screen, userEvent } from "@/test-utils";
import type { PermissionsConfig } from "@/types/electron";

import { SensitivePathsSection } from "./SensitivePathsSection";

beforeEach(() => {
  installMockAPIs();
});

const basePermissions: PermissionsConfig = {
  autoApproveReadOnly: false,
  allow: [],
  tools: {},
  servers: {},
};

function renderSection(overrides: { allowedSensitivePaths?: string[] } = {}) {
  const onUpdate = vi.fn<(p: PermissionsConfig) => void>();
  const permissions: PermissionsConfig = {
    ...basePermissions,
    allowedSensitivePaths: overrides.allowedSensitivePaths,
  };
  render(<SensitivePathsSection permissions={permissions} onUpdate={onUpdate} />);
  return { onUpdate };
}

describe("SensitivePathsSection", () => {
  it("renders a list of allowed sensitive paths", () => {
    renderSection({ allowedSensitivePaths: ["/home/user/.ssh/config", "/home/user/.gitconfig"] });
    expect(screen.getByText("/home/user/.ssh/config")).toBeInTheDocument();
    expect(screen.getByText("/home/user/.gitconfig")).toBeInTheDocument();
  });

  it("renders empty state message when list is empty", () => {
    renderSection({ allowedSensitivePaths: [] });
    expect(screen.getByText(/No exceptions/i)).toBeInTheDocument();
  });

  it("removes entry on × button click", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderSection({
      allowedSensitivePaths: ["/home/user/.ssh/config", "/home/user/.gitconfig"],
    });

    await user.click(screen.getByRole("button", { name: "Remove /home/user/.ssh/config" }));

    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate.mock.calls[0][0].allowedSensitivePaths).toEqual(["/home/user/.gitconfig"]);
  });

  it("adds a new pattern via the input + Add button", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderSection({ allowedSensitivePaths: [] });

    await user.type(screen.getByRole("textbox"), "/home/user/.ssh/*");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate.mock.calls[0][0].allowedSensitivePaths).toEqual(["/home/user/.ssh/*"]);
  });

  it("does not add duplicate entries", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderSection({
      allowedSensitivePaths: ["/home/user/.ssh/config"],
    });

    await user.type(screen.getByRole("textbox"), "/home/user/.ssh/config");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(onUpdate).not.toHaveBeenCalled();
  });
});
