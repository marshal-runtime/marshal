import fs from "fs";
import path from "path";

import { test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";

process.env.MARSHAL_E2E_CHAT_CONTROLS = "1";

test("keeps context and timeline filters discoverable in installed chat layouts", async ({
  app,
  page,
}, testInfo) => {
  const evidenceDir =
    process.env.CHAT_CONTROLS_EVIDENCE_DIR ?? testInfo.outputPath("chat-controls-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const capture = async (name: string) => {
    await page.screenshot({ path: path.join(evidenceDir, name) });
  };
  const setWindowSize = async (width: number, height: number) => {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(size.width, size.height);
      },
      { width, height },
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
  };

  await setWindowSize(1003, 526);
  const contextTrigger = page.getByTestId("workspace-role-trigger");
  const longChatSession = page.locator(
    '[data-testid="session-item"][data-session-id="e2e-chat-controls"]',
  );
  const shortChatSession = page.locator(
    '[data-testid="session-item"][data-session-id="e2e-chat-controls-short"]',
  );
  const freshSession = page.locator('[data-testid="session-item"][data-session-id="e2e-fresh"]');
  const bottomMessage = page.getByText("Current bottom message 59");
  const selectLegacySession = async (session: typeof longChatSession) => {
    await freshSession.focus();
    await freshSession.press("Enter");
    await expect(freshSession).toHaveAttribute("data-active", "true");
    await session.focus();
    await session.press("Enter");
    await expect(session).toHaveAttribute("data-active", "true");
  };
  await selectLegacySession(shortChatSession);
  await expect(page.getByText("A source-less legacy answer")).toBeVisible();
  await expect(contextTrigger).toBeVisible();
  await expect(contextTrigger).toBeEnabled();
  await expect(contextTrigger).toContainText("No workspace · Default");
  await expect(page.getByTestId("timeline-filter-trigger")).toBeVisible();
  await capture("01-legacy-short-context-filter.png");

  const selectLongChat = async () => {
    await selectLegacySession(longChatSession);
  };
  await selectLongChat();
  await expect(bottomMessage).toBeVisible();
  const messagesContainer = page.getByTestId("messages-container");
  await messagesContainer.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const filterTrigger = page.getByTestId("timeline-filter-trigger");
  await expect(filterTrigger).toBeVisible();
  await expect(messagesContainer.locator('[data-testid="timeline-filter-trigger"]')).toHaveCount(0);
  await capture("02-legacy-long-bottom-filter.png");

  await filterTrigger.click();
  const filterPopover = page.getByTestId("timeline-filter-popover");
  await expect(filterPopover).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "You" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Assistant" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Goals" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Runtime" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "System" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Named agent or reviewer" })).toBeVisible();
  await expect(page.locator("#timeline-filter-from")).toBeVisible();
  await expect(page.locator("#timeline-filter-to")).toBeVisible();
  await capture("03-legacy-open-participant-agent-time-filters.png");

  for (const label of ["Assistant", "You", "Goals", "Runtime", "System"]) {
    // eslint-disable-next-line no-await-in-loop -- each controlled checkbox must settle before the next click
    await page.getByRole("checkbox", { name: label }).click();
  }
  await page.getByRole("combobox", { name: "Named agent or reviewer" }).click();
  await page.getByRole("option", { name: "Accessibility reviewer" }).click();
  await filterTrigger.click();
  await expect(filterPopover).toBeHidden();
  await expect(page.getByRole("button", { name: "Filter timeline, 2 active" })).toBeVisible();
  await expect(page.getByText("The persistent controls are reachable.")).toBeVisible();
  await capture("04-legacy-active-filter-badge.png");
  await page.reload();
  await page.locator("nav[aria-label='Main navigation']").waitFor();
  await selectLongChat();
  await expect(page.getByRole("button", { name: "Filter timeline, 2 active" })).toBeVisible();
  await expect(page.getByText("The persistent controls are reachable.")).toBeVisible();
  await expect(contextTrigger).toContainText("No workspace · Default");
  await capture("05-legacy-long-restart-restored.png");

  await page.getByRole("button", { name: "Filter timeline, 2 active" }).click();
  await page.locator("#timeline-filter-from").fill("2099-01-01T00:00");
  await filterTrigger.click();
  await expect(filterPopover).toBeHidden();
  await expect(page.getByText("No timeline entries match these filters.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Filter timeline, 3 active" })).toBeVisible();
  await capture("06-filtered-zero-results.png");

  await page.getByRole("button", { name: "Clear timeline filters" }).click();
  await setWindowSize(900, 900);
  await chatInput(page).fill(
    "A deliberately long draft that wraps across the narrow composer while both compact controls remain visible and reachable.",
  );
  await expect(page.getByTestId("workspace-role-trigger")).toBeVisible();
  await expect(page.getByTestId("timeline-filter-trigger")).toBeVisible();
  await capture("07-narrow-layout-long-draft.png");

  await page.getByTestId("new-chat-btn").click();
  await expect(page.getByTestId("welcome-state")).toBeVisible();
  await expect(page.getByTestId("workspace-role-trigger")).toContainText("No workspace · Default");
  await capture("08-fresh-empty-context.png");
});
