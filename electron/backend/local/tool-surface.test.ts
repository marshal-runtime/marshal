import { describe, expect, it } from "vitest";

import type { RuntimeTool } from "../runtime-contract";
import { restrictToolSurface } from "./tool-surface";

function tool(name: string): RuntimeTool {
  return { name, description: name, parameters: { type: "object" }, handler: async () => "" };
}

const tools = ["runtimeSearch", "runtimeInvoke", "runtimeExecuteTypeScript", "setSessionTodos"].map(
  tool,
);

describe("restrictToolSurface", () => {
  it("leaves an unrestricted session untouched", () => {
    const surface = restrictToolSurface(tools, undefined, { failOnUnknown: true });
    expect(surface.tools.map((entry) => entry.name)).toEqual(tools.map((entry) => entry.name));
    expect(surface.availableTools).toBeUndefined();
  });

  it("keeps only the allowlisted tools and mirrors them as the runtime allowlist", () => {
    const surface = restrictToolSurface(tools, ["runtimeInvoke", "runtimeSearch"], {
      failOnUnknown: true,
    });
    expect(surface.tools.map((entry) => entry.name)).toEqual(["runtimeInvoke", "runtimeSearch"]);
    expect(surface.availableTools).toEqual(["runtimeInvoke", "runtimeSearch"]);
  });

  it("treats an empty allowlist as tool-free", () => {
    expect(restrictToolSurface(tools, [], { failOnUnknown: true })).toEqual({
      tools: [],
      availableTools: [],
    });
  });

  it("fails closed on unknown names at creation", () => {
    expect(() =>
      restrictToolSurface(tools, ["runtimeInvoke", "bash"], { failOnUnknown: true }),
    ).toThrow(/unknown host tools: bash/);
  });

  it("drops unknown names on resume instead of widening or stranding the session", () => {
    const surface = restrictToolSurface(tools, ["runtimeInvoke", "gone"], { failOnUnknown: false });
    expect(surface.availableTools).toEqual(["runtimeInvoke"]);
  });
});
