// Marshal-owned real-account harness.
// Marshal-owned fixed E2E suite.
/**
 * 29-automation-step-update: Create a multi-step automation, update a specific step, verify the change.
 */
import {
  waitForReady,
  sendPrompt,
  waitForResponse,
  getLastAssistantMessage,
  screenshot,
  timestamp,
} from "../marshal-cdp-helpers.mjs";

export default {
  name: "Automation Step Update",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;
    const ts = timestamp();
    const automationName = `E2E Step Update Automation ${ts}`;

    await waitForReady(Runtime);
    steps++;

    // Create a multi-step automation
    await sendPrompt(
      Runtime,
      `Create an automation called "${automationName}" scheduled every weekday at 9am. ` +
        `It should have two steps: step 1 checks the current time, step 2 sends a summary to me.`,
    );
    steps++;
    console.log(`   ✓ Sent: create multi-step automation "${automationName}"`);

    await waitForResponse(Runtime, 20, 60);
    steps++;

    const response1 = await getLastAssistantMessage(Runtime);
    if (!response1) throw new Error("No response for automation creation");
    steps++;
    console.log(`   ✓ Create response: "${response1.slice(0, 80)}"`);

    await screenshot(Page, resultsDir, "29-automation-created.png");
    console.log("   📸 29-automation-created.png");

    // Update a specific step
    await sendPrompt(
      Runtime,
      `Update step 2 of the automation "${automationName}" so that instead of sending a summary it writes the result to a file called output.txt.`,
    );
    steps++;
    console.log("   ✓ Sent: update step 2");

    await waitForResponse(Runtime, 20, 60);
    steps++;

    const response2 = await getLastAssistantMessage(Runtime);
    if (!response2) throw new Error("No response for step update");
    steps++;
    console.log(`   ✓ Update response: "${response2.slice(0, 80)}"`);

    await screenshot(Page, resultsDir, "29-automation-step-updated.png");
    console.log("   📸 29-automation-step-updated.png");

    // Verify step 1 is unchanged
    await sendPrompt(
      Runtime,
      `Show me the full details of the automation "${automationName}" including all step prompts.`,
    );
    steps++;

    await waitForResponse(Runtime, 15, 60);
    steps++;

    const response3 = await getLastAssistantMessage(Runtime);
    if (!response3) throw new Error("No response for automation details");
    const lowerResponse = response3.toLowerCase();
    if (!lowerResponse.includes("time") && !lowerResponse.includes("step 1")) {
      throw new Error(
        `Step 1 appears to have been overwritten. Response: "${response3.slice(0, 200)}"`,
      );
    }
    if (!lowerResponse.includes("output.txt") && !lowerResponse.includes("file")) {
      throw new Error(`Step 2 update not reflected. Response: "${response3.slice(0, 200)}"`);
    }
    steps++;
    console.log(`   ✓ Verified: step 1 unchanged, step 2 updated`);

    await screenshot(Page, resultsDir, "29-automation-details.png");
    console.log("   📸 29-automation-details.png");

    // Cleanup
    await sendPrompt(Runtime, `Delete the automation "${automationName}". Confirm when done.`);
    steps++;

    await waitForResponse(Runtime, 15, 60);
    steps++;

    const response4 = await getLastAssistantMessage(Runtime);
    steps++;
    console.log(`   ✓ Delete response: "${(response4 || "").slice(0, 80)}"`);

    await screenshot(Page, resultsDir, "29-automation-cleaned.png");
    console.log("   📸 29-automation-cleaned.png");

    return steps;
  },
};
