import fs from "fs";
import path from "path";

import { E2E_DATA_DIR } from "../electron/mock-mode";
import { test, expect } from "./marshal-fixtures";
import { openMoreMenuItem } from "./helpers/marshal-nav";

const GLOBAL_SKILLS_DIR = path.join(E2E_DATA_DIR, "skills");

test.describe("global skill toggle — Marshal flow", () => {
  test("global skill can be toggled off and does not show edit/remove buttons", async ({
    page,
  }) => {
    // Seed a global skill into the E2E temp dir and reload so the app picks it up
    const skillDir = path.join(GLOBAL_SKILLS_DIR, "test-global-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: test-global-skill\ndescription: A test global skill\n---\nDo test things",
    );
    await page.reload();
    await page.locator("nav[aria-label='Main navigation']").waitFor();

    // Navigate to Extensions panel
    await (await openMoreMenuItem(page, /Extensions/)).click();

    // Wait for the Extensions panel to load (Skills tab with content) - smart wait
    await expect(page.getByText("Your Skills")).toBeVisible({ timeout: 10000 });

    // Find the skill card container (look for element containing the skill name) - will resolve as soon as it appears
    const skillContainer = page
      .locator("div, article, li")
      .filter({ hasText: /test-global-skill/ })
      .first();
    await expect(skillContainer).toBeVisible({ timeout: 10000 });

    // Should have a toggle switch nearby (inside the same container)
    const toggle = skillContainer.locator("role=switch").first();
    await expect(toggle).toBeVisible();

    // Should NOT have edit or uninstall buttons (global skill)
    await expect(skillContainer.locator("[aria-label='Open in Editor']")).toHaveCount(0);
    await expect(skillContainer.locator("[aria-label='Uninstall']")).toHaveCount(0);

    // Toggle off should work without error
    await toggle.click();
    await expect(toggle).not.toBeChecked();
  });

  test("global skill detail dialog does not show Edit/Remove buttons", async ({ page }) => {
    // Seed a global skill and reload
    const skillDir = path.join(GLOBAL_SKILLS_DIR, "test-detail-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: test-detail-skill\ndescription: A detail test skill\n---\nDo detail things",
    );
    await page.reload();
    await page.locator("nav[aria-label='Main navigation']").waitFor();

    // Navigate to Extensions and click the global skill card to open detail dialog
    await (await openMoreMenuItem(page, /Extensions/)).click();

    // Wait for the Extensions panel to load - smart wait
    await expect(page.getByText("Your Skills")).toBeVisible({ timeout: 10000 });

    // Find the skill card container - will resolve as soon as it appears
    const skillContainer = page
      .locator("div, article, li")
      .filter({ hasText: /test-detail-skill/ })
      .first();
    await expect(skillContainer).toBeVisible({ timeout: 10000 });
    await skillContainer.click();

    // Detail dialog should be open
    const dialog = page.locator("role=dialog");
    await expect(dialog).toBeVisible();

    // Should NOT have Edit or Remove buttons
    await expect(dialog.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Remove" })).toHaveCount(0);
  });
});
