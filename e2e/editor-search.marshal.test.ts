import fs from "fs";
import path from "path";

import { E2E_DATA_DIR } from "../electron/mock-mode";
import { sharedTest as test, expect } from "./marshal-fixtures";

const WORKSPACE_DIR = path.join(E2E_DATA_DIR, "workspace", "Scratchpad");

const SEARCH_MD = `# Search Test Document

This paragraph contains the word apple and another apple here.

## Second Section

More text with apple in it and some banana mentions.

The end of the document.`;

/** Navigate to Workspaces, select a workspace, and open a file.
 *  Handles the case where the file is already open after page.reload(). */
async function openFile(page: import("@playwright/test").Page, fileName: string) {
  // If editor segments are already visible, the file is already open (post-reload)
  const seg = page.locator(".md-seg").first();
  if (await seg.isVisible().catch(() => false)) return;

  const navButton = page.getByRole("button", { name: "Workspaces" });
  await navButton.waitFor({ timeout: 10_000 });
  await navButton.click();

  const fileLink = page.getByText(fileName);
  await fileLink.waitFor({ timeout: 10_000 });
  await fileLink.click();
  await page.locator(".md-seg").first().waitFor({ timeout: 5000 });

  // Wait for editor DOM to stabilize
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const editor = document.querySelector(".md-custom-editor");
        if (!editor) {
          resolve(true);
          return;
        }
        let timer: ReturnType<typeof setTimeout> = setTimeout(() => {
          observer.disconnect();
          resolve(true);
        }, 800);
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            observer.disconnect();
            resolve(true);
          }, 800);
        });
        observer.observe(editor, { childList: true, subtree: true, characterData: true });
      }),
    undefined,
    { timeout: 10_000 },
  );
}

test.describe("Search in markdown preview", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "search-test.md"), SEARCH_MD);
    await openFile(page, "search-test.md");
  });

  test("Ctrl+F opens the search bar in preview mode", async ({ page }) => {
    // Search bar should not be visible initially
    await expect(page.getByTestId("search-bar")).toBeHidden();

    // Ctrl+F opens it
    await page.keyboard.press("Control+f");
    await expect(page.getByTestId("search-bar")).toBeVisible();
    await expect(page.getByTestId("search-input")).toBeFocused();
  });

  test("Escape closes the search bar", async ({ page }) => {
    await openFile(page, "search-test.md");
    await page.keyboard.press("Control+f");
    await expect(page.getByTestId("search-bar")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("search-bar")).toBeHidden();
  });

  test("typing a query highlights matches and shows count", async ({ page }) => {
    await openFile(page, "search-test.md");
    await page.keyboard.press("Control+f");

    const input = page.getByTestId("search-input");
    await input.fill("apple");

    // Wait for highlights to appear
    await expect(page.locator("mark.md-search-highlight").first()).toBeVisible({ timeout: 3000 });

    // Should show match count
    const countEl = page.getByTestId("search-match-count");
    await expect(countEl).toContainText("of");
  });
});
