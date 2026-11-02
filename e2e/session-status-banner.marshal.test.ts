import type { SessionsAPI } from "../common/marshal-ipc-contract";
import { chatInput } from "./helpers/marshal-chat-input";
import { sharedTest as test, expect } from "./marshal-fixtures";

test.describe("session status banner during recovery", () => {
  test.beforeEach(async ({ page }) => {
    await chatInput(page).waitFor();
  });

  test("shows status banner with spinner during session recovery", async ({ app, page }) => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("sessions:switch-to", "e2e-python");
    });
    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible({
      timeout: 5000,
    });

    const currentView = await page.evaluate(() => {
      const appWindow = window as Window & { sessionsAPI?: SessionsAPI };
      return appWindow.sessionsAPI?.resyncView("e2e-python");
    });
    expect(currentView?.success).toBe(true);
    expect(currentView?.snapshot).toBeDefined();
    const { epoch, sequence } = currentView.snapshot!;

    // Inject a synthetic session:view event with sessionStatus to simulate recovery
    await app.evaluate(
      ({ BrowserWindow }, delivery) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          win.webContents.send("session:view", delivery);
        }
      },
      {
        sessionId: "e2e-python",
        type: "session:view",
        epoch,
        sequence: sequence + 1,
        view: {
          status: "submitted",
          streamingText: "",
          reasoning: null,
          toolStatuses: [],
          tokenUsage: null,
          error: null,
          sessionStatus: "Reconnecting session...",
        },
        committedMessages: [],
      },
    );

    // Wait for renderer to process the event and show the banner
    const banner = page.locator("text=Reconnecting session...");
    await expect(banner).toBeVisible({ timeout: 2000 });
    await expect(page.getByRole("button", { name: "Dismiss session status" })).toBeVisible();
    await page.screenshot({
      path: "test-screenshots/session-status-banner-active.png",
      fullPage: false,
    });

    await page.getByRole("button", { name: "Dismiss session status" }).click();
    await expect(banner).not.toBeVisible({ timeout: 2000 });
    await page.screenshot({
      path: "test-screenshots/session-status-banner-dismissed.png",
      fullPage: false,
    });

    // Clear the status
    await app.evaluate(
      ({ BrowserWindow }, delivery) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          win.webContents.send("session:view", delivery);
        }
      },
      {
        sessionId: "e2e-python",
        type: "session:view",
        epoch,
        sequence: sequence + 2,
        view: {
          status: "ready",
          streamingText: "",
          reasoning: null,
          toolStatuses: [],
          tokenUsage: null,
          error: null,
          sessionStatus: null,
        },
        committedMessages: [],
      },
    );

    await expect(banner).not.toBeVisible({ timeout: 2000 });
    await page.screenshot({
      path: "test-screenshots/session-status-banner-cleared.png",
      fullPage: false,
    });
  });
});
