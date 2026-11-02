import { describe, expect, it } from "vitest";

import { render, screen } from "@/test-utils";

import { MarshalSecureAccessIcon } from "./MarshalSecureAccessIcon";

describe("MarshalSecureAccessIcon", () => {
  it("renders a decorative icon at its default size", () => {
    render(<MarshalSecureAccessIcon />);
    const svg = screen.getByTestId("marshal-secure-access-icon");

    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("width", "48");
    expect(svg).toHaveAttribute("height", "48");
    expect(svg).toHaveAttribute("viewBox", "0 0 48 48");
  });

  it("uses currentColor for the filled core and secure-access spokes", () => {
    render(<MarshalSecureAccessIcon />);

    expect(screen.getAllByTestId("marshal-secure-access-fill")).toHaveLength(5);
    for (const node of screen.getAllByTestId("marshal-secure-access-fill")) {
      expect(node).toHaveAttribute("fill", "currentColor");
    }
    expect(screen.getAllByTestId("marshal-secure-access-stroke")).toHaveLength(2);
    for (const node of screen.getAllByTestId("marshal-secure-access-stroke")) {
      expect(node).toHaveAttribute("stroke", "currentColor");
    }
  });

  it("applies a custom size", () => {
    render(<MarshalSecureAccessIcon size={32} />);
    const svg = screen.getByTestId("marshal-secure-access-icon");

    expect(svg).toHaveAttribute("width", "32");
    expect(svg).toHaveAttribute("height", "32");
  });
});
