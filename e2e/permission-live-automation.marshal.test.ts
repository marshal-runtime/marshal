import { test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";

/**
 * Interactive permission card pipeline tests for automations.
 *
 * Automations show interactive permission cards (no deny-prompt). When an automation runs,
 * sendAndCollect blocks on the permission card until the user responds. The automation
 * session is switched to via sessions:switch-to so the card is visible in chat view.
 *
 * Uses buildAutomationStepResponseWithPermission (shell) triggered when the automation
 * step prompt contains the "permission" keyword.
 */
test.describe("permission live automation pipeline", () => {
  test.beforeEach(async ({ page }) => {
    await chatInput(page).waitFor();
    await page.getByRole("button", { name: /Automations/ }).click();
    await page.getByText("Automations").first().waitFor();
  });

  /**
   * Create an automation whose step prompt triggers the permission scenario.
   * The prompt must contain "permission" AND match the automation route heuristic
   * (contains "step" or is long enough).
   */
  async function createPermissionAutomation(page: import("@playwright/test").Page, name: string) {
    await page.getByRole("button", { name: /new automation/i }).click();
    await expect(page.getByText("New Automation")).toBeVisible();

    await page.getByPlaceholder("e.g. Morning Briefing").fill(name);
    await page.getByPlaceholder(/every weekday/).fill("every day at 10am");
    await page.getByPlaceholder("Step 1 label").fill("Check TODOs");
    // Prompt contains "step" and "permission" to route through the permission automation scenario
    await page
      .getByPlaceholder("What should Marshal do")
      .fill("Run a permission check step on the codebase");
    await page.getByRole("button", { name: "Create Automation" }).click();

    // Back to list with new automation visible
    await expect(page.getByText(name)).toBeVisible();
  }

  /** Open overflow menu on an automation card and click "Run now". */
  async function runAutomation(page: import("@playwright/test").Page, name: string) {
    const card = page.locator("[data-testid='automation-card']").filter({ hasText: name });
    await card.getByLabel("More actions").click();
    await page.getByText("Run now").click();
  }

  test("run automation → permission card blocks → allow → step completes", async ({ page }) => {
    await createPermissionAutomation(page, "Perm Test Allow");
    await runAutomation(page, "Perm Test Allow");

    // App switches to automation session — permission card should appear
    const card = page.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="shell"]',
    );
    await card.waitFor({ timeout: 15_000 });
    await card.getByTestId("permission-details-toggle").click();
    await expect(card.locator("pre")).toContainText('grep -r "TODO" ./src/');

    // Allow
    await card.getByRole("button", { name: "Allow once" }).click();

    // Tool executes, response completes
    await expect(
      page.locator('[data-testid="message-assistant"]').filter({ hasText: /TODO|catalogued/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Navigate back to Automations panel → verify run in history
    await page.getByRole("button", { name: /Automations/ }).click();
    await page.getByText("Automations").first().waitFor();
  });

  test("run automation → deny → step completes without tool output", async ({ page }) => {
    await createPermissionAutomation(page, "Perm Test Deny");
    await runAutomation(page, "Perm Test Deny");

    // Permission card appears
    const card = page.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="shell"]',
    );
    await card.waitFor({ timeout: 15_000 });

    // Deny — card resolves and gains data-resolved attribute
    await card.getByRole("button", { name: "Not now" }).click();

    const resolvedCard = page.locator(
      '[data-testid="permission-card"][data-resolved="denied"][data-kind="shell"]',
    );
    await expect(resolvedCard).toBeVisible({ timeout: 5_000 });

    // Scenario continues — step completes with remaining assistant text
    await expect(page.locator('[data-testid="message-assistant"]').first()).toBeVisible({
      timeout: 15_000,
    });

    // Navigate back to verify the automation panel is accessible
    await page.getByRole("button", { name: /Automations/ }).click();
    await page.getByText("Automations").first().waitFor();
  });

  test("automation with shell server auto-approve → no permission card appears", async ({
    page,
  }) => {
    await createPermissionAutomation(page, "Perm Test AutoApprove");

    // Edit the automation via the pencil button (aria-label="Edit")
    const card = page
      .locator("[data-testid='automation-card']")
      .filter({ hasText: "Perm Test AutoApprove" });
    await card.getByLabel("Edit").click();

    // Click "Customize permissions" to open PermissionsPanel
    const customizeBtn = page.getByTestId("customize-permissions-btn");
    const manageBtn = page.getByTestId("manage-permissions-btn");
    await expect(customizeBtn.or(manageBtn)).toBeVisible({ timeout: 5000 });
    // eslint-disable-next-line playwright/no-conditional-in-test
    if ((await customizeBtn.count()) > 0) {
      await customizeBtn.click();
    } else {
      await manageBtn.click();
    }

    // Enable Shell server auto-approve. The automation permission scenario uses a shell tool
    // (grep -r "TODO" ./src/), so enabling Shell auto-approve bypasses the permission card.
    // PermissionsPanel auto-saves on toggle — no explicit Save button needed.
    await page.getByTestId("shell-server-auto-approve").click();

    // Go back from PermissionsPanel to the automation edit form
    await page.getByLabel("Back").click();

    // Save the automation changes
    await page.getByRole("button", { name: "Save Changes" }).click();

    // Return to automation list
    await page.getByText("Automations").first().waitFor();

    // Run the automation
    await runAutomation(page, "Perm Test AutoApprove");

    // No permission card should appear — shell server auto-approve returns "approve" directly
    // Step completes without user interaction
    await expect(
      page.locator('[data-testid="message-assistant"]').filter({ hasText: /TODO|catalogued/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Verify no unresolved permission cards appeared
    await expect(page.locator('[data-testid="permission-card"]:not([data-resolved])')).toHaveCount(
      0,
    );
  });

  test("always-allow persists for subsequent automation runs", async ({ page }) => {
    await createPermissionAutomation(page, "Perm Test AlwaysAllow");

    // First run: Allow everywhere
    await runAutomation(page, "Perm Test AlwaysAllow");

    const firstCard = page.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="shell"]',
    );
    await firstCard.waitFor({ timeout: 15_000 });
    await firstCard.getByTestId("permission-scope-trigger").click();
    await page.getByTestId("allow-primary-pattern").click();

    // Step completes
    await expect(
      page.locator('[data-testid="message-assistant"]').filter({ hasText: /TODO|catalogued/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Navigate back and run again
    await page.getByRole("button", { name: /Automations/ }).click();
    await page.getByText("Automations").first().waitFor();
    await runAutomation(page, "Perm Test AlwaysAllow");

    // No permission card should appear — "Allow everywhere" persisted
    await expect(
      page
        .locator('[data-testid="message-assistant"]')
        .filter({ hasText: /TODO|catalogued/i })
        .last(),
    ).toBeVisible({ timeout: 15_000 });

    // Verify no unresolved permission cards from the second run
    await expect(page.locator('[data-testid="permission-card"]:not([data-resolved])')).toHaveCount(
      0,
    );
  });
});
