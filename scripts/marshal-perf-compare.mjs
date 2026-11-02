#!/usr/bin/env node
// Marshal-owned path
/**
 * Compare two marshal-perf-profile.mjs metrics.json files and print a markdown table.
 *
 * Usage:
 *   node scripts/marshal-perf-compare.mjs perf-main/metrics.json perf-refactored/metrics.json
 */

import fs from "node:fs";

const [fileA, fileB] = process.argv.slice(2);

if (!fileA || !fileB) {
  console.error("Usage: node scripts/marshal-perf-compare.mjs <baseline.json> <comparison.json>");
  process.exit(1);
}

function load(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`Failed to load ${filePath}: ${err.message}`);
    process.exit(1);
  }
}

const a = load(fileA);
const b = load(fileB);

const sa = a.summary;
const sb = b.summary;

function fmt(v, unit = "ms") {
  if (v == null || isNaN(v)) return "n/a";
  return unit === "MB" ? `${v.toFixed(2)} ${unit}` : `${v.toFixed(1)} ${unit}`;
}

function delta(va, vb, unit = "ms") {
  if (va == null || vb == null || isNaN(va) || isNaN(vb)) return "n/a";
  const d = vb - va;
  const sign = d >= 0 ? "+" : "";
  return unit === "MB" ? `${sign}${d.toFixed(2)} ${unit}` : `${sign}${d.toFixed(1)} ${unit}`;
}

const labelA = sa.detectedBranch || "baseline";
const labelB = sb.detectedBranch || "comparison";

const rows = [
  ["Avg total turn", sa.avgTotalTurnMs, sb.avgTotalTurnMs, "ms"],
  ["Avg first paint", sa.avgFirstContentPaintMs, sb.avgFirstContentPaintMs, "ms"],
  ["Avg event→DOM", sa.avgEventToDOMMs, sb.avgEventToDOMMs, "ms"],
  ["Avg events/turn", sa.avgEventCount, sb.avgEventCount, ""],
  ["Avg mutations/turn", sa.avgMutationCount, sb.avgMutationCount, ""],
  ["Avg heap delta", sa.avgHeapDeltaMB, sb.avgHeapDeltaMB, "MB"],
];

console.log(`\n## Performance Comparison\n`);
console.log(`| Metric | ${labelA} | ${labelB} | Delta |`);
console.log(`|--------|${"-".repeat(labelA.length + 2)}|${"-".repeat(labelB.length + 2)}|-------|`);

for (const [label, va, vb, unit] of rows) {
  const colA = fmt(va, unit);
  const colB = fmt(vb, unit);
  const colD = delta(va, vb, unit);
  console.log(
    `| ${label.padEnd(20)} | ${colA.padEnd(labelA.length)} | ${colB.padEnd(labelB.length)} | ${colD} |`,
  );
}

console.log(
  `\n_Baseline: ${fileA} (${sa.successfulRuns} runs) | Comparison: ${fileB} (${sb.successfulRuns} runs)_\n`,
);
