// Marshal-owned tooling test.
import { describe, expect, it } from "vitest";

import { normalizeState, parseRepoSlug } from "../src/marshal-review-github.ts";

describe("parseRepoSlug", () => {
  it("extracts owner/repo from a standard pull URL", () => {
    expect(parseRepoSlug("https://github.com/OmerMachluf/marshal/pull/1234")).toBe(
      "OmerMachluf/marshal",
    );
  });

  it("tolerates a trailing path segment (files, commits, etc.)", () => {
    expect(parseRepoSlug("https://github.com/OmerMachluf/marshal/pull/42/files")).toBe(
      "OmerMachluf/marshal",
    );
  });

  it("is case-insensitive on the scheme/host", () => {
    expect(parseRepoSlug("HTTPS://GitHub.com/OmerMachluf/marshal/pull/1")).toBe(
      "OmerMachluf/marshal",
    );
  });

  it("returns null for non-pull URLs", () => {
    expect(parseRepoSlug("https://github.com/OmerMachluf/marshal")).toBeNull();
    expect(parseRepoSlug("https://github.com/OmerMachluf/marshal/issues/1")).toBeNull();
  });

  it("returns null for non-github hosts", () => {
    expect(parseRepoSlug("https://gitlab.com/foo/bar/pull/1")).toBeNull();
    expect(parseRepoSlug("https://example.com/OmerMachluf/marshal/pull/1")).toBeNull();
  });

  it("returns null for malformed inputs", () => {
    expect(parseRepoSlug("")).toBeNull();
    expect(parseRepoSlug("not-a-url")).toBeNull();
    expect(parseRepoSlug("https://github.com//m/pull/1")).toBeNull();
  });
});

describe("normalizeState", () => {
  it("uppercases the lowercase gh output", () => {
    expect(normalizeState("open")).toBe("OPEN");
    expect(normalizeState("merged")).toBe("MERGED");
    expect(normalizeState("closed")).toBe("CLOSED");
  });

  it("accepts already-uppercase input (defense-in-depth)", () => {
    expect(normalizeState("OPEN")).toBe("OPEN");
    expect(normalizeState("MERGED")).toBe("MERGED");
  });

  it("returns null for unknown / non-string input", () => {
    expect(normalizeState("draft")).toBeNull();
    expect(normalizeState("")).toBeNull();
    expect(normalizeState(null)).toBeNull();
    expect(normalizeState(42)).toBeNull();
    expect(normalizeState({ state: "merged" })).toBeNull();
  });
});
