// Marshal-owned real-account harness.
// Marshal-owned fixed E2E suite.
/**
 * 02-chat: Send a basic message and verify the LLM responds.
 */
import {
  waitForReady,
  sendPrompt,
  waitForResponse,
  getLastAssistantMessage,
  getMessageCount,
  screenshot,
} from "../marshal-cdp-helpers.mjs";

export default {
  name: "Chat Basic",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;

    await waitForReady(Runtime);
    steps++;

    // Send a simple greeting
    await sendPrompt(Runtime, "Hello! Please respond with a short greeting.");
    steps++;
    console.log('   ✓ Sent: "Hello! Please respond with a short greeting."');

    // Wait for response
    await waitForResponse(Runtime, 15, 60);
    steps++;

    // Verify assistant responded
    const response = await getLastAssistantMessage(Runtime);
    if (!response) throw new Error("No assistant response received");
    if (response.length < 2) throw new Error(`Response too short: "${response}"`);
    steps++;
    console.log(`   ✓ Got response: "${response.slice(0, 80)}..."`);

    // Verify message count
    const count = await getMessageCount(Runtime);
    if (count < 2) throw new Error(`Expected at least 2 messages, got ${count}`);
    steps++;
    console.log(`   ✓ Message count: ${count}`);

    await screenshot(Page, resultsDir, "02-chat-response.png");
    console.log("   📸 02-chat-response.png");

    return steps;
  },
};
