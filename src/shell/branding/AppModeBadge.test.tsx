import { describe, expect, it } from "vitest";

import { render, screen } from "@/test-utils";

import { AppModeBadge } from "./AppModeBadge";

describe("AppModeBadge", () => {
  it.each([
    ["dev", "DEV"],
    ["beta", "BETA"],
  ] as const)("renders the %s label", (mode, label) => {
    render(<AppModeBadge mode={mode} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByLabelText(`${label} mode`)).toBeInTheDocument();
  });

  it("renders nothing for release mode", () => {
    const { container } = render(<AppModeBadge mode="release" />);
    expect(container).toBeEmptyDOMElement();
  });
});
