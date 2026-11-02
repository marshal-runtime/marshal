import { describe, expect, it } from "vitest";

import { PALETTE, pickAvatarColorClasses } from "./avatar-color";

describe("pickAvatarColorClasses", () => {
  it("returns the muted default when key is empty or undefined", () => {
    expect(pickAvatarColorClasses(undefined)).toContain("bg-muted");
    expect(pickAvatarColorClasses("")).toContain("bg-muted");
    expect(pickAvatarColorClasses("   ")).toContain("bg-muted");
  });

  it("is deterministic for the same key", () => {
    const a = pickAvatarColorClasses("dino@example.com");
    const b = pickAvatarColorClasses("dino@example.com");
    expect(a).toBe(b);
  });

  it("trims whitespace so equivalent keys collide", () => {
    expect(pickAvatarColorClasses("  dino@example.com  ")).toBe(
      pickAvatarColorClasses("dino@example.com"),
    );
  });

  it("can reach every palette entry across a reasonable input space", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(pickAvatarColorClasses(`user${i}@example.com`));
    }
    expect(seen.size).toBe(PALETTE.length);
  });
});
