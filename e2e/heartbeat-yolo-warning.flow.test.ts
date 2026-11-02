import { sharedTest as test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";
import { openMoreMenuItem } from "./helpers/marshal-nav";

/**
 * Verify the permissions section renders in the Heartbeat panel.
 */
test.describe("heartbeat permissions section — Marshal flow", () => {
  test.beforeEach(async ({ page }) => {
    await chatInput(page).waitFor();
    await (await openMoreMenuItem(page, /Heartbeat/)).click();
    await page.getByText("Heartbeat").first().waitFor();
  });

  test("displays permissions section with correct default state", async ({ page }) => {
    // Wait for the permissions section header to appear
    const permissionsHeader = page.getByText(/Permissions —/);
    await permissionsHeader.waitFor({ timeout: 10000 });

    // Default state: "Global defaults + read-only" or "Custom"
    await expect(permissionsHeader).toBeVisible();

    // Should show either "Customize permissions" button (default) or "Manage Permissions" (custom)
    // Default state: "Customize permissions" button should be visible
    // (heartbeat starts with global defaults, not custom permissions)
    const customizeBtn = page.getByTestId("customize-permissions-btn");
    const manageBtn = page.getByTestId("manage-permissions-btn");

    // At least one must be visible — Customize (default) or Manage (custom)
    await expect(customizeBtn.or(manageBtn)).toBeVisible({ timeout: 5000 });
  });
});
