// Marshal-owned test
import { describe, expect, it } from "vitest";

import {
  hasUnrepresentablePatterns,
  mergeBooleansIntoToolPolicy,
  toolPolicyToBooleans,
} from "./tools-map";

describe("toolPolicyToBooleans", () => {
  it("returns empty map for empty policy", () => {
    expect(toolPolicyToBooleans({})).toEqual({});
  });

  it("maps alsoAllow entries to true", () => {
    expect(toolPolicyToBooleans({ alsoAllow: ["mcp:fs:read"] })).toEqual({
      "mcp:fs:read": true,
    });
  });

  it("maps deny entries to false", () => {
    expect(toolPolicyToBooleans({ deny: ["mcp:fs:write"] })).toEqual({
      "mcp:fs:write": false,
    });
  });

  it("merges allow and alsoAllow as true (display-only fallback)", () => {
    expect(toolPolicyToBooleans({ allow: ["a"], alsoAllow: undefined, deny: ["b"] })).toEqual({
      a: true,
      b: false,
    });
  });

  it("deny wins over alsoAllow when same name in both (defensive)", () => {
    expect(toolPolicyToBooleans({ alsoAllow: ["x"], deny: ["x"] })).toEqual({ x: false });
  });
});

describe("mergeBooleansIntoToolPolicy", () => {
  it("starts from empty policy and writes booleans", () => {
    expect(mergeBooleansIntoToolPolicy({}, { foo: true, bar: false })).toEqual({
      alsoAllow: ["foo"],
      deny: ["bar"],
    });
  });

  it("removes a name from alsoAllow when newly false", () => {
    expect(
      mergeBooleansIntoToolPolicy({ alsoAllow: ["foo", "bar"], deny: [] }, { foo: false }),
    ).toEqual({ alsoAllow: ["bar"], deny: ["foo"] });
  });

  it("removes a name from deny when newly true", () => {
    expect(mergeBooleansIntoToolPolicy({ deny: ["foo"] }, { foo: true })).toEqual({
      alsoAllow: ["foo"],
      deny: [],
    });
  });

  it("preserves entries not mentioned in the patch", () => {
    expect(mergeBooleansIntoToolPolicy({ alsoAllow: ["a"], deny: ["b"] }, { c: true })).toEqual({
      alsoAllow: ["a", "c"],
      deny: ["b"],
    });
  });

  it("is idempotent (writing same boolean twice has no effect)", () => {
    const first = mergeBooleansIntoToolPolicy({}, { foo: true });
    const second = mergeBooleansIntoToolPolicy(first, { foo: true });
    expect(second).toEqual(first);
  });
});

describe("hasUnrepresentablePatterns", () => {
  it("returns false for plain tool names", () => {
    expect(hasUnrepresentablePatterns({ alsoAllow: ["mcp:fs:read"], deny: ["foo"] })).toBe(false);
  });

  it("returns true when alsoAllow contains a glob", () => {
    expect(hasUnrepresentablePatterns({ alsoAllow: ["mcp:fs:*"] })).toBe(true);
  });

  it("returns true when deny contains a glob", () => {
    expect(hasUnrepresentablePatterns({ deny: ["mcp:*"] })).toBe(true);
  });

  it("returns true when allow[] (strict mode) is set", () => {
    expect(hasUnrepresentablePatterns({ allow: ["foo"] })).toBe(true);
  });
});
