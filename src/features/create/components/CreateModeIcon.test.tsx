import { describe, expect, it } from "vitest";

import { render } from "@/test-utils";

import { CreateModeIcon } from "./CreateModeIcon";

describe("CreateModeIcon", () => {
  it("gives default instances unique definitions and matching fill references", () => {
    render(
      <>
        <CreateModeIcon />
        <CreateModeIcon />
      </>,
    );
    const svgs = document.querySelectorAll("svg");
    const gradients = [...document.querySelectorAll("linearGradient")];
    const prefixes = gradients
      .map((gradient) => gradient.id.replace(/-(?:core|orbit)$/, ""))
      .filter((prefix, index, all) => all.indexOf(prefix) === index);

    expect(prefixes).toHaveLength(2);
    expect(svgs).toHaveLength(2);
    for (const [index, svg] of [...svgs].entries()) {
      expect(svg).toHaveAttribute("aria-hidden", "true");
      const core = svg.querySelector("path");
      expect(core).toHaveAttribute("fill", `url(#${prefixes[index]}-core)`);
      expect(svg.querySelectorAll(`[fill="url(#${prefixes[index]}-orbit)"]`)).toHaveLength(2);
    }
  });

  it("supports custom size, class, and explicit definition namespace", () => {
    render(<CreateModeIcon id="workspace" size={32} className="size-8" />);
    const svg = document.querySelector("svg");
    expect(svg).toHaveAttribute("width", "32");
    expect(svg).toHaveAttribute("height", "32");
    expect(svg).toHaveClass("size-8");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(document.getElementById("workspace-core")).toBeInTheDocument();
    expect(document.getElementById("workspace-orbit")).toBeInTheDocument();
  });
});
