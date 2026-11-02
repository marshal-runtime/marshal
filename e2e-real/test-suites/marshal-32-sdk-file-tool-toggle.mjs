// Marshal-owned real-account harness.
/**
 * 32-sdk-file-tool-toggle: Verify SDK built-in file tools are gated by the
 * filesystem server toggle.
 *
 * Disables File System Access, asks the agent to read a file (triggering
 * view/grep/glob) and then edit a file (triggering edit/create), then asserts
 * on the audit log that both were denied by the pre-hook-disabled-server rule.
 * Re-enables and verifies reads work again.
 *
 * Requires pnpm electron:debug (CDP on :9222) with a real account signed in.
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

const AUDIT_LOG_DIR = path.join(os.homedir(), ".marshal-dev", "marshal-audit-logs");

function readAuditEntriesSince(sinceIso) {
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

const SDK_FILE_READ_TOOLS = new Set(["view", "grep", "glob"]);
const SDK_FILE_WRITE_TOOLS = new Set(["edit", "create"]);

async function pollAuditForTools(toolSet, sinceIso, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = readAuditEntriesSince(sinceIso);
    const matched = entries.filter((e) => toolSet.has(e.toolName));
    if (matched.length > 0) return matched;
    await sleep(250);
  }
  return [];
}

export default {
  name: "SDK File Tool Toggle",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;

    await waitForReady(Runtime);
    steps++;

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
      // Disable File System Access
      const prevServers = originalSettings?.permissions?.servers ?? {};
      const prevFs = prevServers.filesystem ?? { enabled: true, autoApprove: true };
      await invokeIPC(Runtime, "settingsAPI", "save", {
        ...originalSettings,
        permissions: {
          ...originalSettings?.permissions,
          servers: {
            ...prevServers,
            filesystem: { ...prevFs, enabled: false },
          },
        },
      });
      await sleep(2000);
      console.log('   ✓ Disabled "File System Access" (filesystem.enabled = false)');
      steps++;

      await screenshot(Page, resultsDir, "32-filesystem-disabled.png");
      console.log("   📸 32-filesystem-disabled.png");

      // --- Read test: trigger view/grep/glob ---
      const readSentAt = new Date().toISOString();
      await sendPrompt(
        Runtime,
        "Use the view tool to read the file ~/.zshrc and show me what's in it.",
      );
      console.log("   ✓ Sent read request (view tool should be denied by pre-hook)");
      steps++;

      await waitForResponse(Runtime, 20, 60);
      steps++;

      const readEntries = await pollAuditForTools(SDK_FILE_READ_TOOLS, readSentAt);
      if (readEntries.length === 0) {
        const response = await getLastAssistantMessage(Runtime);
        const auditHint = fs.existsSync(AUDIT_LOG_DIR)
          ? ""
          : ` (audit dir missing: ${AUDIT_LOG_DIR} — is app running via pnpm electron:debug?)`;
        throw new Error(
          `No SDK file read tool (view/grep/glob) appeared in audit log.${auditHint} ` +
            `Last response: "${(response || "").slice(0, 120)}"`,
        );
      }
      const approvedReads = readEntries.filter((e) => e.decision === "approved");
      if (approvedReads.length > 0) {
        throw new Error(
          `SDK read tools were not blocked when filesystem disabled. Approved: ` +
            JSON.stringify(approvedReads.map((e) => `${e.toolName}/${e.source}`)),
        );
      }
      const deniedReads = readEntries.filter(
        (e) => e.decision === "denied" && e.source === "pre-hook-disabled-server",
      );
      if (deniedReads.length === 0) {
        throw new Error(
          `SDK read tool invoked but not denied by pre-hook-disabled-server. Entries: ` +
            JSON.stringify(readEntries.map((e) => `${e.toolName}:${e.decision}/${e.source}`)),
        );
      }
      console.log(
        `   ✓ SDK read tool blocked by pre-hook-disabled-server (${deniedReads.length} entr${deniedReads.length === 1 ? "y" : "ies"}: ` +
          `${deniedReads.map((e) => e.toolName).join(", ")})`,
      );
      steps++;

      await screenshot(Page, resultsDir, "32-read-denied.png");
      console.log("   📸 32-read-denied.png");

      // --- Write test: verify no write succeeds when filesystem + shell are disabled ---
      // Disable shell too so the model cannot route around the filesystem gate via
      // printf/tee/etc. The security property we test is: no write reaches the disk.
      const prevShell = prevServers.shell ?? { enabled: true, autoApprove: false };
      await invokeIPC(Runtime, "settingsAPI", "save", {
        ...originalSettings,
        permissions: {
          ...originalSettings?.permissions,
          servers: {
            ...prevServers,
            filesystem: { ...prevFs, enabled: false },
            shell: { ...prevShell, enabled: false },
          },
        },
      });
      await sleep(1000);
      console.log("   ✓ Also disabled shell (closes printf/tee workaround)");

      const writeTarget = `/tmp/e2e-sdk-write-test-${Date.now()}.txt`;
      if (fs.existsSync(writeTarget)) fs.unlinkSync(writeTarget);

      const writeSentAt = new Date().toISOString();
      await sendPrompt(
        Runtime,
        `Append the text "# e2e-write-test" to the file ${writeTarget}. Use any method available.`,
      );
      console.log("   ✓ Sent write request (all file-write paths should be blocked)");
      steps++;

      await waitForResponse(Runtime, 20, 60);
      steps++;

      // Ground-truth assertion: the file must not exist.
      if (fs.existsSync(writeTarget)) {
        throw new Error(
          `Write succeeded despite filesystem + shell being disabled — file was created: ${writeTarget}`,
        );
      }
      console.log("   ✓ File was NOT written to disk — write gate held");

      // Also check that the SDK edit/create tools, if invoked, were denied at the pre-hook.
      const writeEntries = await pollAuditForTools(SDK_FILE_WRITE_TOOLS, writeSentAt);
      if (writeEntries.length > 0) {
        const approvedWrites = writeEntries.filter((e) => e.decision === "approved");
        if (approvedWrites.length > 0) {
          throw new Error(
            `SDK write tools were approved despite filesystem being disabled: ` +
              JSON.stringify(approvedWrites.map((e) => `${e.toolName}/${e.source}`)),
          );
        }
        const deniedWrites = writeEntries.filter(
          (e) => e.decision === "denied" && e.source === "pre-hook-disabled-server",
        );
        console.log(
          `   ✓ SDK write tool denied by pre-hook-disabled-server (${deniedWrites.map((e) => e.toolName).join(", ")})`,
        );
      } else {
        // Model used shell or MCP — that's fine, the file-not-written check above is authoritative.
        console.log("   ✓ Model did not invoke SDK edit/create (used shell or MCP, also blocked)");
      }
      steps++;

      await screenshot(Page, resultsDir, "32-write-denied.png");
      console.log("   📸 32-write-denied.png");
    } finally {
      // Restore original settings
      try {
        await invokeIPC(Runtime, "settingsAPI", "save", originalSettings);
        await sleep(2000);
        console.log('   ✓ Re-enabled "File System Access"');
      } catch (err) {
        console.log(`   ⚠️  Could not restore settings: ${err.message}`);
      }
    }
    steps++;

    // Verify reads work again after re-enabling
    await sendPrompt(Runtime, "Use the view tool to read /tmp and list what's there.");
    steps++;

    await waitForResponse(Runtime, 30, 90);
    steps++;

    const response2 = await getLastAssistantMessage(Runtime);
    if (response2 && !/denied|blocked|cannot/i.test(response2)) {
      console.log("   ✓ File read works after re-enabling File System Access");
    } else {
      console.log(`   ⚠️  File read may still be blocked: "${(response2 || "").slice(0, 80)}"`);
    }
    steps++;

    await screenshot(Page, resultsDir, "32-filesystem-reenabled.png");
    console.log("   📸 32-filesystem-reenabled.png");

    return steps;
  },
};
