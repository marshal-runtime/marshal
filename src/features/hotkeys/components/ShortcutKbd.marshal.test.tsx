// marshal-owned renderer test
import { describe, expect, it } from "vitest";

import { render, screen, within } from "@/test-utils";

import { ShortcutKbd } from "./ShortcutKbd";

describe("ShortcutKbd", () => {
  it("formats TanStack hotkey strings with grouped keycaps", () => {
    render(<ShortcutKbd hotkey="mod+k" />);

    const group = screen.getByLabelText("Ctrl+K");

    expect(group).toHaveAttribute("data-slot", "kbd-group");
    expect(within(group).getByText("Ctrl").tagName).toBe("KBD");
    expect(within(group).getByText("K").tagName).toBe("KBD");
  });
});
