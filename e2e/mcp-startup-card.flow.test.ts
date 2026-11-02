import { test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";

/**
 * E2E coverage for the inline MCP startup card. The card is an **attention
 * surface**, not a roster: it only renders when at least one MCP server
 * needs the user to do something (sign-in required, or a connection failure).
 * Ready and connecting servers are intentionally not surfaced — the
 * Extensions panel is the canonical place to inspect the full inventory.
 *
 * Driven from `mcps:list` + `mcpOAuthStore`, so the bundled mock SDK's
 * mcp-oauth scenario (which emits session.mcp_server_status_changed events)
 * is enough to exercise the rising-edge path.
 */
test.describe("MCP startup card — Marshal flow", () => {
  test.beforeEach(async ({ page }) => {
    await chatInput(page).waitFor();
  });

  test("does not render at top of timeline when seeded built-ins are healthy", async ({ page }) => {
    const input = chatInput(page);
    await input.fill("hello");
    await input.press("Enter");

    // Wait until the timeline has replaced the welcome state.
    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible();

    // No card: built-ins reach steady state without attention. Users see the
    // Extensions panel for full inventory rather than a noisy chat banner.
    await expect(page.getByTestId("mcp-startup-card")).toBeHidden();
  });

  test("shows a sign-in action after a server emits needs-auth", async ({ page }) => {
    const input = chatInput(page);
    // The mcp-oauth mock scenario emits a session.mcp_server_status_changed
    // event for "powerbi-remote" with status "needs-auth", which is forwarded
    // into SessionManager.getMcpServerStatuses(), surfaces in mcps:list, and
    // therefore in the startup card.
    await input.fill("trigger mcp-oauth flow");
    await input.press("Enter");

    // Dismiss the foreground OAuth dialog so it does not occlude the card.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    const card = page.getByTestId("mcp-startup-card");
    await expect(card).toBeVisible();

    // The card surfaces only attention items, so the powerbi-remote row is
    // visible directly with no expand/collapse step required.
    const row = card.getByTestId("mcp-startup-card-row").filter({ hasText: "powerbi-remote" });
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: /Sign in/ })).toBeVisible();
  });

  test("appears mid-session when an attention-requiring server arrives", async ({ page }) => {
    const input = chatInput(page);

    // 1. Start a session with a benign prompt. Only the seeded built-ins exist
    //    at this point; they reach steady state without attention, so the card
    //    is hidden entirely.
    await input.fill("hello");
    await input.press("Enter");

    const card = page.getByTestId("mcp-startup-card");
    await expect(card).toBeHidden();

    // 2. Trigger the oauth scenario, which emits needs-auth for powerbi-remote.
    await input.fill("trigger mcp-oauth flow");
    await input.press("Enter");

    // Dismiss the foreground OAuth dialog so it does not occlude the card.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    // 3. The card appears because an attention item arrived. Rows are visible
    //    immediately and the powerbi-remote row carries Sign in.
    await expect(card).toBeVisible();
    const row = card.getByTestId("mcp-startup-card-row").filter({ hasText: "powerbi-remote" });
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: /Sign in/ })).toBeVisible();
  });
});
