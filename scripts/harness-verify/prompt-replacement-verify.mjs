/**
 * Isolated boot smoke for the production session-config trace surface.
 *
 * BOUNDARY — a MARSHAL_E2E (mock-mode) boot CANNOT prove the Claude
 * replacement end-to-end: resolveRuntimeStartupSelection pins the copilot
 * runtime whenever mockMode is on (electron/backend/startup-selection.ts), so
 * the Claude adapter never runs under this harness regardless of seeded
 * settings. The Claude-side proof (assembled prompt → local wrapper →
 * toClaudeQueryOptions, byte-identical systemPrompt string on create+resume,
 * mode=replace in the trace) lives in the integration seam test:
 * electron/sessions-prompt-replacement.test.ts ("carries the assembled prompt
 * byte-identical into the Claude SDK options"). A boot-level mode=replace
 * assertion needs a non-mock isolated profile (reviewer-owned run).
 *
 * What this harness DOES verify on a real boot (isolated data dir + CDP
 * port, no paid turn, live app untouched): the app boots with the seeded
 * flag profile, session creation flows through the production local wrapper,
 * and the per-runtime session-config trace (m-<runtime>-session-config-trace
 * .jsonl) is written with the systemMessage evidence fields (mode/chars/
 * sha256) this project added.
 *
 * Usage (repo root, after `pnpm build:vite`):
 *   node scripts/harness-verify/prompt-replacement-verify.mjs
 * Env: PORT (default 9351), WORKER (default prompt-replacement-verify).
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { connectToApp, evaluate, waitForReady } from "./cdp-helpers.mjs";

const PORT = Number(process.env.PORT || 9351);
const WORKER = process.env.WORKER || "prompt-replacement-verify";
const TRACE_TIMEOUT_MS = Number(process.env.TRACE_TIMEOUT_MS || 120_000);

const log = (...args) => console.log("[prompt-replacement-verify]", ...args);
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function seedProfile() {
  execFileSync("node", ["scripts/harness-verify/seed-isolated.mjs"], {
    env: { ...process.env, MARSHAL_E2E_WORKER: WORKER },
    stdio: "inherit",
  });
  const dataDir = path.join(os.tmpdir(), `marshal-e2e-data-${WORKER}`);
  const settingsPath = path.join(dataDir, "marshal-settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  settings.runtimeId = "claude";
  settings.experiments = { ...(settings.experiments ?? {}), promptReplacement: true };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  // The seeded session predates the flag; retag it to the claude runtime so
  // the replacement gate applies to it.
  const sessionsDir = path.join(dataDir, "marshal-sessions");
  for (const name of ["goal-harness-seed.json"]) {
    const p = path.join(sessionsDir, name);
    const session = JSON.parse(fs.readFileSync(p, "utf8"));
    session.runtimeId = "claude";
    delete session.backendOrigin;
    fs.writeFileSync(p, JSON.stringify(session, null, 2));
  }
  const indexPath = path.join(sessionsDir, "sessions-index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  for (const row of index.sessions) {
    row.runtimeId = "claude";
    delete row.backendOrigin;
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  log(`Seeded isolated claude+flag profile at ${dataDir}`);
  return dataDir;
}

function launchApp(dataDir) {
  const child = spawn(
    path.join("node_modules", ".bin", "electron"),
    [
      ".",
      "--no-sandbox",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${path.join(dataDir, "electron-user-data")}`,
    ],
    {
      env: {
        ...process.env,
        MARSHAL_E2E: "1",
        MARSHAL_E2E_WORKSPACE_FIXTURES: "1",
        MARSHAL_E2E_WORKER: WORKER,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => process.stdout.write(`[app] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[app] ${chunk}`));
  log(`Launched isolated app pid=${child.pid} port=${PORT}`);
  return child;
}

// The trace filename is per-runtime (LocalBackend strategy):
// m-claude-… / m-copilot-… / m-local-… — read whichever the boot produced.
const TRACE_FILENAMES = [
  "m-claude-session-config-trace.jsonl",
  "m-copilot-session-config-trace.jsonl",
  "m-local-session-config-trace.jsonl",
];

async function readTraceEntries(dataDir) {
  const entries = [];
  for (const name of TRACE_FILENAMES) {
    const tracePath = path.join(dataDir, name);
    if (!fs.existsSync(tracePath)) continue;
    for (const line of fs.readFileSync(tracePath, "utf8").split("\n")) {
      if (line.trim()) entries.push({ ...JSON.parse(line), traceFile: name });
    }
  }
  return entries;
}

async function main() {
  const dataDir = seedProfile();
  const app = launchApp(dataDir);
  const finish = (code) => {
    try {
      app.kill("SIGKILL");
    } catch {
      /* dead */
    }
    process.exit(code);
  };
  try {
    const { Runtime } = await connectToApp(PORT);
    await waitForReady(Runtime, 90_000);
    log("Renderer ready — creating a session to trigger backend session creation");
    // Opening/creating a session drives createBackendSession → the trace.
    // Signature: create(model?, soul?, options?) — the name goes in options;
    // passing it positionally would be misread as the model.
    await evaluate(
      Runtime,
      `window.sessionsAPI.create(undefined, undefined, {name: "prompt verify session"})`,
    );

    const deadline = Date.now() + TRACE_TIMEOUT_MS;
    let entry = null;
    while (Date.now() < deadline && !entry) {
      const entries = await readTraceEntries(dataDir);
      entry =
        entries.find(
          (candidate) =>
            candidate.operation === "createSession" &&
            typeof candidate.systemMessage?.mode === "string" &&
            typeof candidate.systemMessage?.sha256 === "string" &&
            typeof candidate.systemMessage?.chars === "number",
        ) ?? null;
      if (!entry) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    const entries = await readTraceEntries(dataDir);
    log(`Trace entries: ${entries.length}`);
    for (const candidate of entries) {
      log(
        `  file=${candidate.traceFile} op=${candidate.operation} profile=${candidate.systemMessageProfile} mode=${candidate.systemMessage?.mode} chars=${candidate.systemMessage?.chars} sha=${String(candidate.systemMessage?.sha256).slice(0, 12)}`,
      );
    }
    assert(entry, "no session-config trace entry with systemMessage evidence appeared");
    const replaceEntry = entries.find((candidate) => candidate.systemMessage?.mode === "replace");
    if (replaceEntry) {
      assert(
        replaceEntry.systemMessage.chars > 60_000,
        `replacement prompt unexpectedly small: ${replaceEntry.systemMessage.chars} chars`,
      );
      log(
        `PASS (full): mode=replace reached the runtime config (${replaceEntry.systemMessage.chars} chars, sha256=${replaceEntry.systemMessage.sha256})`,
      );
    } else {
      log(
        `PASS (trace surface only): boot wrote ${entry.traceFile} with systemMessage evidence (mode=${entry.systemMessage.mode}). ` +
          "Mock-mode boots pin the copilot runtime, so Claude mode=replace CANNOT appear here — " +
          "that proof is the integration seam test in electron/sessions-prompt-replacement.test.ts; " +
          "a boot-level replace assertion requires a non-mock isolated profile.",
      );
    }
    finish(0);
  } catch (error) {
    console.error("[prompt-replacement-verify] FAIL:", error);
    finish(1);
  }
}

await main();
