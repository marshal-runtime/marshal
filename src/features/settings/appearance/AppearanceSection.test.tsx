import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { installMockAPIs } from "@/test-utils";

import { AppearanceSection } from "./AppearanceSection";

describe("AppearanceSection", () => {
  it("forwards the selected theme and trigger element", async () => {
    const user = userEvent.setup();
    const onThemeChange =
      vi.fn<(theme: "system" | "light" | "dark", origin?: HTMLElement | null) => void>();
    installMockAPIs();
    render(<AppearanceSection theme="system" onThemeChange={onThemeChange} />);

    const trigger = screen.getByRole("combobox");
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Dark" }));
    expect(onThemeChange).toHaveBeenCalledWith("dark", trigger);
  });
});
