import { sharedTest as test, expect } from "./marshal-fixtures";

test.describe("permission card kinds — Marshal flow", () => {
  test("renders memory and hook permission cards", async ({ app, page }) => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("sessions:switch-to", "e2e-history");
    });
    await page.locator('[data-testid="message-user"]').first().waitFor({ timeout: 10000 });

    const memoryCard = page.locator('[data-testid="permission-card"][data-kind="memory"]');
    await expect(memoryCard).toBeVisible();
    await expect(memoryCard).toContainText("Memory");
    await expect(memoryCard).toContainText("Remember fact");
    await expect(memoryCard).toHaveAttribute("data-resolved", "allowed");

    const hookCard = page.locator('[data-testid="permission-card"][data-kind="hook"]');
    await expect(hookCard).toBeVisible();
    await expect(hookCard).toContainText("Hook");
    await expect(hookCard).toContainText("Run hook");
    await expect(hookCard).toHaveAttribute("data-resolved", "allowed");
  });
});
