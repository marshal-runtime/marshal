import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Skill } from "@/types/electron";

import { SkillMenuOption } from "../editor/plugins/SkillTypeaheadPlugin";
import { SkillCommandPalette } from "./SkillCommandPalette";

function makeSkill(id: string, name: string, scope: Skill["scope"] = "local"): Skill {
  return {
    id,
    name,
    description: `${name} description`,
    instructions: "",
    enabled: true,
    scope,
    createdAt: new Date().toISOString(),
  };
}

function makeOption(id: string, name: string, scope: Skill["scope"] = "local"): SkillMenuOption {
  return new SkillMenuOption(makeSkill(id, name, scope));
}

const noopIndex = vi.fn<(i: number) => void>();
const noopOption = vi.fn<(o: SkillMenuOption) => void>();

beforeEach(() => {
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SkillCommandPalette", () => {
  // --- Rendering ---

  it("renders nothing when options array is empty", () => {
    const { container } = render(
      <SkillCommandPalette
        options={[]}
        selectedIndex={0}
        onHover={noopIndex}
        onSelect={noopOption}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders all skills with slash-prefixed names", () => {
    const threeOptions = [
      makeOption("a", "alpha"),
      makeOption("b", "beta"),
      makeOption("c", "gamma"),
    ];
    render(
      <SkillCommandPalette
        options={threeOptions}
        selectedIndex={0}
        onHover={noopIndex}
        onSelect={noopOption}
      />,
    );
    expect(screen.getByText("/alpha")).toBeInTheDocument();
    expect(screen.getByText("/beta")).toBeInTheDocument();
    expect(screen.getByText("/gamma")).toBeInTheDocument();
  });

  it("renders skill descriptions", () => {
    const oneOption = [makeOption("a", "alpha")];
    render(
      <SkillCommandPalette
        options={oneOption}
        selectedIndex={0}
        onHover={noopIndex}
        onSelect={noopOption}
      />,
    );
    expect(screen.getByText("alpha description")).toBeInTheDocument();
  });

  it("shows 'Global' badge only for global-scoped skills", () => {
    const mixed = [
      makeOption("loc", "local-skill", "local"),
      makeOption("glo", "global-skill", "global"),
      makeOption("bun", "bundled-skill", "bundled"),
    ];
    render(
      <SkillCommandPalette
        options={mixed}
        selectedIndex={0}
        onHover={noopIndex}
        onSelect={noopOption}
      />,
    );
    const badges = screen.getAllByText("Global");
    expect(badges).toHaveLength(1);
  });

  // --- Selection / aria ---

  it("marks the selected item with aria-selected and data-selected", () => {
    const twoOptions = [makeOption("a", "alpha"), makeOption("b", "beta")];
    render(
      <SkillCommandPalette
        options={twoOptions}
        selectedIndex={1}
        onHover={noopIndex}
        onSelect={noopOption}
      />,
    );
    const items = screen.getAllByRole("option");
    expect(items[0]).toHaveAttribute("aria-selected", "false");
    expect(items[0]).toHaveAttribute("data-selected", "false");
    expect(items[1]).toHaveAttribute("aria-selected", "true");
    expect(items[1]).toHaveAttribute("data-selected", "true");
  });

  // --- Ref wiring (Lexical scroll-into-view) ---

  it("wires setRefElement on each rendered option", () => {
    const twoOptions = [makeOption("a", "alpha"), makeOption("b", "beta")];
    render(
      <SkillCommandPalette
        options={twoOptions}
        selectedIndex={0}
        onHover={noopIndex}
        onSelect={noopOption}
      />,
    );
    // setRefElement should have been called with the DOM element
    expect(twoOptions[0]?.ref?.current).toBeInstanceOf(HTMLElement);
    expect(twoOptions[1]?.ref?.current).toBeInstanceOf(HTMLElement);
  });

  // --- Callbacks ---

  it("calls onSelect with the correct option when clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn<(o: SkillMenuOption) => void>();
    const twoOptions = [makeOption("a", "alpha"), makeOption("b", "beta")];
    render(
      <SkillCommandPalette
        options={twoOptions}
        selectedIndex={0}
        onHover={noopIndex}
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByText("/beta"));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(twoOptions[1]);
  });

  it("calls onHover with the correct index on mouseEnter", async () => {
    const user = userEvent.setup();
    const onHover = vi.fn<(i: number) => void>();
    const twoOptions = [makeOption("a", "alpha"), makeOption("b", "beta")];
    render(
      <SkillCommandPalette
        options={twoOptions}
        selectedIndex={0}
        onHover={onHover}
        onSelect={noopOption}
      />,
    );

    await user.hover(screen.getByText("/beta"));

    expect(onHover).toHaveBeenCalledWith(1);
  });
});
