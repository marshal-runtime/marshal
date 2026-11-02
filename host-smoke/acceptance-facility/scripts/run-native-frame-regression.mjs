#!/usr/bin/env node
import fs from "node:fs";
// D4, point (d): deterministic native-frame regression suite
// (AUDIT-VERDICT-AND-ACCEPTANCE.md "Testing capability gaps"). Runs D1's
// shared-contract regression test BY PATH (never edited or duplicated here —
// see Field Guide decision 2) plus this facility's own controlled-data
// scenarios, kept DISTINCT from real-provider acceptance (no network, no
// live app, no provider credentials touched).
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeReceipt } from "../lib/receipt.mjs";
import { pnpmCommand, runPnpm, tail } from "../lib/run-command.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const RECEIPTS_DIR = path.resolve(__dirname, "..", "example-receipts");
// Shared filename contract with the d1-frame lane (Field Guide decision 2).
// Referenced by path only; this facility never edits it.
const D1_TEST_RELATIVE_PATH =
  "src/features/runtime-ui/RuntimeUiApplicationWorkspace.layout.browser.test.tsx";
const CONTROLLED_SCENARIOS_CONFIG = "host-smoke/acceptance-facility/native-frame/vitest.config.ts";

function runD1SharedContract() {
  const absolutePath = path.join(REPO_ROOT, D1_TEST_RELATIVE_PATH);
  const receiptPath = path.join(RECEIPTS_DIR, "native-frame-regression.d1-shared-contract.json");
  if (!fs.existsSync(absolutePath)) {
    return writeReceipt(receiptPath, {
      evidenceClass: "native-frame",
      status: "blocked",
      facility: "run-native-frame-regression",
      subject: `D1 shared-contract regression file: ${D1_TEST_RELATIVE_PATH}`,
      reason:
        "File not present in this worktree. D1 owns and lands this file in its own swarm lane/worktree; " +
        "this facility references it by path and does not create, edit, or duplicate it. Re-run after integration.",
      limits: [
        "Cannot certify D1's fix from this worktree alone.",
        "Run again with `pnpm exec vitest run --project browser " +
          D1_TEST_RELATIVE_PATH +
          "` once D1's change is integrated.",
      ],
    });
  }
  const run = runPnpm(
    ["exec", "vitest", "run", "--project", "browser", D1_TEST_RELATIVE_PATH],
    REPO_ROOT,
  );
  return writeReceipt(receiptPath, {
    evidenceClass: "native-frame",
    status: run.status === 0 ? "pass" : "fail",
    facility: "run-native-frame-regression",
    subject: `D1 shared-contract regression file: ${D1_TEST_RELATIVE_PATH}`,
    reason: run.status === 0 ? undefined : `vitest exited with status ${run.status}`,
    proof: {
      command: `${pnpmCommand()} exec vitest run --project browser ${D1_TEST_RELATIVE_PATH}`,
      exitCode: run.status,
      stdoutTail: tail(run.stdout),
      stderrTail: tail(run.stderr),
    },
  });
}

function runControlledScenarios() {
  const receiptPath = path.join(RECEIPTS_DIR, "native-frame-regression.controlled-scenarios.json");
  const run = runPnpm(
    ["exec", "vitest", "run", "--config", CONTROLLED_SCENARIOS_CONFIG],
    REPO_ROOT,
  );
  return writeReceipt(receiptPath, {
    evidenceClass: "native-frame",
    status: run.status === 0 ? "pass" : "fail",
    facility: "run-native-frame-regression",
    subject:
      "Controlled-data scenarios: small/large pane, resize, inner scrolling, long lines, " +
      "init/selection changes, error feedback, pagination-shaped content",
    reason: run.status === 0 ? undefined : `vitest exited with status ${run.status}`,
    proof: {
      command: `${pnpmCommand()} exec vitest run --config ${CONTROLLED_SCENARIOS_CONFIG}`,
      exitCode: run.status,
      stdoutTail: tail(run.stdout),
      stderrTail: tail(run.stderr),
    },
    limits: [
      "Drives this facility's own sample-app fixture through the real " +
        "RuntimeUiInstanceFrame/PackagedRuntimeUiRenderer chain — not the live installed Code Review extension.",
      "Real clicks/types/scrolls/selections are dispatched via page.frameLocator (real browser automation " +
        "reaching the sandboxed cross-origin iframe); confirmation comes from the sandboxed app's own DOM " +
        "measurements reported back over the same tools/call bridge production uses.",
    ],
  });
}

function main() {
  const d1 = runD1SharedContract();
  const controlled = runControlledScenarios();
  const summary = { d1, controlled };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  const anyFailed = [d1, controlled].some((receipt) => receipt.status === "fail");
  process.exitCode = anyFailed ? 1 : 0;
}

main();
