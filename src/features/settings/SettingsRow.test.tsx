import { describe, it, expect } from "vitest";

import { render, screen } from "@/test-utils";

import { SettingsRow } from "./SettingsRow";

describe("SettingsRow", () => {
  it("renders a <label> linked to the control when htmlFor is set", () => {
    render(
      <SettingsRow htmlFor="email-toggle" label="Email">
        <input id="email-toggle" type="checkbox" />
      </SettingsRow>,
    );
    expect(screen.getByLabelText("Email")).toBe(screen.getByRole("checkbox"));
    const labelText = screen.getByText("Email");
    expect(labelText.closest("label")).not.toBeNull();
  });

  it("does not render a <label> element when htmlFor is omitted", () => {
    render(
      <SettingsRow label="Stats">
        <span />
      </SettingsRow>,
    );
    // Without htmlFor, the label slot is a <span>, so getByLabelText should miss.
    expect(screen.queryByLabelText("Stats")).not.toBeInTheDocument();
    const labelText = screen.getByText("Stats");
    expect(labelText).toBeInTheDocument();
    expect(labelText.closest("label")).toBeNull();
  });

  it("renders the description text when provided", () => {
    render(
      <SettingsRow label="Theme" description="Choose system, light, or dark.">
        <span />
      </SettingsRow>,
    );
    expect(screen.getByText("Choose system, light, or dark.")).toBeInTheDocument();
  });

  it("applies cursor-pointer to the label only when htmlFor is set", () => {
    render(
      <SettingsRow htmlFor="x" label="Linked">
        <input id="x" type="checkbox" />
      </SettingsRow>,
    );
    expect(screen.getByText("Linked")).toHaveClass("cursor-pointer");
  });

  it("scopes getByLabelText to the label text, not the description", () => {
    render(
      <SettingsRow htmlFor="t" label="Theme" description="Light or dark.">
        <input id="t" type="checkbox" />
      </SettingsRow>,
    );
    // Exact-match getByLabelText resolves to the input via the label text alone.
    expect(screen.getByLabelText("Theme")).toBe(screen.getByRole("checkbox"));
  });

  it("renders a divided row with the control in the action slot", () => {
    render(
      <SettingsRow label="Storage">
        <button type="button">Configure</button>
      </SettingsRow>,
    );

    const button = screen.getByRole("button", { name: "Configure" });
    const action = button.parentElement;
    const tile = action?.parentElement;

    expect(tile).toHaveAttribute("data-slot", "settings-control-tile");
    expect(tile).toHaveClass("grid", "border-b");
    expect(action).toContainElement(button);
  });
});
