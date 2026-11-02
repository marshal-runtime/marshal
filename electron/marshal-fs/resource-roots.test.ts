import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("../skills", () => ({
  LOCAL_SKILLS_DIR: "/home/.marshal/marshal-skills",
  GLOBAL_SKILLS_DIR: "/home/.marshal/skills",
}));
vi.mock("../app-paths", () => ({ getAppDataDir: () => "/home/.marshal" }));

import { getFsResourceRoots } from "./resource-roots";

describe("getFsResourceRoots", () => {
  it("returns both skill dirs and the automations resource dir (no disk I/O)", () => {
    // Pins the concrete regression from review: if any root is dropped, the
    // skills/automations the old MCP granted silently start prompting for a card.
    expect(getFsResourceRoots()).toEqual([
      "/home/.marshal/marshal-skills",
      "/home/.marshal/skills",
      path.join("/home/.marshal", "marshal-automations", "resources"),
    ]);
  });
});
