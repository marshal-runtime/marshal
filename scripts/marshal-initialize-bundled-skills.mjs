#!/usr/bin/env node
/**
 * Initializes bundled skill files: downloads from anthropics/skills using the
 * skills CLI, then copies first-party skills committed to the repo.
 * Run automatically before builds via `pnpm run prebuild:skills`, or manually:
 *
 *   node scripts/marshal-initialize-bundled-skills.mjs
 *
 * The skills CLI resolves shared dependencies (e.g. office/) automatically.
 * Output is written to bundled-skills/ (gitignored, bundled by electron-builder).
 */

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, cpSync, rmSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const OUTPUT_DIR = join(PROJECT_ROOT, "bundled-skills");
const SKILLS = ["pptx", "docx", "xlsx", "web-artifacts-builder"];
const REPO = "anthropics/skills";

// Use a temp directory for `skills add` since it writes to .agents/skills/
const tmpDir = join(PROJECT_ROOT, ".tmp-skills-download");

try {
  // Clean previous output
  if (existsSync(OUTPUT_DIR)) rmSync(OUTPUT_DIR, { recursive: true });
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  console.log(`Downloading skills: ${SKILLS.join(", ")} from ${REPO}...\n`);

  const skillsCli = join(PROJECT_ROOT, "node_modules", "skills", "bin", "cli.mjs");
  if (!existsSync(skillsCli)) {
    throw new Error("The pinned skills CLI is missing. Run pnpm install before building Marshal.");
  }
  const skillArgs = SKILLS.flatMap((skill) => ["-s", skill]);
  const result = spawnSync(
    process.execPath,
    [skillsCli, "add", REPO, ...skillArgs, "--copy", "-y"],
    {
      cwd: tmpDir,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`skills CLI failed with exit code ${result.status ?? "unknown"}`);
  }

  // Move downloaded skills from .agents/skills/ to bundled-skills/
  const agentsSkillsDir = join(tmpDir, ".agents", "skills");
  if (!existsSync(agentsSkillsDir)) {
    throw new Error(`Expected output at ${agentsSkillsDir} but it doesn't exist`);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const name of readdirSync(agentsSkillsDir)) {
    cpSync(join(agentsSkillsDir, name), join(OUTPUT_DIR, name), { recursive: true });
  }

  // Copy first-party skills (committed to repo) into bundled-skills/
  const firstPartyDir = join(PROJECT_ROOT, "first-party-skills");
  const downloadedSkills = new Set(SKILLS);
  if (existsSync(firstPartyDir)) {
    for (const entry of readdirSync(firstPartyDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (downloadedSkills.has(entry.name)) {
        console.log(`Merging first-party overrides into downloaded skill "${entry.name}"...`);
      }
      cpSync(join(firstPartyDir, entry.name), join(OUTPUT_DIR, entry.name), { recursive: true });
    }
  }

  console.log(`\nDone. Skills written to bundled-skills/`);
  console.log(`Skills: ${readdirSync(OUTPUT_DIR).join(", ")}`);
} finally {
  // Clean up temp directory
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
}
