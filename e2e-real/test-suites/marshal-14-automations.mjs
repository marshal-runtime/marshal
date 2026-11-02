// Marshal-owned real-account harness.
/**
 * 14-automations: Create an automation, run it, then delete it.
 */
import {
  waitForReady,
  sendPrompt,
  waitForResponse,
  getLastAssistantMessage,
  invokeIPC,
  screenshot,
  sleep,
  timestamp,
} from "../marshal-cdp-helpers.mjs";

async function findAutomation(Runtime, name) {
  const result = await invokeIPC(Runtime, "automationsAPI", "list");
  if (!result?.success) throw new Error(result?.error || "automations:list failed");
  return result.automations?.find((automation) => automation.name === name) || null;
}

async function waitForAutomation(Runtime, name, present, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const automation = await findAutomation(Runtime, name);
    if (Boolean(automation) === present) return automation;
    await sleep(500);
  }
  throw new Error(`Automation "${name}" did not become ${present ? "present" : "absent"}`);
}

async function waitForCompletedRun(Runtime, automationId, previousRunIds, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await invokeIPC(Runtime, "automationsAPI", "getHistory", automationId);
    if (!result?.success) throw new Error(result?.error || "automations:getHistory failed");
    const run = result.runs?.find((candidate) => !previousRunIds.has(candidate.id));
    if (run?.status === "completed") return run;
    if (run?.status === "failed") {
      throw new Error(`Automation run failed: ${run.error || run.finalOutput || run.id}`);
    }
    await sleep(1000);
  }
  throw new Error(`Automation ${automationId} produced no completed run`);
}

export default {
  name: "Automations",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;
    const ts = timestamp();
    const automationName = `E2E Test Automation ${ts}`;

    await waitForReady(Runtime);
    steps++;

    let createdAutomation;
    try {
      // Exercise the real model/tool path, then verify the durable automation state via IPC.
      await sendPrompt(
        Runtime,
        `Create an automation called "${automationName}" scheduled every hour with the description "Automated test automation" that checks the current time when run.`,
      );
      steps++;
      console.log(`   ✓ Sent: create automation "${automationName}"`);

      await waitForResponse(Runtime, 20, 60);
      steps++;

      const response1 = await getLastAssistantMessage(Runtime);
      if (!response1) throw new Error("No response for automation creation");
      createdAutomation = await waitForAutomation(Runtime, automationName, true);
      steps++;
      console.log(`   ✓ Persisted automation: ${createdAutomation.id}`);

      await screenshot(Page, resultsDir, "14-automation-created.png");
      console.log("   📸 14-automation-created.png");

      const historyBefore = await invokeIPC(
        Runtime,
        "automationsAPI",
        "getHistory",
        createdAutomation.id,
      );
      if (!historyBefore?.success) {
        throw new Error(historyBefore?.error || "Could not read baseline automation history");
      }
      const previousRunIds = new Set((historyBefore.runs || []).map((run) => run.id));

      await sendPrompt(
        Runtime,
        `Run the automation "${automationName}" now and show me the result.`,
      );
      steps++;
      await waitForResponse(Runtime, 30, 90);
      steps++;

      const response2 = await getLastAssistantMessage(Runtime);
      if (!response2) throw new Error("No response for automation run");
      const completedRun = await waitForCompletedRun(Runtime, createdAutomation.id, previousRunIds);
      steps++;
      console.log(`   ✓ Completed persisted run: ${completedRun.id}`);

      await screenshot(Page, resultsDir, "14-automation-run.png");
      console.log("   📸 14-automation-run.png");

      await sendPrompt(Runtime, `Delete the automation "${automationName}". Confirm when done.`);
      steps++;
      await waitForResponse(Runtime, 15, 60);
      steps++;

      const response3 = await getLastAssistantMessage(Runtime);
      if (!response3) throw new Error("No response for automation deletion");
      await waitForAutomation(Runtime, automationName, false);
      createdAutomation = null;
      steps++;
      console.log("   ✓ Automation deletion persisted");

      await screenshot(Page, resultsDir, "14-automation-cleaned.png");
      console.log("   📸 14-automation-cleaned.png");
    } finally {
      // Never leave a failed real-account run behind in the user's automation list.
      const leftover = createdAutomation || (await findAutomation(Runtime, automationName));
      if (leftover?.id) {
        await invokeIPC(Runtime, "automationsAPI", "delete", leftover.id);
      }
    }

    return steps;
  },
};
