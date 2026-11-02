import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { sharedTest as test, expect } from "./marshal-fixtures";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.join(__dirname, "..", "test-screenshots");

/**
 * Visual showcase of the permission card timeline.
 *
 * The seeded "e2e-history" session in e2e-stubs.ts renders as:
 *
 *  Turn 1 — Two grouped shell cards (both allowed)
 *  Turn 2 — Mixed-kind group: write (allowed) + shell (denied)
 *  Turn 3 — Single standalone MCP card (failed)
 *  Turn 4 — URL, memory, and hook cards (allowed, in AssistantRun) + pending shell prompt (unresolved, in the decision tray)
 *
 * All permission kinds (shell, write, mcp, url, memory, hook), all 3 resolved badges
 * (allowed, denied, failed), and one active pending card with action buttons.
 *
 * Settled cards render in `[data-testid="assistant-run-permissions"]` groups (AssistantRun component).
 * Active/pending cards render in `[data-testid="permission-decision-tray"]` above the composer.
 */
test.describe("permission card timeline showcase", () => {
  test.beforeEach(async ({ app, page }) => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("sessions:switch-to", "e2e-history");
    });
    await page.locator('[data-testid="message-user"]').first().waitFor({ timeout: 10000 });
  });

  test.afterEach(async ({ page }, testInfo) => {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const name = testInfo.title.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-]/g, "");
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, `${name}.png`),
      fullPage: true,
    });
  });

  test("renders all permission card kinds and states", async ({ page }) => {
    // 4 user messages, 7 committed assistant messages + one live activity receipt
    await expect(page.locator('[data-testid="message-user"]')).toHaveCount(4);
    await expect(page.locator('[data-testid="message-assistant"]')).toHaveCount(8);

    // 8 settled cards (resolved) + 1 pending (active)
    await expect(page.locator('[data-testid="permission-card"][data-resolved]')).toHaveCount(8);
    await expect(page.locator('[data-testid="permission-card"]:not([data-resolved])')).toHaveCount(
      1,
    );

    // All seeded kinds present
    await expect(page.locator('[data-testid="permission-card"][data-kind="shell"]')).toHaveCount(4);
    await expect(page.locator('[data-testid="permission-card"][data-kind="write"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="permission-card"][data-kind="mcp"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="permission-card"][data-kind="url"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="permission-card"][data-kind="memory"]')).toHaveCount(
      1,
    );
    await expect(page.locator('[data-testid="permission-card"][data-kind="hook"]')).toHaveCount(1);

    // All 3 resolved badge variants
    await expect(
      page.locator('[data-testid="resolved-badge"]').filter({ hasText: "Allowed" }),
    ).toHaveCount(6);
    await expect(
      page.locator('[data-testid="resolved-badge"]').filter({ hasText: "Denied" }),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-testid="resolved-badge"]').filter({ hasText: "Failed" }),
    ).toHaveCount(1);

    // Pending card has compact direct actions plus an explicit scope selector.
    const pendingCard = page.locator('[data-testid="permission-card"]:not([data-resolved])');
    await expect(pendingCard.locator("button")).toHaveCount(4);
    await expect(pendingCard.getByRole("button", { name: "Allow once" })).toBeVisible();
    await expect(pendingCard.getByRole("button", { name: "Not now" })).toBeVisible();
    await pendingCard.getByTestId("permission-scope-trigger").click();
    await expect(page.getByRole("menuitem", { name: /This session/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /All chats/ })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("groups consecutive cards and keeps standalone cards separate", async ({ page }) => {
    // Timeline groups rendered by AssistantRun
    const timelineGroups = page.locator('[data-testid="assistant-run-permissions"]');
    //   [perm-1,perm-2], [perm-3,perm-4], [perm-5], [perm-6,perm-8,perm-9]
    await expect(timelineGroups).toHaveCount(4);

    // Group 1: two shell cards
    await expect(timelineGroups.nth(0).locator('[data-testid="permission-card"]')).toHaveCount(2);
    await expect(
      timelineGroups.nth(0).locator('[data-testid="permission-card"][data-kind="shell"]'),
    ).toHaveCount(2);

    // Group 2: one write + one shell (mixed kinds)
    await expect(timelineGroups.nth(1).locator('[data-testid="permission-card"]')).toHaveCount(2);
    await expect(
      timelineGroups.nth(1).locator('[data-testid="permission-card"][data-kind="write"]'),
    ).toHaveCount(1);
    await expect(
      timelineGroups.nth(1).locator('[data-testid="permission-card"][data-kind="shell"]'),
    ).toHaveCount(1);

    // Group 3: single MCP card (standalone)
    await expect(timelineGroups.nth(2).locator('[data-testid="permission-card"]')).toHaveCount(1);
    await expect(
      timelineGroups.nth(2).locator('[data-testid="permission-card"][data-kind="mcp"]'),
    ).toHaveCount(1);

    // Group 4: URL + memory + hook cards (settled, in timeline)
    await expect(timelineGroups.nth(3).locator('[data-testid="permission-card"]')).toHaveCount(3);
    await expect(
      timelineGroups.nth(3).locator('[data-testid="permission-card"][data-kind="url"]'),
    ).toHaveCount(1);
    await expect(
      timelineGroups.nth(3).locator('[data-testid="permission-card"][data-kind="memory"]'),
    ).toHaveCount(1);
    await expect(
      timelineGroups.nth(3).locator('[data-testid="permission-card"][data-kind="hook"]'),
    ).toHaveCount(1);

    // Decision tray: pending shell card is stable above the composer, outside the timeline.
    const decisionTray = page.getByTestId("permission-decision-tray");
    await expect(decisionTray).toHaveCount(1);
    await expect(decisionTray.locator('[data-testid="permission-card"]')).toHaveCount(1);
    await expect(decisionTray.locator("button")).toHaveCount(4);
    await expect(
      page.getByTestId("messages-container").getByTestId("permission-decision-tray"),
    ).toHaveCount(0);
  });

  test("screenshot with output panels expanded", async ({ page }) => {
    // Expand all output toggles so the screenshot shows full card content
    const toggles = page.locator('[data-testid="output-toggle"]');
    const count = await toggles.count();
    for (let i = 0; i < count; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential test steps
      await toggles.nth(i).click();
    }

    // Verify at least some outputs are now visible
    await expect(page.locator('[data-testid="output-full"]').first()).toBeVisible();

    // Scroll to top so full-page screenshot starts at the beginning
    await page.evaluate(() => window.scrollTo(0, 0));
  });
});
