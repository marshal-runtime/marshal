import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveWorktreeRoot } from "./worktree-root";

describe("resolveWorktreeRoot", () => {
  it("uses the existing app-data location by default", () => {
    expect(resolveWorktreeRoot("C:/Users/test/.marshal")).toBe(
      path.join("C:/Users/test/.marshal", "marshal-worktrees"),
    );
  });

  it("uses a configured directory for future worktrees", () => {
    expect(resolveWorktreeRoot("C:/Users/test/.marshal", " Q:/Marshal/worktrees ")).toBe(
      path.resolve("Q:/Marshal/worktrees"),
    );
  });
});
