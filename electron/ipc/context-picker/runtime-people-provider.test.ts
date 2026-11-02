import { describe, expect, it, vi } from "vitest";

import { createRuntimePeopleSearch } from "./runtime-people-provider";

const scope = {
  sessionId: "session-1",
  workspaceName: "acme",
  workspacePath: "/workspaces/acme",
};

describe("createRuntimePeopleSearch", () => {
  it("discovers and invokes one tagged Runtime directory provider", async () => {
    const search = vi.fn<Parameters<typeof createRuntimePeopleSearch>[0]["host"]["search"]>(
      async () => ({
        protocolVersion: "1.0.0" as const,
        query: "",
        detail: "summary" as const,
        matches: [
          {
            protocolVersion: "1.0.0" as const,
            capability: { name: "company_people_search" },
            score: 1,
            matchedTerms: [],
            matchedFields: [],
          },
        ],
      }),
    );
    const execute = vi.fn<Parameters<typeof createRuntimePeopleSearch>[0]["host"]["execute"]>(
      async () => ({
        protocolVersion: "1.0.0" as const,
        status: "success" as const,
        result: { output: { people: [{ id: "U1", displayName: "Ada", title: "Engineer" }] } },
        receipt: { executionId: "exec-1", startedAt: "now", completedAt: "now" },
      }),
    );
    const provider = createRuntimePeopleSearch({
      host: { search, execute },
      resolveScope: async () => scope,
    });

    await expect(provider("ada")).resolves.toEqual([
      {
        type: "People",
        id: "U1",
        referenceId: "U1",
        displayName: "Ada",
        jobTitle: "Engineer",
      },
    ]);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["directory", "people", "context-picker"] }),
      expect.objectContaining({ sessionId: "session-1", workspacePath: "/workspaces/acme" }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "company_people_search",
        input: { query: "ada", limit: 25 },
      }),
      expect.anything(),
    );
  });

  it("returns undefined when no Runtime directory provider is installed", async () => {
    const provider = createRuntimePeopleSearch({
      host: {
        search: async () => ({
          protocolVersion: "1.0.0",
          query: "",
          detail: "summary",
          matches: [],
        }),
        execute: vi.fn<Parameters<typeof createRuntimePeopleSearch>[0]["host"]["execute"]>(),
      },
      resolveScope: async () => scope,
    });
    await expect(provider("ada")).resolves.toBeUndefined();
  });
});
