import fs from "fs";
import path from "path";

import { E2E_DATA_DIR } from "../electron/mock-mode";
import { sharedTest as test, expect } from "./marshal-fixtures";

const WORKSPACE_DIR = path.join(E2E_DATA_DIR, "workspace", "Scratchpad");

const SLASH_MD = `# Slash Test

Some text above.

`;

/** Navigate to Workspaces and open a file. */
async function openFile(page: import("@playwright/test").Page, fileName: string) {
  const navButton = page.getByRole("button", { name: "Workspaces" });
  await navButton.waitFor({ timeout: 5000 });
  await navButton.click();

  const fileLink = page.getByText(fileName);
  await fileLink.waitFor({ timeout: 5000 });
  await fileLink.click();
  await page.locator(".md-seg").first().waitFor({ timeout: 5000 });
}

/** Get the active textarea/input inside the editor */
function activeInput(page: import("@playwright/test").Page) {
  return page.locator(".md-seg-active textarea, .md-seg-active input");
}

/** Click a blank segment (the empty line after content) */
async function clickBlankSegment(page: import("@playwright/test").Page) {
  // The last segment should be blank (empty line at end of document)
  const blankSeg = page.locator(".md-seg").last();
  await blankSeg.click();
  await expect(activeInput(page)).toBeVisible();
}

test.describe("Slash command menu", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "slash-test.md"), SLASH_MD);
    await openFile(page, "slash-test.md");
  });

  test('typing "/" on blank line opens the slash menu', async ({ page }) => {
    await clickBlankSegment(page);
    await activeInput(page).fill("/");
    // The popover menu should appear
    const menu = page.locator("[data-slot=popover-content]");
    await expect(menu).toBeVisible({ timeout: 2000 });
    // Should show some command items
    const items = menu.locator("[data-selected]");
    await expect(items.first()).toBeVisible();
  });

  test('typing "/hea" filters to heading items', async ({ page }) => {
    await clickBlankSegment(page);
    await activeInput(page).fill("/hea");
    const menu = page.locator("[data-slot=popover-content]");
    await expect(menu).toBeVisible({ timeout: 2000 });
    // Should show heading items (H1, H2, H3)
    const items = menu.locator("[data-selected]");
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(3);
    // First item text should contain "Heading"
    await expect(items.first()).toContainText("Heading");
  });

  test("arrow down + enter selects a command", async ({ page }) => {
    await clickBlankSegment(page);
    await activeInput(page).fill("/");
    const menu = page.locator("[data-slot=popover-content]");
    await expect(menu).toBeVisible({ timeout: 2000 });

    // Press ArrowDown to move to second item then Enter to select
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    // Menu should close
    await expect(menu).not.toBeVisible({ timeout: 2000 });

    // The active input should contain markdown (e.g., "## " for Heading 2)
    const input = activeInput(page);
    const value = await input.inputValue();
    expect(value.length).toBeGreaterThan(0);
    expect(value).not.toContain("/");
  });

  test("escape dismisses the slash menu", async ({ page }) => {
    await clickBlankSegment(page);
    await activeInput(page).fill("/");
    const menu = page.locator("[data-slot=popover-content]");
    await expect(menu).toBeVisible({ timeout: 2000 });

    await page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible({ timeout: 2000 });
  });

  test('selecting "Heading 1" inserts "# " prefix', async ({ page }) => {
    await clickBlankSegment(page);
    await activeInput(page).fill("/h1");
    const menu = page.locator("[data-slot=popover-content]");
    await expect(menu).toBeVisible({ timeout: 2000 });

    // "h1" filters to Heading 1 — press Enter to select it
    await page.keyboard.press("Enter");
    await expect(menu).not.toBeVisible({ timeout: 2000 });

    const input = activeInput(page);
    await expect(input).toHaveValue("# ");
  });

  test('selecting "Code Block" inserts fenced code block', async ({ page }) => {
    await clickBlankSegment(page);
    await activeInput(page).fill("/code");
    const menu = page.locator("[data-slot=popover-content]");
    await expect(menu).toBeVisible({ timeout: 2000 });

    // Should filter to Code Block
    const codeItem = menu.locator("[data-selected]", { hasText: "Code Block" });
    await expect(codeItem).toBeVisible();
    await page.keyboard.press("Enter");

    // Menu should close
    await expect(menu).not.toBeVisible({ timeout: 2000 });

    // The document should now contain ``` fences
    await expect(page.locator(".md-custom-editor")).toContainText("```", { timeout: 2000 });
  });

  test('selecting "Horizontal rule" renders an <hr> element', async ({ page }) => {
    await clickBlankSegment(page);
    await activeInput(page).fill("/hr");
    const menu = page.locator("[data-slot=popover-content]");
    await expect(menu).toBeVisible({ timeout: 2000 });

    const hrItem = menu.locator("[data-selected]", { hasText: "Horizontal rule" });
    await expect(hrItem).toBeVisible();
    await page.keyboard.press("Enter");

    await expect(menu).not.toBeVisible({ timeout: 2000 });

    // An <hr> element should appear in the editor
    await expect(page.locator(".md-custom-editor hr")).toBeVisible({ timeout: 2000 });
  });

  test("clicking a menu item with mouse selects the command", async ({ page }) => {
    await clickBlankSegment(page);
    await activeInput(page).fill("/");
    const menu = page.locator("[data-slot=popover-content]");
    await expect(menu).toBeVisible({ timeout: 2000 });

    // Click "Heading 2" with the mouse
    const h2Item = menu.locator("[data-selected]", { hasText: "Heading 2" });
    await h2Item.click();

    // Menu should close and "## " should be inserted
    await expect(menu).not.toBeVisible({ timeout: 2000 });
    const input = activeInput(page);
    await expect(input).toHaveValue("## ");
  });

  test("placeholder text shows on blank lines", async ({ page }) => {
    await clickBlankSegment(page);
    const input = activeInput(page);
    const placeholder = await input.getAttribute("placeholder");
    expect(placeholder).toContain("/");
    expect(placeholder).toContain("commands");
  });

  test('"/" on non-blank line does not open menu', async ({ page }) => {
    // Click the "Some text above." segment (not blank)
    const textSeg = page.locator(".md-seg", { hasText: "Some text above" }).first();
    await textSeg.click();
    await expect(activeInput(page)).toBeVisible();

    // Type "/" at the end
    await page.keyboard.press("End");
    await page.keyboard.type("/");

    // Menu should NOT appear
    const menu = page.locator("[data-slot=popover-content]");
    await expect(menu).not.toBeVisible({ timeout: 1000 });
  });
});
