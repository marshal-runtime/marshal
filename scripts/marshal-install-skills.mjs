#!/usr/bin/env node
/**
 * Installs all repo-local skills from skills/* into repo-local skill folders for
 * both Claude Code and GitHub Copilot.
 *
 * Usage: node scripts/marshal-install-skills.mjs
 *        pnpm install:skills
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

import { isDirectoryLink, removeLink } from "./marshal-skill-link-utils.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const repoSkillsDir = join(repoRoot, "skills");
const isWindows = process.platform === "win32";
const targets = [
  {
    label: "Claude Code",
    dir: join(repoRoot, ".claude", "skills"),
  },
  {
    label: "GitHub Copilot",
    dir: join(repoRoot, ".github", "skills"),
  },
];

if (!existsSync(repoSkillsDir)) {
  console.error(`Skills directory not found: ${repoSkillsDir}`);
  process.exit(1);
}

const skills = readdirSync(repoSkillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(repoSkillsDir, entry.name, "SKILL.md")))
  .map((entry) => ({
    name: entry.name,
    source: join(repoSkillsDir, entry.name),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));
const skillNames = new Set(skills.map((skill) => skill.name));
let hadFailure = false;

if (skills.length === 0) {
  console.error(`No skills with SKILL.md found under ${repoSkillsDir}`);
  process.exit(1);
}

function removeStaleSkillLinks(targetDir) {
  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    if (entry.name === ".gitignore" || skillNames.has(entry.name)) {
      continue;
    }

    const target = join(targetDir, entry.name);
    const stat = lstatSync(target);

    if (isDirectoryLink(target, stat)) {
      console.log(`  Removing stale link: ${target}`);
      removeLink(target);
      continue;
    }

    if (stat.isDirectory()) {
      console.warn(
        `⚠ ${target} is an unexpected real directory. Leaving it in place — remove it manually if you want a clean repo-local skill folder.`,
      );
      continue;
    }

    console.warn(`⚠ ${target} is an unexpected file. Leaving it in place.`);
  }
}

function ensureSkillLink(source, target) {
  if (existsSync(target)) {
    const stat = lstatSync(target);

    if (isDirectoryLink(target, stat)) {
      try {
        const existing = resolve(readlinkSync(target));
        if (existing === resolve(source)) {
          console.log(`✓ ${target} → already linked correctly`);
          return;
        }
      } catch {
        // readlinkSync fails if it's a real directory, not a junction.
      }

      console.log(`  Removing stale link: ${target}`);
      removeLink(target);
    } else if (stat.isDirectory()) {
      console.warn(
        `⚠ ${target} is a real directory (not a symlink). Skipping — remove it manually if you want the repo version.`,
      );
      return;
    } else {
      console.warn(`⚠ ${target} already exists and is not a directory symlink. Skipping.`);
      return;
    }
  }

  try {
    // On Windows, use 'junction' (no admin rights needed). On Unix, use 'dir'.
    symlinkSync(source, target, isWindows ? "junction" : "dir");
    console.log(`✓ ${target} → ${source}`);
  } catch (error) {
    hadFailure = true;
    console.error(`✗ Failed to create symlink: ${target}`, error.message);
  }
}

for (const target of targets) {
  if (!existsSync(target.dir)) {
    mkdirSync(target.dir, { recursive: true });
  }

  console.log(`\nInstalling repo skills for ${target.label}: ${target.dir}`);
  removeStaleSkillLinks(target.dir);
  for (const skill of skills) {
    ensureSkillLink(skill.source, join(target.dir, skill.name));
  }
}

if (hadFailure) {
  process.exit(1);
}
