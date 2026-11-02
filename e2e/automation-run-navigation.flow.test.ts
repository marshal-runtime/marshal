import { sharedTest as test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";

/**
 * Verify that "Run now" on an automation navigates to the chat view
 * (away from the Automations panel).
 */
test.describe("automation Run Now navigation — Marshal flow", () => {
  test.beforeEach(async ({ page }) => {
    await chatInput(page).waitFor();
    await page.getByRole("button", { name: /Automations/ }).click();
    await page.getByText("Automations").first().waitFor();
  });

  test("Run Now switches from Automations panel to chat view", async ({ page }) => {
    // Verify we're in the Automations panel
    await expect(page.getByRole("button", { name: /new automation/i })).toBeVisible();

    // Click Run now on the first automation
    await page
      .locator("[data-testid='automation-card']")
      .first()
      .getByLabel("More actions")
      .click();
    await page.getByText("Run now").click();

    // Should navigate away from Automations panel to chat view
    // The Automations panel "New Automation" button should no longer be visible
    // and we should see either the chat input or welcome state
    await expect(page.locator('[data-testid="chat-input-editor"]')).toBeVisible({
      timeout: 10000,
    });

    // The Automations panel content should be gone
    await expect(page.getByRole("button", { name: /new automation/i })).toBeHidden();
  });
});
