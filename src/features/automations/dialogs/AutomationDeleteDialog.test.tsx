import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { render, screen } from "@/test-utils";

import { AutomationDeleteDialog } from "./AutomationDeleteDialog";

const confirm = { id: "automation-1", name: "Daily brief", skillNames: ["calendar", "mail"] };

describe("AutomationDeleteDialog", () => {
  it("cancels through the dialog close action", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn<() => void>();
    render(
      <AutomationDeleteDialog
        deleteConfirm={confirm}
        onDelete={vi.fn<() => void>()}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it.each([
    ["Delete automation + skills", true],
    ["Delete automation only", false],
  ])("deletes with the %s scope", async (label, deleteSkills) => {
    const user = userEvent.setup();
    const onDelete = vi.fn<(id: string, deleteSkills: boolean) => void>();
    render(
      <AutomationDeleteDialog
        deleteConfirm={confirm}
        onDelete={onDelete}
        onCancel={vi.fn<() => void>()}
      />,
    );

    await user.click(screen.getByRole("button", { name: label }));
    expect(onDelete).toHaveBeenCalledWith("automation-1", deleteSkills);
  });
});
