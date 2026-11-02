#!/usr/bin/env node
// Marshal-owned path
/**
 * Measure bundle sizes for the current branch.
 *
 * Usage:
 *   node scripts/marshal-measure-bundle-size.mjs          # measure current working tree
 *   node scripts/marshal-measure-bundle-size.mjs --json    # output JSON for diffing
 *
 * Reports:
 *   - Vite JS bundle size (raw + gzip)
 *   - Vite CSS bundle size (raw + gzip)
 *   - app.asar size (if full build available)
 *   - Installer size (if full build available)
 */
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const jsonMode = process.argv.includes("--json");
const fullBuild = process.argv.includes("--full");

function run(cmd) {
  return execSync(cmd, { cwd: process.cwd(), stdio: "pipe" }).toString().trim();
}

function findFiles(dir, pattern) {
  try {
    return readdirSync(dir)
      .filter((f) => pattern.test(f))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function fmt(bytes) {
  if (bytes === null) return "N/A";
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(2)} KB`;
}

// Step 1: Vite build
console.error("Building with Vite...");
run("pnpm run build:vite");

// Step 2: Measure Vite output
const distAssets = join(process.cwd(), "dist", "assets");
const jsFiles = findFiles(distAssets, /\.js$/);
const cssFiles = findFiles(distAssets, /\.css$/);

const viteSizes = {};
for (const f of [...jsFiles, ...cssFiles]) {
  const name = f.split(/[\\/]/).pop();
  const raw = fileSize(f);
  let gzip = null;
  try {
    gzip = gzipSync(readFileSync(f)).length;
  } catch {
    /* ok */
  }
  viteSizes[name] = { raw, gzip };
}

const totalJsRaw = jsFiles.reduce((sum, f) => sum + (fileSize(f) || 0), 0);
const totalCssRaw = cssFiles.reduce((sum, f) => sum + (fileSize(f) || 0), 0);

// Step 3: Full Electron build (optional)
let asarSize = null;
let installerSize = null;

if (fullBuild) {
  console.error("Running full Electron build...");
  run("pnpm run build");

  // Find app.asar
  const releaseDir = join(process.cwd(), "release");
  try {
    for (const sub of readdirSync(releaseDir)) {
      const winUnpacked = join(releaseDir, sub, "win-unpacked", "resources", "app.asar");
      const macUnpacked = join(
        releaseDir,
        sub,
        "mac-arm64",
        "M.app",
        "Contents",
        "Resources",
        "app.asar",
      );
      asarSize = fileSize(winUnpacked) ?? fileSize(macUnpacked) ?? asarSize;

      // Find installer
      const installers = findFiles(join(releaseDir, sub), /\.(exe|dmg)$/);
      for (const inst of installers) {
        const s = fileSize(inst);
        if (s && (installerSize === null || s > installerSize)) installerSize = s;
      }
    }
  } catch {
    /* no release dir */
  }
}

// Step 4: Get branch info
let branch = "unknown";
try {
  branch = run("git branch --show-current") || run("git rev-parse --short HEAD");
} catch {
  /* ok */
}

const result = {
  branch,
  viteJs: {
    total: totalJsRaw,
    files: Object.fromEntries(
      jsFiles.map((f) => [f.split(/[\\/]/).pop(), viteSizes[f.split(/[\\/]/).pop()]]),
    ),
  },
  viteCss: { total: totalCssRaw },
  asar: asarSize,
  installer: installerSize,
};

if (jsonMode) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\n📦 Bundle sizes — branch: ${branch}`);
  console.log("─".repeat(60));
  console.log(`Vite JS total:   ${fmt(totalJsRaw)}`);
  for (const [name, sizes] of Object.entries(viteSizes)) {
    if (name.endsWith(".js")) {
      console.log(`  ${name}: ${fmt(sizes.raw)}${sizes.gzip ? ` (gzip: ${fmt(sizes.gzip)})` : ""}`);
    }
  }
  console.log(`Vite CSS total:  ${fmt(totalCssRaw)}`);
  for (const [name, sizes] of Object.entries(viteSizes)) {
    if (name.endsWith(".css")) {
      console.log(`  ${name}: ${fmt(sizes.raw)}${sizes.gzip ? ` (gzip: ${fmt(sizes.gzip)})` : ""}`);
    }
  }
  if (fullBuild) {
    console.log(`app.asar:        ${fmt(asarSize)}`);
    console.log(`Installer:       ${fmt(installerSize)}`);
  }
  console.log("─".repeat(60));
}
