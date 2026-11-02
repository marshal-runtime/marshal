import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import bundledSkillsManifest from "../../common/marshal-bundled-skills-manifest.json";
import { getRepositoryCustomizationsForSystemPrompt } from "../backend/local/repository-customizations";
import {
  GOLDEN_ASSEMBLE_CASES,
  createGoldenRepo,
  removeGoldenRepo,
} from "../test-helpers/lean-prompt-golden";
import { assembleMarshalSystemPrompt } from "./assemble";
import {
  isLeanPromptSession,
  LEAN_ONLY_SKILL_NAMES,
  resolveLeanPromptForNewSession,
} from "./lean-prompt";
import { CLAUDE_NATIVE_TOOLING } from "./sections/claude-tooling";
import { MARSHAL_HOST_TOOLS } from "./sections/host-tools";
import { applySectionEdits } from "./sections/lean-projection";
import { RUNTIME_SECTION_TEMPLATE } from "./sections/runtime-section";

describe("lean prompt flag resolution", () => {
  it("defaults ON for new sessions and honors the setting", () => {
    expect(resolveLeanPromptForNewSession(undefined, {})).toBe(true);
    expect(resolveLeanPromptForNewSession(true, {})).toBe(true);
    expect(resolveLeanPromptForNewSession(false, {})).toBe(false);
  });

  it("lets MARSHAL_LEAN_PROMPT override the setting for new sessions", () => {
    expect(resolveLeanPromptForNewSession(true, { MARSHAL_LEAN_PROMPT: "0" })).toBe(false);
    expect(resolveLeanPromptForNewSession(true, { MARSHAL_LEAN_PROMPT: "off" })).toBe(false);
    expect(resolveLeanPromptForNewSession(false, { MARSHAL_LEAN_PROMPT: "1" })).toBe(true);
    expect(resolveLeanPromptForNewSession(false, { MARSHAL_LEAN_PROMPT: "true" })).toBe(true);
    expect(resolveLeanPromptForNewSession(false, { MARSHAL_LEAN_PROMPT: "garbage" })).toBe(false);
  });

  it("keeps sessions on what they started with, except for the env kill switch", () => {
    expect(isLeanPromptSession(true, {})).toBe(true);
    expect(isLeanPromptSession(false, {})).toBe(false);
    expect(isLeanPromptSession(undefined, {})).toBe(false);
    expect(isLeanPromptSession(undefined, { MARSHAL_LEAN_PROMPT: "1" })).toBe(false);
    expect(isLeanPromptSession(true, { MARSHAL_LEAN_PROMPT: "0" })).toBe(false);
  });
});

describe("section projection", () => {
  it("is lossless when nothing is edited", () => {
    for (const text of [MARSHAL_HOST_TOOLS, CLAUDE_NATIVE_TOOLING, RUNTIME_SECTION_TEMPLATE]) {
      expect(applySectionEdits(text, [])).toBe(text);
    }
  });

  it("fails loudly when an edit targets a missing section", () => {
    expect(() => applySectionEdits("## A\nbody", [{ heading: "B" }])).toThrow(/missing section/);
  });

  it("does not split on headings inside code fences", () => {
    const text = "## A\n\n```\n## not a heading\n```\n\n## B\nbody\n";
    expect(applySectionEdits(text, [{ heading: "B" }])).toBe(
      "## A\n\n```\n## not a heading\n```\n",
    );
  });
});

describe("lean assembled prompt", () => {
  let repoRoot: string;
  beforeAll(() => {
    repoRoot = createGoldenRepo();
  });
  afterAll(() => {
    removeGoldenRepo(repoRoot);
  });

  const claudeMain = GOLDEN_ASSEMBLE_CASES.find((c) => c.name === "claude-main-with-repo")!;
  const claudeSubagent = GOLDEN_ASSEMBLE_CASES.find((c) => c.name === "claude-subagent-with-repo")!;

  function assemble(goldenCase: (typeof GOLDEN_ASSEMBLE_CASES)[number], lean: boolean): string {
    const customizations = getRepositoryCustomizationsForSystemPrompt(
      repoRoot,
      "claude",
      lean ? { lean: true } : undefined,
    );
    return assembleMarshalSystemPrompt({ ...goldenCase.input(customizations), lean }).content;
  }

  it("is substantially smaller than the legacy prompt for main and subagent sessions", () => {
    for (const goldenCase of [claudeMain, claudeSubagent]) {
      const legacy = assemble(goldenCase, false);
      const lean = assemble(goldenCase, true);
      expect(legacy.length - lean.length).toBeGreaterThan(30_000);
    }
  });

  it("keeps the behavior-changing anchors", () => {
    const lean = assemble(claudeMain, true);
    for (const anchor of [
      "## The discovery loop",
      "runtimeSearch {name:",
      "## Invocation results, errors, idempotency",
      "The grant is bound to your idempotency key",
      "## Full TypeScript execution",
      "if the command you are about to run would contain `jq`, `python -c`",
      "## Showing UI in one call: runtimeShowUi",
      "**Decision rule:** if your answer would include a table of more than 15 rows",
      "Create one without being asked whenever it serves them better than prose",
      "**Phone and desktop views.**",
      "### Where views go",
      "## Delegation: spawning and steering subagents",
      "`spawnSubagent` launches a real, user-visible Marshal session",
      "spawnSubagent creates\na separate user-visible Marshal session",
      "## Asking the user: askUser",
      "## Task records (TaskCreate, TaskGet, TaskList, TaskUpdate)",
      "Git conduct through the shell:",
      "## Code questions: search the knowledge index first",
      'getSkill {name: "runtime-ui-authoring"}',
      "end your turn: Marshal wakes you",
      "Never shrink the goal to fit the turn",
      "Propose `blocked` only for a persistent real impasse",
    ]) {
      expect(lean, anchor).toContain(anchor);
    }
  });

  it("moves interactive-UI authoring, the legacy Workflows section, and Task polling advice out of the prompt", () => {
    const lean = assemble(claudeMain, true);
    for (const removed of [
      "## Building custom React UI (agent-authored, end to end)",
      "marshal.callAction",
      "interface TriageInput",
      "## Workflows (legacy — do not author new ones here)",
      "## Reading files (Read)",
      "## Orchestration (Workflow) and remaining specialized tools",
    ]) {
      expect(lean, removed).not.toContain(removed);
    }
    expect(lean).not.toContain("do not busy-loop the same tool");
  });

  it("indexes large non-native always-apply repository rules and keeps small ones inline", () => {
    const lean = assemble(claudeMain, true);
    expect(lean).toContain("### AGENTS.md");
    expect(lean).toContain("### .cursor/rules/always/small.mdc");
    expect(lean).not.toContain("general rule 1:");
    expect(lean).toContain(
      "- .cursor/rules/always/general.mdc (4 KB): Core behavioral rules for every change",
    );
    expect(lean).toContain("already loaded natively via .claude/rules/testing.md");
    expect(lean).toContain("### Scoped Repository Rules");
    expect(lean).toContain(".cursor/rules/scoped/py.mdc: Python conventions");
  });
});

describe("lean-only bundled skill", () => {
  const skillPath = path.join(__dirname, "../../first-party-skills/runtime-ui-authoring/SKILL.md");

  it("ships as a first-party skill registered in the bundled manifest", () => {
    const skill = fs.readFileSync(skillPath, "utf8");
    expect(skill).toMatch(/^---\nname: runtime-ui-authoring\ndescription: .+\n---\n/);
    for (const anchor of [
      "ui.compile",
      "ui.render",
      "marshal.callAction",
      "Sandbox truth",
      "interface TriageInput",
      'Two different "surface" vocabularies',
    ]) {
      expect(skill, anchor).toContain(anchor);
    }
    expect(bundledSkillsManifest.skills.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([...LEAN_ONLY_SKILL_NAMES, "goals"]),
    );
  });

  it("keeps the full goal pursuit discipline reachable in the goals skill", () => {
    const goals = fs.readFileSync(
      path.join(__dirname, "../../first-party-skills/goals/SKILL.md"),
      "utf8",
    );
    expect(goals).toContain("## Pursuit discipline");
    expect(goals).toContain("**Completion is proven, not assumed.**");
  });
});
