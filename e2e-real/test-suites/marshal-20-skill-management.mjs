// Marshal-owned real-account harness.
// Marshal-owned fixed E2E suite.
/**
 * 20-skill-management: Create a skill, list it, then delete it.
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
  name: "Skill Management",
  async run({ Runtime, Page, resultsDir }) {
    let steps = 0;
    const ts = timestamp();
    const skillName = `e2e-test-skill-${ts}`;

    await waitForReady(Runtime);
    steps++;

    // Create skill
    await sendPrompt(
      Runtime,
      `Create a skill called '${skillName}' that counts words in a given text.`,
    );
    steps++;
    console.log(`   ✓ Sent: create skill "${skillName}"`);

    await waitForResponse(Runtime, 20, 60);
    steps++;

    const response1 = await getLastAssistantMessage(Runtime);
    if (!response1) throw new Error("No response for skill creation");
    steps++;
    console.log(`   ✓ Create response: "${response1.slice(0, 80)}"`);

    await screenshot(Page, resultsDir, "20-skill-created.png");
    console.log("   📸 20-skill-created.png");

    // List skills
    await sendPrompt(Runtime, "List my custom skills.");
    steps++;

    await waitForResponse(Runtime, 15, 60);
    steps++;

    const response2 = await getLastAssistantMessage(Runtime);
    if (!response2) throw new Error("No response for skill list");
    if (!response2.toLowerCase().includes(skillName.toLowerCase())) {
      throw new Error(
        `Skill list does not mention "${skillName}". Got: ${response2.slice(0, 200)}`,
      );
    }
    steps++;
    console.log(`   ✓ List response mentions skill: "${response2.slice(0, 80)}"`);

    await screenshot(Page, resultsDir, "20-skill-listed.png");
    console.log("   📸 20-skill-listed.png");

    // Delete skill
    await sendPrompt(Runtime, `Delete the skill '${skillName}'.`);
    steps++;

    await waitForResponse(Runtime, 15, 60);
    steps++;

    const response3 = await getLastAssistantMessage(Runtime);
    steps++;
    console.log(`   ✓ Delete response: "${(response3 || "").slice(0, 80)}"`);

    await screenshot(Page, resultsDir, "20-skill-deleted.png");
    console.log("   📸 20-skill-deleted.png");

    return steps;
  },
};
