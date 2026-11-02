#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const ALLOWED_PREFIXES = ["electron/backend/copilot/"];
const SELF = "scripts/verify-marshal-state-root.mjs";
const PATH_LITERAL = /(?:["'`]\.copilot(?:-dev)?["'`]|~[/\\]\.copilot(?:-dev)?(?:[/\\]|\b)|[/\\]\.copilot(?:-dev)?[/\\])/g;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const violations = [];

for (const file of files) {
  if (file === SELF || ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
  if (!fs.existsSync(file)) continue;
  if (file === ".copilot" || file.startsWith(".copilot/") || file.includes("/.copilot/")) {
    violations.push(`${file}: tracked path uses the GitHub Copilot profile name`);
    continue;
  }
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const match of content.matchAll(PATH_LITERAL)) {
    const line = content.slice(0, match.index).split("\n").length;
    violations.push(`${file}:${line}: ${match[0]}`);
  }
}

if (violations.length > 0) {
  console.error(
    "Marshal-owned code must use ~/.marshal; only the GitHub Copilot adapter may reference the CLI profile:\n" +
      violations.join("\n"),
  );
  process.exit(1);
}

console.log("Marshal state-root verification passed.");
