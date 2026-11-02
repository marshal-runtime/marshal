import { gatewaySharedTest as test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";

test.describe("gateway E2E fixture — Marshal flow", () => {
  test("streams a mock assistant reply when a prompt is sent", async ({ page }) => {
    await chatInput(page).waitFor();

    const textarea = chatInput(page);
    await textarea.fill("hello gateway");
    await textarea.press("Enter");

    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible();

    await expect(page.locator('[data-testid="message-assistant"]').first()).toContainText(
      "Hi! This is the mock gateway.",
      { timeout: 5000 },
    );

    const errorBanner = page.locator("[role='alert']");
    await expect(errorBanner).toHaveCount(0);
  });
});
