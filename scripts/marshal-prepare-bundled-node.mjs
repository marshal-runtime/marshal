#!/usr/bin/env node
// Marshal-owned path
/**
 * Creates electron-builder-compatible symlinks for bundled Node.
 *
 * electron-builder's ${os} macro resolves to "mac"/"win"/"linux", but our
 * node-bin/ directories use Node's process.platform convention ("darwin"/
 * "win32"). This script creates the electron-builder-expected symlinks so
 * extraResources can find them.
 *
 * The real directories (node-bin/darwin-x64/, etc.) are kept for portability
 * and to match Node.js conventions elsewhere in the codebase.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const nodeBinDir = path.join(projectRoot, "node-bin");

const SYMLINK_MAP = {
  "mac-x64": "darwin-x64",
  "mac-arm64": "darwin-arm64",
  "win-x64": "win32-x64",
  "win-arm64": "win32-arm64",
};

// On Windows, plain directory symlinks need Developer Mode or admin and
// otherwise EPERM. Junctions don't — same workaround as marshal-install-skills.mjs.
// Junctions require an absolute target path; "dir" symlinks take a relative
// name. See nodejs/node#27156.
const isWindows = process.platform === "win32";
const linkType = isWindows ? "junction" : "dir";

for (const [linkName, targetName] of Object.entries(SYMLINK_MAP)) {
  const linkPath = path.join(nodeBinDir, linkName);
  const targetPath = path.join(nodeBinDir, targetName);

  if (fs.existsSync(linkPath)) {
    console.log(`  prepare-bundled-node: ${linkName} already exists, skipping`);
    continue;
  }

  if (!fs.existsSync(targetPath)) {
    console.warn(
      `  prepare-bundled-node: target ${targetName} not found at ${targetPath}, skipping symlink creation`,
    );
    continue;
  }

  try {
    fs.symlinkSync(isWindows ? targetPath : targetName, linkPath, linkType);
    console.log(`  prepare-bundled-node: created ${linkType} ${linkName} → ${targetName}`);
  } catch (err) {
    console.error(
      `  prepare-bundled-node: failed to create ${linkType} ${linkName}: ${err.message}`,
    );
    process.exit(1);
  }
}
