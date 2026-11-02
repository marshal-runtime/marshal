import type { Page } from "@playwright/test";

import { chatInput } from "./helpers/marshal-chat-input";
import { expect, test } from "./marshal-fixtures";

const interruptions = {
  cancel: async (page: Page) => {
    // Match the cancellation fixture: unrelated runtime notices can cover the composer.
    await page.getByTestId("stop-btn").dispatchEvent("click");
    await expect(page.getByTestId("send-btn")).toBeVisible();
    await expect(page.getByText("Inspecting the cancellation path.")).toBeVisible();
    await chatInput(page).fill("cancel-followup");
    await chatInput(page).press("Enter");
  },
  steer: async (page: Page) => {
    await chatInput(page).fill("cancel-followup");
    await chatInput(page).press("Enter");
  },
};

for (const [action, interrupt] of Object.entries(interruptions)) {
  test(`${action} keeps the interrupted response after a follow-up and reload`, async ({
    page,
  }) => {
    await page.locator('[data-testid="session-item"][data-session-id="e2e-fresh"]').click();
    await chatInput(page).fill("cancel-activity-only");
    await chatInput(page).press("Enter");
    await expect(page.getByText("Inspecting the cancellation path.")).toBeVisible();
    await expect(page.getByTestId("tool-status-indicator")).toBeVisible();

    await interrupt(page);

    await expect(page.getByText("Follow-up completed.")).toBeVisible();
    await expect(page.getByText("Inspecting the cancellation path.")).toBeVisible();
    await expect(page.getByTestId("message-assistant")).toHaveCount(2);
    await expect(page.getByTestId("committed-tool-calls")).toHaveCount(1);
    await page.getByTestId("committed-tool-calls-toggle").click();
    await expect(page.getByTestId("tool-status-shimmer")).toHaveCount(0);

    await page.reload();
    await page.locator('[data-testid="session-item"][data-session-id="e2e-fresh"]').click();
    await expect(page.getByText("Inspecting the cancellation path.")).toBeVisible();
    await expect(page.getByText("Follow-up completed.")).toBeVisible();
    await expect(page.getByTestId("message-assistant")).toHaveCount(2);
    await expect(page.getByTestId("committed-tool-calls")).toHaveCount(1);
    await expect(page.getByText("Late cancelled output", { exact: true })).toHaveCount(0);
  });
}
