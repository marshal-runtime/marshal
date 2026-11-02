import { sharedTest as test, expect } from "./marshal-fixtures";

/**
 * Verify that permission cards are scoped to their session.
 *
 * Uses two seeded sessions (e2e-session-a with 2 cards, e2e-session-b with 1 card)
 * to confirm cards don't leak across sessions.
 */
test.describe("permission cards scoped by session — Marshal flow", () => {
  test("shows only the cards belonging to the active session", async ({ app, page }) => {
    // Switch to Session A (2 permission cards: shell allowed + write pending)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("sessions:switch-to", "e2e-session-a");
    });
    await page.locator('[data-testid="message-user"]').first().waitFor({ timeout: 10000 });

    // Session A should show exactly 2 permission cards
    await expect(page.locator('[data-testid="permission-card"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="permission-card"][data-kind="shell"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="permission-card"][data-kind="write"]')).toHaveCount(1);

    // Switch to Session B (1 permission card: mcp denied)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("sessions:switch-to", "e2e-session-b");
    });
    await page.locator('[data-testid="message-user"]').first().waitFor({ timeout: 10000 });

    // Session B should show exactly 1 permission card
    await expect(page.locator('[data-testid="permission-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="permission-card"][data-kind="mcp"]')).toHaveCount(1);

    // Switch back to Session A — cards should still be there
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("sessions:switch-to", "e2e-session-a");
    });
    await page.locator('[data-testid="message-user"]').first().waitFor({ timeout: 10000 });

    await expect(page.locator('[data-testid="permission-card"]')).toHaveCount(2);
  });
});
