import { describe, expect, it } from "vitest";

import { getInitials } from "./initials";

describe("getInitials", () => {
  it("returns null for undefined, empty, or whitespace-only input", () => {
    expect(getInitials(undefined)).toBeNull();
    expect(getInitials(null)).toBeNull();
    expect(getInitials("")).toBeNull();
    expect(getInitials("   ")).toBeNull();
  });

  it("returns a single uppercase letter for one-token names", () => {
    expect(getInitials("Cher")).toBe("C");
    expect(getInitials("dino")).toBe("D");
  });

  it("returns first + last token initials for multi-token names", () => {
    expect(getInitials("Dino Ilic")).toBe("DI");
    expect(getInitials("Dino van der Berg")).toBe("DB");
  });

  it("collapses extra whitespace", () => {
    expect(getInitials("  Dino   Ilic  ")).toBe("DI");
  });

  it("preserves non-Latin glyphs without crashing", () => {
    expect(getInitials("张 伟")).toBe("张伟");
    expect(getInitials("Ångström")).toBe("Å");
  });
});
