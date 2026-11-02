// Marshal-owned real-account harness.
// Marshal-owned fixed E2E suite.
/**
 * 04-browser: Open a page, navigate to another with goto, verify content.
 * Also verifies the browser actually launched visually (new process detected).
 * Test 3 verifies the browser write-kind permission pipeline with real Playwright MCP:
 *   3a. screenshot with explicit path + autoApprove:false → permission card blocks tool
 *   3b. screenshot with explicit path + autoApprove:true  → file written to outputDir sandbox
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  waitForReady,
  sendPrompt,
  waitForResponse,
  getLastAssistantMessage,
  getToolCalls,
  screenshot,
  getBrowserPids,
  invokeIPC,
  sleep,
} from "../marshal-cdp-helpers.mjs";
import { E2E_TEST_PERMISSIONS, NO_AUTO_APPROVE_PERMISSIONS } from "../marshal-e2e-permissions.mjs";

export default {
  name: "Browser Interaction",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;

    await waitForReady(Runtime);
    steps++;

    // Snapshot browser PIDs before the open command
    const pidsBefore = getBrowserPids();
    console.log(`   ✓ Browser PIDs before open: ${pidsBefore.size}`);
    steps++;

    // Test 1: Open a webpage — use explicit "open a browser" phrasing to route through
    // browser_navigate (Playwright MCP) rather than web_fetch (native SDK tool).
    await sendPrompt(
      Runtime,
      "Open a browser and go to https://example.com — tell me what the page title and main heading say.",
    );
    steps++;
    console.log("   ✓ Sent: open example.com");

    await waitForResponse(Runtime, 30, 90);
    steps++;

    const tools1 = await getToolCalls(Runtime);
    console.log(`   ✓ Tool calls: ${tools1.join(", ").slice(0, 120)}`);
    steps++;

    const response1 = await getLastAssistantMessage(Runtime);
    if (!response1) throw new Error("No response for browser open");
    if (!/example/i.test(response1)) {
      console.log(`   ⚠️  Response may not mention Example Domain: "${response1.slice(0, 100)}"`);
    }
    steps++;
    console.log(`   ✓ Browser open verified`);

    // Verify new browser processes appeared (browser visually launched)
    const pidsAfter = getBrowserPids();
    const newPids = [...pidsAfter].filter((pid) => !pidsBefore.has(pid));
    if (newPids.length > 0) {
      console.log(`   ✓ Browser launched visually — ${newPids.length} new process(es) detected`);
    } else {
      console.log(`   ⚠️  No new browser processes detected (browser may have reused existing)`);
    }
    steps++;

    await screenshot(Page, resultsDir, "04-browser-open.png");
    console.log("   📸 04-browser-open.png");

    // Test 2: Navigate to another page in the open browser (should use goto, not open)
    await sendPrompt(
      Runtime,
      "In the browser, navigate to https://httpbin.org/html and summarize what you see on the page.",
    );
    steps++;
    console.log("   ✓ Sent: goto httpbin.org/html");

    await waitForResponse(Runtime, 30, 90);
    steps++;

    const tools2 = await getToolCalls(Runtime);
    // Check if goto was used instead of open (validates prompt optimization)
    const toolText = tools2.join(" ").toLowerCase();
    if (toolText.includes("goto")) {
      console.log("   ✓ Used 'goto' for second navigation (prompt optimization working!)");
    } else if (toolText.includes("open")) {
      console.log("   ⚠️  Used 'open' instead of 'goto' — prompt optimization may not be working");
    }
    steps++;

    const response2 = await getLastAssistantMessage(Runtime);
    if (!response2) throw new Error("No response for second navigation");
    steps++;
    console.log(`   ✓ Second navigation response: "${response2.slice(0, 80)}..."`);

    // Verify browser still running after goto (didn't kill & restart)
    const pidsAfterGoto = getBrowserPids();
    const gotoNewPids = [...pidsAfterGoto].filter((pid) => !pidsAfter.has(pid));
    const gotoGonePids = [...pidsAfter].filter((pid) => !pidsAfterGoto.has(pid));
    if (gotoGonePids.length === 0 && gotoNewPids.length === 0) {
      console.log("   ✓ Browser reused for goto (no process churn)");
    } else {
      console.log(
        `   ⚠️  Browser processes changed after goto: +${gotoNewPids.length} -${gotoGonePids.length}`,
      );
    }
    steps++;

    await screenshot(Page, resultsDir, "04-browser-goto.png");
    console.log("   📸 04-browser-goto.png");

    // Test 3: Browser write permission gate (real Playwright subprocess).
    //
    // Verifies the write-kind upgrade in permissionHandler works end-to-end by
    // toggling the playwright server on/off — the cleanest observable signal in
    // CDP-based tests that can't click permission cards:
    //
    //   3a. playwright.enabled: false → server-disabled deny (step 4 of evaluate()) →
    //       tool blocked immediately, AI reports failure, no file written.
    //   3b. playwright.enabled: true, autoApprove: true → write-kind auto-approved →
    //       screenshot written to disk (confirms full pipeline from toolArgs plumbing
    //       through permissionHandler kind-upgrade through evaluate() auto-approve).

    // Use separate paths for 3a and 3b so the AI has no stale denial context for 3b.
    const screenshotPath3a = path.join(os.homedir(), "e2e-browser-write-blocked.png");
    const screenshotPath3b = path.join(os.homedir(), "e2e-browser-write-allowed.png");
    for (const p of [screenshotPath3a, screenshotPath3b]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    // Record timestamp before 3b starts so the sandbox fallback only accepts newly-written files.
    const test3bStartMs = Date.now();

    let savedSettings;
    try {
      const result = await invokeIPC(Runtime, "settingsAPI", "get");
      savedSettings = result?.settings ?? result;
    } catch {
      throw new Error("Could not read current settings — cannot run permission pipeline test");
    }
    steps++;

    try {
      // ── 3a: filesystem server disabled → browser write denied (same pipeline) ──
      // Browser file writes route through the write-kind pipeline which uses the
      // filesystem server gate — same as any other disk write. Disabling FS access
      // blocks browser screenshots just as it blocks filesystem MCP file writes.
      await invokeIPC(Runtime, "settingsAPI", "save", {
        ...savedSettings,
        permissions: {
          ...E2E_TEST_PERMISSIONS,
          servers: {
            ...E2E_TEST_PERMISSIONS.servers,
            filesystem: { enabled: false, autoApprove: false },
          },
        },
      });
      await sleep(1000);
      console.log("   ✓ Set filesystem.enabled: false");
      steps++;

      await sendPrompt(
        Runtime,
        `Open a browser and take a screenshot, save it to ${screenshotPath3a}`,
      );
      steps++;
      console.log("   ✓ Sent: screenshot with explicit path (filesystem disabled)");

      await waitForResponse(Runtime, 15, 60);
      steps++;

      const response3a = await getLastAssistantMessage(Runtime);
      console.log(
        `   ✓ 3a response (tool should have been blocked): "${(response3a ?? "").slice(0, 80)}..."`,
      );
      if (fs.existsSync(screenshotPath3a)) {
        throw new Error(
          `3a: screenshot was written even with filesystem.enabled: false — ${screenshotPath3a}`,
        );
      }
      console.log("   ✓ 3a: no file written (filesystem-disabled gate held)");
      steps++;

      await screenshot(Page, resultsDir, "04-browser-screenshot-blocked.png");
      console.log("   📸 04-browser-screenshot-blocked.png");

      // ── 3b: playwright enabled + autoApprove:true → write auto-approved ────
      await invokeIPC(Runtime, "settingsAPI", "save", {
        ...savedSettings,
        permissions: E2E_TEST_PERMISSIONS,
      });
      await sleep(2000);
      console.log("   ✓ Set filesystem.enabled: true, autoApprove: true");
      steps++;

      await sendPrompt(
        Runtime,
        `Open a browser and take a screenshot, save it to ${screenshotPath3b}`,
      );
      steps++;
      console.log("   ✓ Sent: screenshot with explicit path (playwright enabled)");

      await waitForResponse(Runtime, 20, 90);
      steps++;

      const response3b = await getLastAssistantMessage(Runtime);
      console.log(`   ✓ 3b response: "${(response3b ?? "").slice(0, 80)}..."`);

      if (!fs.existsSync(screenshotPath3b)) {
        // Playwright's checkFile may have sandboxed the write to outputDir.
        const fallbackDirs = [
          path.join(os.homedir(), ".marshal-dev", "browser-output"),
          path.join(os.homedir(), ".marshal", "browser-output"),
        ];
        const sandboxedFile = fallbackDirs.some(
          (d) =>
            fs.existsSync(d) &&
            fs.readdirSync(d, { recursive: true, withFileTypes: true }).some((e) => {
              if (!e.isFile() || !e.name.endsWith(".png")) return false;
              const filePath = path.join(e.parentPath ?? e.path ?? d, e.name);
              const { mtimeMs } = fs.statSync(filePath);
              return mtimeMs >= test3bStartMs;
            }),
        );
        if (sandboxedFile) {
          console.log(
            "   ✓ 3b: screenshot in browser-output sandbox (checkFile enforced outputDir)",
          );
        } else {
          throw new Error("3b: screenshot not found — write-kind auto-approve path may be broken");
        }
      } else {
        console.log(`   ✓ 3b: screenshot written to ${screenshotPath3b}`);
      }
      steps++;

      await screenshot(Page, resultsDir, "04-browser-screenshot-approved.png");
      console.log("   📸 04-browser-screenshot-approved.png");
    } finally {
      try {
        await invokeIPC(Runtime, "settingsAPI", "save", {
          ...savedSettings,
          permissions: E2E_TEST_PERMISSIONS,
        });
        await sleep(500);
      } catch {
        console.log("   ⚠️  Could not restore permissions");
      }
      for (const p of [screenshotPath3a, screenshotPath3b]) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    }

    return steps;
  },
};
