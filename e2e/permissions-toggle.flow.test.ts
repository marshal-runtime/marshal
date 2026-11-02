import { test, expect } from "./marshal-fixtures";
import { openMoreMenuItem } from "./helpers/marshal-nav";

test.describe("permissions toggle state — Marshal flow", () => {
  test("toggling group auto-approve OFF restores previous partial state", async ({ page }) => {
    // Navigate to Settings → Permissions
    await (await openMoreMenuItem(page, /Settings/)).click();
    await page.getByTestId("manage-permissions-btn").click();

    // Find the "Calendar" group header
    const groupHeader = page.locator("button", { hasText: "Calendar" }).first();
    await expect(groupHeader).toBeVisible();

    // Expand the group
    await groupHeader.click();

    // Wait for the expanded tool list to appear with checkboxes
    // The checkboxes are inside labels within a CollapsibleContent sibling
    const firstToolLabel = page
      .locator("label")
      .filter({ hasText: "List calendar events" })
      .first();
    await expect(firstToolLabel).toBeVisible();
    const firstCheckbox = firstToolLabel.getByRole("checkbox");
    await expect(firstCheckbox).toBeVisible();

    // Capture the count BEFORE clicking — scoped via testid because the header
    // button now also contains a group-description span with the same
    // text-muted-foreground class. Reading first lets us assert the click
    // actually changed the count (so a silent miss can't be masked by the
    // group already being in a non-empty state).
    const countLabel = groupHeader.getByTestId("tool-group-count");
    const beforeCount = await countLabel.textContent();
    // Guard the textContent-can-be-null edge: if `beforeCount` is null we'd
    // coerce to "" and `not.toHaveText("")` would pass against any non-empty
    // text — masking a silent click miss.
    expect(beforeCount).not.toBeNull();

    await firstCheckbox.click();

    await expect(countLabel).not.toHaveText(beforeCount!);
    const partialCount = await countLabel.textContent();
    expect(partialCount).toMatch(/\d+\/\d+/);

    // Find the group switch in the header row
    const headerRow = groupHeader.locator("..");
    const groupSwitch = headerRow.locator("role=switch").first();
    await expect(groupSwitch).toBeVisible();
    await groupSwitch.click();

    // Toggle OFF — should restore the partial state
    await groupSwitch.click();

    // The count should match the partial state we created
    await expect(countLabel).toHaveText(partialCount!);
  });
});
