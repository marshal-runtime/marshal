/**
 * Tests: right-clicking (single segment and multi-block selection) doesn't crash the editor.
 */
import fs from "fs";
import path from "path";

import { E2E_DATA_DIR } from "../electron/mock-mode";
import { sharedTest as test, expect } from "./marshal-fixtures";

const WORKSPACE_DIR = path.join(E2E_DATA_DIR, "workspace", "Scratchpad");

const SAMPLE_MD = `# Title

First paragraph of text.

- Bullet A
- Bullet B
- Bullet C

Last paragraph here.`;

function segByText(page: import("@playwright/test").Page, text: string) {
  return page.locator(`.md-seg`).filter({ hasText: text }).first();
}

test("right-click on single segment does not crash", async ({ page }) => {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE_DIR, "ctx-test.md"), SAMPLE_MD);

  const navButton = page.getByRole("button", { name: "Workspaces" });
  await navButton.waitFor({ timeout: 5000 });
  await navButton.click();
  await page.getByText("ctx-test.md").click();
  await page.locator(".md-seg").first().waitFor({ timeout: 5000 });

  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  const bulletA = segByText(page, "Bullet A");
  await bulletA.click({ button: "right" });
  // eslint-disable-next-line playwright/no-wait-for-timeout
  await page.waitForTimeout(300);

  await expect(page.locator(".md-custom-editor")).toBeVisible({ timeout: 3000 });
  expect(errors).toHaveLength(0);
});

test("right-click after multi-block selection does not crash", async ({ page }) => {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE_DIR, "ctx-test2.md"), SAMPLE_MD);

  const navButton = page.getByRole("button", { name: "Workspaces" });
  await navButton.waitFor({ timeout: 5000 });
  await navButton.click();
  await page.getByText("ctx-test2.md").click();
  await page.locator(".md-seg").first().waitFor({ timeout: 5000 });

  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  // Select across multiple segments then right-click
  const firstPara = segByText(page, "First paragraph");
  const bulletC = segByText(page, "Bullet C");
  await firstPara.click();
  await bulletC.click({ modifiers: ["Shift"] });
  await bulletC.click({ button: "right" });
  // eslint-disable-next-line playwright/no-wait-for-timeout
  await page.waitForTimeout(300);

  await expect(page.locator(".md-custom-editor")).toBeVisible({ timeout: 3000 });
  expect(errors).toHaveLength(0);
});
