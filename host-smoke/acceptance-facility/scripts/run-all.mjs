#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Top-level entry point: runs every D4 script against the sample app and
// writes a facility-wide evidence-class summary. Safe to run with no
// environment configured (everything live-gated reports "blocked" honestly,
// per Field Guide decision 5 / AUDIT-VERDICT-AND-ACCEPTANCE.md point 6 —
// never silently downgraded to a weaker class).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { summarizeReceipts } from "../lib/receipt.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECEIPTS_DIR = path.resolve(__dirname, "..", "example-receipts");

const STEPS = [
  "run-unit-tests.mjs",
  "identify-installed-artifact.mjs",
  "execute-application-route.mjs",
  "agent-path-invoke.mjs",
  "provider-acceptance-receipts.mjs",
  "run-native-frame-regression.mjs",
  // No-arg invocation: without ACCEPTANCE_FACILITY_ALLOW_LIVE this always
  // records a "blocked" installed-ui receipt (see README.md for real usage
  // with an operation argument once live).
  "drive-native-frame.mjs",
];

function runStep(name) {
  const result = spawnSync(process.execPath, [path.join(__dirname, name)], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  return { name, exitCode: result.status };
}

function main() {
  const stepResults = STEPS.map(runStep);
  const receiptFiles = fs
    .readdirSync(RECEIPTS_DIR)
    .filter((entry) => entry.endsWith(".json") && entry !== "facility-summary.json")
    .map((entry) => path.join(RECEIPTS_DIR, entry));
  const byEvidenceClass = summarizeReceipts(receiptFiles);
  const summary = {
    generatedAt: new Date().toISOString(),
    steps: stepResults,
    receiptCount: receiptFiles.length,
    byEvidenceClass,
  };
  fs.writeFileSync(
    path.join(RECEIPTS_DIR, "facility-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`);
  const anyStepFailed = stepResults.some((step) => step.exitCode !== 0);
  process.exitCode = anyStepFailed ? 1 : 0;
}

main();
