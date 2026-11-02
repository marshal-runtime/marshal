import type { Page } from "@playwright/test";

import { sharedTest as test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";
import { openMoreMenuItem } from "./helpers/marshal-nav";

const backBtn = (page: Page) => page.getByLabel("Go to previous page");
const forwardBtn = (page: Page) => page.getByLabel("Go to next page");
const nav = (page: Page) => page.locator("nav[aria-label='Main navigation']");

const isMac = process.platform === "darwin";
const BACK_SHORTCUT = isMac ? "Meta+[" : "Alt+ArrowLeft";
const FORWARD_SHORTCUT = isMac ? "Meta+]" : "Alt+ArrowRight";

test.describe("title bar navigation — Marshal flow", () => {
  test("shows back and forward buttons", async ({ page }) => {
    await expect(backBtn(page)).toBeVisible();
    await expect(forwardBtn(page)).toBeVisible();
    await expect(backBtn(page)).toBeDisabled();
    await expect(forwardBtn(page)).toBeDisabled();
  });

  test("back button enables after navigating to a panel", async ({ page }) => {
    await chatInput(page).waitFor();
    await (await openMoreMenuItem(page, /Settings/)).click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await expect(backBtn(page)).toBeEnabled();
    await expect(forwardBtn(page)).toBeDisabled();
  });

  test("back button returns to previous view", async ({ page }) => {
    await chatInput(page).waitFor();
    await (await openMoreMenuItem(page, /Settings/)).click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await backBtn(page).click();
    await expect(chatInput(page)).toBeVisible();
    await expect(page.getByTestId("settings-panel")).toBeHidden();
    await expect(backBtn(page)).toBeDisabled();
    await expect(forwardBtn(page)).toBeEnabled();
  });

  test("forward button restores view after going back", async ({ page }) => {
    await chatInput(page).waitFor();
    await (await openMoreMenuItem(page, /Settings/)).click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await backBtn(page).click();
    await expect(chatInput(page)).toBeVisible();
    await forwardBtn(page).click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await expect(forwardBtn(page)).toBeDisabled();
  });

  test("multi-step navigation chain with back and forward", async ({ page }) => {
    await chatInput(page).waitFor();
    await nav(page).getByRole("button", { name: "Automations" }).click();
    await expect(page.getByRole("button", { name: /new automation/i })).toBeVisible();
    await (await openMoreMenuItem(page, /Settings/)).click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await backBtn(page).click();
    await expect(page.getByRole("button", { name: /new automation/i })).toBeVisible();
    await backBtn(page).click();
    await expect(chatInput(page)).toBeVisible();
    await expect(backBtn(page)).toBeDisabled();
    await forwardBtn(page).click();
    await expect(page.getByRole("button", { name: /new automation/i })).toBeVisible();
    await forwardBtn(page).click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await expect(forwardBtn(page)).toBeDisabled();
  });

  test("new navigation truncates forward history", async ({ page }) => {
    await chatInput(page).waitFor();
    await (await openMoreMenuItem(page, /Settings/)).click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await backBtn(page).click();
    await expect(chatInput(page)).toBeVisible();
    await expect(forwardBtn(page)).toBeEnabled();
    await nav(page).getByRole("button", { name: "Automations" }).click();
    await expect(page.getByRole("button", { name: /new automation/i })).toBeVisible();
    await expect(forwardBtn(page)).toBeDisabled();
    await backBtn(page).click();
    await expect(chatInput(page)).toBeVisible();
  });

  test("switching sessions creates navigable history", async ({ page }) => {
    await chatInput(page).waitFor();
    await page
      .locator('[data-testid="session-item"]')
      .filter({ hasText: "Python debugging session" })
      .click();
    await expect(chatInput(page)).toBeVisible();
    await expect(backBtn(page)).toBeEnabled();
    await page
      .locator('[data-testid="session-item"]')
      .filter({ hasText: "API design review" })
      .click();
    await expect(chatInput(page)).toBeVisible();
    await backBtn(page).click();
    await expect(chatInput(page)).toBeVisible();
    await expect(backBtn(page)).toBeEnabled();
    // Verify the correct session was restored
    await expect(page.locator('[data-testid="session-item"][data-active]')).toContainText(
      "Python debugging session",
    );
  });

  test("deduplicates repeated clicks on the same nav item", async ({ page }) => {
    await chatInput(page).waitFor();
    await (await openMoreMenuItem(page, /Settings/)).click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await (await openMoreMenuItem(page, /Settings/)).click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await backBtn(page).click();
    await expect(chatInput(page)).toBeVisible();
    await expect(backBtn(page)).toBeDisabled();
  });

  test("keyboard shortcuts navigate back and forward", async ({ page }) => {
    await chatInput(page).waitFor();
    await (await openMoreMenuItem(page, /Settings/)).click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await page.keyboard.press(BACK_SHORTCUT);
    await expect(chatInput(page)).toBeVisible();
    await page.keyboard.press(FORWARD_SHORTCUT);
    await expect(page.getByTestId("settings-panel")).toBeVisible();
  });

  test("keyboard shortcuts keep working from chat input", async ({ page }) => {
    await chatInput(page).waitFor();
    await (await openMoreMenuItem(page, /Settings/)).click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await backBtn(page).click();
    await expect(chatInput(page)).toBeVisible();
    await chatInput(page).focus();
    await page.keyboard.press(FORWARD_SHORTCUT);
    await expect(page.getByTestId("settings-panel")).toBeVisible();
  });

  test("IPC sessions:switch-to creates navigable history", async ({ app, page }) => {
    await chatInput(page).waitFor();
    await nav(page).getByRole("button", { name: "Automations" }).click();
    await expect(page.getByRole("button", { name: /new automation/i })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("sessions:switch-to", "e2e-python");
    });
    await expect(chatInput(page)).toBeVisible({ timeout: 5000 });
    await backBtn(page).click();
    await expect(page.getByRole("button", { name: /new automation/i })).toBeVisible();
  });

  test("navigating across multiple views preserves correct back order", async ({ page }) => {
    await chatInput(page).waitFor();
    await (await openMoreMenuItem(page, /Activity/)).click();
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
    await (await openMoreMenuItem(page, /Extensions/)).click();
    await expect(page.getByRole("heading", { name: "Extensions" })).toBeVisible();
    await nav(page).getByRole("button", { name: "Automations" }).click();
    await expect(page.getByRole("button", { name: /new automation/i })).toBeVisible();
    await (await openMoreMenuItem(page, /Settings/)).click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await backBtn(page).click();
    await expect(page.getByRole("button", { name: /new automation/i })).toBeVisible();
    await backBtn(page).click();
    await expect(page.getByRole("heading", { name: "Extensions" })).toBeVisible();
    await backBtn(page).click();
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
    await backBtn(page).click();
    await expect(chatInput(page)).toBeVisible();
    await expect(backBtn(page)).toBeDisabled();
  });

  test("session switch mid-panel returns to correct session on back", async ({ page }) => {
    await chatInput(page).waitFor();
    await page
      .locator('[data-testid="session-item"]')
      .filter({ hasText: "Python debugging session" })
      .click();
    await expect(chatInput(page)).toBeVisible();
    await (await openMoreMenuItem(page, /Settings/)).click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await backBtn(page).click();
    await expect(chatInput(page)).toBeVisible();
    await expect(backBtn(page)).toBeEnabled();
    // Verify the correct session is active in the sidebar
    await expect(page.locator('[data-testid="session-item"][data-active]')).toContainText(
      "Python debugging session",
    );
  });
});
