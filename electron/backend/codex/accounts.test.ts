import path from "node:path";

import { describe, expect, it } from "vitest";

import { codexAccountHome } from "./accounts";

describe("codexAccountHome", () => {
  it("gives each extra account its own CODEX_HOME and rejects unsafe ids", () => {
    expect(codexAccountHome("work", "/home/me")).toBe(
      path.join("/home/me", ".marshal", "marshal-codex-accounts", "work"),
    );
    expect(() => codexAccountHome("../escape", "/home/me")).toThrow("Invalid Codex account id");
  });
});
