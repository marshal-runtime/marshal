#!/usr/bin/env node
// Asserts that the packaged Marshal binary REJECTS LOLBin attacks
// (ELECTRON_RUN_AS_NODE and NODE_OPTIONS injection). Failure mode:
// any of these produce stdout containing the canary string.
//
// Usage: node scripts/marshal-verify-no-lolbin.cjs <path-to-Marshal-main-binary>

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CANARY = "lolbin-canary-payload";

function runWithEnv(exe, env) {
  return spawnSync(exe, ["-e", `console.log("${CANARY}")`], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 5000,
  });
}

function runWithNodeOptions(exe) {
  const payload = path.join(os.tmpdir(), `lolbin-${Date.now()}.js`);
  fs.writeFileSync(payload, `console.log("${CANARY}");`);
  try {
    return spawnSync(exe, [], {
      env: { ...process.env, NODE_OPTIONS: `--require ${payload}` },
      encoding: "utf8",
      timeout: 5000,
    });
  } finally {
    fs.unlinkSync(payload);
  }
}

function classify(label, r) {
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.error && r.error.code === "ETIMEDOUT") {
    // On Windows with runAsNode:false the binary starts as a GUI process (the fuse
    // ignores ELECTRON_RUN_AS_NODE) and never exits — that IS the expected rejection.
    // spawnSync still captures any output up to the kill, so check the canary there.
    if (out.includes(CANARY)) {
      console.error(`FAIL: ${label} produced code execution before timeout`);
      return false;
    }
    console.log(`OK: ${label} rejected (started as GUI, no canary output)`);
    return true;
  }
  if (out.includes(CANARY)) {
    console.error(`FAIL: ${label} still produced code execution`);
    return false;
  }
  console.log(`OK: ${label} rejected`);
  return true;
}

function main() {
  const exe = process.argv[2];
  if (!exe) {
    console.error("usage: node scripts/marshal-verify-no-lolbin.cjs <path-to-Marshal-main-binary>");
    process.exit(2);
  }
  const ok1 = classify("ELECTRON_RUN_AS_NODE=1", runWithEnv(exe, { ELECTRON_RUN_AS_NODE: "1" }));
  const ok2 = classify("NODE_OPTIONS=--require", runWithNodeOptions(exe));
  if (!ok1 || !ok2) process.exit(1);
}
main();
