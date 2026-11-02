import { test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";

/**
 * Interactive permission card pipeline tests for regular chat.
 *
 * Uses the 2-tool MOCK_SCENARIO_PERMISSION (shell + write) triggered by the
 * "permission" keyword. Tests verify the full live pipeline:
 *   MockCopilotSession.send() → playScenario() → onPermissionRequest →
 *   PermissionPolicy.evaluate() → PermissionCardManager → UI card →
 *   user responds → scenario continues/tool skipped.
 */
test.describe("permission live chat pipeline", () => {
  /** Send "permission test" and wait for the first permission card to appear. */
  async function sendPermissionMessage(page: import("@playwright/test").Page) {
    const textarea = chatInput(page);
    await textarea.waitFor();
    await textarea.fill("permission test");
    await textarea.press("Enter");
    // User message appears
    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible();
  }

  test("deny both tools — response completes without tool output", async ({ page }) => {
    await sendPermissionMessage(page);

    // First permission card: shell (wait for any pending shell card)
    const pendingShell = page.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="shell"]',
    );
    await pendingShell.waitFor({ timeout: 15_000 });
    await pendingShell.getByTestId("permission-details-toggle").click();
    await expect(pendingShell.locator("pre")).toContainText("rm -rf /tmp/old-files/*");

    // Deny shell — card resolves and gains data-resolved attribute
    await pendingShell.getByRole("button", { name: "Not now" }).click();

    // Verify the shell card is now resolved as denied
    const resolvedShell = page.locator(
      '[data-testid="permission-card"][data-resolved="denied"][data-kind="shell"]',
    );
    await expect(resolvedShell).toBeVisible({ timeout: 5_000 });

    // Second permission card: write
    const pendingWrite = page.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="write"]',
    );
    await pendingWrite.waitFor({ timeout: 10_000 });

    // Deny write
    await pendingWrite.getByRole("button", { name: "Not now" }).click();

    const resolvedWrite = page.locator(
      '[data-testid="permission-card"][data-resolved="denied"][data-kind="write"]',
    );
    await expect(resolvedWrite).toBeVisible({ timeout: 5_000 });

    // Response completes — assistant message text appears (emitted regardless of denials)
    await expect(page.locator('[data-testid="message-assistant"]').first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("allow first, always-allow second — second auto-approved on re-send", async ({ page }) => {
    await sendPermissionMessage(page);

    // First card: shell → Allow
    const shellCard = page.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="shell"]',
    );
    await shellCard.waitFor({ timeout: 15_000 });
    await shellCard.getByRole("button", { name: "Allow once" }).click();

    // Second card: write → Allow everywhere
    const writeCard = page.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="write"]',
    );
    await writeCard.waitFor({ timeout: 10_000 });
    await writeCard.getByTestId("permission-scope-trigger").click();
    await page.getByTestId("allow-primary-pattern").click();

    // Response completes with both tools executed
    await expect(
      page.locator('[data-testid="message-assistant"]').filter({ hasText: /cleaned up|report/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Send again — "Allow everywhere" persisted for write, but shell needs approval again
    const textarea = chatInput(page);
    await textarea.waitFor();
    await textarea.fill("permission test");
    await textarea.press("Enter");

    // Shell card appears again (Allow is per-invocation)
    const shellCard2 = page
      .locator('[data-testid="permission-card"]:not([data-resolved])[data-kind="shell"]')
      .last();
    await shellCard2.waitFor({ timeout: 15_000 });
    await shellCard2.getByRole("button", { name: "Allow once" }).click();

    // Write card should NOT appear — "Allow everywhere" persisted
    // Wait for the response to complete; if write card appeared, the test
    // would see it as an unresolved card. Verify no pending write cards.
    await expect(
      page
        .locator('[data-testid="message-assistant"]')
        .filter({ hasText: /cleaned up|report/i })
        .last(),
    ).toBeVisible({ timeout: 10_000 });

    // Positive assertion: response text confirms both tools executed (not just card absence)
    await expect(
      page
        .locator('[data-testid="message-assistant"]')
        .filter({ hasText: /cleaned up|report/i })
        .last(),
    ).toBeVisible({ timeout: 10_000 });

    // Confirm no unresolved write cards remain (auto-approved at policy level, no card created)
    await expect(
      page.locator('[data-testid="permission-card"]:not([data-resolved])[data-kind="write"]'),
    ).toHaveCount(0);
  });

  test("allow-for-session persists within session", async ({ page }) => {
    await sendPermissionMessage(page);

    // First card: shell → Allow for session
    const shellCard = page.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="shell"]',
    );
    await shellCard.waitFor({ timeout: 15_000 });
    await shellCard.getByTestId("permission-scope-trigger").click();
    await page.getByRole("menuitem", { name: /This session/ }).click();

    // Second card: write → Allow (single invocation only)
    const writeCard = page.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="write"]',
    );
    await writeCard.waitFor({ timeout: 10_000 });
    await writeCard.getByRole("button", { name: "Allow once" }).click();

    // Response completes
    await expect(
      page.locator('[data-testid="message-assistant"]').filter({ hasText: /cleaned up|report/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Send again
    const textarea = chatInput(page);
    await textarea.waitFor();
    await textarea.fill("permission test");
    await textarea.press("Enter");

    // Shell card does NOT appear — session-scoped approval from "Allow for session"
    // Write card DOES appear — single "Allow" was per-invocation
    const writeCard2 = page
      .locator('[data-testid="permission-card"]:not([data-resolved])[data-kind="write"]')
      .last();
    await writeCard2.waitFor({ timeout: 15_000 });

    // Verify no pending shell cards
    // The last shell permission should be auto-resolved (session approval) not pending
    const pendingShellCards = page.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="shell"]',
    );
    await expect(pendingShellCards).toHaveCount(0);

    // Resolve write card to complete the response
    await writeCard2.getByRole("button", { name: "Allow once" }).click();

    await expect(
      page
        .locator('[data-testid="message-assistant"]')
        .filter({ hasText: /cleaned up|report/i })
        .last(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
