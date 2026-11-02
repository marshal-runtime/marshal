import type { Locator, Page } from "@playwright/test";

// Marshal owns this shared E2E chat-input locator.
/**
 * The chat prompt input is a Lexical contenteditable (no longer a <textarea>).
 * Use this helper to target it from E2E tests; Playwright's .fill() / .press() /
 * .toHaveText() all work on a contenteditable in real Chromium.
 */
export function chatInput(page: Page | Locator): Locator {
  return page.getByTestId("chat-input-editor");
}
