import { sharedTest as test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";
import { openMoreMenuItem } from "./helpers/marshal-nav";

/**
 * Verify that receiving a sessions:switch-to IPC event navigates away
 * from any open panel (Automations, Heartbeat, Activities) back to chat view.
 *
 * This tests the fix in App.tsx where onSwitchTo sets activeView("chat").
 */
test.describe("sessions:switch-to navigates away from panels — Marshal flow", () => {
  test.beforeEach(async ({ page }) => {
    await chatInput(page).waitFor();
  });

  test("navigates from Automations panel to chat", async ({ app, page }) => {
    // Open Automations panel
    await page.getByRole("button", { name: /Automations/ }).click();
    await expect(page.getByRole("button", { name: /new automation/i })).toBeVisible();

    // Fire switch-to IPC
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("sessions:switch-to", "e2e-python");
    });

    // Should navigate to chat view — textarea visible, Automations gone
    await expect(page.locator('[data-testid="chat-input-editor"]')).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByRole("button", { name: /new automation/i })).toBeHidden();
  });

  test("navigates from Heartbeat panel to chat", async ({ app, page }) => {
    // Open Heartbeat panel (lives in the bottom-bar More menu)
    await (await openMoreMenuItem(page, /Heartbeat/)).click();
    await page.getByText("Heartbeat").first().waitFor();
    // Wait for the permissions section to load (confirms panel is rendered)
    await page.getByText(/Permissions —/).waitFor({ timeout: 10000 });

    // Fire switch-to IPC
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("sessions:switch-to", "e2e-api");
    });

    // Should navigate to chat view — Heartbeat panel gone
    await expect(page.locator('[data-testid="chat-input-editor"]')).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText(/Permissions —/)).toBeHidden();
  });
});
