import { sharedTest as test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";

test.describe("navigate away during streaming — Marshal flow", () => {
  test.beforeEach(async ({ page }) => {
    await chatInput(page).waitFor();
  });

  test("messages are preserved when switching sessions mid-stream", async ({ page }) => {
    // Send a message (triggers mock scenario ~2.5s of streaming)
    const textarea = chatInput(page);
    await textarea.fill("Analyze the auth system");
    await textarea.press("Enter");

    // Wait for streaming to start — the assistant row should appear
    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="message-assistant"]').first()).toBeVisible();

    // Let streaming accumulate before navigating away
    // eslint-disable-next-line playwright/no-wait-for-timeout -- need real time for mock scenario to stream
    await page.waitForTimeout(800);

    // Navigate away by switching to a different session in the sidebar
    const sessionItems = page.locator('[data-testid="session-item"]');
    await expect(sessionItems.nth(1)).toBeVisible({ timeout: 5000 });
    await sessionItems.nth(1).click();

    // Wait for navigation to take effect
    // eslint-disable-next-line playwright/no-wait-for-timeout -- session switch needs rendering time
    await page.waitForTimeout(500);

    // Navigate back to the first session (it should be first in the list)
    await sessionItems.first().click();

    // Wait for the session to fully load and streaming to complete
    // eslint-disable-next-line playwright/no-wait-for-timeout -- mock scenario needs time to finish
    await page.waitForTimeout(5000);

    // The user message should still be visible
    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible();

    // After streaming completes, the committed assistant message should contain
    // real content from the mock scenario — not empty or just a "Thinking" indicator.
    await expect(
      page.locator('[data-testid="message-assistant"] [data-testid="message-text"]').first(),
    ).toContainText("authentication system", { timeout: 10000 });
  });
});
