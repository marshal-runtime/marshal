import { describe, it, expect } from "vitest";

import { BUILT_IN_AGENT_TYPES, isBuiltInAgentType } from "./built-in-agent-types";

describe("isBuiltInAgentType", () => {
  it("recognizes every name in BUILT_IN_AGENT_TYPES", () => {
    for (const name of BUILT_IN_AGENT_TYPES) {
      expect(isBuiltInAgentType(name)).toBe(true);
    }
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(isBuiltInAgentType("General-Purpose")).toBe(true);
    expect(isBuiltInAgentType("  rubber-duck  ")).toBe(true);
    expect(isBuiltInAgentType("CODE-REVIEW")).toBe(true);
  });

  it("rejects unknown names and empty values", () => {
    expect(isBuiltInAgentType("oncall-investigator")).toBe(false);
    expect(isBuiltInAgentType("./bundled.agent.md")).toBe(false);
    expect(isBuiltInAgentType("")).toBe(false);
    expect(isBuiltInAgentType(undefined)).toBe(false);
    expect(isBuiltInAgentType(null)).toBe(false);
  });
});
