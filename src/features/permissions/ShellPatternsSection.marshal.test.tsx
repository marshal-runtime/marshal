// marshal-owned renderer test
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs, render, screen, userEvent, within } from "@/test-utils";
import type { PermissionsConfig } from "@/types/electron";

// basePerms is the same shape as basePermsWithLiteral (used in the edit + blur tests below).
// Defined early so it's available in the edit/blur describes.
const basePerms: PermissionsConfig = {
  autoApproveReadOnly: false,
  allow: ["npm run *", "rm file.txt", "az repos list *"],
  tools: {},
  servers: {},
};

import { ShellPatternsSection } from "./ShellPatternsSection";
import { TOOL_PLAIN_COPY } from "./tool-descriptions";

beforeEach(() => {
  installMockAPIs();
});

const basePermissions: PermissionsConfig = {
  autoApproveReadOnly: false,
  allow: [],
  tools: {},
  servers: {},
};

function renderSection(
  overrides: { permissions?: Partial<PermissionsConfig>; disabled?: boolean } = {},
) {
  const onUpdate = vi.fn<(p: PermissionsConfig) => void>();
  const permissions = { ...basePermissions, ...overrides.permissions };

  render(
    <ShellPatternsSection
      permissions={permissions}
      onUpdate={onUpdate}
      disabled={overrides.disabled}
    />,
  );

  return { onUpdate };
}

describe("ShellPatternsSection", () => {
  it("renders existing patterns", () => {
    renderSection({ permissions: { allow: ["npm run *", "cat *"] } });
    expect(screen.getByText("npm run *")).toBeInTheDocument();
    expect(screen.getByText("cat *")).toBeInTheDocument();
  });

  it("renders the shellAllowPatterns description from the spec", () => {
    renderSection({ permissions: { allow: ["ls"] } });
    expect(screen.getByText(TOOL_PLAIN_COPY.shellAllowPatterns.description)).toBeInTheDocument();
  });

  it("removes pattern on X button click", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderSection({ permissions: { allow: ["npm run *", "cat *"] } });

    const removeButton = screen.getByRole("button", { name: "Remove npm run *" });
    await user.click(removeButton);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][0].allow).toEqual(["cat *"]);
  });

  it("adds pattern via button click", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderSection();

    const input = screen.getByPlaceholderText("e.g., npm run *");
    await user.type(input, "git push *");

    const addButton = screen.getAllByRole("button").find((b) => !b.textContent?.includes("×"));
    await user.click(addButton!);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][0].allow).toEqual(["git push *"]);
  });

  it("adds pattern via Enter key", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderSection();

    const input = screen.getByPlaceholderText("e.g., npm run *");
    await user.type(input, "git push *{Enter}");

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0][0].allow).toEqual(["git push *"]);
  });

  it("does not add empty pattern", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderSection();

    const input = screen.getByPlaceholderText("e.g., npm run *");
    await user.type(input, "   {Enter}");

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("does not add duplicate pattern", async () => {
    const user = userEvent.setup();
    const { onUpdate } = renderSection({ permissions: { allow: ["npm run *"] } });

    const input = screen.getByPlaceholderText("e.g., npm run *");
    await user.type(input, "npm run *{Enter}");

    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe("ShellPatternsSection tenant policy", () => {
  it("disables input when disabled is true", () => {
    renderSection({ disabled: true });

    const input = screen.getByPlaceholderText("e.g., npm run *");
    expect(input).toBeDisabled();
  });

  it("disables add button when disabled is true", () => {
    renderSection({ disabled: true });

    const addButton = screen.getByRole("button");
    expect(addButton).toBeDisabled();
  });

  it("disables remove buttons when disabled is true", () => {
    renderSection({ disabled: true, permissions: { allow: ["npm run *"] } });

    const removeButton = screen.getByRole("button", { name: "Remove npm run *" });
    expect(removeButton).toBeDisabled();
  });

  it("shows locked message when disabled is true", () => {
    renderSection({ disabled: true });

    expect(screen.getByText("Locked by organization policy")).toBeInTheDocument();
  });
});

const basePermsWithLiteral: PermissionsConfig = {
  autoApproveReadOnly: false,
  allow: ["npm run *", "rm file.txt", "az repos list *"],
  tools: {},
  servers: {},
};

describe("ShellPatternsSection — literal chip", () => {
  it("renders Literal chip for patterns without *", () => {
    render(<ShellPatternsSection permissions={basePermsWithLiteral} onUpdate={() => {}} />);
    // "rm file.txt" is literal (index 1) — use data-testid to find the row
    const literalRow = screen.getByTestId("pattern-row-1");
    expect(within(literalRow).getByText("Literal")).toBeInTheDocument();
  });

  it("does not render Literal chip for patterns with *", () => {
    render(<ShellPatternsSection permissions={basePermsWithLiteral} onUpdate={() => {}} />);
    // Only one "Literal" badge should exist (for "rm file.txt"), not for wildcard patterns
    expect(screen.getAllByText("Literal")).toHaveLength(1);
  });

  it("hovering the Literal chip reveals an explanatory tooltip", async () => {
    const user = userEvent.setup();
    render(<ShellPatternsSection permissions={basePermsWithLiteral} onUpdate={() => {}} />);
    await user.hover(screen.getByText("Literal"));
    const tips = await screen.findAllByText(
      "Matches only this exact command. Any variation will re-prompt.",
    );
    expect(tips.length).toBeGreaterThan(0);
  });
});

describe("ShellPatternsSection — edit in place", () => {
  it("click on pattern converts it to input; Enter commits replacement", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn<(p: PermissionsConfig) => void>();
    render(<ShellPatternsSection permissions={basePermsWithLiteral} onUpdate={onUpdate} />);
    await user.click(screen.getByRole("button", { name: "npm run *" }));
    const input = screen.getByDisplayValue("npm run *");
    await user.clear(input);
    await user.type(input, "npm run build *");
    await user.keyboard("{Enter}");
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        allow: ["npm run build *", "rm file.txt", "az repos list *"],
      }),
    );
  });

  it("Escape cancels the edit", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn<(p: PermissionsConfig) => void>();
    render(<ShellPatternsSection permissions={basePermsWithLiteral} onUpdate={onUpdate} />);
    await user.click(screen.getByRole("button", { name: "npm run *" }));
    const input = screen.getByDisplayValue("npm run *");
    await user.clear(input);
    await user.type(input, "changed");
    await user.keyboard("{Escape}");
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "npm run *" })).toBeInTheDocument();
  });

  it("blur commits the edit (primary real-world path)", async () => {
    const ue = userEvent.setup();
    const onUpdate = vi.fn<(permissions: PermissionsConfig) => void>();
    render(<ShellPatternsSection permissions={basePerms} onUpdate={onUpdate} />);
    await ue.click(screen.getByRole("button", { name: "npm run *" }));
    const input = screen.getByDisplayValue("npm run *");
    await ue.clear(input);
    await ue.type(input, "npm run build *");
    input.blur();
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        allow: ["npm run build *", "rm file.txt", "az repos list *"],
      }),
    );
  });

  it("does not commit an edit that would duplicate another existing pattern", async () => {
    const ue = userEvent.setup();
    const onUpdate = vi.fn<(p: PermissionsConfig) => void>();
    render(<ShellPatternsSection permissions={basePerms} onUpdate={onUpdate} />);
    await ue.click(screen.getByRole("button", { name: "npm run *" }));
    const input = screen.getByDisplayValue("npm run *");
    await ue.clear(input);
    await ue.type(input, "rm file.txt{Enter}");
    expect(onUpdate).not.toHaveBeenCalled();
    // Original row still present; no duplicate was created.
    expect(screen.getByRole("button", { name: "npm run *" })).toBeInTheDocument();
  });

  it("blur does NOT commit when clicking a Remove button mid-edit", async () => {
    const ue = userEvent.setup();
    const onUpdate = vi.fn<(permissions: PermissionsConfig) => void>();
    render(<ShellPatternsSection permissions={basePerms} onUpdate={onUpdate} />);
    await ue.click(screen.getByRole("button", { name: "npm run *" }));
    const input = screen.getByDisplayValue("npm run *");
    await ue.clear(input);
    await ue.type(input, "npm run build *");
    // User changes their mind and clicks Remove on a sibling row (row 0's Remove is hidden
    // while editing; row 1's Remove is visible — same blur race applies).
    const siblingRow = screen.getByTestId("pattern-row-1");
    const removeBtn = within(siblingRow).getByRole("button", { name: /^Remove/ });
    await ue.click(removeBtn);
    // Single onUpdate call — the Remove one, without the in-progress edit.
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        allow: ["npm run *", "az repos list *"],
      }),
    );
  });
});

describe("ShellPatternsSection unrepresentablePatterns", () => {
  it("renders warning chip for patterns in the unrepresentable list", () => {
    render(
      <ShellPatternsSection
        permissions={{
          autoApproveReadOnly: false,
          allow: ["git", "gh api repos/*"],
          tools: {},
          servers: {},
        }}
        onUpdate={() => {}}
        unrepresentablePatterns={["gh api repos/*"]}
      />,
    );
    expect(screen.getAllByLabelText(/limited.*gateway/i).length).toBeGreaterThan(0);
  });

  it("does not render warning chip when list is empty", () => {
    render(
      <ShellPatternsSection
        permissions={{
          autoApproveReadOnly: false,
          allow: ["git"],
          tools: {},
          servers: {},
        }}
        onUpdate={() => {}}
      />,
    );
    expect(screen.queryAllByLabelText(/limited.*gateway/i).length).toBe(0);
  });
});
