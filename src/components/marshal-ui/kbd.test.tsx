import { describe, expect, it } from "vitest";

import { render, screen, within } from "@/test-utils";

import { CommandShortcut } from "../ui/command";
import { ContextMenuShortcut } from "../ui/context-menu";
import { DropdownMenuShortcut } from "../ui/dropdown-menu";
import { Kbd, KbdGroup, renderShortcutKeys } from "./kbd";

describe("Kbd", () => {
  it("renders keyboard hints with the shared slot and merged classes", () => {
    render(
      <Kbd className="min-w-6" aria-label="Command K">
        Cmd K
      </Kbd>,
    );

    const key = screen.getByText("Cmd K");

    expect(key.tagName).toBe("KBD");
    expect(key).toHaveAttribute("data-slot", "kbd");
    expect(key).toHaveAttribute("aria-label", "Command K");
    expect(key).toHaveClass("min-w-6");
    expect(key).toHaveClass("rounded-sm");
  });

  it("groups multiple keycaps for keyboard shortcuts", () => {
    render(
      <KbdGroup aria-label="Ctrl+K">
        <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
      </KbdGroup>,
    );

    const group = screen.getByRole("img", { name: "Ctrl+K" });
    expect(group).toHaveAttribute("data-slot", "kbd-group");
    expect(within(group).getByText("Ctrl")).toHaveAttribute("data-slot", "kbd");
    expect(within(group).getByText("K")).toHaveAttribute("data-slot", "kbd");
  });

  it("splits shortcut strings into one keycap per key", () => {
    render(<KbdGroup aria-label="Ctrl+Shift+K">{renderShortcutKeys("Ctrl+Shift+K")}</KbdGroup>);

    const group = screen.getByRole("img", { name: "Ctrl+Shift+K" });
    expect(within(group).getByText("Ctrl")).toHaveAttribute("data-slot", "kbd");
    expect(within(group).getByText("Shift")).toHaveAttribute("data-slot", "kbd");
    expect(within(group).getByText("K")).toHaveAttribute("data-slot", "kbd");
    expect(screen.getByText("Ctrl").tagName).toBe("KBD");
    expect(screen.getByText("Shift").tagName).toBe("KBD");
    expect(screen.getByText("K").tagName).toBe("KBD");
  });

  it("renders a literal plus key when the shortcut ends with plus", () => {
    render(<KbdGroup aria-label="Ctrl++">{renderShortcutKeys("Ctrl++")}</KbdGroup>);

    const group = screen.getByRole("img", { name: "Ctrl++" });
    expect(within(group).getByText("Ctrl")).toHaveAttribute("data-slot", "kbd");
    expect(within(group).getByText("+")).toHaveAttribute("data-slot", "kbd");
  });

  it("backs menu and command shortcut slots with grouped keyboard markup", () => {
    render(
      <>
        <CommandShortcut>Ctrl+K</CommandShortcut>
        <DropdownMenuShortcut>Ctrl+P</DropdownMenuShortcut>
        <ContextMenuShortcut>Shift+Enter</ContextMenuShortcut>
      </>,
    );

    for (const shortcut of ["Ctrl+K", "Ctrl+P", "Shift+Enter"]) {
      const group = screen.getByRole("img", { name: shortcut });
      expect(group).toHaveAttribute("data-slot", "kbd-group");
    }
  });
});
