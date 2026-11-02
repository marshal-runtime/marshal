import fs from "fs";
import path from "path";

import { E2E_DATA_DIR } from "../electron/mock-mode";
import { test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";

const WORKSPACE_DIR = path.join(E2E_DATA_DIR, "workspace", "Scratchpad");

/** Navigate to Workspaces and wait for the session drawer to appear. */
async function openCoCreate(page: import("@playwright/test").Page) {
  const navButton = page.getByRole("button", { name: "Workspaces" });
  await navButton.waitFor({ timeout: 5000 });
  await navButton.click();

  // Wait for the session drawer to appear (initial session auto-created)
  await page.locator('[data-testid="workspace-session-drawer"]').waitFor({ timeout: 5000 });
}

/** Hover over drawer and wait for session items to be visible (handles animation timing). */
async function expandDrawer(page: import("@playwright/test").Page) {
  const drawer = page.locator('[data-testid="workspace-session-drawer"]');
  await drawer.hover();
  // The session list only renders after async IPC loads sessions AND the 150ms expand
  // timer fires. Wait for at least one session item to appear (confirms both conditions).
  await page
    .locator('[data-testid="workspace-session-item"]')
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
}

test.describe("CoCreate multisession", () => {
  test.beforeEach(async ({ page }) => {
    // Ensure workspace dir exists for CoCreate file tree
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "notes.md"), "# Notes\n\nSome content here.");

    await chatInput(page).waitFor();
    await openCoCreate(page);
  });

  test("shows session drawer with active session on Workspaces open", async ({ page }) => {
    const drawer = page.locator('[data-testid="workspace-session-drawer"]');
    await expect(drawer).toBeVisible();

    // Active session should show the workspace session name
    const active = page.locator('[data-testid="workspace-active-session"]');
    await expect(active).toBeVisible();
  });

  test("creates new session via New chat button", async ({ page }) => {
    const newChatBtn = page.locator('[data-testid="workspace-new-chat-btn"]');
    await expect(newChatBtn).toBeVisible();
    await newChatBtn.click();

    // Hover to expand the dropdown (shows other sessions)
    await expandDrawer(page);

    // Should have at least 1 other session in the expanded list
    await expect(page.locator('[data-testid="workspace-session-item"]')).toHaveCount(1, {
      timeout: 5000,
    });
  });

  test("creates multiple sessions and lists them in drawer", async ({ page }) => {
    const newChatBtn = page.locator('[data-testid="workspace-new-chat-btn"]');

    // Create a second session
    await newChatBtn.click();
    // Wait for session creation by expanding drawer and verifying count
    await expandDrawer(page);
    await expect(page.locator('[data-testid="workspace-session-item"]')).toHaveCount(1, {
      timeout: 5000,
    });

    // Send a message so this session is no longer "empty"
    const chatTextarea = chatInput(page).last();
    await chatTextarea.fill("make this session non-empty");
    await chatTextarea.press("Enter");
    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible({
      timeout: 5000,
    });

    // Now "New chat" should create a third session (previous one is non-empty)
    await newChatBtn.click();

    // Re-expand the drawer
    await expandDrawer(page);

    // Should show 2 other sessions (active is not in the list)
    await expect(page.locator('[data-testid="workspace-session-item"]')).toHaveCount(2, {
      timeout: 5000,
    });
  });

  test("clicking New chat twice without typing reuses the empty session", async ({ page }) => {
    const newChatBtn = page.locator('[data-testid="workspace-new-chat-btn"]');

    // First click — creates a new empty session
    await newChatBtn.click();
    await expandDrawer(page);
    await expect(page.locator('[data-testid="workspace-session-item"]')).toHaveCount(1, {
      timeout: 5000,
    });

    // Second click — should NOT create another session (the active one is still empty)
    await newChatBtn.click();

    // Count should remain 1, not grow to 2
    await expect(page.locator('[data-testid="workspace-session-item"]')).toHaveCount(1, {
      timeout: 5000,
    });
  });

  test("switches between sessions by clicking in drawer", async ({ page }) => {
    const newChatBtn = page.locator('[data-testid="workspace-new-chat-btn"]');
    await newChatBtn.click();

    // Expand the drawer
    await expandDrawer(page);

    // Get the non-active session and click it (hover it first to keep drawer open)
    const otherSession = page.locator('[data-testid="workspace-session-item"]').first();
    await expect(otherSession).toBeVisible({ timeout: 5000 });
    const otherName = await otherSession.innerText();

    // Hover directly on the session item to keep drawer expanded, then click
    await otherSession.hover();
    await otherSession.click();

    // The active session name should change
    const active = page.locator('[data-testid="workspace-active-session"]');
    await expect(active).toContainText(otherName.split("\n")[0], { timeout: 5000 });
  });

  test("session messages are preserved when switching", async ({ page }) => {
    // Send a message in the first session — textarea is in the ChatPanel below the drawer
    const chatTextarea = chatInput(page).last();
    await chatTextarea.fill("Hello from session 1");
    await chatTextarea.press("Enter");

    // Wait for user message to appear
    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible({
      timeout: 5000,
    });

    // Create a new session
    await page.locator('[data-testid="workspace-new-chat-btn"]').click();

    // In the new session, messages should be empty (no user messages)
    // Wait for the session switch to take effect — old messages should disappear
    await expect(page.locator('[data-testid="message-user"]')).toHaveCount(0, { timeout: 10_000 });

    // Switch back to first session
    await expandDrawer(page);
    const firstSession = page.locator('[data-testid="workspace-session-item"]').first();
    await firstSession.hover();
    await firstSession.click();

    // The original message should be visible again
    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator('[data-testid="message-user"]').first()).toContainText(
      "Hello from session 1",
    );
  });

  test.fixme("deleting a session removes it from the drawer", async ({ page }) => {
    const newChatBtn = page.locator('[data-testid="workspace-new-chat-btn"]');
    await newChatBtn.click();

    // Expand the drawer
    await expandDrawer(page);

    // Should have 1 other session
    await expect(page.locator('[data-testid="workspace-session-item"]')).toHaveCount(1, {
      timeout: 5000,
    });

    // Hover over the session to reveal delete button, then delete
    // Retry hover+click together — CSS :hover can be lost between actions on slow CI.
    // force: true bypasses visibility checks since the button toggles display:none/flex on hover.
    const sessionItem = page.locator('[data-testid="workspace-session-item"]').first();
    const deleteBtn = sessionItem.locator('button[title="Delete"]');
    await expect(async () => {
      await sessionItem.hover();
      await deleteBtn.click({ force: true }); // eslint-disable-line playwright/no-force-option -- button uses display:none/flex toggle on :hover
    }).toPass({ timeout: 10_000 });

    // Session should be removed
    await expect(page.locator('[data-testid="workspace-session-item"]')).toHaveCount(0, {
      timeout: 5000,
    });
  });
});
