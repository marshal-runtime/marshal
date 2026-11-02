// Marshal-owned module.
import { describe, it, expect } from "vitest";

import { render, screen } from "@/test-utils";

import { SectionHeader } from "./section-header";

describe("SectionHeader", () => {
  it("renders an h3 with the title text", () => {
    render(<SectionHeader>Permissions</SectionHeader>);
    expect(screen.getByRole("heading", { level: 3, name: "Permissions" })).toBeInTheDocument();
  });

  it("renders the divider element by default", () => {
    render(<SectionHeader>Memory</SectionHeader>);
    expect(screen.getByTestId("section-header-divider")).toBeInTheDocument();
  });

  it("omits the divider when divider={false}", () => {
    render(<SectionHeader divider={false}>Servers</SectionHeader>);
    expect(screen.queryByTestId("section-header-divider")).not.toBeInTheDocument();
  });

  it("merges className onto the heading element when divider is off", () => {
    render(
      <SectionHeader divider={false} className="mt-4">
        B
      </SectionHeader>,
    );
    expect(screen.getByRole("heading", { level: 3, name: "B" })).toHaveClass("mt-4");
  });

  it("merges className onto the wrapper when divider is on", () => {
    render(<SectionHeader className="mt-4">A</SectionHeader>);
    // Heading is wrapped in the wrapper; the wrapper carries className.
    expect(screen.getByRole("heading", { level: 3, name: "A" }).parentElement).toHaveClass("mt-4");
  });
});
