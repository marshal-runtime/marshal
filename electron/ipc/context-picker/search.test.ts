import { describe, expect, it, vi } from "vitest";

import { searchAllTypes, type RuntimePeopleSearch } from "./search";

describe("searchAllTypes", () => {
  it("returns Runtime people results for People searches", async () => {
    const runtimePeopleSearch = vi.fn<RuntimePeopleSearch>(async () => [
      { type: "People" as const, id: "U1", displayName: "Acme Person" },
    ]);

    const entities = await searchAllTypes("acme", new Set(["People"]), runtimePeopleSearch);

    expect(entities).toEqual([{ type: "People", id: "U1", displayName: "Acme Person" }]);
    expect(runtimePeopleSearch).toHaveBeenCalledWith("acme");
  });

  it("returns no File entities of its own", async () => {
    const entities = await searchAllTypes("budget", new Set(["People", "File"]), async () => [
      { type: "People", id: "p1", displayName: "Alice" },
    ]);

    expect(entities.map((entity) => entity.type)).toEqual(["People"]);
  });

  it("skips the people provider when People is not requested", async () => {
    const runtimePeopleSearch = vi.fn<RuntimePeopleSearch>(async () => []);

    const entities = await searchAllTypes("budget", new Set(["File"]), runtimePeopleSearch);

    expect(entities).toEqual([]);
    expect(runtimePeopleSearch).not.toHaveBeenCalled();
  });

  it("degrades to no people when the Runtime provider fails", async () => {
    const entities = await searchAllTypes("acme", new Set(["People"]), async () => {
      throw new Error("provider unavailable");
    });

    expect(entities).toEqual([]);
  });

  it("returns no people when Runtime has no directory provider", async () => {
    expect(await searchAllTypes("alice", new Set(["People"]), async () => undefined)).toEqual([]);
    expect(await searchAllTypes("alice", new Set(["People"]))).toEqual([]);
  });
});
