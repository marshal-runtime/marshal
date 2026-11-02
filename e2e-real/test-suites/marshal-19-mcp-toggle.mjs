// Marshal-owned real-account harness.
/**
 * 19-mcp-toggle: Phase 2 — Disable/enable MCP servers and verify blocking.
 *
 * Disables Browser Control, verifies browser commands are denied,
 * then re-enables and verifies they work.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  waitForReady,
  sendPrompt,
  waitForResponse,
  getLastAssistantMessage,
  invokeIPC,
  screenshot,
  sleep,
} from "../marshal-cdp-helpers.mjs";

// electron:debug runs unpackaged → dev mode → ~/.marshal-dev/ (see electron/app-paths.ts:getAppDataDir).
const AUDIT_LOG_DIR = path.join(os.homedir(), ".marshal-dev", "marshal-audit-logs");

function readAuditEntriesSince(sinceIso) {
  // Derive dates from sinceIso, not read time — the audit log rotates by UTC date
  // (electron/audit-log.ts), so a test that started before midnight UTC and reads
  // after must still pick up entries from the original file. Read both if they differ.
  const sinceDate = sinceIso.slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const dates = sinceDate === today ? [sinceDate] : [sinceDate, today];
  const out = [];
  for (const d of dates) {
    const file = path.join(AUDIT_LOG_DIR, `permissions-${d}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.timestamp >= sinceIso) out.push(entry);
      } catch {
        // skip malformed lines
      }
    }
  }
  return out;
}

export default {
  name: "MCP Server Toggle",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;

    await waitForReady(Runtime);
    steps++;

    // Save current settings
    let originalSettings;
    try {
      const result = await invokeIPC(Runtime, "settingsAPI", "get");
      originalSettings = result?.settings ?? result;
      console.log("   ✓ Saved original settings");
    } catch {
      console.log("   ⚠️  Could not save original settings");
    }
    steps++;

    try {
      // Disable Browser Control by setting permissions.servers.playwright.enabled = false.
      try {
        const prevServers = originalSettings?.permissions?.servers ?? {};
        const prevPlaywright = prevServers.playwright ?? { enabled: true, autoApprove: true };
        await invokeIPC(Runtime, "settingsAPI", "save", {
          ...originalSettings,
          permissions: {
            ...originalSettings?.permissions,
            servers: {
              ...prevServers,
              playwright: { ...prevPlaywright, enabled: false },
            },
          },
        });
        await sleep(2000);
        console.log(
          '   ✓ Disabled "Browser Control" (permissions.servers.playwright.enabled = false)',
        );
      } catch (err) {
        throw new Error(`Could not disable Browser Control: ${err.message}`, { cause: err });
      }
      steps++;

      await screenshot(Page, resultsDir, "19-mcp-browser-disabled.png");
      console.log("   📸 19-mcp-browser-disabled.png");

      // Try to use browser — playwright tool calls should be denied at the pre-hook.
      // We assert on the audit log rather than the assistant text, because the model
      // may fall back to a different tool (e.g. web_fetch) and still answer the
      // question — the response wouldn't reflect whether playwright itself was blocked.
      const sentAt = new Date().toISOString();
      await sendPrompt(Runtime, "Go to https://example.com and tell me what you see.");
      steps++;
      console.log("   ✓ Sent browser command (should be denied)");

      await waitForResponse(Runtime, 20, 60);
      steps++;

      // Audit log writes are chained async (electron/audit-log.ts) — poll until a
      // playwright entry appears or the deadline lapses. Bails out fast on the
      // happy path instead of always paying a fixed flush sleep.
      let entries = [];
      const pollDeadline = Date.now() + 10_000;
      while (Date.now() < pollDeadline) {
        entries = readAuditEntriesSince(sentAt);
        if (entries.some((e) => e.toolName?.startsWith("playwright-"))) break;
        await sleep(250);
      }

      const playwrightEntries = entries.filter((e) => e.toolName?.startsWith("playwright-"));
      if (playwrightEntries.length === 0) {
        const response1 = await getLastAssistantMessage(Runtime);
        const dirHint = fs.existsSync(AUDIT_LOG_DIR)
          ? ""
          : ` (audit log dir not found at ${AUDIT_LOG_DIR} — is the app running in dev mode via pnpm electron:debug?)`;
        throw new Error(
          `Model did not invoke any playwright-* tool — cannot verify toggle.${dirHint} ` +
            `Audit entries since ${sentAt}: ${entries.length}. ` +
            `Last response: "${(response1 || "").slice(0, 120)}"`,
        );
      }
      const approvedPlaywright = playwrightEntries.filter((e) => e.decision === "approved");
      if (approvedPlaywright.length > 0) {
        throw new Error(
          `Browser Control toggle did not block playwright tools. Approved entries: ` +
            JSON.stringify(approvedPlaywright.map((e) => `${e.toolName}/${e.source}`)),
        );
      }
      const deniedByToggle = playwrightEntries.filter(
        (e) => e.decision === "denied" && e.source === "pre-hook-disabled-server",
      );
      if (deniedByToggle.length === 0) {
        throw new Error(
          `Playwright was invoked but not denied by the disabled-server pre-hook. ` +
            `Playwright entries: ` +
            JSON.stringify(playwrightEntries.map((e) => `${e.toolName}:${e.decision}/${e.source}`)),
        );
      }
      console.log(
        `   ✓ Playwright blocked by pre-hook-disabled-server (${deniedByToggle.length} deny ` +
          `entr${deniedByToggle.length === 1 ? "y" : "ies"}: ` +
          `${deniedByToggle.map((e) => e.toolName).join(", ")})`,
      );
      steps++;

      await screenshot(Page, resultsDir, "19-mcp-browser-denied.png");
      console.log("   📸 19-mcp-browser-denied.png");
    } finally {
      // Always restore original MCP settings
      try {
        await invokeIPC(Runtime, "settingsAPI", "save", originalSettings);
        await sleep(2000);
        console.log('   ✓ Re-enabled "Browser Control"');
      } catch (err) {
        console.log(`   ⚠️  Could not re-enable Browser Control: ${err.message}`);
      }
    }
    steps++;

    // Verify browser works again
    await sendPrompt(Runtime, "Go to https://example.com and tell me the page title.");
    steps++;

    await waitForResponse(Runtime, 30, 90);
    steps++;

    const response2 = await getLastAssistantMessage(Runtime);
    if (response2 && /example/i.test(response2)) {
      console.log("   ✓ Browser works after re-enabling");
    } else {
      console.log(`   ⚠️  Browser may not work: "${(response2 || "").slice(0, 80)}"`);
    }
    steps++;

    await screenshot(Page, resultsDir, "19-mcp-browser-enabled.png");
    console.log("   📸 19-mcp-browser-enabled.png");

    return steps;
  },
};
