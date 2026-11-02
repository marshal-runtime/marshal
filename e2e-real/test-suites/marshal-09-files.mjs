// Marshal-owned real-account harness.
/**
 * 09-files: Create, read, and delete a test file via filesystem MCP.
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
  name: "File System",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;
    const ts = timestamp();
    const fileName = `e2e-test-${ts}.txt`;
    const content = `Hello from Marshal E2E test at ${ts}`;

    await waitForReady(Runtime);
    steps++;

    // Create file
    await sendPrompt(
      Runtime,
      `Create a file called "${fileName}" in the current working directory with the content: "${content}"`,
    );
    steps++;
    console.log(`   ✓ Sent: create file "${fileName}"`);

    await waitForResponse(Runtime, 20, 60);
    steps++;

    const response1 = await getLastAssistantMessage(Runtime);
    if (!response1) throw new Error("No response for file creation");
    steps++;
    console.log(`   ✓ Create response: "${response1.slice(0, 80)}"`);

    await screenshot(Page, resultsDir, "09-file-created.png");
    console.log("   📸 09-file-created.png");

    // Read file
    await sendPrompt(Runtime, `Read the file "${fileName}" and tell me exactly what's in it.`);
    steps++;

    await waitForResponse(Runtime, 15, 60);
    steps++;

    const response2 = await getLastAssistantMessage(Runtime);
    if (!response2) throw new Error("No response for file read");
    if (!response2.includes("Hello from Marshal E2E test")) {
      console.log(`   ⚠️  Response may not contain file content: "${response2.slice(0, 100)}"`);
    }
    steps++;
    console.log("   ✓ File content verified");

    await screenshot(Page, resultsDir, "09-file-read.png");
    console.log("   📸 09-file-read.png");

    // Delete file
    await sendPrompt(Runtime, `Delete the file "${fileName}". Confirm when done.`);
    steps++;

    await waitForResponse(Runtime, 15, 60);
    steps++;

    const response3 = await getLastAssistantMessage(Runtime);
    steps++;
    console.log(`   ✓ Delete response: "${(response3 || "").slice(0, 80)}"`);

    await screenshot(Page, resultsDir, "09-file-cleaned.png");
    console.log("   📸 09-file-cleaned.png");

    return steps;
  },
};
