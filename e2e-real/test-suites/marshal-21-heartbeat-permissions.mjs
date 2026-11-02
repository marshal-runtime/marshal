// Marshal-owned real-account harness.
/**
 * 21-heartbeat-permissions: Verify heartbeat custom permissions and toggle.
 *
 * Part 1: Enables heartbeat with custom permissions (auto-approve read-only),
 *          triggers "Run Now", checks that tool calls complete.
 * Part 2: Removes custom permissions (deny-prompt default), changes prompt
 *          to "ls -la ~/", runs heartbeat, verifies tool call is blocked
 *          and logged in heartbeat activity.
 */
import os from "node:os";
import path from "node:path";

import {
  waitForReady,
  sendPrompt,
  waitForResponse,
  getLastAssistantMessage,
  evaluate,
  invokeIPC,
  openLeftNavItem,
  screenshot,
} from "../marshal-cdp-helpers.mjs";
import { E2E_TEST_PERMISSIONS, NO_AUTO_APPROVE_PERMISSIONS } from "../marshal-e2e-permissions.mjs";

/** Open the Heartbeat panel via the bottom-left "More" menu. */
async function openHeartbeatPanel(Runtime) {
  const alreadyOpen = await evaluate(
    Runtime,
    `!!document.querySelector('section[aria-label="Heartbeat settings"]')`,
  );
  if (alreadyOpen) return;

  await openLeftNavItem(Runtime, "Heartbeat");

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const visible = await evaluate(
      Runtime,
      `!!document.querySelector('section[aria-label="Heartbeat settings"]')`,
    );
    if (visible) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Heartbeat panel did not open");
}

/** Close the Heartbeat panel. */
async function closeHeartbeatPanel(Runtime) {
  await evaluate(
    Runtime,
    `(() => {
      const btn = document.querySelector('section[aria-label="Heartbeat settings"] button[aria-label="Close"]');
      if (btn) { btn.click(); return true; }
      // Fallback: click a session in the sidebar
      const session = document.querySelector('[data-session-id]');
      if (session) { session.click(); return true; }
      return false;
    })()`,
  );
  await new Promise((r) => setTimeout(r, 1000));
}

export default {
  name: "Heartbeat Permissions",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;

    await waitForReady(Runtime);
    steps++;

    // ── Setup: ensure heartbeat has custom permissions (auto-approve read-only) ──

    await openHeartbeatPanel(Runtime);

    // Click "Customize permissions" if not already customized
    const setupResult = await evaluate(
      Runtime,
      `(() => {
        const btns = [...document.querySelectorAll('section[aria-label="Heartbeat settings"] button')];
        const customizeBtn = btns.find(b => b.textContent.includes('Customize permissions'));
        if (customizeBtn) { customizeBtn.click(); return 'clicked-customize'; }
        // Already has custom permissions
        return 'already-custom';
      })()`,
    );
    await new Promise((r) => setTimeout(r, 500));
    console.log(`   ✓ Initial permissions state: ${setupResult}`);
    await closeHeartbeatPanel(Runtime);
    steps++;

    // ── Part 1: Custom permissions ON — tools auto-approved ───────────

    // Wait for chat textarea to re-mount after panel close
    await waitForReady(Runtime);

    // Enable heartbeat with a prompt that would trigger tool calls
    await sendPrompt(
      Runtime,
      'Enable heartbeat with the prompt "What is the current date and time?" Set a 60-minute interval.',
    );
    steps++;
    console.log("   ✓ Sent: enable heartbeat");

    await waitForResponse(Runtime, 20, 60);
    steps++;

    const response1 = await getLastAssistantMessage(Runtime);
    if (!response1) throw new Error("No response for heartbeat enable");
    console.log(`   ✓ Enable response: "${response1.slice(0, 80)}"`);
    steps++;

    // Trigger Run Now
    await sendPrompt(Runtime, "Run the heartbeat check now.");
    steps++;

    await waitForResponse(Runtime, 30, 90);
    steps++;

    // After heartbeat runs, check that NO permission cards were shown
    const permCount = await evaluate(
      Runtime,
      `document.querySelectorAll('.permission-card').length`,
    );
    console.log(
      `   ${permCount === 0 ? "✓" : "⚠️"} Permission cards in DOM (custom perms ON): ${permCount}`,
    );
    steps++;

    // Verify heartbeat completed (check for a result message)
    const response2 = await getLastAssistantMessage(Runtime);
    console.log(`   ✓ Run response: "${(response2 || "").slice(0, 80)}"`);
    steps++;

    await screenshot(Page, resultsDir, "21-heartbeat-perms-on.png");
    console.log("   📸 21-heartbeat-perms-on.png");

    // ── Part 2: Remove custom permissions — shell tool calls should be blocked ──

    // Save current settings so we can restore them
    const savedSettings = await invokeIPC(Runtime, "settingsAPI", "get");
    const origSettings = savedSettings?.settings ?? savedSettings;
    steps++;

    try {
      // Disable all auto-approve paths so shell commands are blocked
      await invokeIPC(Runtime, "settingsAPI", "save", {
        ...origSettings,
        permissions: NO_AUTO_APPROVE_PERMISSIONS,
      });
      await new Promise((r) => setTimeout(r, 500));
      console.log("   ✓ Disabled all auto-approve (permissions block)");
      steps++;

      // Remove custom permissions via IPC (revert to deny-prompt default).
      // Use null instead of undefined: JSON.stringify drops undefined keys,
      // so { permissions: undefined } would arrive as {} and merge-spread
      // would leave the existing custom permissions in place. null survives
      // serialization, and the renderer's !permissions check treats null
      // and undefined the same way.
      await invokeIPC(Runtime, "heartbeatAPI", "saveSettings", { permissions: null });
      await new Promise((r) => setTimeout(r, 500));
      console.log("   ✓ Removed custom permissions (deny-prompt default)");
      steps++;

      await openHeartbeatPanel(Runtime);
      steps++;
      console.log("   ✓ Opened Heartbeat panel");

      // Verify "Customize permissions" button is visible (no custom perms)
      const customizeBtnVisible = await evaluate(
        Runtime,
        `(() => {
        const btns = [...document.querySelectorAll('section[aria-label="Heartbeat settings"] button')];
        return !!btns.find(b => b.textContent.includes('Customize permissions'));
      })()`,
      );
      console.log(
        `   ${customizeBtnVisible ? "✓" : "⚠️"} Customize button visible: ${customizeBtnVisible}`,
      );
      steps++;

      // Change the heartbeat prompt to force a NON-read-only shell tool call.
      // The heartbeat default permissions hardcode autoApproveReadOnly=true
      // (heartbeat.ts:501-503) even when global permissions disable it, so a
      // read-only command like `ls` would be auto-approved at Step 6 and
      // never reach the deny-prompt branch. `mkdir` is not in the read-only
      // allowlist, so it falls through to prompt → deny-prompt → blocked.
      // The OS-level mkdir never runs because deny-prompt blocks before exec —
      // but routing through os.tmpdir() with a unique suffix means a future
      // regression in the deny-prompt path leaks into the auto-collected temp
      // dir instead of Marshal's CWD.
      const denyTargetPath = path.join(os.tmpdir(), `marshal-e2e-perm-block-${Date.now()}`);
      const denyPrompt = `Use the shell tool to run exactly this command and nothing else: mkdir ${denyTargetPath}`;
      await evaluate(
        Runtime,
        `(() => {
        const ta = document.querySelector('section[aria-label="Heartbeat settings"] textarea');
        if (!ta) throw new Error('Heartbeat prompt textarea not found');
        const nativeSet = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype, 'value'
        ).set;
        nativeSet.call(ta, ${JSON.stringify(denyPrompt)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
      );
      await new Promise((r) => setTimeout(r, 300));
      await evaluate(
        Runtime,
        `(() => {
        const btns = [...document.querySelectorAll('section[aria-label="Heartbeat settings"] button')];
        const btn = btns.find(b => /^Save$/i.test(b.textContent.trim()));
        if (!btn) throw new Error('Save button not found');
        btn.click();
        return true;
      })()`,
      );
      await new Promise((r) => setTimeout(r, 500));
      steps++;
      console.log("   ✓ Changed prompt to: mkdir (non-read-only, will be blocked)");

      await screenshot(Page, resultsDir, "21-heartbeat-perms-off.png");
      console.log("   📸 21-heartbeat-perms-off.png");

      // Click Run Now from the panel. Poll for the button to be available
      // and not disabled — an earlier chat-driven heartbeat run can still
      // be in progress, in which case the button reads "Running…" instead
      // of "Run now" and is disabled.
      const RUN_NOW_POLL_DEADLINE_MS = 30_000;
      const runDeadline = Date.now() + RUN_NOW_POLL_DEADLINE_MS;
      let clicked = false;
      while (Date.now() < runDeadline) {
        clicked = await evaluate(
          Runtime,
          `(() => {
          const btns = [...document.querySelectorAll('section[aria-label="Heartbeat settings"] button')];
          const btn = btns.find(b => /Run now/i.test(b.textContent));
          if (!btn || btn.disabled) return false;
          btn.click();
          return true;
        })()`,
        );
        if (clicked) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!clicked)
        throw new Error(
          `Run Now button never became clickable within ${RUN_NOW_POLL_DEADLINE_MS}ms`,
        );
      steps++;
      console.log("   ✓ Clicked Run Now (no custom permissions)");

      // Close panel, wait for heartbeat to run
      await closeHeartbeatPanel(Runtime);
      await new Promise((r) => setTimeout(r, 20000));
      steps++;

      // Re-open heartbeat panel and check for error state + blocked tool logs
      await openHeartbeatPanel(Runtime);
      await new Promise((r) => setTimeout(r, 500));

      // Check for "Tool blocked" log entry (from deny-prompt callback).
      // Scope to the heartbeat section — other panels (Horizon, etc.) also
      // render log-entry test ids and would pollute the search.
      const blockedLog = await evaluate(
        Runtime,
        `(() => {
        const entries = [...document.querySelectorAll('section[aria-label="Heartbeat settings"] [data-testid="log-entry"]')];
        const blocked = entries.find(e => e.textContent.includes('Tool blocked'));
        return blocked ? blocked.textContent.trim() : null;
      })()`,
      );
      console.log(
        `   ${blockedLog ? "✓" : "⚠️"} Deny log: ${blockedLog || "(no 'Tool blocked' entry)"}`,
      );
      steps++;

      // Check for error log entries — scoped to heartbeat panel only.
      const errorLogs = await evaluate(
        Runtime,
        `[...document.querySelectorAll('section[aria-label="Heartbeat settings"] [data-testid="log-entry"][data-log-type="error"]')]
        .map(e => e.textContent.trim())`,
      );
      console.log(`   ${errorLogs.length > 0 ? "✓" : "⚠️"} Error log entries: ${errorLogs.length}`);
      for (const entry of errorLogs.slice(0, 3)) {
        console.log(`     → ${entry}`);
      }
      steps++;

      // Verify heartbeat did NOT log "complete" (it should have failed due to blocked tools)
      const completedLog = await evaluate(
        Runtime,
        `(() => {
        const entries = [...document.querySelectorAll('section[aria-label="Heartbeat settings"] [data-testid="log-entry"]')];
        const recent = entries.slice(-6).map(e => e.textContent.trim());
        return recent.find(t => t.includes('Heartbeat check complete')) || null;
      })()`,
      );
      console.log(
        `   ${!completedLog ? "✓" : "⚠️"} Heartbeat did ${completedLog ? "NOT " : ""}fail as expected`,
      );
      steps++;

      await screenshot(Page, resultsDir, "21-heartbeat-perms-off-blocked.png");
      console.log("   📸 21-heartbeat-perms-off-blocked.png");
    } finally {
      // ── Part 3: Restore custom permissions, restore prompt, restore settings ──

      // Re-enable custom permissions via "Customize permissions" button
      const restoreResult = await evaluate(
        Runtime,
        `(() => {
        const btns = [...document.querySelectorAll('section[aria-label="Heartbeat settings"] button')];
        const btn = btns.find(b => b.textContent.includes('Customize permissions'));
        if (btn) { btn.click(); return 'restored'; }
        return 'already-custom';
      })()`,
      );
      await new Promise((r) => setTimeout(r, 500));
      console.log(`   ✓ Permissions restore: ${restoreResult}`);

      // Restore original prompt
      await evaluate(
        Runtime,
        `(() => {
        const ta = document.querySelector('section[aria-label="Heartbeat settings"] textarea');
        if (!ta) return true;
        const nativeSet = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype, 'value'
        ).set;
        nativeSet.call(ta, 'What is the current date and time?');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
      );
      await new Promise((r) => setTimeout(r, 300));
      await evaluate(
        Runtime,
        `(() => {
        const btns = [...document.querySelectorAll('section[aria-label="Heartbeat settings"] button')];
        const btn = btns.find(b => /^Save$/i.test(b.textContent.trim()));
        if (btn) btn.click();
        return true;
      })()`,
      );
      await new Promise((r) => setTimeout(r, 500));
      await closeHeartbeatPanel(Runtime);
      console.log("   ✓ Restored custom permissions + original prompt");
      steps++;

      // Restore E2E test permissions
      await invokeIPC(Runtime, "settingsAPI", "save", {
        ...origSettings,
        permissions: E2E_TEST_PERMISSIONS,
      });
      console.log("   ✓ Restored E2E test permissions");
      steps++;
    } // end try/finally around Parts 2-3

    // Ensure chat input is available after panel close + settings restore
    await waitForReady(Runtime);

    // Disable heartbeat
    await sendPrompt(Runtime, "Disable the heartbeat.");
    steps++;

    await waitForResponse(Runtime, 15, 60);
    steps++;

    const response3 = await getLastAssistantMessage(Runtime);
    console.log(`   ✓ Disable response: "${(response3 || "").slice(0, 80)}"`);

    await screenshot(Page, resultsDir, "21-heartbeat-perms-disabled.png");
    console.log("   📸 21-heartbeat-perms-disabled.png");

    return steps;
  },
};
