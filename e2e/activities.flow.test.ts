import { chatInput } from "./helpers/marshal-chat-input";
import { openMoreMenuItem } from "./helpers/marshal-nav";
import { sharedTest as test, test as freshTest, expect } from "./marshal-fixtures";

test.describe("activities panel — Marshal flow", () => {
  test.beforeEach(async ({ page }) => {
    await chatInput(page).waitFor();
    await (await openMoreMenuItem(page, /Activity/)).click();
    await page.getByText("Upcoming").waitFor();
  });

  test("opens with upcoming tab active by default", async ({ page }) => {
    await expect(page.getByRole("tab", { name: "Upcoming" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "History" })).toBeVisible();
  });

  test("sidebar nav closes the panel", async ({ page }) => {
    // Panel close button removed — exit Activity by navigating elsewhere via the sidebar.
    await page.getByTestId("new-chat-btn").click();
    await expect(page.getByText("Upcoming")).toBeHidden();
  });

  test("upcoming tab shows configured automations", async ({ page }) => {
    await expect(page.getByText("Morning Email Summary")).toBeVisible();
    await expect(page.getByText("Weekly Status Report")).toBeVisible();
  });

  test("disabled automation shows off badge", async ({ page }) => {
    // Weekly Status Report is disabled in sample data
    await expect(page.getByText("off").first()).toBeVisible();
  });

  test("clicking upcoming automation opens automations panel and closes activities", async ({
    page,
  }) => {
    await page.getByTitle("Open in Automations").first().click();
    await expect(page.getByText("Automations").first()).toBeVisible();
    // Activities panel should be closed
    await expect(page.getByRole("tab", { name: "Upcoming" })).toBeHidden();
  });

  test("navigable automation item is keyboard-accessible via Enter", async ({ page }) => {
    // Verify navigable items have role="button" and tabIndex so they're
    // reachable via keyboard, then activate with Enter.
    const target = page.getByTitle("Open in Automations").first();
    await expect(target).toHaveRole("button");
    await expect(target).toHaveAttribute("tabindex", "0");
    // Use press to simulate keyboard activation on the focused element
    await target.press("Enter");
    await expect(page.getByText("Automations").first()).toBeVisible();
    await expect(page.getByRole("tab", { name: "Upcoming" })).toBeHidden();
  });

  test("history tab shows automation runs with status", async ({ page }) => {
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByText("Morning Email Summary")).toBeVisible();
    await expect(page.getByText("completed").first()).toBeVisible();
  });

  test("history tab shows final output summary", async ({ page }) => {
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByText("Morning summary sent to relay.")).toBeVisible();
  });

  test("clicking history run with deleted session shows banner", async ({ page }) => {
    await page.getByRole("tab", { name: "History" }).click();
    // sessions:get is stubbed to return { success: true, session: null }
    // so any run with a sessionId triggers the "Session no longer exists" notice
    await page.getByTitle("Open session").first().click();
    await expect(page.getByText("Session no longer exists")).toBeVisible();
  });

  test("one-shot automation shows one-time badge in upcoming tab", async ({ page }) => {
    // wf-3 "Prepare Monday Presentation" is seeded with oneShot: true
    await expect(page.getByText("Prepare Monday Presentation")).toBeVisible();
    await expect(page.getByText("one-time")).toBeVisible();
  });

  test("recurring automations do not show one-time badge", async ({ page }) => {
    // wf-1 "Morning Email Summary" has no oneShot flag
    // There should be exactly one one-time badge (only for wf-3)
    await expect(page.getByText("one-time")).toHaveCount(1);
  });
});

// App-level wiring: clicking a history run with a real session must navigate to
// the chat view. Uses the non-shared `freshTest` fixture so the sessions:get
// override is isolated to this test (sharedTest persists ipcMain handlers across
// the file and would leak into the deleted-session banner test above).
freshTest.describe("activities panel — navigation to chat", () => {
  freshTest.afterEach(async ({ app }) => {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("sessions:get");
    });
  });

  freshTest(
    "clicking a history run with a real session navigates to chat",
    async ({ app, page }) => {
      // Override sessions:get to return a valid session so handleRunClick fires
      // onSessionSelect rather than the "Session no longer exists" banner.
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler("sessions:get");
        ipcMain.handle("sessions:get", async () => ({
          success: true,
          session: {
            id: "deleted-session-abc123",
            name: "Morning Email Summary",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hasUnread: false,
            isActive: false,
            source: "automation",
            messages: [],
            permissionCards: [],
          },
          isBusy: false,
        }));
      });

      await chatInput(page).waitFor();
      await (await openMoreMenuItem(page, /Activity/)).click();
      await page.getByText("Upcoming").waitFor();
      await page.getByRole("tab", { name: "History" }).click();
      await page.getByTitle("Open session").first().click();

      // App.tsx wires onSessionSelect to navigate to chat after the session
      // switch resolves; the chat input becoming visible is the load-bearing signal.
      await expect(page.locator('[data-testid="chat-input-editor"]')).toBeVisible({
        timeout: 5000,
      });
      await expect(page.getByRole("tab", { name: "Upcoming" })).toBeHidden();
    },
  );
});
