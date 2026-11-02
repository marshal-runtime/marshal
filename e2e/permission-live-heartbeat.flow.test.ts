import { chatInput } from "./helpers/marshal-chat-input";
import { openMoreMenuItem } from "./helpers/marshal-nav";
import { test, expect } from "./marshal-fixtures";

/**
 * Deny-prompt permission pipeline tests for heartbeat.
 *
 * Heartbeat uses setDenyPrompt() so tools that would normally prompt are auto-denied
 * without showing permission cards. Observable signals: "Tool blocked (deny-prompt): ..."
 * log entries in the Recent Activity section.
 *
 * Uses HEARTBEAT_PERMISSION_SCENARIOS triggered when the heartbeat prompt contains
 * the "permission" keyword. The scenario uses listAutomations (a read-only self-tool).
 *
 * With autoApproveReadOnly ON (default): listAutomations is approved at step 6.
 * With autoApproveReadOnly OFF: it falls through to step 9 (deny-prompt) and gets denied.
 */
test.describe("permission live heartbeat pipeline — Marshal flow", () => {
  test.beforeEach(async ({ page }) => {
    await chatInput(page).waitFor();
    await (await openMoreMenuItem(page, /Heartbeat/)).click();
    await page.getByText("Heartbeat").first().waitFor();
  });

  /** Open heartbeat permissions editor (Customize or Manage button). */
  async function openPermissionsEditor(page: import("@playwright/test").Page) {
    const customizeBtn = page.getByTestId("customize-permissions-btn");
    const manageBtn = page.getByTestId("manage-permissions-btn");
    await expect(customizeBtn.or(manageBtn)).toBeVisible({ timeout: 5000 });
    // eslint-disable-next-line playwright/no-conditional-in-test -- handle both initial/custom states
    if ((await customizeBtn.count()) > 0) {
      await customizeBtn.click();
    } else {
      await manageBtn.click();
    }
  }

  test("disable read-only auto-approve → tool blocked, re-enable → tool approved", async ({
    page,
  }) => {
    // Set prompt with "permission" keyword to trigger the permission scenario
    const promptInput = page.getByPlaceholder("e.g. Check my inbox");
    await promptInput.click();
    await promptInput.clear();
    await promptInput.type("Check my messages permission");
    await page.getByRole("button", { name: "Save" }).click();

    // --- Phase 1: Disable autoApproveReadOnly so listAutomations gets denied ---
    await openPermissionsEditor(page);

    // Find and disable the "Auto-approve read-only operations" toggle.
    // It's the second toggle in the permissions editor (after the global auto-approve all).
    const readOnlyLabel = page.locator("label").filter({ hasText: "Auto-approve read-only" });
    await readOnlyLabel.getByRole("switch").click();

    // Go back — PermissionsPanel auto-saves on toggle
    await page.getByLabel("Back").click();

    // Run heartbeat
    await page.getByRole("button", { name: "Run now" }).click();
    await expect(page.getByText("Heartbeat check complete")).toBeVisible({ timeout: 15_000 });

    // Verify deny-prompt log entry — listAutomations should be blocked
    await expect(page.getByText(/Tool blocked.*deny-prompt.*custom-tool/)).toBeVisible();

    // No permission cards — deny-prompt mode doesn't show UI
    await expect(page.locator('[data-testid="permission-card"]')).toHaveCount(0);

    // --- Phase 2: Re-enable autoApproveReadOnly → listAutomations approved ---
    await openPermissionsEditor(page);

    const readOnlyLabel2 = page.locator("label").filter({ hasText: "Auto-approve read-only" });
    await readOnlyLabel2.getByRole("switch").click();

    await page.getByLabel("Back").click();

    // Run again
    await page.getByRole("button", { name: "Run now" }).click();
    await expect(page.getByText("Heartbeat check complete")).toBeVisible({ timeout: 15_000 });

    // Verify heartbeat completed — with autoApproveReadOnly on, listAutomations
    // is approved at step 6 and never reaches deny-prompt.
    const entries = page.getByTestId("log-entry");
    const count = await entries.count();
    expect(count).toBeGreaterThan(0);

    // Negative assertion: no deny-prompt entries from the second run
    // (the first run's entries are still visible, so scope to the latest batch)
    const latestEntry = entries.last();
    await expect(latestEntry).not.toContainText("Tool blocked");
  });
});
