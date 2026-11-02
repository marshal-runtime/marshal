import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { expect, sharedTest as test } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.join(__dirname, "..", "test-screenshots", "tool-activity-redesign");

function screenshotPath(name: string): string {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  return path.join(SCREENSHOTS_DIR, `${name}.png`);
}

test.describe("tool activity redesign visual evidence", () => {
  test("captures working state without a tool activity island", async ({ page }) => {
    const input = chatInput(page);
    await input.fill("activity-showcase");
    await input.press("Enter");

    await expect(page.getByText("Working")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("tool-status-indicator")).toHaveCount(0);
    await page.screenshot({
      path: screenshotPath("tool-activity-working"),
      fullPage: true,
    });

    await expect(page.getByText("Activity showcase finished with issues.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("committed-tool-calls")).toHaveCount(0);
    await page.screenshot({
      path: screenshotPath("tool-activity-completed"),
      fullPage: true,
    });
  });

  test("captures the pending permission decision tray", async ({ page }) => {
    const input = chatInput(page);
    await input.fill("permission test");
    await input.press("Enter");

    const tray = page.getByTestId("permission-decision-tray");
    await expect(tray).toBeVisible({ timeout: 15_000 });
    await expect(tray.getByRole("button", { name: "Allow once" })).toBeVisible();
    await expect(tray.getByRole("button", { name: "Not now" })).toBeVisible();
    await page.screenshot({
      path: screenshotPath("permission-decision-tray"),
      fullPage: true,
    });

    await tray.getByRole("button", { name: "Not now" }).click();
    const nextCard = tray.locator('[data-testid="permission-card"]:not([data-resolved])');
    await expect(nextCard).toBeVisible({ timeout: 10_000 });
    await nextCard.getByRole("button", { name: "Not now" }).click();
  });
});
