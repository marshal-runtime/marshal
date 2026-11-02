#!/usr/bin/env node
// F-DEPLOY-2b HONEST-RED/GREEN capture (Codex-found, independently confirmed
// — see Field Guide SUPERSESSION section, binding).
//
// F-DEPLOY-2's 3b8e99bc3 repair rejected known real-desktop-browser
// `Browser` product strings (Chrome/Firefox/Safari/Edg/OPR) unconditionally
// at the /json/version pre-evaluate check. Its own doc comment claimed
// Electron reports "Electron/<version>" there — false: Electron's CDP
// handshake reports the underlying Chromium build's own product string, so
// the deployed host's real /json/version reports Browser="Chrome/146.0.7680.166"
// (committed fixture: ../example-receipts/live-demonstration/json-version-9333.json,
// captured read-only, no CDP attach). The 3b8e99bc3 pattern refused this real
// Marshal endpoint, fail-closed (no evaluate ran — good), but this is
// over-rejection: the facility could never drive a live Marshal at all.
//
// This repair accepts via /json/version's `User-Agent` field instead (which
// Electron always marks with `Marshal/<version> ... Electron/<version>`),
// while preserving every no-guess guard: a real desktop browser's User-Agent
// never carries those markers (still refused), and the mandatory
// window-marker probe evaluate remains the authoritative check regardless —
// a spoofed Marshal/Electron User-Agent on a non-Marshal endpoint is still
// caught there, metadata is never sufficient alone.
//
// Produces:
//   test-receipts/facfix2-red.txt   — the SUPERSEDED 3b8e99bc3 pattern
//     (frozen copy, single-arg isKnownNonMarshalBrowserString(browser))
//     wrongly refusing the REAL live Marshal /json/version fixture.
//   test-receipts/facfix2-green.txt — the CURRENT (post-2b-repair) pattern:
//     (a) accepts the real-Marshal fixture through User-Agent metadata,
//     (b) still refuses a real-desktop-Chrome fixture with no Marshal/
//         Electron marker in its User-Agent,
//     (c) a spoofed Marshal/Electron User-Agent on a non-Marshal endpoint is
//         still refused — by the marker-probe evaluate, not metadata.
//
// Re-runnable on demand. Not part of run-all.mjs's offline pipeline (guard c
// launches a real browser) — the receipts it writes are the committed
// evidence; permanent fast regression coverage of the same decision logic
// lives in lib/live-connection.test.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connectToRunningMarshal, LiveConnectionRefusalError } from "../lib/live-connection.mjs";
import { launchTestOwnedChromium } from "../lib/test-owned-chromium.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECEIPTS_DIR = path.resolve(__dirname, "..", "test-receipts");
const FIXTURE_PATH = path.resolve(
  __dirname,
  "..",
  "example-receipts",
  "live-demonstration",
  "json-version-9333.json",
);

// --- Frozen, historical copy of the SUPERSEDED 3b8e99bc3
// --- isKnownNonMarshalBrowserString(), single-arg, Browser-string-only.
// --- Never imported by, or reachable from, any production code path in this
// --- facility — kept ONLY so the red reproduction proves the real
// --- over-rejection defect rather than a strawman.
const SUPERSEDED_KNOWN_NON_MARSHAL_BROWSER_PATTERN = /^(Chrome|Firefox|Safari|Edg|OPR)\//;
function supersededIsKnownNonMarshalBrowserString(browser) {
  return typeof browser === "string" && SUPERSEDED_KNOWN_NON_MARSHAL_BROWSER_PATTERN.test(browser);
}

function loadFixture() {
  // SF-4: fixture is this facility's own committed file, not external input.
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
}

async function captureRed() {
  const lines = [
    "=== F-DEPLOY-2b RED: superseded 3b8e99bc3 isKnownNonMarshalBrowserString() against the REAL live Marshal /json/version shape ===",
    "",
  ];
  const fixture = loadFixture();
  lines.push(
    `Fixture: ${path.relative(process.cwd(), FIXTURE_PATH)} (captured read-only from the deployed host's ` +
      `own debug port on ${fixture.capturedAt}; no CDP attach, no evaluate).`,
  );
  lines.push(
    `Browser=${JSON.stringify(fixture.response.Browser)}, ` +
      `User-Agent=${JSON.stringify(fixture.response["User-Agent"])}`,
  );
  lines.push("");
  lines.push(
    "Calling the superseded 3b8e99bc3 pattern's isKnownNonMarshalBrowserString(browser) — Browser string " +
      "only, no User-Agent parameter — against this real fixture's Browser field...",
  );
  const superseded = supersededIsKnownNonMarshalBrowserString(fixture.response.Browser);
  lines.push(`Result: ${superseded}`);
  const ok = superseded === true;
  if (ok) {
    lines.push(
      "REFUSED (incorrectly). The superseded pattern's verifyNotAKnownDesktopBrowser() would have thrown " +
        'LiveConnectionRefusalError(code: "non-marshal-endpoint") here, before any Runtime.evaluate — ' +
        "fail-closed held (no evaluate ran against the real Marshal), but this is over-rejection: the real, " +
        "already-running, already-authenticated Marshal endpoint is refused solely because Electron's own " +
        "Browser field happens to be Chrome-shaped. The facility could never drive a live Marshal at all " +
        "under this pattern. This is the exact F-DEPLOY-2b defect Codex found and this repair closes.",
    );
  } else {
    lines.push("FAIL: expected the superseded pattern to (incorrectly) refuse this fixture.");
  }
  return { lines, ok };
}

async function captureGreenMetadataAccepted() {
  const lines = [
    "=== F-DEPLOY-2b GREEN (a): the REAL live Marshal fixture is accepted through User-Agent metadata ===",
    "",
  ];
  const fixture = loadFixture();
  const { isKnownNonMarshalBrowserString } = await import("../lib/live-connection.mjs");
  lines.push(
    `Fixture: Browser=${JSON.stringify(fixture.response.Browser)} (Chrome-shaped — Electron's own CDP ` +
      "handshake, not a real desktop browser), " +
      `User-Agent=${JSON.stringify(fixture.response["User-Agent"])} (carries both Marshal/ and Electron/ ` +
      "markers).",
  );
  lines.push("Calling the CURRENT isKnownNonMarshalBrowserString(browser, userAgent)...");
  const rejected = isKnownNonMarshalBrowserString(
    fixture.response.Browser,
    fixture.response["User-Agent"],
  );
  lines.push(`Result: ${rejected} (rejected=${rejected})`);
  const ok = rejected === false;
  lines.push(
    ok
      ? "NOT REJECTED at the metadata stage — this endpoint proceeds to the mandatory marker-probe evaluate " +
          "(the authoritative check), which a real Marshal renderer passes. Metadata acceptance alone never " +
          "grants a connection; it only avoids a false refusal here."
      : "FAIL: expected the real Marshal fixture to NOT be rejected at the metadata stage.",
  );
  return { lines, ok };
}

async function captureGreenDesktopChromeRefused() {
  const lines = [
    "=== F-DEPLOY-2b GREEN (b): a real desktop Chrome fixture (no Marshal/Electron marker) is still refused ===",
    "",
  ];
  // Representative real-desktop-Chrome /json/version shape (Browser field
  // format matches this facility's own pre-existing unit-test fixtures in
  // lib/live-connection.test.mjs) — the literal F-DEPLOY-2 scenario this
  // guard must keep catching: an operator's personal browser on the CDP port.
  const browser = "Chrome/146.0.7680.166";
  const userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/146.0.7680.166 Safari/537.36";
  const { isKnownNonMarshalBrowserString } = await import("../lib/live-connection.mjs");
  lines.push(
    `Fixture: Browser=${JSON.stringify(browser)} — the SAME Browser string as the real Marshal fixture ` +
      `above (same underlying Chromium build) — but User-Agent=${JSON.stringify(userAgent)} carries no ` +
      "Marshal/Electron marker (a real desktop Chrome install's own, unmodified User-Agent).",
  );
  lines.push("Calling the CURRENT isKnownNonMarshalBrowserString(browser, userAgent)...");
  const rejected = isKnownNonMarshalBrowserString(browser, userAgent);
  lines.push(`Result: ${rejected} (rejected=${rejected})`);
  const ok = rejected === true;
  lines.push(
    ok
      ? "REFUSED at the metadata stage, before any Runtime.evaluate — the wrong-browser guard the 3b8e99bc3 " +
          "repair intended is preserved: Browser alone is ambiguous (identical to the real Marshal's), but " +
          "the User-Agent correctly disambiguates."
      : "FAIL: expected a real desktop Chrome's User-Agent to still be refused.",
  );
  return { lines, ok };
}

async function captureGreenSpoofedUaCaughtByProbe() {
  const lines = [
    "=== F-DEPLOY-2b GREEN (c): a spoofed Marshal/Electron User-Agent is NOT caught by metadata — the mandatory marker probe still refuses it ===",
    "",
  ];
  const chrome = await launchTestOwnedChromium([
    "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Marshal/0.23.999 Chrome/145.0.0.0 Electron/41.9.9 Safari/537.36",
  ]);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "facfix2-spoofed-ua-"));
  const distDir = path.join(tmpDir, "dist");
  fs.mkdirSync(distDir);
  const spoofedFile = path.join(distDir, "index.html");
  fs.writeFileSync(spoofedFile, "<h1>Not actually Marshal (spoofed User-Agent)</h1>");
  let ok = false;
  try {
    lines.push(
      `Test-owned headless Chromium (bundled @playwright/test, version ${chrome.version}) started on ` +
        `127.0.0.1:${chrome.port} — ephemeral port, localhost only — launched with ` +
        "--user-agent=... containing both Marshal/ and Electron/ markers (a spoofed User-Agent an attacker " +
        "or misconfigured endpoint might present).",
    );
    const versionRes = await fetch(`http://127.0.0.1:${chrome.port}/json/version`);
    const version = await versionRes.json();
    lines.push(
      `This endpoint's own /json/version now reports Browser=${JSON.stringify(version.Browser)}, ` +
        `User-Agent=${JSON.stringify(version["User-Agent"])} — carries the spoofed Marshal/Electron markers.`,
    );
    const page = await chrome.browser.newPage();
    await page.goto(`file://${spoofedFile}`);
    lines.push(
      `Opened a plain static HTML file this script wrote to a temp dir, whose URL matches the legacy ` +
        `/dist/index.html pattern (so page matching succeeds) but is not Marshal: ${page.url()}`,
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
        "The /json/version metadata check did NOT reject this endpoint (User-Agent carries the Marshal/ " +
          "and Electron/ markers) — it fell through, exactly as designed. The mandatory window-marker " +
          "probe evaluate — the FIRST and only evaluate this connector runs — is what actually caught it: " +
          "this page has no window.sessionsAPI/window.runtimeUiAPI. This proves metadata acceptance alone " +
          "never suffices; a spoofed User-Agent cannot bypass endpoint verification.",
      );
      ok = isRefusal;
    }
  } finally {
    await chrome.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
  const redPath = writeLines("facfix2-red.txt", [red]);

  const greenA = await captureGreenMetadataAccepted();
  const greenB = await captureGreenDesktopChromeRefused();
  const greenC = await captureGreenSpoofedUaCaughtByProbe();
  const greenPath = writeLines("facfix2-green.txt", [greenA, greenB, greenC]);

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
