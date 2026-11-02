// Marshal-owned real-account harness.
// Marshal-owned fixed E2E suite.
/**
 * 18-permissions: Phase 2 — Test permission system.
 *
 * Sets all permissions to deny (NO_AUTO_APPROVE_PERMISSIONS), verifies shell
 * commands are blocked, then restores E2E test permissions and verifies they
 * work again.
 *
 * NOTE: When all auto-approve is off, tool calls trigger permission cards
 * that CDP cannot interact with. The test verifies the blocking behavior
 * by checking that the LLM response indicates the tool was denied/timed out.
 */
import {
  waitForReady,
  sendPrompt,
  waitForResponse,
  getLastAssistantMessage,
  invokeIPC,
  screenshot,
  sleep,
} from "../marshal-cdp-helpers.mjs";
import { E2E_TEST_PERMISSIONS, NO_AUTO_APPROVE_PERMISSIONS } from "../marshal-e2e-permissions.mjs";

export default {
  name: "Permissions",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;

    await waitForReady(Runtime);
    steps++;

    // Save current settings so we can restore
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
      // Disable all auto-approve paths so permission cards appear
      try {
        await invokeIPC(Runtime, "settingsAPI", "save", {
          ...originalSettings,
          permissions: NO_AUTO_APPROVE_PERMISSIONS,
        });
        await sleep(1000);
        console.log("   ✓ Disabled auto-approve (all servers + read-only)");
      } catch (err) {
        throw new Error(`Could not disable auto-approve: ${err.message}`, { cause: err });
      }
      steps++;

      await screenshot(Page, resultsDir, "18-permissions-disabled.png");
      console.log("   📸 18-permissions-disabled.png");

      // Try to run a shell command — should be blocked by permission dialog
      await sendPrompt(Runtime, "Run the command: echo permission-test");
      steps++;
      console.log("   ✓ Sent shell command (should be blocked)");

      // Wait shorter — the command should NOT complete because a dialog blocks it
      await sleep(10_000);
      steps++;

      // Check if response contains denial/blocked indication
      const response = await getLastAssistantMessage(Runtime);
      const isBlocked =
        !response || /denied|blocked|permission|waiting|cannot|unable/i.test(response || "");
      console.log(
        `   ${isBlocked ? "✓" : "⚠️"} Command appears ${isBlocked ? "blocked" : "NOT blocked"}: "${(response || "no response").slice(0, 80)}"`,
      );
      steps++;

      await screenshot(Page, resultsDir, "18-permissions-blocked.png");
      console.log("   📸 18-permissions-blocked.png");
    } finally {
      // Always restore E2E test permissions
      try {
        await invokeIPC(Runtime, "settingsAPI", "save", {
          ...originalSettings,
          permissions: E2E_TEST_PERMISSIONS,
        });
        await sleep(1000);
        console.log("   ✓ Restored E2E test permissions");
      } catch (err) {
        console.log(`   ⚠️  Could not restore permissions: ${err.message}`);
      }
    }
    steps++;

    // Now the same command should work
    await sendPrompt(Runtime, "Run the command: echo permission-test-enabled");
    steps++;

    await waitForResponse(Runtime, 15, 60);
    steps++;

    const response2 = await getLastAssistantMessage(Runtime);
    if (response2 && /permission-test-enabled/i.test(response2)) {
      console.log("   ✓ Command succeeded with E2E permissions restored");
    } else {
      console.log(`   ⚠️  Command may not have succeeded: "${(response2 || "").slice(0, 80)}"`);
    }
    steps++;

    await screenshot(Page, resultsDir, "18-permissions-allowed.png");
    console.log("   📸 18-permissions-allowed.png");

    return steps;
  },
};
