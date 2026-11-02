import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HotkeysRoot } from "./MarshalHotkeysRuntimeRoot";

describe("HotkeysRoot", () => {
  it("renders children inside the hotkeys provider", () => {
    render(
      <HotkeysRoot>
        <div>Hotkeys child</div>
      </HotkeysRoot>,
    );

    expect(screen.getByText("Hotkeys child")).toBeInTheDocument();
  });
});
