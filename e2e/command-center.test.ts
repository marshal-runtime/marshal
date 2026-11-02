import type { CommandCenterAPI } from "../common/marshal-ipc-contract";
import { test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";

test.describe("command center", () => {
  test.beforeEach(async ({ page }) => {
    await chatInput(page).waitFor();
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: /Activity/ }).click();
    await page.getByRole("tab", { name: "Command Center" }).click();
    await page.getByTestId("command-center-section-active").waitFor();
  });

  test("renders the three session sections with named sessions and reused detail panel", async ({
    page,
  }) => {
    const commandCenter = page.locator("[aria-label='Command Center']");

    // Three section headers, with the Older bucket collapsed by default.
    const activeSection = commandCenter.getByTestId("command-center-section-active");
    const recentSection = commandCenter.getByTestId("command-center-section-recent");
    const olderSection = commandCenter.getByTestId("command-center-section-older");
    const pythonSession = olderSection.getByText("Python debugging session");
    await expect(activeSection).toBeVisible();
    await expect(recentSection).toBeVisible();
    await expect(olderSection).toBeVisible();

    // Seeded sessions are days old → all in Older. Older is collapsed, so the
    // session name is hidden until the section is expanded.
    await expect(pythonSession).toBeHidden();
    await olderSection.getByRole("button", { name: /Older/ }).click();
    await expect(pythonSession).toBeVisible();

    // Removed surfaces should not appear.
    const panelText = await commandCenter.innerText();
    expect(panelText).not.toContain("Replay state");
    expect(panelText).not.toMatch(/^Tools$/m);
    expect(panelText).not.toMatch(/^Runs$/m);
    expect(panelText).not.toMatch(/^Blockers$/m);
    expect(panelText).not.toMatch(/^Artifacts$/m);

    const todoResult = await page.evaluate(() => {
      const appWindow = window as Window & { commandCenterAPI?: CommandCenterAPI };
      return appWindow.commandCenterAPI?.upsertTodo({
        todoId: "todo_e2e_panel_controls",
        title: "Review command center snapshot",
        status: "in_progress",
      });
    });
    expect(todoResult?.success).toBe(true);

    // Selecting a session opens the reused activity panel (same testid as the
    // chat-view side panel).
    await olderSection.getByRole("button", { name: /Python debugging session/ }).click();
    const activityPanel = page.getByTestId("session-activity-panel").first();
    await expect(activityPanel).toBeVisible();
    await expect(page.getByTestId("session-activity-progress")).toBeVisible();
    await expect(page.getByText("Review command center snapshot")).toBeVisible();

    await page.getByTestId("session-activity-panel-expand").click();
    await expect(activityPanel).toHaveAttribute("data-panel-mode", "expanded");
    await page.getByTestId("session-activity-panel-restore").click();
    await expect(activityPanel).toHaveAttribute("data-panel-mode", "normal");

    await page.getByTestId("session-activity-panel-collapse").click();
    await expect(page.getByTestId("session-activity-progress")).toBeHidden();
    await expect(page.getByTestId("session-activity-panel-show")).toBeVisible();
    await page.getByTestId("session-activity-panel-show").click();
    await expect(page.getByTestId("session-activity-progress")).toBeVisible();
  });

  test("closes back to chat", async ({ page }) => {
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Activity" })).toBeHidden();
    await expect(chatInput(page)).toBeVisible();
  });
});
