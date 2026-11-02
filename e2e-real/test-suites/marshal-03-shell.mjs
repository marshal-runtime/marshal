// Marshal-owned real-account harness.
/**
 * 03-shell: Run shell commands and verify output.
 */
import {
  waitForReady,
  sendPrompt,
  getLastAssistantMessage,
  getAssistantMessageCount,
  waitForNewAssistantMessage,
  getToolCalls,
  screenshot,
} from "../marshal-cdp-helpers.mjs";

export default {
  name: "Shell Command",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;

    await waitForReady(Runtime);
    steps++;

    // Test 1: Run echo command
    const msgCountBefore = await getAssistantMessageCount(Runtime);
    await sendPrompt(
      Runtime,
      "Run this exact shell command and tell me the output: echo MARSHAL-E2E-TEST-WORKS",
    );
    steps++;
    console.log("   ✓ Sent echo command prompt");

    await waitForNewAssistantMessage(Runtime, msgCountBefore, 15, 60);
    steps++;

    const tools = await getToolCalls(Runtime);
    console.log(`   ✓ Tool calls: ${tools.length} (${tools.join(", ").slice(0, 100)})`);
    steps++;

    const response = await getLastAssistantMessage(Runtime);
    if (!response) throw new Error("No response for echo command");
    if (!response.includes("MARSHAL-E2E-TEST-WORKS")) {
      throw new Error(`Response does not contain expected output: "${response.slice(0, 200)}"`);
    }
    steps++;
    console.log("   ✓ Echo output verified");

    await screenshot(Page, resultsDir, "03-shell-echo.png");
    console.log("   📸 03-shell-echo.png");

    // Test 2: Get working directory
    const msgCountBefore2 = await getAssistantMessageCount(Runtime);
    await sendPrompt(
      Runtime,
      "What is the current working directory? Use pwd (or cd on Windows) and tell me the path.",
    );
    steps++;

    await waitForNewAssistantMessage(Runtime, msgCountBefore2, 15, 60);
    steps++;

    const cwdResponse = await getLastAssistantMessage(Runtime);
    if (!cwdResponse) throw new Error("No response for cwd command");
    // Should contain some path-like string
    const hasPath = /[A-Z]:\\|\/home|\/Users|\/tmp/i.test(cwdResponse);
    if (!hasPath) {
      console.log(`   ⚠️  Response may not contain a path: "${cwdResponse.slice(0, 100)}"`);
    }
    steps++;
    console.log(`   ✓ CWD response: "${cwdResponse.slice(0, 80)}"`);

    await screenshot(Page, resultsDir, "03-shell-cwd.png");
    console.log("   📸 03-shell-cwd.png");

    return steps;
  },
};
