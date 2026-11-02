import type { Locator, Page } from "@playwright/test";

// Marshal owns this shared E2E navigation helper.
/**
 * Heartbeat / Activity / Extensions / Integrations / Settings live inside the
 * bottom-bar More overflow menu in both narrow and wide nav modes. Tests that
 * navigate to one of those views must open the More menu first; this helper
 * does that and returns the menu item locator so the test can click it.
 */
export async function openMoreMenuItem(page: Page, name: RegExp | string): Promise<Locator> {
  // `exact: true` is load-bearing: every session-item kebab trigger has
  // aria-label="More actions" (and a parent accessible name like "Session A
  // More actions"), so a substring match on "More" hits 10+ elements and
  // trips Playwright's strict-mode check.
  await page.getByRole("button", { name: "More", exact: true }).click();
  return page.getByRole("menuitem", { name });
}
