import { test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";

/**
 * E2E tests for the browser file-write permission pipeline.
 *
 * Three flows exercised:
 *   1. browser_take_screenshot with explicit filename → write-kind card showing the path
 *   2. browser_take_screenshot targeting a sensitive path → write-kind card with sensitivePathWarning
 *   3. browser_run_code → write-kind card with "Browser code execution" title
 *
 * All three use triggered mock scenarios. The pre-tool-use step for screenshot tests
 * runs before the permission-request step so pendingBrowserWritePaths is populated
 * before permissionHandler reads it and upgrades kind "mcp" → "write".
 */
test.describe("browser write permission pipeline", () => {
  test("browser_take_screenshot — write-kind card shows target path", async ({ page }) => {
    const textarea = chatInput(page);
    await textarea.waitFor();
    await textarea.fill("browser-screenshot-write please");
    await textarea.press("Enter");

    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible();

    // The permission card should be a write-kind (upgraded from mcp by permissionHandler)
    const card = page.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="write"]',
    );
    await card.waitFor({ timeout: 15_000 });

    // The target path must be visible somewhere on the card
    await card.getByTestId("permission-details-toggle").click();
    await expect(card).toContainText("/tmp/report.png");

    // Allow the write
    await card.getByRole("button", { name: "Allow once" }).click();

    await expect(
      page.locator('[data-testid="permission-card"][data-resolved="allowed"][data-kind="write"]'),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("browser_take_screenshot — sensitive path shows warning banner", async ({ page }) => {
    const textarea = chatInput(page);
    await textarea.waitFor();
    await textarea.fill("browser-screenshot-sensitive please");
    await textarea.press("Enter");

    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible();

    const card = page.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="write"]',
    );
    await card.waitFor({ timeout: 15_000 });

    // The sensitive-path warning banner must be visible
    await expect(card.locator('[data-testid="sensitive-path-warning"]')).toBeVisible({
      timeout: 5_000,
    });

    // Allow anyway
    await card.getByRole("button", { name: "Allow once" }).click();

    await expect(
      page.locator('[data-testid="permission-card"][data-resolved="allowed"][data-kind="write"]'),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("browser_run_code — write-kind card with code-execution title and message", async ({
    page,
  }) => {
    const textarea = chatInput(page);
    await textarea.waitFor();
    await textarea.fill("browser-exec-write please");
    await textarea.press("Enter");

    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible();

    const card = page.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="write"]',
    );
    await card.waitFor({ timeout: 15_000 });

    // Title is "Browser code execution" (set by the isBrowserWrite + path:"*" branch)
    await expect(card).toContainText("Browser code execution");

    // Message mentions file writing
    await expect(card).toContainText("may write files to disk");

    // Allow the write
    await card.getByRole("button", { name: "Allow once" }).click();

    await expect(
      page.locator('[data-testid="permission-card"][data-resolved="allowed"][data-kind="write"]'),
    ).toBeVisible({ timeout: 5_000 });
  });
});
