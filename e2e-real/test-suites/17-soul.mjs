/**
 * 17-soul: Switch soul to Operator, verify tone, switch back.
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

export default {
  name: "Soul",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;

    await waitForReady(Runtime);
    steps++;

    // Get current soul
    let originalSoul;
    try {
      originalSoul = await invokeIPC(Runtime, "soulAPI", "getDefault");
      console.log(`   ✓ Current soul: ${originalSoul}`);
    } catch {
      console.log("   ⚠️  Could not read current soul");
    }
    steps++;

    // List available souls
    try {
      const souls = await invokeIPC(Runtime, "soulAPI", "list");
      console.log(`   ✓ Available: ${souls?.map((p) => p.name || p.id).join(", ")}`);
    } catch {
      // non-fatal
    }
    steps++;

    // Switch to Operator
    try {
      await invokeIPC(Runtime, "soulAPI", "setDefault", "operator");
      await sleep(1000);
      console.log("   ✓ Switched to Operator soul");
    } catch (err) {
      throw new Error(`Could not switch soul: ${err.message}`, { cause: err });
    }
    steps++;

    await screenshot(Page, resultsDir, "17-soul-operator.png");
    console.log("   📸 17-soul-operator.png");

    // Ask for a joke — Operator should answer tersely
    await sendPrompt(Runtime, "Tell me a joke about programming.");
    steps++;

    await waitForResponse(Runtime, 15, 60);
    steps++;

    const response = await getLastAssistantMessage(Runtime);
    if (!response) throw new Error("No response from Operator soul");
    steps++;
    console.log(`   ✓ Operator response: "${response.slice(0, 100)}"`);

    await screenshot(Page, resultsDir, "17-soul-response.png");
    console.log("   📸 17-soul-response.png");

    // Switch back
    const restoreTo = originalSoul || "default";
    try {
      await invokeIPC(Runtime, "soulAPI", "setDefault", restoreTo);
      console.log(`   ✓ Restored soul: ${restoreTo}`);
    } catch {
      console.log("   ⚠️  Could not restore soul");
    }
    steps++;

    return steps;
  },
};
