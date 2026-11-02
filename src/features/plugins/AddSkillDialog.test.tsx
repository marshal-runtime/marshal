// Marshal-owned module.
import { describe, it, expect, vi } from "vitest";

import { render, screen, userEvent } from "@/test-utils";

import { AddSkillDialog } from "./AddSkillDialog";

describe("AddSkillDialog", () => {
  it("renders 'Add Skill' title", () => {
    render(<AddSkillDialog onSave={vi.fn<() => void>()} onClose={vi.fn<() => void>()} />);
    expect(screen.getByText("Add Skill")).toBeInTheDocument();
  });

  it("shows name, display name, description, and instructions fields", () => {
    render(<AddSkillDialog onSave={vi.fn<() => void>()} onClose={vi.fn<() => void>()} />);
    expect(screen.getByLabelText(/^Name/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Display Name/)).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Instructions/)).toBeInTheDocument();
  });

  it("Create button disabled when name empty", () => {
    render(<AddSkillDialog onSave={vi.fn<() => void>()} onClose={vi.fn<() => void>()} />);
    expect(screen.getByRole("button", { name: "Create Skill" })).toBeDisabled();
  });

  it("name field only accepts lowercase + dashes", async () => {
    const user = userEvent.setup();
    render(<AddSkillDialog onSave={vi.fn<() => void>()} onClose={vi.fn<() => void>()} />);
    const nameInput = screen.getByLabelText(/^Name/);
    await user.type(nameInput, "My SKILL_Test!");
    // uppercase stripped, underscores/special chars stripped, leaves lowercase + dashes
    expect(nameInput).toHaveValue("myskilltest");
  });

  it("in edit mode shows 'Edit Skill' title and name is disabled", () => {
    render(
      <AddSkillDialog
        onSave={vi.fn<() => void>()}
        onClose={vi.fn<() => void>()}
        initial={{
          name: "existing-skill",
          displayName: "Existing",
          description: "desc",
          instructions: "instr",
        }}
      />,
    );
    expect(screen.getByText("Edit Skill")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toBeDisabled();
  });

  it("calls onSave with correct arguments", async () => {
    const user = userEvent.setup();
    const onSave =
      vi.fn<
        (name: string, description: string, instructions: string, displayName?: string) => void
      >();
    render(<AddSkillDialog onSave={onSave} onClose={vi.fn<() => void>()} />);

    await user.type(screen.getByLabelText(/^Name/), "my-skill");
    await user.type(screen.getByLabelText(/Display Name/), "My Skill");
    await user.type(screen.getByLabelText("Description"), "A description");
    await user.type(screen.getByLabelText(/^Instructions/), "Do the thing");

    await user.click(screen.getByRole("button", { name: "Create Skill" }));
    expect(onSave).toHaveBeenCalledWith("my-skill", "A description", "Do the thing", "My Skill");
  });
});
