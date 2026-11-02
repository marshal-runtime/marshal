import { test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";
import { openMoreMenuItem } from "./helpers/marshal-nav";

test.describe("draft preservation across session switches — Marshal flow", () => {
  test.beforeEach(async ({ page }) => {
    await chatInput(page).waitFor();
    await expect(page.locator('[data-testid="session-item"]')).not.toHaveCount(0);
  });

  test("preserves draft when switching to another session and back", async ({ page }) => {
    const textarea = chatInput(page);
    const sessionItems = page.locator('[data-testid="session-item"]');

    // Type a draft in the active session
    await textarea.fill("draft for session A");
    await expect(textarea).toHaveText("draft for session A");

    // Switch to a different session
    await sessionItems.nth(1).click();
    await expect(textarea).toHaveText("");

    // Switch back to the first session — draft should be restored
    await sessionItems.nth(0).click();
    await expect(textarea).toHaveText("draft for session A");
  });

  test("clears draft after sending a message", async ({ page }) => {
    const textarea = chatInput(page);
    const sessionItems = page.locator('[data-testid="session-item"]');

    // Type a draft and switch away to save it
    await textarea.fill("will be sent");
    await sessionItems.nth(1).click();
    await expect(textarea).toHaveText("");

    // Switch back — draft should be restored
    await sessionItems.nth(0).click();
    await expect(textarea).toHaveText("will be sent");

    // Send the message
    await textarea.press("Enter");
    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible();

    // Switch away and back — draft should be gone
    await sessionItems.nth(1).click();
    await sessionItems.nth(0).click();
    await expect(textarea).toHaveText("");
  });

  test("preserves draft when navigating to settings and back", async ({ page }) => {
    const textarea = chatInput(page);

    // Type a draft
    await textarea.fill("draft before settings");
    await expect(textarea).toHaveText("draft before settings");

    // Navigate to settings (in the More menu)
    await (await openMoreMenuItem(page, /Settings/)).click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();

    // Navigate back to chat by re-selecting the active session in the sidebar
    // (panel close button removed — sidebar handles navigation away).
    await page.locator('[data-testid="session-item"]').first().click();
    await chatInput(page).waitFor();

    // Draft should be restored
    await expect(chatInput(page)).toHaveText("draft before settings");
  });

  test("clears draft when session is deleted", async ({ page }) => {
    const textarea = chatInput(page);
    const sessionItems = page.locator('[data-testid="session-item"]');
    const initialCount = await sessionItems.count();

    // Type a draft in the second session
    await sessionItems.nth(1).click();
    await textarea.fill("draft to be deleted");

    // Switch away so the draft is saved
    await sessionItems.nth(0).click();
    await expect(textarea).toHaveText("");

    // Delete the second session
    const secondSession = sessionItems.nth(1);
    await secondSession.hover();
    await secondSession.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: /Delete/ }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();

    // Session should be removed
    await expect(sessionItems).toHaveCount(initialCount - 1);

    // The deleted session's draft should not leak anywhere — create a new session
    // and verify it starts clean
    await page.locator('[data-testid="new-chat-btn"]').click();
    await chatInput(page).waitFor();
    await expect(chatInput(page)).toHaveText("");
  });

  test("New Chat reuses empty session when no draft is present", async ({ page }) => {
    const sessionItems = page.locator('[data-testid="session-item"]');
    const textarea = chatInput(page);
    const initialCount = await sessionItems.count();

    // Ensure textarea is empty (no draft)
    await expect(textarea).toHaveText("");

    // Click New Chat on an empty session with no draft
    await page.locator('[data-testid="new-chat-btn"]').click();
    await chatInput(page).waitFor();

    // Session count should NOT increase — empty session reused
    await expect(sessionItems).toHaveCount(initialCount, { timeout: 5000 });
  });

  test("New Chat creates new session when current has a draft", async ({ page }) => {
    const sessionItems = page.locator('[data-testid="session-item"]');
    const textarea = chatInput(page);
    const initialCount = await sessionItems.count();

    // Type a draft in the current empty session
    await textarea.fill("my draft prompt");
    await expect(textarea).toHaveText("my draft prompt");

    // Click New Chat
    await page.locator('[data-testid="new-chat-btn"]').click();
    await chatInput(page).waitFor();

    // A new session should be created
    await expect(sessionItems).toHaveCount(initialCount + 1, { timeout: 5000 });

    // New session should have an empty textarea
    await expect(textarea).toHaveText("");

    // Switch back to the previous session — draft should be preserved
    await sessionItems.nth(1).click();
    await expect(textarea).toHaveText("my draft prompt");
  });
});
