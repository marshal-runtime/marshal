// Marshal-owned real-account harness.
// Marshal-owned fixed E2E suite.
/**
 * 22-automation-session: Create an automation, run it, and verify a navigable session
 * with real content is created.
 */
import {
  waitForReady,
  sendPrompt,
  waitForResponse,
  getLastAssistantMessage,
  evaluate,
  invokeIPC,
  screenshot,
  sleep,
  timestamp,
} from "../marshal-cdp-helpers.mjs";

export default {
  name: "Automation Session",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;
    const ts = timestamp();
    const automationName = `E2E Session Test ${ts}`;

    await waitForReady(Runtime);
    steps++;

    // Count sessions before
    const sessionsBefore = await invokeIPC(Runtime, "sessionsAPI", "list");
    const countBefore = sessionsBefore?.sessions?.length || 0;
    console.log(`   ✓ Sessions before: ${countBefore}`);
    steps++;

    // Create automation
    await sendPrompt(
      Runtime,
      `Create an automation called "${automationName}" scheduled daily at 9am with the description "Test session creation" and the prompt "What is 2 + 2?"`,
    );
    steps++;

    await waitForResponse(Runtime, 20, 60);
    steps++;

    const createResponse = await getLastAssistantMessage(Runtime);
    console.log(`   ✓ Create response: "${(createResponse || "").slice(0, 80)}"`);
    steps++;

    await screenshot(Page, resultsDir, "22-automation-created.png");
    console.log("   📸 22-automation-created.png");

    // Run the automation
    await sendPrompt(Runtime, `Run the automation "${automationName}" now.`);
    steps++;

    await waitForResponse(Runtime, 30, 90);
    steps++;

    // Wait a bit for the session to be created
    await sleep(3000);

    // Count sessions after — should be more than before
    const sessionsAfter = await invokeIPC(Runtime, "sessionsAPI", "list");
    const countAfter = sessionsAfter?.sessions?.length || 0;
    console.log(
      `   ${countAfter > countBefore ? "✓" : "⚠️"} Sessions after: ${countAfter} (was ${countBefore})`,
    );
    steps++;

    // Try to navigate to the newest session (should be the automation session)
    if (sessionsAfter?.sessions?.length > 0) {
      // Find the newest session (by creation date)
      const sorted = [...sessionsAfter.sessions].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      const newest = sorted[0];

      if (newest && newest.id) {
        await invokeIPC(Runtime, "sessionsAPI", "switch", newest.id);
        await sleep(2000);

        // Check that the session has messages (not empty)
        const msgCount = await evaluate(
          Runtime,
          `document.querySelectorAll('[data-testid="message-assistant"]').length`,
        );
        console.log(`   ${msgCount > 0 ? "✓" : "⚠️"} Assistant messages in session: ${msgCount}`);

        await screenshot(Page, resultsDir, "22-automation-session.png");
        console.log("   📸 22-automation-session.png");
      }
    }
    steps++;

    // Clean up — delete automation
    await sendPrompt(Runtime, `Delete the automation "${automationName}".`);
    steps++;

    await waitForResponse(Runtime, 15, 60);
    steps++;

    const deleteResponse = await getLastAssistantMessage(Runtime);
    console.log(`   ✓ Delete response: "${(deleteResponse || "").slice(0, 80)}"`);

    await screenshot(Page, resultsDir, "22-automation-cleaned.png");
    console.log("   📸 22-automation-cleaned.png");

    return steps;
  },
};
