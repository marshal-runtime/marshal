import { describe, it, expect } from "vitest";

import { maskEmail } from "./email";

describe("maskEmail", () => {
  it("masks the local part of an email", () => {
    expect(maskEmail("jane.doe@example.com")).toBe("j***@example.com");
  });

  it("handles single-char local part", () => {
    expect(maskEmail("j@example.com")).toBe("j***@example.com");
  });

  it("returns *** for invalid input without @", () => {
    expect(maskEmail("noemail")).toBe("***");
  });

  it("returns *** when @ is the first character", () => {
    expect(maskEmail("@domain.com")).toBe("***");
  });
});
