#!/usr/bin/env node
// F-DEPLOY-2 HONEST-RED/GREEN capture (Field Guide decision 2).
//
// Reproduces the pre-repair vulnerable connectToRunningMarshal() attach +
// evaluate, and then proves the post-repair guards refuse, against a
// NON-Marshal CDP endpoint that THIS SCRIPT starts and stops: a headless
// Chromium launched from this repo's own bundled @playwright/test
// dependency, on an OS-assigned ephemeral port, localhost only. This never
// touches the user's Google Chrome, any other user process, or the live
// deployed Marshal — the browser instance this script drives exists only
// for the few seconds each scenario below runs, and is closed in every
// scenario's `finally`.
//
// Produces:
//   test-receipts/facfix-red.txt   — the PRE-repair code attaches and
//     evaluates inside a foreign (non-Marshal) page, exactly reproducing the
//     parent's live-reproduced finding (only a sessionsAPI-undefined-style
//     error came back; nothing exfiltrated — but the facility must never be
//     ABLE to do this regardless of operator error).
//   test-receipts/facfix-green.txt — the CURRENT (post-repair)
//     lib/live-connection.mjs typed-refuses all three guards: missing
//     explicit port, non-Marshal endpoint, no matching Marshal page.
//
// Re-runnable on demand. Not part of run-all.mjs's offline pipeline (it
// downloads/launches a real browser and is slower than this facility's other
// offline steps) — the receipts it writes are the committed evidence;
// permanent fast regression coverage of the same three guards' decision
// logic lives in lib/live-connection.test.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import CDP from "chrome-remote-interface";

import {
  connectToRunningMarshal,
  LiveConnectionRefusalError,
  liveModePort,
} from "../lib/live-connection.mjs";
import { launchTestOwnedChromium } from "../lib/test-owned-chromium.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECEIPTS_DIR = path.resolve(__dirname, "..", "test-receipts");
const PORT_KEY = "ACCEPTANCE_FACILITY_CDP_PORT";

// --- Frozen, historical copy of the PRE-repair connectToRunningMarshal() and
// --- its evaluate helper, byte-for-byte as they existed at
// --- d421db1ad5be6b897920312634275a5cdb0a84e7 (branch hostport/port)'s
// --- lib/live-connection.mjs, kept ONLY for this red reproduction. Never
// --- imported by, or reachable from, any production code path in this
// --- facility — this is exactly the vulnerable DEFAULT_PORT-era matcher
// --- (blind `!mini-mode-page` fallback, no endpoint verification) F-DEPLOY-2
// --- found, preserved verbatim so the red receipt below proves the real
// --- historical vulnerability rather than a strawman.
async function preRepairConnectToRunningMarshal(port) {
  const deadline = Date.now() + 5_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const targets = await CDP.List({ port });
      const pageTargets = targets.filter(
        (target) => target.type === "page" && !target.url.includes("devtools://"),
      );
      const rendererTarget =
        pageTargets.find((target) => target.url.includes("/dist/index.html")) ??
        pageTargets.find((target) => !target.url.includes("mini-mode-page")) ??
        pageTargets[0];
      if (!rendererTarget)
        throw new Error(`No renderer target found among ${targets.length} targets.`);
      // eslint-disable-next-line no-await-in-loop
      const client = await CDP({ port, target: rendererTarget });
      // eslint-disable-next-line no-await-in-loop
      await Promise.all([client.Runtime.enable(), client.Page.enable()]);
      return { client, target: rendererTarget };
    } catch (error) {
      lastError = error;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Failed to connect to a running Marshal on port ${port}: ${lastError?.message}`);
}

async function preRepairEvaluate(client, expression) {
  const { result, exceptionDetails } = await client.Runtime.evaluate({
    expression, // nosemgrep: javascript.chrome-remote-interface.security.audit.chrome-remote-interface-compilescript-injection.chrome-remote-interface-compilescript-injection
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(
      `CDP eval error: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
    );
  }
  return result.value;
}

async function captureRed() {
  const lines = [
    "=== F-DEPLOY-2 RED: pre-repair connectToRunningMarshal() against a non-Marshal endpoint ===",
    "",
  ];
  const chrome = await launchTestOwnedChromium();
  let ok = false;
  try {
    lines.push(
      `Test-owned headless Chromium (bundled @playwright/test, version ${chrome.version}) started on ` +
        `127.0.0.1:${chrome.port} — an OS-assigned ephemeral port, localhost only. Not the user's Google ` +
        "Chrome, not any other user process.",
    );
    const page = await chrome.browser.newPage();
    await page.goto("data:text/html,<h1>Personal Tab (simulated, e.g. a Slack tab)</h1>");
    lines.push(`Opened the only page on this endpoint: ${page.url()}`);
    lines.push("");
    lines.push(
      "Running the historical PRE-REPAIR connectToRunningMarshal() (frozen copy of " +
        "d421db1ad5be6b897920312634275a5cdb0a84e7's lib/live-connection.mjs) against this endpoint, with " +
        "no explicit-port guard, no endpoint verification, and the original blind fallback matcher...",
    );
    const { client } = await preRepairConnectToRunningMarshal(chrome.port);
    lines.push(
      "ATTACHED. The pre-repair matcher's second `.find(!url.includes('mini-mode-page'))` clause matched " +
        "this foreign page (it is not `/dist/index.html` and does not contain `mini-mode-page`) — the exact " +
        "blind-fallback shape that, live, matched the operator's personal Slack tab.",
    );
    lines.push("");
    lines.push(
      "Evaluating the same static discovery expression identify-installed-artifact.mjs's live path uses " +
        "(window.sessionsAPI.list())...",
    );
    try {
      await preRepairEvaluate(client, "window.sessionsAPI.list().then((r) => JSON.stringify(r))");
      lines.push(
        "EVALUATED — unexpectedly succeeded (this page has no window.sessionsAPI; unexpected).",
      );
    } catch (error) {
      lines.push(
        `EVALUATED. Runtime.evaluate ran inside the foreign page and raised: ${error.message}`,
      );
      lines.push(
        "This is the exact shape of the live-reproduced F-DEPLOY-2 finding: only a sessionsAPI-undefined-" +
          "style error came back — nothing was exfiltrated — but the pre-repair code attached to, and " +
          "evaluated inside, a non-Marshal page without ever verifying it should refuse. That is the defect " +
          "this repair closes.",
      );
      ok = true;
    }
    await client.close();
  } finally {
    await chrome.close();
  }
  return { lines, ok };
}

async function captureGreenMissingPort() {
  const lines = [
    "=== F-DEPLOY-2 GREEN (guard a): missing explicit ACCEPTANCE_FACILITY_CDP_PORT ===",
    "",
  ];
  const saved = process.env[PORT_KEY];
  delete process.env[PORT_KEY];
  let ok = false;
  try {
    lines.push("ACCEPTANCE_FACILITY_CDP_PORT is unset. Calling liveModePort()...");
    liveModePort();
    lines.push("FAIL: liveModePort() did not refuse.");
  } catch (error) {
    const isRefusal =
      error instanceof LiveConnectionRefusalError && error.code === "missing-explicit-cdp-port";
    lines.push(
      `${isRefusal ? "REFUSED" : "UNEXPECTED ERROR"}: ${error.code ?? error.constructor.name}: ${error.message}`,
    );
    lines.push(
      "No connection was attempted — the refusal happens before any network call is made.",
    );
    ok = isRefusal;
  } finally {
    if (saved === undefined) delete process.env[PORT_KEY];
    else process.env[PORT_KEY] = saved;
  }
  return { lines, ok };
}

async function captureGreenNonMarshalEndpoint() {
  const lines = [
    "=== F-DEPLOY-2 GREEN (guard b): non-Marshal endpoint (URL matches, marker probe does not) ===",
    "",
  ];
  const chrome = await launchTestOwnedChromium();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "facfix-spoofed-dist-"));
  const distDir = path.join(tmpDir, "dist");
  fs.mkdirSync(distDir);
  const spoofedFile = path.join(distDir, "index.html");
  fs.writeFileSync(spoofedFile, "<h1>Not actually Marshal</h1>");
  let ok = false;
  try {
    lines.push(
      `Test-owned headless Chromium (bundled @playwright/test, version ${chrome.version}) started on ` +
        `127.0.0.1:${chrome.port} — ephemeral port, localhost only.`,
    );
    const page = await chrome.browser.newPage();
    await page.goto(`file://${spoofedFile}`);
    lines.push(
      `Opened a plain static HTML file this script wrote to a temp dir, whose URL contains the legacy ` +
        `match substring but is not Marshal: ${page.url()}`,
    );
    lines.push("(No Marshal preload globals exist on this page.)");
    lines.push("");
    lines.push("Running the POST-REPAIR connectToRunningMarshal() against this endpoint...");
    try {
      await connectToRunningMarshal(chrome.port);
      lines.push("FAIL: connectToRunningMarshal() did not refuse.");
    } catch (error) {
      const isRefusal =
        error instanceof LiveConnectionRefusalError && error.code === "non-marshal-endpoint";
      lines.push(
        `${isRefusal ? "REFUSED" : "UNEXPECTED ERROR"}: ${error.code ?? error.constructor.name}: ${error.message}`,
      );
      lines.push(
        "The legacy /dist/index.html URL matcher matched this page (kept for compatibility, as required), " +
          "but the mandatory window-marker probe — the FIRST and only evaluate this connector runs — " +
          "correctly detected it is not really Marshal and refused before any further evaluate.",
      );
      ok = isRefusal;
    }
  } finally {
    await chrome.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return { lines, ok };
}

async function captureGreenNoMarshalPage() {
  const lines = [
    "=== F-DEPLOY-2 GREEN (guard c): no confident Marshal page match (no blind fallback) ===",
    "",
  ];
  const chrome = await launchTestOwnedChromium();
  let ok = false;
  try {
    lines.push(
      `Test-owned headless Chromium (bundled @playwright/test, version ${chrome.version}) started on ` +
        `127.0.0.1:${chrome.port} — ephemeral port, localhost only.`,
    );
    const page = await chrome.browser.newPage();
    await page.goto("data:text/html,<h1>Personal Tab (simulated, e.g. a Slack tab)</h1>");
    lines.push(
      `Only page open: ${page.url()} — matches neither marshal://app/index.html nor the legacy ` +
        "/dist/index.html pattern.",
    );
    lines.push("");
    lines.push("Running the POST-REPAIR connectToRunningMarshal() against this endpoint...");
    try {
      await connectToRunningMarshal(chrome.port);
      lines.push("FAIL: connectToRunningMarshal() did not refuse.");
    } catch (error) {
      const isRefusal =
        error instanceof LiveConnectionRefusalError && error.code === "no-marshal-page";
      lines.push(
        `${isRefusal ? "REFUSED" : "UNEXPECTED ERROR"}: ${error.code ?? error.constructor.name}: ${error.message}`,
      );
      lines.push(
        "No blind first-page fallback ran — the exact page selection the original F-DEPLOY-2 finding relied " +
          "on (an unmatched page selected by default) is refused instead of guessed.",
      );
      ok = isRefusal;
    }
  } finally {
    await chrome.close();
  }
  return { lines, ok };
}

function writeLines(fileName, sections) {
  const filePath = path.join(RECEIPTS_DIR, fileName);
  const body = sections.map(({ lines }) => lines.join("\n")).join("\n\n");
  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
  fs.writeFileSync(filePath, `${body}\n`);
  return filePath;
}

async function main() {
  const red = await captureRed();
  const redPath = writeLines("facfix-red.txt", [red]);

  const greenA = await captureGreenMissingPort();
  const greenB = await captureGreenNonMarshalEndpoint();
  const greenC = await captureGreenNoMarshalPage();
  const greenPath = writeLines("facfix-green.txt", [greenA, greenB, greenC]);

  const summary = {
    redPath,
    greenPath,
    redOk: red.ok,
    greenOk: greenA.ok && greenB.ok && greenC.ok,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = summary.redOk && summary.greenOk ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
