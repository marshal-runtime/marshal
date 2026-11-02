import { describe, it, expect } from "vitest";

import { isOutsideNavRight } from "./use-session-drag-out";

// Behavioral coverage (drag start/end, ESC cancel, child-target rejection) is
// exercised through LeftNav.browser.test.tsx — those scenarios need a real
// rendered consumer and real DnD events, not a synthetic harness.
describe("isOutsideNavRight", () => {
  const navRect = new DOMRect(0, 48, 250, 552);

  it("is true when the cursor is right of the nav and inside the vertical band", () => {
    expect(isOutsideNavRight(300, 200, navRect)).toBe(true);
  });

  it("is false when the cursor is inside the nav", () => {
    expect(isOutsideNavRight(100, 200, navRect)).toBe(false);
  });

  it("is true when the cursor is past the window's right edge (drag into empty desktop space)", () => {
    // Intentional: dragging out of an un-maximised window into desktop space
    // is a valid drop. The window-width clamp was removed.
    expect(isOutsideNavRight(99999, 200, navRect)).toBe(true);
  });

  it("is false when the cursor is above the nav's top edge", () => {
    expect(isOutsideNavRight(300, 10, navRect)).toBe(false);
  });

  it("is false when the cursor is below the nav's bottom edge", () => {
    expect(isOutsideNavRight(300, 700, navRect)).toBe(false);
  });
});
