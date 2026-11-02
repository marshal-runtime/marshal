import { chatInput } from "./helpers/marshal-chat-input";
import { test, expect } from "./marshal-fixtures";

test.describe("automations panel", () => {
  test.beforeEach(async ({ page }) => {
    await chatInput(page).waitFor();
    await page.getByRole("button", { name: /Automations/ }).click();
    await page.getByText("Automations").first().waitFor();
  });

  test("shows automations list with create button", async ({ page }) => {
    await expect(page.getByRole("button", { name: /new automation/i })).toBeVisible();
    // Description text
    await expect(page.getByText("Create automated multi-step tasks")).toBeVisible();
  });

  test("create a new automation", async ({ page }) => {
    await page.getByRole("button", { name: /new automation/i }).click();
    await expect(page.getByText("New Automation")).toBeVisible();

    // Fill name
    await page.getByPlaceholder("e.g. Morning Briefing").fill("Test Automation");

    // Fill schedule
    await page.getByPlaceholder(/every weekday/).fill("every day at 10am");

    // Fill step
    await page.getByPlaceholder("Step 1 label").fill("Check things");
    await page.getByPlaceholder("What should Marshal do").fill("Check all the things");

    // Save
    await page.getByRole("button", { name: "Create Automation" }).click();

    // Should return to list with new automation visible
    await expect(page.getByText("Test Automation")).toBeVisible();
  });

  test("toggle automation enabled/disabled", async ({ page }) => {
    // Sample data has wf-2 disabled — enable it
    await page.getByLabel("Enable").first().click();
    // Both should now be enabled
    await expect(page.getByLabel("Disable").first()).toBeVisible();
  });

  test("delete an automation", async ({ page }) => {
    // Open overflow menu on the first automation card
    const firstCard = page.locator("[data-testid='automation-card']").first();
    await firstCard.getByLabel("More actions").click();
    await page.getByText("Delete").click();

    // Should have one fewer automation card
    const cards = page.locator("[data-testid='automation-card']");
    await expect(cards).toHaveCount(2); // was 3 seeded, now 2
  });

  test("view run history", async ({ page }) => {
    await page
      .locator("[data-testid='automation-card']")
      .first()
      .getByLabel("More actions")
      .click();
    await page.getByText("History").click();
    await expect(page.getByText("Run History")).toBeVisible();
  });

  test("run automation produces step results", async ({ page }) => {
    await page
      .locator("[data-testid='automation-card']")
      .first()
      .getByLabel("More actions")
      .click();
    await page.getByText("Run now").click();

    // "Run now" creates a automation session and navigates to it via sessions:switch-to.
    // Navigate back to the Automations panel to check run history.
    await page.getByRole("button", { name: /Automations/ }).click();
    await page.getByText("Automations").first().waitFor();
    await page
      .locator("[data-testid='automation-card']")
      .first()
      .getByLabel("More actions")
      .click();
    await page.getByText("History").click();
    await expect(page.getByText("Run History")).toBeVisible();
  });

  test("export automation", async ({ page }) => {
    await page
      .locator("[data-testid='automation-card']")
      .first()
      .getByLabel("More actions")
      .click();
    await page.getByText("Export").click();
    // Export triggers a blob download — no error means success
    await expect(page.getByRole("button", { name: /new automation/i })).toBeVisible();
  });

  test("create a condition-triggered automation", async ({ page }) => {
    await page.getByRole("button", { name: /new automation/i }).click();
    await expect(page.getByText("New Automation")).toBeVisible();

    // Fill name
    await page.getByPlaceholder("e.g. Morning Briefing").fill("PR Watcher");

    // Switch to Condition trigger
    await page.getByRole("radio", { name: "Condition" }).click();

    // Schedule input should be hidden, condition input visible
    await expect(page.getByPlaceholder(/every weekday/)).toBeHidden();

    // Fill condition
    await page.getByPlaceholder(/PR #123/).fill("PR #456 is approved");

    // Select check interval via DropdownMenu
    await page.getByRole("button", { name: /15 minutes/ }).click();
    await page.getByRole("menuitem", { name: /30 minutes/ }).click();

    // Fill step
    await page.getByPlaceholder("Step 1 label").fill("Notify");
    await page
      .getByPlaceholder(/What should/)
      .first()
      .fill("Send a relay message");

    // Save
    await page.getByRole("button", { name: "Create Automation" }).click();

    // Should return to list with condition automation visible, showing interval
    await expect(page.getByText("PR Watcher")).toBeVisible();
    await expect(page.getByText(/PR #456 is approved/)).toBeVisible();
    await expect(page.getByText(/every 30m/)).toBeVisible();
  });

  test("toggle 'Run browser headless' persists through create + edit", async ({ page }) => {
    // Step 1: Create a new automation with the checkbox checked
    await page.getByRole("button", { name: /new automation/i }).click();
    await expect(page.getByText("New Automation")).toBeVisible();

    await page.getByPlaceholder("e.g. Morning Briefing").fill("Background Auto");
    await page.getByPlaceholder(/every weekday/).fill("every day at 10am");
    await page.getByPlaceholder("Step 1 label").fill("Step");
    await page.getByPlaceholder("What should Marshal do").fill("Do something");

    // Toggle the new "Run browser headless" checkbox ON
    const checkboxCreate = page.getByRole("checkbox", { name: /run browser headless/i });
    await expect(checkboxCreate).not.toBeChecked();
    await checkboxCreate.click();
    await expect(checkboxCreate).toBeChecked();

    await page.getByRole("button", { name: "Create Automation" }).click();

    // Should return to list with new automation visible
    const card = page
      .locator("[data-testid='automation-card']")
      .filter({ hasText: "Background Auto" });
    await expect(card).toBeVisible();

    // Step 2: Reopen the editor and verify the value persisted (toggle still ON)
    await card.getByLabel("Edit").click();
    await expect(page.getByText("Edit Automation")).toBeVisible();
    const checkboxEdit = page.getByRole("checkbox", { name: /run browser headless/i });
    await expect(checkboxEdit).toBeChecked();

    // Step 3 (asymmetric edit path): uncheck and save, then verify OFF persisted.
    // The edit branch in handleSave sends `browserHeadless: false`
    // unconditionally — if a future contributor "symmetrizes" it to a conditional
    // spread, this assertion will catch the silent toggle-OFF regression.
    await checkboxEdit.click();
    await expect(checkboxEdit).not.toBeChecked();
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(card).toBeVisible();

    await card.getByLabel("Edit").click();
    await expect(page.getByText("Edit Automation")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /run browser headless/i })).not.toBeChecked();
  });

  test("'Notify on relay' mode persists through create + edit", async ({ page }) => {
    // Mirrors the browserHeadless persistence smoke test above. The interesting
    // case for teamsNotify is the round-trip ("auto" survives a create + reopen)
    // plus the asymmetric edit-path: handleSave sends `teamsNotify` unconditionally
    // on update so a revert-to-default ("always") actually persists past the
    // gateway's server-side cron-state merge.

    // Step 1: Create a new automation, switch the dropdown from Always → Auto.
    await page.getByRole("button", { name: /new automation/i }).click();
    await expect(page.getByText("New Automation")).toBeVisible();

    await page.getByPlaceholder("e.g. Morning Briefing").fill("Quiet Auto");
    await page.getByPlaceholder(/every weekday/).fill("every day at 10am");
    await page.getByPlaceholder("Step 1 label").fill("Step");
    await page.getByPlaceholder("What should Marshal do").fill("Do something");

    // Default is "Always" — flip to "Auto"
    const triggerCreate = page.getByLabel(/notify on relay/i);
    await expect(triggerCreate).toHaveText(/always/i);
    await triggerCreate.click();
    await page.getByRole("option", { name: /auto/i }).click();
    await expect(triggerCreate).toHaveText(/auto/i);

    await page.getByRole("button", { name: "Create Automation" }).click();

    const card = page.locator("[data-testid='automation-card']").filter({ hasText: "Quiet Auto" });
    await expect(card).toBeVisible();

    // Step 2: Reopen the editor and verify "Auto" persisted.
    await card.getByLabel("Edit").click();
    await expect(page.getByText("Edit Automation")).toBeVisible();
    const triggerEdit = page.getByLabel(/notify on relay/i);
    await expect(triggerEdit).toHaveText(/auto/i);

    // Step 3 (asymmetric edit path): revert to "Always" and save, then verify
    // the revert persisted. handleSave sends teamsNotify unconditionally on
    // update — if a future contributor "tidies" it to a conditional spread,
    // this assertion will catch the silent stuck-at-auto regression.
    await triggerEdit.click();
    await page.getByRole("option", { name: /always/i }).click();
    await expect(triggerEdit).toHaveText(/always/i);
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(card).toBeVisible();

    await card.getByLabel("Edit").click();
    await expect(page.getByText("Edit Automation")).toBeVisible();
    await expect(page.getByLabel(/notify on relay/i)).toHaveText(/always/i);
  });

  test("one-shot automation disappears from panel after run completes", async ({ page }) => {
    // wf-3 "Prepare Monday Presentation" is seeded with oneShot: true and enabled: true
    const prepareMondayCard = page
      .locator("[data-testid='automation-card']")
      .filter({ hasText: "Prepare Monday Presentation" });
    await expect(prepareMondayCard).toBeVisible();

    // Run it now — mock completes in ~600ms, then loadAutomations() refreshes
    await prepareMondayCard.getByLabel("More actions").click();
    await page.getByText("Run now").click();

    // After completion the one-shot automation should be hidden from the panel
    await expect(prepareMondayCard).not.toBeVisible({ timeout: 10000 });
  });
});
