import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getRepositoryCustomizationsForSystemPrompt } from "../backend/local/repository-customizations";
import {
  GOLDEN_ASSEMBLE_CASES,
  GOLDEN_DIR,
  GOLDEN_RUNTIMES,
  GOLDEN_TOOL_OPTION_CASES,
  createGoldenRepo,
  removeGoldenRepo,
  summarizeClaudeToolOptions,
} from "../test-helpers/lean-prompt-golden";
import { assembleMarshalSystemPrompt } from "./assemble";
import { MARSHAL_BEHAVIOR_CORE } from "./sections/behavior-core";
import { LEAN_BEHAVIOR_CORE } from "./sections/lean-behavior-core";

function golden(name: string): string {
  return gunzipSync(fs.readFileSync(path.join(GOLDEN_DIR, `${name}.txt.gz`))).toString("utf8");
}

function expectIdentical(actual: string, expected: string): void {
  if (actual === expected) return;
  let index = 0;
  while (index < actual.length && actual[index] === expected[index]) index++;
  throw new Error(
    `Output differs from golden at char ${index} (actual ${actual.length}, golden ${expected.length}).\n` +
      `golden: …${JSON.stringify(expected.slice(Math.max(0, index - 60), index + 120))}\n` +
      `actual: …${JSON.stringify(actual.slice(Math.max(0, index - 60), index + 120))}`,
  );
}

describe("lean prompt flag OFF reproduces the legacy output byte-for-byte", () => {
  let repoRoot: string;
  beforeAll(() => {
    repoRoot = createGoldenRepo();
  });
  afterAll(() => {
    removeGoldenRepo(repoRoot);
  });

  it.each(GOLDEN_ASSEMBLE_CASES.map((goldenCase) => goldenCase.name))(
    "assembled system prompt: %s",
    (name) => {
      const goldenCase = GOLDEN_ASSEMBLE_CASES.find((candidate) => candidate.name === name)!;
      const customizations = getRepositoryCustomizationsForSystemPrompt(repoRoot, "claude");
      const expected = golden(`assemble-${name}`);
      expectIdentical(
        assembleMarshalSystemPrompt(goldenCase.input(customizations)).content,
        expected,
      );
      expectIdentical(
        assembleMarshalSystemPrompt({ ...goldenCase.input(customizations), lean: false }).content,
        expected,
      );
    },
  );

  it.each([...GOLDEN_RUNTIMES, "no-runtime"])("repository customizations: %s", (runtime) => {
    const runtimeId = runtime === "no-runtime" ? undefined : runtime;
    const expected = golden(`repo-customizations-${runtime}`);
    expectIdentical(getRepositoryCustomizationsForSystemPrompt(repoRoot, runtimeId), expected);
    expectIdentical(
      getRepositoryCustomizationsForSystemPrompt(repoRoot, runtimeId, { lean: false }),
      expected,
    );
  });

  it("repository customizations: no repo", () => {
    expectIdentical(
      getRepositoryCustomizationsForSystemPrompt(undefined, "claude"),
      golden("repo-customizations-no-repo"),
    );
  });

  it("lean flag ignores runtimes other than claude", () => {
    for (const runtime of ["cursor", "codex", "copilot", undefined]) {
      expectIdentical(
        getRepositoryCustomizationsForSystemPrompt(repoRoot, runtime, { lean: true }),
        getRepositoryCustomizationsForSystemPrompt(repoRoot, runtime),
      );
    }
  });

  it("claude query options (native tool list) are unchanged", () => {
    const expected: unknown = JSON.parse(
      fs.readFileSync(path.join(GOLDEN_DIR, "claude-tool-options.json"), "utf8"),
    );
    const actual = Object.fromEntries(
      GOLDEN_TOOL_OPTION_CASES.map((toolCase) => [
        toolCase.name,
        summarizeClaudeToolOptions(toolCase.config),
      ]),
    );
    expect(actual).toEqual(expected);
  });
});

describe("each lean flag changes only its own layer", () => {
  let repoRoot: string;
  beforeAll(() => {
    repoRoot = createGoldenRepo();
  });
  afterAll(() => {
    removeGoldenRepo(repoRoot);
  });

  const claudeCases = GOLDEN_ASSEMBLE_CASES.filter((goldenCase) =>
    goldenCase.name.startsWith("claude-"),
  );

  it.each(claudeCases.map((goldenCase) => goldenCase.name))(
    "leanPrompt only (stage A) matches the stage A fixture: %s",
    (name) => {
      const goldenCase = claudeCases.find((candidate) => candidate.name === name)!;
      const legacyCustomizations = getRepositoryCustomizationsForSystemPrompt(repoRoot, "claude");
      const expected = golden(`stage-a-assemble-${name}`);
      expectIdentical(
        assembleMarshalSystemPrompt({ ...goldenCase.input(legacyCustomizations), lean: true })
          .content,
        expected,
      );
      expectIdentical(
        assembleMarshalSystemPrompt({
          ...goldenCase.input(legacyCustomizations),
          lean: true,
          leanCore: false,
        }).content,
        expected,
      );
    },
  );

  it.each(claudeCases.map((goldenCase) => goldenCase.name))(
    "leanCore only swaps the behavior core in the legacy prompt: %s",
    (name) => {
      const goldenCase = claudeCases.find((candidate) => candidate.name === name)!;
      const legacyCustomizations = getRepositoryCustomizationsForSystemPrompt(repoRoot, "claude");
      const legacy = golden(`assemble-${name}`);
      expect(legacy.startsWith(MARSHAL_BEHAVIOR_CORE.trim())).toBe(true);
      expectIdentical(
        assembleMarshalSystemPrompt({ ...goldenCase.input(legacyCustomizations), leanCore: true })
          .content,
        LEAN_BEHAVIOR_CORE.trim() + legacy.slice(MARSHAL_BEHAVIOR_CORE.trim().length),
      );
    },
  );

  it.each(claudeCases.map((goldenCase) => goldenCase.name))(
    "leanPrompt and leanCore keep stage A's section list apart from deeper trims: %s",
    (name) => {
      const goldenCase = claudeCases.find((candidate) => candidate.name === name)!;
      const legacyCustomizations = getRepositoryCustomizationsForSystemPrompt(repoRoot, "claude");
      const stageA = golden(`stage-a-assemble-${name}`);
      const both = assembleMarshalSystemPrompt({
        ...goldenCase.input(legacyCustomizations),
        lean: true,
        leanCore: true,
      }).content;
      expect(both.startsWith(LEAN_BEHAVIOR_CORE.trim())).toBe(true);
      expect(both.length).toBeLessThan(stageA.length - 20_000);
    },
  );

  it("leanRepoRules only changes the repository-rule block", () => {
    expectIdentical(
      getRepositoryCustomizationsForSystemPrompt(repoRoot, "claude", { lean: true }),
      golden("repo-customizations-claude-lean"),
    );
    expectIdentical(
      getRepositoryCustomizationsForSystemPrompt(repoRoot, "claude", { lean: false }),
      golden("repo-customizations-claude"),
    );
  });
});
