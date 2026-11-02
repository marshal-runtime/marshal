#!/usr/bin/env node
// Evidence class "unit": exercises this facility's own pure logic (evidence
// receipt writer, redaction, provider-comparison helpers) with Node's
// built-in test runner. Deliberately NOT wired into the repo's main
// vitest.config.ts (that file is shared with every other lane); this
// facility owns host-smoke/acceptance-facility/** only.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeReceipt } from "../lib/receipt.mjs";
import { tail } from "../lib/run-command.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(__dirname, "..", "lib");
const RECEIPTS_DIR = path.resolve(__dirname, "..", "example-receipts");

function main() {
  const run = spawnSync(process.execPath, ["--test", path.join(LIB_DIR, "*.test.mjs")], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: true, // needed for the glob to expand; args are static, no user input
  });
  const receipt = writeReceipt(path.join(RECEIPTS_DIR, "facility-unit-tests.unit.json"), {
    evidenceClass: "unit",
    status: run.status === 0 ? "pass" : "fail",
    facility: "run-unit-tests",
    subject: "This facility's own receipt/redaction/provider-comparison helper logic",
    reason: run.status === 0 ? undefined : `node --test exited with status ${run.status}`,
    proof: {
      command: "node --test host-smoke/acceptance-facility/lib/*.test.mjs",
      exitCode: run.status,
      stdoutTail: tail(run.stdout ?? ""),
    },
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.exitCode = receipt.status === "fail" ? 1 : 0;
}

main();
