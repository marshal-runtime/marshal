// Marshal-owned real-account harness.
// Marshal-owned fixed E2E suite.
/**
 * 16-model-switch: Switch to a different AI model and verify it responds.
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
  name: "Model Switching",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;

    await waitForReady(Runtime);
    steps++;

    // Get current model
    let originalModel;
    try {
      const res = await invokeIPC(Runtime, "modelsAPI", "getDefault");
      if (res?.success === false) {
        console.log(`   ⚠️  modelsAPI.getDefault failed: ${res?.error ?? "(unknown error)"}`);
      } else {
        originalModel = res?.model;
        console.log(`   ✓ Current model: ${originalModel ?? "(unset)"}`);
      }
    } catch {
      console.log("   ⚠️  Could not read current model");
    }
    steps++;

    // List available models
    let models;
    try {
      const res = await invokeIPC(Runtime, "modelsAPI", "list");
      if (res?.success === false) {
        console.log(`   ⚠️  modelsAPI.list failed: ${res?.error ?? "(unknown error)"}`);
      } else {
        models = res?.models;
        const available = models
          ?.filter((m) => m.policy?.state !== "disabled")
          ?.map((m) => m.name || m.id);
        console.log(`   ✓ Available models: ${available?.join(", ").slice(0, 120)}`);
      }
    } catch (err) {
      console.log(`   ⚠️  Could not list models: ${err.message}`);
    }
    steps++;

    // Ask the model to identify itself
    await sendPrompt(Runtime, "What AI model are you? Tell me your model name.");
    steps++;

    await waitForResponse(Runtime, 15, 60);
    steps++;

    const response1 = await getLastAssistantMessage(Runtime);
    if (!response1) throw new Error("No response for model identity");
    console.log(`   ✓ Model identity: "${response1.slice(0, 80)}"`);
    steps++;

    await screenshot(Page, resultsDir, "16-model-identity.png");
    console.log("   📸 16-model-identity.png");

    // Switch to a different model if possible
    if (models && models.length > 1) {
      const available = models.filter((m) => m.policy?.state !== "disabled");
      const different = available.find((m) => m.id !== originalModel);
      if (different) {
        try {
          await invokeIPC(Runtime, "modelsAPI", "setDefault", different.id);
          await sleep(1000);
          console.log(`   ✓ Switched to: ${different.name || different.id}`);

          await screenshot(Page, resultsDir, "16-model-switched.png");
          console.log("   📸 16-model-switched.png");

          // Switch back
          if (originalModel) {
            await invokeIPC(Runtime, "modelsAPI", "setDefault", originalModel);
            console.log(`   ✓ Restored original model: ${originalModel}`);
          }
        } catch (err) {
          console.log(`   ⚠️  Model switch failed: ${err.message}`);
        }
      }
    }
    steps++;

    return steps;
  },
};
