#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const rootArgIndex = process.argv.indexOf("--root");
const root = path.resolve(rootArgIndex >= 0 ? process.argv[rootArgIndex + 1] : process.cwd());
const SELF = "scripts/verify-brand.mjs";

// Keep prohibited spellings split so a raw repository grep remains useful.
const token = (...parts) => parts.join("");
const PROHIBITED = [
  new RegExp(token("ms-", "claw", "pilot"), "gi"),
  new RegExp(token("claw", "pilot"), "gi"),
  new RegExp(token("open", "claw"), "gi"),
  new RegExp(token("BRAND-", "COMPAT"), "g"),
];

const ALLOWLIST = [];

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 1 << 28 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

const violations = [];
for (const file of trackedFiles()) {
  if (file === SELF) continue;
  const absolutePath = path.join(root, file);
  let stat;
  try {
    stat = statSync(absolutePath);
  } catch {
    continue;
  }
  if (!stat.isFile()) continue;
  const bytes = readFileSync(absolutePath);
  if (bytes.includes(0)) continue;
  const lines = bytes.toString("utf8").split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const allowed = ALLOWLIST.some((entry) => entry.path === file && entry.pattern.test(line));
    if (allowed) continue;
    for (const regex of PROHIBITED) {
      regex.lastIndex = 0;
      for (const match of line.matchAll(regex)) {
        violations.push({
          file,
          line: lineIndex + 1,
          column: (match.index ?? 0) + 1,
          value: match[0],
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`Brand verification failed: ${violations.length} prohibited occurrence(s).`);
  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line}:${violation.column} ${JSON.stringify(violation.value)}`,
    );
  }
  process.exit(1);
}

console.log(
  `Brand verification passed: ${trackedFiles().length} tracked files, ${ALLOWLIST.length} external-reference allowlist rule.`,
);
