import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { render, screen, waitFor } from "@/test-utils";
import type { Skill } from "@/types/electron";

import { InputEditor, type InputEditorHandle } from "./InputEditor";

const noop = () => {};

function makeSkill(index: number): Skill {
  return {
    id: `skill-${index}`,
    name: `skill-${index}`,
    description: `Skill ${index} description`,
    instructions: "",
    enabled: true,
    createdAt: "2025-01-01",
    scope: "local",
  };
}

const MANY_SKILLS = Array.from({ length: 30 }, (_, index) => makeSkill(index));

let testStyle: HTMLStyleElement | undefined;

beforeEach(() => {
  testStyle = document.createElement("style");
  testStyle.textContent = `
    .max-h-72 { max-height: 18rem; }
    .overflow-y-auto { overflow-y: auto; }
  `;
  document.head.append(testStyle);
});

afterEach(() => {
  testStyle?.remove();
  testStyle = undefined;
});

describe("Skill typeahead keyboard navigation (browser)", () => {
  it("scrolls the menu container when ArrowDown moves the selected skill out of view", async () => {
    const user = userEvent.setup();
    const ref = createRef<InputEditorHandle>();

    render(
      <div style={{ marginTop: 360, width: 480 }}>
        <InputEditor
          ref={ref}
          ariaLabel="Prompt"
          onChange={noop}
          onChipsChange={noop}
          skills={MANY_SKILLS}
          onSelectSkill={noop}
          testId="input-editor"
        />
      </div>,
    );

    await user.click(screen.getByRole("textbox", { name: "Prompt" }));
    await user.keyboard("/");

    await screen.findByText("Skill 0 description");
    const scrollContainer = screen.getByTestId("skill-command-palette");

    expect(scrollContainer.scrollHeight).toBeGreaterThan(scrollContainer.clientHeight);
    expect(scrollContainer.scrollTop).toBe(0);

    await user.keyboard("{ArrowDown}".repeat(20));

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Skill 20 description/ })).toHaveAttribute(
        "data-selected",
        "true",
      );
      expect(scrollContainer.scrollTop).toBeGreaterThan(0);
    });
  });
});
