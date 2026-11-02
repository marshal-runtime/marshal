import { chatInput } from "./helpers/marshal-chat-input";
import { test, expect } from "./marshal-fixtures";

test.describe("sessions sidebar — Marshal flow", () => {
  test.beforeEach(async ({ page }) => {
    await chatInput(page).waitFor();
    // All visible seeded sessions should appear (the workflow-agent seed is hidden)
    await expect(page.locator('[data-testid="session-item"]')).toHaveCount(6);
  });

  test.describe("search", () => {
    test("filters sessions by name as user types", async ({ page }) => {
      const searchInput = page.getByRole("textbox", { name: "Search chats" });

      await searchInput.fill("python");

      // Only the Python session should be visible
      await expect(page.locator('[data-testid="session-item"]')).toHaveCount(1);
      await expect(page.locator('[data-testid="session-item"]')).toContainText(
        "Python debugging session",
      );
    });

    test("updates results when query changes", async ({ page }) => {
      const searchInput = page.getByRole("textbox", { name: "Search chats" });

      await searchInput.fill("python");
      await expect(page.locator('[data-testid="session-item"]')).toHaveCount(1);

      await searchInput.fill("api");
      await expect(page.locator('[data-testid="session-item"]')).toHaveCount(1);
      await expect(page.locator('[data-testid="session-item"]')).toContainText("API design review");
    });

    test("shows no-results message when nothing matches", async ({ page }) => {
      const searchInput = page.getByRole("textbox", { name: "Search chats" });

      await searchInput.fill("xyznonexistent");

      await expect(page.locator('[data-testid="session-item"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="no-sessions"]')).toContainText("xyznonexistent");
    });

    test("restores full list when query is cleared via clear button", async ({ page }) => {
      const searchInput = page.getByRole("textbox", { name: "Search chats" });

      await searchInput.fill("python");
      await expect(page.locator('[data-testid="session-item"]')).toHaveCount(1);

      await page.getByRole("button", { name: "Clear search" }).click();

      await expect(searchInput).toHaveValue("");
      await expect(page.locator('[data-testid="session-item"]')).toHaveCount(6);
    });

    test("restores full list when query is manually cleared", async ({ page }) => {
      const searchInput = page.getByRole("textbox", { name: "Search chats" });

      await searchInput.fill("api");
      await expect(page.locator('[data-testid="session-item"]')).toHaveCount(1);

      await searchInput.clear();

      await expect(page.locator('[data-testid="session-item"]')).toHaveCount(6);
    });
  });

  test.describe("delete", () => {
    /** Open the overflow menu on a session and click Delete to show the confirmation dialog. */
    async function openDeleteDialog(page: import("@playwright/test").Page, sessionText: string) {
      const session = page.locator('[data-testid="session-item"]', { hasText: sessionText });
      await session.hover();
      await session.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: /Delete/ }).click();
    }

    test("shows confirmation dialog before deleting", async ({ page }) => {
      await openDeleteDialog(page, "API design review");

      // Dialog should be visible with the session name
      await expect(page.getByText("Delete session?")).toBeVisible();
      // Session should still exist
      await expect(page.locator('[data-testid="session-item"]')).toHaveCount(6);
    });

    test("deletes session after confirm click and removes it from the list", async ({ page }) => {
      await openDeleteDialog(page, "API design review");
      await page.getByRole("button", { name: "Delete", exact: true }).click();

      const session = page.locator('[data-testid="session-item"]', {
        hasText: "API design review",
      });
      await expect(session).toBeHidden();
      await expect(page.locator('[data-testid="session-item"]')).toHaveCount(5);
    });

    test("removed session stays gone after list refetches from server", async ({ page }) => {
      await openDeleteDialog(page, "Python debugging session");
      await page.getByRole("button", { name: "Delete", exact: true }).click();

      const session = page.locator('[data-testid="session-item"]', {
        hasText: "Python debugging session",
      });
      await expect(session).toBeHidden();
      await page.waitForTimeout(500); // eslint-disable-line playwright/no-wait-for-timeout
      await expect(session).toBeHidden();
      await expect(page.locator('[data-testid="session-item"]')).toHaveCount(5);
    });

    test("deleting a session while search is active removes it from search results", async ({
      page,
    }) => {
      const searchInput = page.getByRole("textbox", { name: "Search chats" });
      await searchInput.fill("python");
      await expect(page.locator('[data-testid="session-item"]')).toHaveCount(1);

      await openDeleteDialog(page, "Python debugging session");
      await page.getByRole("button", { name: "Delete", exact: true }).click();

      const session = page.locator('[data-testid="session-item"]', {
        hasText: "Python debugging session",
      });
      await expect(session).toBeHidden();
      await expect(page.locator('[data-testid="no-sessions"]')).toBeVisible();
    });

    test("cancelling delete dialog does not delete", async ({ page }) => {
      await openDeleteDialog(page, "API design review");
      await page.getByRole("button", { name: "Cancel" }).click();

      // Dialog should close, session should still be there
      await expect(page.getByText("Delete session?")).toBeHidden();
      await expect(
        page.locator('[data-testid="session-item"]', { hasText: "API design review" }),
      ).toBeVisible();
      await expect(page.locator('[data-testid="session-item"]')).toHaveCount(6);
    });
  });
});
