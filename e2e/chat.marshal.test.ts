import { sharedTest as test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";

test.describe("chat with mock mode", () => {
  test.beforeEach(async ({ page }) => {
    // Mock mode is auto-enabled via MARSHAL_E2E — just wait for SDK ready
    await chatInput(page).waitFor();
  });

  test("sends message and receives streaming response", async ({ page }) => {
    const textarea = chatInput(page);
    await textarea.fill("Analyze the auth system");
    await textarea.press("Enter");

    // User message should appear
    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible();

    // Wait for assistant response to appear (processing indicator or streaming text)
    await expect(page.locator('[data-testid="message-assistant"]').first()).toBeVisible();
  });

  test("auto-scroll pauses when user scrolls up", async ({ page }) => {
    const textarea = chatInput(page);
    await textarea.fill("Tell me about auth");
    await textarea.press("Enter");

    // Wait for streaming to start
    await page.waitForTimeout(2000);

    const container = page.locator('[data-testid="messages-container"]');

    // Wait until enough content has streamed that the container is actually scrollable.
    // Without this, scrollTop=0 is a no-op and the use-stick-to-bottom wheel handler
    // bails on its `scrollHeight > clientHeight` guard, so auto-scroll is never paused.
    await expect
      .poll(() => container.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 10000 })
      .toBeGreaterThan(200);

    // Drive a real wheel-up via Playwright's mouse — use-stick-to-bottom only takes the
    // synchronous "user escaped" branch in handleWheel; setting scrollTop directly only
    // hits handleScroll which is debounced and short-circuits during streaming resizes.
    // Several smaller wheels with gaps beat the rAF auto-scroll loop reliably on Windows.
    await container.hover();
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop -- intentional: pace wheel events to beat the rAF auto-scroll loop
      await page.mouse.wheel(0, -200);
      // eslint-disable-next-line no-await-in-loop -- intentional: gap between wheels lets the wheel handler register
      await page.waitForTimeout(50);
    }

    // Record scroll position
    const scrollTopAfterScrollUp = await container.evaluate((el) => el.scrollTop);
    expect(scrollTopAfterScrollUp).toBeLessThan(200);

    // Wait for more streaming content
    await page.waitForTimeout(2000);

    // Scroll position should not have changed significantly (auto-scroll paused).
    // Allow small drift on Windows where rendering timing can cause minor scroll shifts.
    const scrollTopAfterStreaming = await container.evaluate((el) => el.scrollTop);
    expect(Math.abs(scrollTopAfterStreaming - scrollTopAfterScrollUp)).toBeLessThanOrEqual(50);
  });

  test("auto-scroll resumes when user sends new message", async ({ page }) => {
    const textarea = chatInput(page);
    await textarea.fill("First message");
    await textarea.press("Enter");

    // Wait for response to appear
    await page.locator('[data-testid="message-assistant"]').first().waitFor({ timeout: 10000 });

    const container = page.locator('[data-testid="messages-container"]');

    // Wait until the container is actually scrollable before trying to scroll up.
    // See "auto-scroll pauses" above for why we drive a real wheel instead of scrollTop=0.
    await expect
      .poll(() => container.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 10000 })
      .toBeGreaterThan(200);

    await container.hover();
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop -- intentional: pace wheel events to beat the rAF auto-scroll loop
      await page.mouse.wheel(0, -200);
      // eslint-disable-next-line no-await-in-loop -- intentional: gap between wheels lets the wheel handler register
      await page.waitForTimeout(50);
    }

    const scrollTopAfterScrollUp = await container.evaluate((el) => el.scrollTop);
    expect(scrollTopAfterScrollUp).toBeLessThan(200);

    // Send another message — should snap to bottom
    await textarea.fill("Follow up question");
    await textarea.press("Enter");

    // Wait for the new message to appear, then check scroll position
    await page.locator('[data-testid="message-user"]').nth(1).waitFor({ timeout: 10000 });

    // Should be near the bottom now
    await expect
      .poll(
        () => container.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 100),
        { timeout: 5000 },
      )
      .toBe(true);
  });

  test("select all does not include sidebar chrome text", async ({ page }) => {
    const textarea = chatInput(page);
    await textarea.fill("Hello");
    await textarea.press("Enter");

    // Wait for the user message to appear
    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible();

    // Verify that sidebar nav text is not selectable
    const navIsUnselectable = await page
      .locator("nav[aria-label='Main navigation']")
      .evaluate((el) => getComputedStyle(el).userSelect);
    expect(navIsUnselectable).toBe("none");

    // Verify that chat messages container IS selectable
    const messagesSelectable = await page
      .locator('[data-testid="messages-container"]')
      .evaluate((el) => getComputedStyle(el).userSelect);
    expect(messagesSelectable).toBe("text");
  });

  test("text selection is cleared when switching sessions", async ({ page }) => {
    // Navigate to a session with messages
    const sessionItem = page.locator('[data-testid="session-item"]').filter({ hasText: "Python" });
    await sessionItem.click();
    await page.locator('[data-testid="message-user"]').first().waitFor({ timeout: 5000 });

    // Select message text (triple-click selects paragraph)
    await page.locator('[data-testid="message-user"]').first().click({ clickCount: 3 });
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selected.length).toBeGreaterThan(0);

    // Switch to a different session
    const otherSession = page
      .locator('[data-testid="session-item"]')
      .filter({ hasText: "API design" });
    await otherSession.click();
    // Wait for session switch to complete (selection clearing happens in useEffect)
    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible();

    // Selection should be cleared after switch
    const selectionText = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selectionText).toBe("");
  });

  test("messages display timestamps", async ({ page }) => {
    // Navigate to the Python session which has seeded messages with timestamps
    const sessionItem = page.locator('[data-testid="session-item"]').filter({ hasText: "Python" });
    await sessionItem.click();
    await page.locator('[data-testid="message-user"]').first().waitFor({ timeout: 5000 });

    // User messages should have timestamps (on hover)
    const userMessage = page.locator('[data-testid="message-user"]').first();
    const userTimestamp = userMessage.locator('[data-testid="message-timestamp"]');

    // Hover reveals the timestamp
    await userMessage.hover();
    await expect(userTimestamp).toBeVisible();

    // Timestamp shows clock time (today), date (this year), or date with year (older)
    const text = await userTimestamp.textContent();
    expect(text).toMatch(/(\d{1,2}:\d{2} [ap]m|\d{1,2} \w{3}( \d{4})?)/);

    // Assistant messages should NOT have timestamps
    const assistantTimestamp = page
      .locator('[data-testid="message-assistant"]')
      .first()
      .locator('[data-testid="message-timestamp"]');
    await expect(assistantTimestamp).toHaveCount(0);
  });
});
