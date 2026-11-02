import { test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";
import { openMoreMenuItem } from "./helpers/marshal-nav";

async function closeVisibleOAuthPrompts(page: import("@playwright/test").Page) {
  // Dismiss up to 3 stacked OAuth prompts. Each iteration awaits the dialog
  // visibility check before clicking, so the loop is intentionally sequential
  // and `Promise.all` would race the dismissals.
  const dialog = page.getByRole("dialog");
  const cancel = page.getByRole("button", { name: "Cancel" });
  for (let i = 0; i < 3; i++) {
    // oxlint-disable-next-line no-await-in-loop -- sequential dismissal required
    if (!(await dialog.isVisible().catch(() => false))) break;
    // oxlint-disable-next-line no-await-in-loop -- sequential dismissal required
    await cancel.click();
    // oxlint-disable-next-line no-await-in-loop -- sequential dismissal required
    await expect(dialog).toBeHidden({ timeout: 2_000 });
  }
}

/**
 * E2E coverage for the remote MCP OAuth surfacing path. Verifies that when the
 * bundled CLI emits mcp.oauth_required / mcp.oauth_completed /
 * session.mcp_server_status_changed events, the renderer surfaces a foreground
 * sign-in prompt and card-level recovery actions.
 *
 * The mock client (E2E mode) emits runtime-adapter events through the same
 * SessionManager.subscribeToBackendEvents path the real bundled CLI hits, so
 * this exercises the end-to-end wiring: mock SDK event → normalize-event →
 * SessionManager.mcpStatusCallback → main.ts webContents.send → preload
 * mcpsAPI.on* listeners → App.tsx MCP OAuth prompt.
 */
test.describe("MCP OAuth surfacing (mock mode)", () => {
  test.beforeEach(async ({ page }) => {
    await chatInput(page).waitFor();
  });

  test("shows a foreground prompt for chat-time OAuth requirements", async ({ page }) => {
    const input = chatInput(page);
    // Trigger word "mcp-oauth" matched by MOCK_TRIGGERED_SCENARIOS — emits the
    // three MCP-related SDK events plus a final assistant.message + idle.
    await input.fill("trigger mcp-oauth flow");
    await input.press("Enter");

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Marshal needs you to sign in to/)).toBeVisible();
    await expect(dialog.getByLabel("Username or alias")).toHaveValue("e2e@test.com");
    await expect(dialog.getByRole("button", { name: /Sign in|Retry sign in/ })).toBeVisible();
  });

  test("shows runtime-only MCP servers in Extensions after SDK status events", async ({ page }) => {
    const input = chatInput(page);
    await input.fill("trigger mcp-oauth flow");
    await input.press("Enter");

    await expect(
      page.getByRole("dialog").getByText(/Marshal needs you to sign in to/),
    ).toBeVisible();
    await closeVisibleOAuthPrompts(page);

    await (await openMoreMenuItem(page, /Extensions/)).click();
    await closeVisibleOAuthPrompts(page);
    await page.getByRole("tab", { name: "MCP Servers" }).click();

    const yourServers = page.locator("section", { hasText: "Your MCP Servers" });
    // The card is a `<div role="button">` after the Card-primitive refactor —
    // querying by accessible role rather than the `<button>` tag survives
    // the underlying-element swap.
    const card = yourServers.getByRole("button", { name: /powerbi-remote/ });
    await expect(card).toBeVisible();
    await expect(yourServers.getByText("Sign-in required")).toBeVisible();
    await closeVisibleOAuthPrompts(page);

    await card.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("powerbi-remote")).toBeVisible();
    await expect(dialog.getByText("Status")).toBeVisible();
    await expect(dialog.getByText("Sign-in required")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("canceling the OAuth dialog closes it without completing sign-in", async ({ page }) => {
    const input = chatInput(page);
    await input.fill("trigger mcp-oauth flow");
    await input.press("Enter");

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Marshal needs you to sign in to/)).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible({ timeout: 3_000 });
  });

  test("signing in via the dialog closes it and shows a success toast", async ({ page }) => {
    const input = chatInput(page);
    await input.fill("trigger mcp-oauth flow");
    await input.press("Enter");

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Marshal needs you to sign in to/)).toBeVisible();

    await page.getByRole("button", { name: /Sign in|Retry sign in/ }).click();

    // The E2E stub returns { status: "success" } so the dialog closes and a
    // toast confirming sign-in appears.
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Signed in to MCP server/)).toBeVisible();
  });

  test("failed server shows no sign-in button in Extensions", async ({ page }) => {
    const input = chatInput(page);
    await input.fill("trigger mcp-oauth flow");
    await input.press("Enter");

    // Wait for the scenario to complete (assistant says "Done.")
    await expect(page.getByText("Done.")).toBeVisible({ timeout: 10_000 });
    await closeVisibleOAuthPrompts(page);

    await (await openMoreMenuItem(page, /Extensions/)).click();
    await closeVisibleOAuthPrompts(page);
    await page.getByRole("tab", { name: "MCP Servers" }).click();

    const yourServers = page.locator("section", { hasText: "Your MCP Servers" });

    // "broken-mock" was emitted with status "failed" — it should appear in the
    // list but must NOT show a sign-in button (it is not OAuth-capable).
    // Card is `<div role="button">` after the Card-primitive refactor.
    const card = yourServers.getByRole("button", { name: /broken-mock/ });
    await expect(card).toBeVisible();
    await card.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("broken-mock")).toBeVisible();
    await expect(dialog.getByText(/Failed/i)).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Sign in/i })).toBeHidden();
  });
});
