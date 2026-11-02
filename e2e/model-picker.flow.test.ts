import type { Page } from "@playwright/test";

import { test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";
import { openMoreMenuItem } from "./helpers/marshal-nav";

/** Open the options popover and wait for the model picker menu to render. */
async function openModelPicker(page: Page) {
  await page.getByTestId("options-popover").click();
  await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 5000 });
  // Wait for at least one radio item — proves React Query data has resolved
  await page.getByRole("menuitemradio").first().waitFor({ timeout: 5000 });
}

test.describe("model picker — Marshal flow", () => {
  test.beforeEach(async ({ page }) => {
    await chatInput(page).waitFor();
  });

  test("keeps the previous featured models visible while leaving the default on GPT-5.5", async ({
    page,
  }) => {
    await openModelPicker(page);

    await expect(page.getByRole("menuitemradio", { name: /GPT-5\.5/ })).toHaveAttribute(
      "data-state",
      "checked",
      { timeout: 5000 },
    );
    await expect(page.getByRole("menuitemradio", { name: /Claude Opus 4\.7/ })).toBeVisible();
  });

  test("selecting a model updates the display and persists after reopening", async ({ page }) => {
    await openModelPicker(page);

    // Select a different model (Claude Sonnet 4.6 instead of default Opus)
    await page.getByRole("menuitemradio", { name: /Claude Sonnet 4\.6/ }).click();

    // Wait for popover close animation, then reopen and verify
    await page.waitForTimeout(2000); // eslint-disable-line playwright/no-wait-for-timeout

    await openModelPicker(page);
    const sonnetItem = page.getByRole("menuitemradio", { name: /Claude Sonnet 4\.6/ });
    await expect(sonnetItem).toHaveAttribute("data-state", "checked", { timeout: 5000 });
  });

  test("can change model multiple times without reverting", async ({ page }) => {
    // Change to Sonnet
    await openModelPicker(page);
    await page.getByRole("menuitemradio", { name: /Claude Sonnet 4\.6/ }).click();

    // Change to GPT-5.4 — wait for popover close animation first
    await page.waitForTimeout(500); // eslint-disable-line playwright/no-wait-for-timeout
    await openModelPicker(page);
    await page.getByRole("menuitemradio", { name: /GPT-5\.4/ }).click();

    await page.waitForTimeout(1000); // eslint-disable-line playwright/no-wait-for-timeout

    // Verify: reopen and check GPT-5.4 is selected
    await openModelPicker(page);
    const gpt54Check = page.getByRole("menuitemradio", { name: /GPT-5\.4/ });
    await expect(gpt54Check).toHaveAttribute("data-state", "checked", { timeout: 5000 });
  });

  test("per-session model does not affect default for new sessions", async ({ page }) => {
    // TODO: flaky on macOS CI — model selection doesn't persist reliably after sending
    // a message. Needs investigation with macOS hardware access. Passes on Windows CI.
    test.fixme(
      process.platform === "darwin",
      "macOS: model selection persistence is unreliable in CI",
    );
    const textarea = chatInput(page);

    // Session A: change model to Sonnet
    await openModelPicker(page);
    await page.getByRole("menuitemradio", { name: /Claude Sonnet 4\.6/ }).click();
    await expect(page.getByTestId("model-picker")).not.toBeVisible({ timeout: 3000 });

    // Send a message (locks the model)
    await textarea.fill("Hello from session A");
    await textarea.press("Enter");
    await expect(page.locator('[data-testid="message-user"]').first()).toBeVisible();

    // Verify Sonnet is still selected (reopen dropdown)
    await openModelPicker(page);
    await expect(page.getByRole("menuitemradio", { name: /Claude Sonnet 4\.6/ })).toHaveAttribute(
      "data-state",
      "checked",
      { timeout: 5000 },
    );
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("model-picker")).not.toBeVisible({ timeout: 3000 });

    // Create session B — should show default model (GPT-5.5, not Sonnet)
    await page.locator('[data-testid="new-chat-btn"]').click();
    await chatInput(page).waitFor();

    await openModelPicker(page);
    await expect(page.getByRole("menuitemradio", { name: /GPT-5\.5/ })).toHaveAttribute(
      "data-state",
      "checked",
      { timeout: 5000 },
    );
    await expect(
      page.getByRole("menuitemradio", { name: /Claude Sonnet 4\.6/ }),
    ).not.toHaveAttribute("data-state", "checked");
    await page.keyboard.press("Escape");

    // Switch back to session A — Sonnet should still be selected
    const sessionA = page.locator('[data-testid="session-item"]').nth(1);
    await sessionA.click();
    await chatInput(page).waitFor({ timeout: 5000 });

    // Retry the open+check cycle — React Query may still be refetching model data
    await expect(async () => {
      await openModelPicker(page);
      await expect(page.getByRole("menuitemradio", { name: /Claude Sonnet 4\.6/ })).toHaveAttribute(
        "data-state",
        "checked",
      );
    }).toPass({ timeout: 10_000 });
  });

  test("changing default model in settings affects new sessions", async ({ page }) => {
    // Open settings via the More menu
    await (await openMoreMenuItem(page, /Settings/)).click();
    await expect(page.getByText("Default model")).toBeVisible();

    // Change default model to Claude Sonnet 4.6 (shadcn Select — click trigger, then option)
    const selectTrigger = page.getByTestId("default-model-select");
    await selectTrigger.click();
    await page.getByRole("option", { name: /Sonnet 4\.6/i }).click();

    // Dismiss any open overlay; panel close button removed — clicking New chat
    // both navigates back to the chat view and creates the new session for the
    // default-model assertion below.
    await page.keyboard.press("Escape");
    await page.locator('[data-testid="new-chat-btn"]').click();
    await chatInput(page).waitFor();

    // Open model dropdown and verify Sonnet is now the default
    await openModelPicker(page);
    await expect(page.getByRole("menuitemradio", { name: /Claude Sonnet 4\.6/i })).toHaveAttribute(
      "data-state",
      "checked",
      { timeout: 5000 },
    );
  });
});
