// Marshal-owned real-account harness.
// Marshal-owned fixed E2E suite.
/**
 * 05-search-web: Verify web search capability.
 */
import {
  waitForReady,
  sendPrompt,
  waitForResponse,
  getLastAssistantMessage,
  getToolCalls,
  screenshot,
} from "../marshal-cdp-helpers.mjs";

export default {
  name: "Search Web",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;

    await waitForReady(Runtime);
    steps++;

    await sendPrompt(
      Runtime,
      "Search the web and tell me: what is the latest LTS version of Node.js?",
    );
    steps++;
    console.log("   ✓ Sent web search prompt");

    await waitForResponse(Runtime, 20, 60);
    steps++;

    const tools = await getToolCalls(Runtime);
    console.log(`   ✓ Tool calls: ${tools.join(", ").slice(0, 120)}`);
    steps++;

    const response = await getLastAssistantMessage(Runtime);
    if (!response) throw new Error("No response for web search");
    // Should contain some version number
    if (/\d+\.\d+/.test(response)) {
      console.log("   ✓ Response contains a version number");
    } else {
      console.log(`   ⚠️  Response may not contain version: "${response.slice(0, 100)}"`);
    }
    steps++;

    await screenshot(Page, resultsDir, "05-search-web.png");
    console.log("   📸 05-search-web.png");

    return steps;
  },
};
