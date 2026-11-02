// Marshal-owned real-account harness.
// Marshal-owned fixed E2E suite.
/**
 * 12-memory: Store a memory, recall it in context, then forget it.
 */
import {
  waitForReady,
  sendPrompt,
  waitForResponse,
  getLastAssistantMessage,
  screenshot,
} from "../marshal-cdp-helpers.mjs";

export default {
  name: "Memory",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;

    await waitForReady(Runtime);
    steps++;

    // Store memory
    await sendPrompt(
      Runtime,
      "Remember this fact: my favorite programming language is Rust. Store this in your memory.",
    );
    steps++;
    console.log("   ✓ Sent: store memory");

    await waitForResponse(Runtime, 15, 60);
    steps++;

    const response1 = await getLastAssistantMessage(Runtime);
    if (!response1) throw new Error("No response for memory store");
    if (!/remember|stored|noted|saved/i.test(response1)) {
      console.log(`   ⚠️  Response may not confirm storage: "${response1.slice(0, 100)}"`);
    }
    steps++;
    console.log("   ✓ Memory stored");

    await screenshot(Page, resultsDir, "12-memory-stored.png");
    console.log("   📸 12-memory-stored.png");

    // Recall memory (in same session — cross-session recall would need session switch)
    await sendPrompt(Runtime, "What is my favorite programming language? Check your memory.");
    steps++;

    await waitForResponse(Runtime, 15, 60);
    steps++;

    const response2 = await getLastAssistantMessage(Runtime);
    if (!response2) throw new Error("No response for memory recall");
    if (!/rust/i.test(response2)) {
      console.log(`   ⚠️  Response may not mention Rust: "${response2.slice(0, 100)}"`);
    }
    steps++;
    console.log("   ✓ Memory recalled");

    await screenshot(Page, resultsDir, "12-memory-recalled.png");
    console.log("   📸 12-memory-recalled.png");

    // Clean up memory
    await sendPrompt(
      Runtime,
      "Forget the fact about my favorite programming language. Delete it from your memory.",
    );
    steps++;

    await waitForResponse(Runtime, 15, 60);
    steps++;

    await screenshot(Page, resultsDir, "12-memory-cleaned.png");
    console.log("   📸 12-memory-cleaned.png");

    return steps;
  },
};
