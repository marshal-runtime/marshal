import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/tmp" },
}));

import {
  getRepositoryAgentByPath,
  getRepositoryCustomizationsForSystemPrompt,
  getRepositorySkillProviderRoots,
  loadRepositoryAgents,
  loadRepositoryCommands,
  loadRepositoryInstructions,
} from "./repository-customizations";
import { SkillCatalog } from "../../skills";

const temporaryRoots: string[] = [];

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-customizations-"));
  temporaryRoots.push(root);
  return root;
}

function write(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("cross-runtime repository customizations", () => {
  it("normalizes Copilot, Cursor, and Claude agents into one assignable catalog", () => {
    const root = repository();
    write(root, ".github/agents/reviewer.agent.md", "---\nname: reviewer\ndescription: GitHub review\n---\nReview GitHub changes.");
    write(root, ".cursor/agents/planner.md", "---\nname: planner\ndescription: Cursor planning\nmodel: inherit\n---\nPlan the work.");
    write(root, ".claude/agents/implementer.md", "---\nname: implementer\ndescription: Claude implementation\n---\nImplement carefully.");

    expect(loadRepositoryAgents(root)).toEqual([
      expect.objectContaining({ name: "reviewer", source: "copilot" }),
      expect.objectContaining({ name: "planner", source: "cursor", model: "inherit" }),
      expect.objectContaining({ name: "implementer", source: "claude" }),
    ]);
    expect(getRepositoryAgentByPath(root, ".cursor/agents/planner.md")).toEqual(
      expect.objectContaining({ source: "cursor", instructions: "Plan the work." }),
    );
  });

  it("discovers hierarchical instructions, native rules, skills, and commands", () => {
    const root = repository();
    write(root, "AGENTS.md", "Shared project instructions");
    write(root, "packages/web/CLAUDE.md", "Web package instructions");
    write(root, ".cursor/rules/testing.mdc", "---\nalwaysApply: true\n---\nRun browser tests.");
    write(
      root,
      ".cursor/rules/python.mdc",
      "---\ndescription: Python conventions\nglobs: '*.py'\nalwaysApply: false\n---\nUse the private Python rule body.",
    );
    write(root, ".claude/rules/security.md", "Never expose secrets.");
    write(root, ".github/copilot-instructions.md", "Follow repository conventions.");
    write(root, ".cursor/skills/design/SKILL.md", "---\nname: design\ndescription: Design workflow\n---\nDesign it.");
    write(root, ".claude/skills/debug/SKILL.md", "---\nname: debug\ndescription: Debug workflow\n---\nDebug it.");
    write(root, ".github/skills/release/SKILL.md", "---\nname: release\ndescription: Release workflow\n---\nRelease it.");
    write(root, ".cursor/commands/check.md", "---\nname: check\ndescription: Check everything\n---\nRun checks.");
    write(root, ".claude/commands/ship.md", "Ship the change.");

    expect(loadRepositoryInstructions(root).map((item) => item.path)).toEqual(
      expect.arrayContaining([
        ".github/copilot-instructions.md",
        "AGENTS.md",
        path.join("packages", "web", "CLAUDE.md"),
        path.join(".cursor", "rules", "testing.mdc"),
        path.join(".cursor", "rules", "python.mdc"),
        path.join(".claude", "rules", "security.md"),
      ]),
    );
    expect(loadRepositoryCommands(root)).toEqual([
      expect.objectContaining({ name: "check", source: "cursor", instructions: "Run checks." }),
      expect.objectContaining({ name: "ship", source: "claude", instructions: "Ship the change." }),
    ]);
    const runtimeRoots = getRepositorySkillProviderRoots(root);
    expect(runtimeRoots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "copilot-workspace" }),
        expect.objectContaining({ id: "cursor-workspace" }),
        expect.objectContaining({ id: "claude-workspace" }),
        expect.objectContaining({ id: "cursor-commands", format: "command-files" }),
        expect.objectContaining({ id: "claude-commands", format: "command-files" }),
      ]),
    );
    expect(
      new SkillCatalog(["runtime-adapter"])
        .list({ runtimeRoots })
        .map((skill) => skill.name),
    ).toEqual(expect.arrayContaining(["release", "design", "debug", "check", "ship"]));
    const claudeRuntimeRoots = getRepositorySkillProviderRoots(root, "claude");
    expect(claudeRuntimeRoots.map((providerRoot) => providerRoot.id)).not.toContain(
      "claude-workspace",
    );
    expect(claudeRuntimeRoots.map((providerRoot) => providerRoot.id)).toContain("claude-commands");
    for (const runtimeId of ["copilot", "codex", "cursor"]) {
      expect(
        getRepositorySkillProviderRoots(root, runtimeId).map((providerRoot) => providerRoot.id),
      ).toContain("claude-workspace");
    }
    const prompt = getRepositoryCustomizationsForSystemPrompt(root);
    expect(prompt).toContain("Shared project instructions");
    expect(prompt).toContain("packages/web/CLAUDE.md");
    expect(prompt).not.toContain("Web package instructions");
    expect(prompt).toContain("/check");
    expect(prompt).toContain("/ship");
    expect(prompt).toContain("Python conventions");
    expect(prompt).toContain("applies to *.py");
    expect(prompt).not.toContain("Use the private Python rule body.");
    const cursorPrompt = getRepositoryCustomizationsForSystemPrompt(root, "cursor");
    expect(cursorPrompt).not.toContain("Run browser tests.");
    expect(cursorPrompt).not.toContain("Shared project instructions");
    expect(cursorPrompt).toContain("Never expose secrets.");
    const claudePrompt = getRepositoryCustomizationsForSystemPrompt(root, "claude");
    expect(claudePrompt).not.toContain("Never expose secrets.");
    expect(claudePrompt).toContain("Run browser tests.");
  });

  it("leaves the root AGENTS.md to Codex, which loads it natively", () => {
    const root = repository();
    write(root, "AGENTS.md", "Shared project instructions");
    write(root, "packages/web/AGENTS.md", "Web package instructions");
    write(root, ".claude/rules/security.md", "Never expose secrets.");

    const codexPrompt = getRepositoryCustomizationsForSystemPrompt(root, "codex");
    expect(codexPrompt).not.toContain("Shared project instructions");
    expect(codexPrompt).toContain("Never expose secrets.");
    expect(codexPrompt).toContain("packages/web/AGENTS.md");
    expect(getRepositoryCustomizationsForSystemPrompt(root, "copilot")).toContain(
      "Shared project instructions",
    );
  });

  it("adds no repository section for Codex when AGENTS.md is the only customization", () => {
    const root = repository();
    write(root, "AGENTS.md", "Shared project instructions");

    expect(getRepositoryCustomizationsForSystemPrompt(root, "codex")).toBe("");
  });
});
