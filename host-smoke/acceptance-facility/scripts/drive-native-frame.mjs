#!/usr/bin/env node
// D4, point (c): visual/user operation
// (AUDIT-VERDICT-AND-ACCEPTANCE.md "Testing capability gaps", point 3). A
// verified route to the REAL native frame and sandbox for capture, click,
// type, scroll, resize, and native selection — the exact gap the audit
// names ("An API success alone cannot certify a button works"). This is
// installed-ui evidence: it only makes sense against an already-running,
// already-authenticated Marshal, so it is unconditionally live-gated.
//
// Uses Playwright's frameLocator (via connectPageOverCDP), NOT plain
// `document.querySelector` JS evaluation: the packaged application iframe
// is `sandbox="allow-scripts"` with no `allow-same-origin`, so it has an
// opaque origin distinct from the renderer's own — a direct JS property
// access from the top-level document cannot reach inside it, same as it
// cannot from the app's own script. frameLocator dispatches through the
// browser's automation layer instead, which is what actually reaches a
// real user's click, exactly as validated in
// ../native-frame/controlled-scenarios.browser.test.tsx (native-frame
// evidence class — the always-runnable, non-live counterpart to this file).
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  connectPageOverCDP,
  LiveConnectionRefusalError,
  liveModePort,
  liveModeRequested,
} from "../lib/live-connection.mjs";
import { writeReceipt } from "../lib/receipt.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECEIPTS_DIR = path.resolve(__dirname, "..", "example-receipts");

const SUPPORTED_OPERATIONS = Object.freeze([
  "capture",
  "click",
  "type",
  "scroll",
  "resize",
  "select",
]);

function parseArgs(argv) {
  return {
    operation: argv[0],
    applicationTitle: argv[1],
    role: argv[2],
    name: argv[3],
    value: argv[4],
  };
}

async function driveOperation(page, args) {
  const { operation, applicationTitle, role, name, value } = args;
  switch (operation) {
    case "capture": {
      const buffer = await page.screenshot();
      return { operation, capturedBytes: buffer.length };
    }
    case "resize": {
      const [width, height] = String(value ?? "")
        .split("x")
        .map(Number);
      await page.setViewportSize({ width: width || 800, height: height || 600 });
      return { operation, width, height };
    }
    default: {
      if (!applicationTitle)
        throw new Error("An application iframe title is required for this operation.");
      const frame = page.frameLocator(page.getByTitle(applicationTitle));
      const locator = role
        ? frame.getByRole(role, name ? { name } : undefined)
        : frame.getByTestId(name);
      if (operation === "click") {
        await locator.click();
        return { operation, applicationTitle, role, name };
      }
      if (operation === "type") {
        await locator.fill(value ?? "");
        return { operation, applicationTitle, role, name, valueLength: (value ?? "").length };
      }
      if (operation === "select") {
        await locator.selectOptions(value ?? "");
        return { operation, applicationTitle, role, name, value };
      }
      if (operation === "scroll") {
        await locator.wheel({ delta: { y: Number(value ?? 0) } });
        return { operation, applicationTitle, role, name, delta: value };
      }
      throw new Error(
        `Unsupported operation: ${operation}. Expected one of ${SUPPORTED_OPERATIONS.join(", ")}.`,
      );
    }
  }
}

async function main() {
  const receiptPath = path.join(RECEIPTS_DIR, "drive-native-frame.installed-ui.json");
  const args = parseArgs(process.argv.slice(2));
  if (!liveModeRequested()) {
    writeReceipt(receiptPath, {
      evidenceClass: "installed-ui",
      status: "blocked",
      facility: "drive-native-frame",
      subject: `Real native-frame ${args.operation ?? "capture/click/type/scroll/resize/select"} via Playwright-over-CDP`,
      reason:
        "Requires parent deployment step / live authorization: set ACCEPTANCE_FACILITY_ALLOW_LIVE=1 and run " +
        "against an already-running Marshal with a CDP debug port open (e.g. `pnpm electron:debug`).",
      limits: [
        "Usage once live: node drive-native-frame.mjs <capture|click|type|scroll|select|resize> " +
          "[applicationIframeTitle] [ariaRole] [accessibleName] [value]",
        "click/type/scroll/select require the packaged application's iframe title (its declared resource " +
          "name) and locate the target control inside it by ARIA role/name or test id, the same way " +
          "../native-frame/controlled-scenarios.browser.test.tsx does.",
        "capture returns a screenshot byte count only, to keep receipts free of application content.",
      ],
    });
    process.exitCode = 0;
    return;
  }
  if (!args.operation || !SUPPORTED_OPERATIONS.includes(args.operation)) {
    writeReceipt(receiptPath, {
      evidenceClass: "installed-ui",
      status: "fail",
      facility: "drive-native-frame",
      subject: "Real native-frame operation via Playwright-over-CDP",
      reason: `Missing or unsupported operation. Expected one of ${SUPPORTED_OPERATIONS.join(", ")}.`,
    });
    process.exitCode = 1;
    return;
  }
  let browser;
  try {
    const port = liveModePort();
    let page;
    ({ browser, page } = await connectPageOverCDP(port));
    const proof = await driveOperation(page, args);
    writeReceipt(receiptPath, {
      evidenceClass: "installed-ui",
      status: "pass",
      facility: "drive-native-frame",
      subject: `Real native-frame ${args.operation} via Playwright-over-CDP`,
      proof,
    });
    process.exitCode = 0;
  } catch (error) {
    const isRefusal = error instanceof LiveConnectionRefusalError;
    writeReceipt(receiptPath, {
      evidenceClass: "installed-ui",
      // F-DEPLOY-2 (b)/(c): a typed connection-guard refusal is reported "blocked", not "fail" — see
      // identify-installed-artifact.mjs for the same convention.
      status: isRefusal ? "blocked" : "fail",
      facility: "drive-native-frame",
      subject: `Real native-frame ${args.operation} via Playwright-over-CDP`,
      reason: error instanceof Error ? error.message : String(error),
      ...(isRefusal ? { proof: { refusalCode: error.code } } : {}),
    });
    process.exitCode = isRefusal ? 0 : 1;
  } finally {
    await browser?.close();
  }
}

main();
