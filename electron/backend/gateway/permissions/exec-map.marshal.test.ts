// Marshal-owned test
import { describe, expect, it } from "vitest";

import {
  buildExecPatchFromAutoApprove,
  buildExecPatchFromShellAllow,
  execToAutoApproveReadOnly,
  execToShellAllow,
  isShellPatternRepresentable,
} from "./exec-map";

describe("execToAutoApproveReadOnly", () => {
  it("returns true when ask is on-miss", () => {
    expect(execToAutoApproveReadOnly({ ask: "on-miss" })).toBe(true);
  });

  it("returns false when ask is always", () => {
    expect(execToAutoApproveReadOnly({ ask: "always" })).toBe(false);
  });

  it("returns false when ask is off (defensive — full auto)", () => {
    expect(execToAutoApproveReadOnly({ ask: "off" })).toBe(false);
  });

  it("returns false when exec is undefined", () => {
    expect(execToAutoApproveReadOnly(undefined)).toBe(false);
  });
});

describe("buildExecPatchFromAutoApprove", () => {
  it("maps true to ask=on-miss, security=allowlist", () => {
    expect(buildExecPatchFromAutoApprove(true)).toEqual({
      ask: "on-miss",
      security: "allowlist",
    });
  });

  it("maps false to ask=always", () => {
    expect(buildExecPatchFromAutoApprove(false)).toEqual({ ask: "always" });
  });
});

describe("isShellPatternRepresentable", () => {
  it("accepts plain binary names", () => {
    expect(isShellPatternRepresentable("git")).toBe(true);
    expect(isShellPatternRepresentable("npm")).toBe(true);
  });

  it("rejects glob patterns and command-with-args", () => {
    expect(isShellPatternRepresentable("gh api repos/foo/*")).toBe(false);
    expect(isShellPatternRepresentable("git status")).toBe(false);
    expect(isShellPatternRepresentable("ls *.tmp")).toBe(false);
  });

  it("rejects empty/whitespace", () => {
    expect(isShellPatternRepresentable("")).toBe(false);
    expect(isShellPatternRepresentable("   ")).toBe(false);
  });
});

describe("execToShellAllow", () => {
  it("returns safeBins as the allow list", () => {
    expect(execToShellAllow({ safeBins: ["git", "gh"] })).toEqual(["git", "gh"]);
  });

  it("returns empty array when safeBins is missing", () => {
    expect(execToShellAllow({})).toEqual([]);
    expect(execToShellAllow(undefined)).toEqual([]);
  });
});

describe("buildExecPatchFromShellAllow", () => {
  it("partitions patterns into representable safeBins and unrepresentable rejects", () => {
    expect(buildExecPatchFromShellAllow(["git", "gh api repos/*", "npm"])).toEqual({
      patch: { safeBins: ["git", "npm"] },
      rejected: ["gh api repos/*"],
    });
  });

  it("returns empty rejected when all patterns are binaries", () => {
    expect(buildExecPatchFromShellAllow(["git", "npm"])).toEqual({
      patch: { safeBins: ["git", "npm"] },
      rejected: [],
    });
  });
});
