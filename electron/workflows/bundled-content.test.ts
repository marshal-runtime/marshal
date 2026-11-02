/**
 * IMPL-SKILL — sanity checks for the bundled workflow-author skill.
 *
 * We do NOT execute the workflow.ts default exports because the foundation
 * `defineWorkflow` throws `NotImplementedError` until IMPL-SDK fills it in.
 * Instead we read each example file as text and assert it contains the
 * minimum shape — `import { defineWorkflow }`, `export default defineWorkflow(`,
 * an `id:` literal, a `run:` arrow.
 *
 * Compile-time correctness is enforced separately by `pnpm typecheck`,
 * which picks up the example files via the tsconfig `include` extension
 * added in this branch.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "path";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const EXAMPLES_DIR = join(REPO_ROOT, "first-party-skills", "workflow-author", "examples");
const SKILL_MD = join(REPO_ROOT, "first-party-skills", "workflow-author", "SKILL.md");

function listExampleDirs(): string[] {
  if (!existsSync(EXAMPLES_DIR)) return [];
  return readdirSync(EXAMPLES_DIR).filter((name) =>
    statSync(join(EXAMPLES_DIR, name)).isDirectory(),
  );
}

describe("bundled workflow-author skill", () => {
  it("ships SKILL.md with parseable YAML frontmatter", () => {
    expect(existsSync(SKILL_MD)).toBe(true);
    const content = readFileSync(SKILL_MD, "utf-8");
    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
    expect(match, "SKILL.md must start with --- frontmatter ---").toBeTruthy();
    const frontmatter = match![1];
    expect(frontmatter).toMatch(/^name:\s*workflow-author\s*$/m);
    expect(frontmatter).toMatch(/^description:\s*['"].+['"]\s*$/m);
  });

  it("ships the required reference files", () => {
    const root = join(REPO_ROOT, "first-party-skills", "workflow-author");
    for (const rel of [
      "cheatsheet.md",
      "decision-tree.md",
      "troubleshooting.md",
      "references/phase-patterns.md",
      "references/anti-patterns.md",
      "references/renderer-authoring.md",
      "templates/workflow.template.ts",
      "templates/renderer.template.tsx",
      "templates/manifest.template.json",
    ]) {
      expect(existsSync(join(root, rel)), `missing ${rel}`).toBe(true);
    }
  });

  it("ships the non-trivial worked examples named in the design", () => {
    const dirs = new Set(listExampleDirs());
    for (const expected of [
      "pr-fanout",
      "doc-translation",
      "review-rework-loop",
      "wsr-mini",
      "fanout-with-renderer",
    ]) {
      expect(dirs.has(expected), `missing example ${expected}`).toBe(true);
    }
  });

  it("every example exports a defineWorkflow default with an id and run", () => {
    const dirs = listExampleDirs();
    expect(dirs.length).toBeGreaterThan(0);

    for (const dir of dirs) {
      const wf = join(EXAMPLES_DIR, dir, "workflow.ts");
      expect(existsSync(wf), `${dir}/workflow.ts missing`).toBe(true);
      const src = readFileSync(wf, "utf-8");

      expect(src, `${dir}: must import defineWorkflow`).toMatch(
        /import\s*\{[^}]*\bdefineWorkflow\b[^}]*\}\s*from\s*["']@marshal\/workflow-sdk["']/,
      );
      expect(src, `${dir}: must export default defineWorkflow(`).toMatch(
        /export\s+default\s+defineWorkflow\s*[<(]/,
      );
      expect(src, `${dir}: must declare an id`).toMatch(/\bid:\s*["'][a-z0-9-]+["']/);
      expect(src, `${dir}: must declare schemaVersion: 1`).toMatch(/\bschemaVersion:\s*1\b/);
      expect(src, `${dir}: must define a run() body`).toMatch(/\brun:\s*async\s*\(ctx\)/);
    }
  });

  it("fanout-with-renderer ships a co-located renderer.tsx", () => {
    const renderer = join(EXAMPLES_DIR, "fanout-with-renderer", "renderer.tsx");
    expect(existsSync(renderer)).toBe(true);
    const src = readFileSync(renderer, "utf-8");
    expect(src).toMatch(
      /import\s*\{[^}]*\bdefineRenderer\b[^}]*\}\s*from\s*["']@marshal\/workflow-sdk["']/,
    );
    expect(src).toMatch(/export\s+default\s+defineRenderer\s*\(/);
    expect(src).toMatch(/workflowId:\s*["']fanout-with-renderer["']/);
  });
});
