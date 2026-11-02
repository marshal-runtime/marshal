import { describe, it, expect } from "vitest";

import { formatToolDescription } from "./marshal-format-tool-description";

describe("formatToolDescription", () => {
  it("renders canonical first-party tools without provider prefixes", () => {
    expect(formatToolDescription("listSkills", {})).toBe("Running list skills");
    expect(formatToolDescription("getSkill", {})).toBe("Running get skill");
    expect(formatToolDescription("createLocalDirectory", {})).toBe(
      "Running create local directory",
    );
  });

  it("does not rewrite an external name that resembles a legacy alias", () => {
    expect(formatToolDescription("mailservice_list_emails", {})).toBeNull();
  });

  it("keeps existing known-tool descriptions working", () => {
    expect(formatToolDescription("view", { path: "/a/b/notes.md" })).toBe("Reading notes.md");
    expect(formatToolDescription("bash", { description: "list files" })).toBe("list files");
    expect(formatToolDescription("web_search", {})).toBe("Searching the web");
  });

  it("uses PowerShell descriptions or command summaries instead of a generic label", () => {
    expect(formatToolDescription("powershell", { description: "Show worktree commit" })).toBe(
      "Show worktree commit",
    );
    expect(formatToolDescription("powershell", { command: "git status --porcelain=v1" })).toBe(
      "Running git status --porcelain=v1",
    );
  });

  it("keeps the playwright- prefix branch working", () => {
    expect(formatToolDescription("playwright-browser_navigate", {})).toBe(
      "Browser: browser navigate",
    );
  });

  it("returns null for unknown/noisy tools", () => {
    expect(formatToolDescription("some_unknown_tool", {})).toBeNull();
  });
});
