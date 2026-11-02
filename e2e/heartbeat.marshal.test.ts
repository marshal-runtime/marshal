import { chatInput } from "./helpers/marshal-chat-input";
import { openMoreMenuItem } from "./helpers/marshal-nav";
import { test, expect } from "./marshal-fixtures";

test.describe("heartbeat panel", () => {
  test.beforeEach(async ({ page }) => {
    await chatInput(page).waitFor();
    const nav = page.locator("nav[aria-label='Main navigation']");
    await nav.waitFor();
    await (await openMoreMenuItem(page, /Heartbeat/)).click();
    await page.getByText("Heartbeat").first().waitFor();
  });

  test("can enable and disable heartbeat", async ({ page }) => {
    const enableBtn = page.getByRole("button", { name: "Enable" });
    const disableBtn = page.getByRole("button", { name: "Disable" });
    const promptInput = page.getByPlaceholder("e.g. Check my inbox");

    // Wait for the prompt input AND Enable button to render — without this,
    // a race with the React Query first response can return count=0 below
    // and skip the fill block, leaving the prompt empty (Enable stays
    // disabled forever). Fresh-seed E2E always starts with heartbeat
    // disabled + empty prompt, so Enable must be present.
    await expect(promptInput).toBeVisible();
    await expect(enableBtn).toBeVisible();

    // Fill the prompt so Enable becomes enabled.
    await promptInput.click();
    await promptInput.fill("Check inbox");
    await page.getByRole("button", { name: "Save" }).click();

    // Wait for Enable to become active after Save (query invalidation + re-render)
    await expect(enableBtn).toBeEnabled();
    await enableBtn.click();
    await expect(page.getByText("Active", { exact: true })).toBeVisible();

    // Disable
    await disableBtn.click();
    await expect(page.getByText("Inactive", { exact: true })).toBeVisible();

    // Re-enable
    await enableBtn.click();
    await expect(page.getByText("Active", { exact: true })).toBeVisible();
  });

  test("edit prompt and save", async ({ page }) => {
    const promptInput = page.getByPlaceholder("e.g. Check my inbox");
    await promptInput.click();
    await promptInput.clear();
    await promptInput.type("Check for urgent messages from my team");

    const saveBtn = page.getByRole("button", { name: "Save" });
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();
    await expect(saveBtn).toBeHidden();
  });

  test("Run Now — full flow with running state, logs, and urgent result", async ({ page }) => {
    // Configure a prompt (fresh install has none)
    const promptInput = page.getByPlaceholder("e.g. Check my inbox");
    await promptInput.click();
    await promptInput.clear();
    await promptInput.type("Check my messages for anything urgent");
    await page.getByRole("button", { name: "Save" }).click();

    // Recent Activity is always visible (no expand needed)

    // Run
    await page.getByRole("button", { name: "Run now" }).click();

    // Button should show running state
    await expect(page.getByText("Running")).toBeVisible();

    // Start log should appear while running
    await expect(page.getByText("Starting heartbeat check")).toBeVisible();

    // Wait for completion
    await expect(page.getByText("Heartbeat check complete")).toBeVisible({ timeout: 30_000 });

    // Button returns to normal
    await expect(page.getByRole("button", { name: "Run now" })).toBeVisible();

    // Log entries should be visible (run 1 produces HEARTBEAT_URGENT)
    await expect(page.getByText("Manager needs response")).toBeVisible();

    // Verify log entries exist in Recent Activity
    const entries = page.getByTestId("log-entry");
    const count = await entries.count();
    expect(count).toBeGreaterThan(0);
  });

  test("shows link to power management settings when heartbeat is enabled", async ({ page }) => {
    await page.evaluate(async () => {
      const appWindow = window as Window & {
        heartbeatAPI?: {
          saveSettings: (updates: Record<string, unknown>) => Promise<unknown>;
          toggle: (enable: boolean) => Promise<unknown>;
        };
      };
      await appWindow.heartbeatAPI?.saveSettings({ prompt: "Check inbox" });
      await appWindow.heartbeatAPI?.toggle(true);
    });

    await page.reload();
    await page.locator("nav[aria-label='Main navigation']").waitFor();
    await (await openMoreMenuItem(page, /Heartbeat/)).click();
    await page.getByText("Heartbeat").first().waitFor();

    await expect(page.getByText(/Settings → Power Management/)).toBeVisible();
  });

  test("power management toggles persist in Settings", async ({ page }) => {
    // Navigate to Settings via the nav bar (not the inline link)
    const nav = page.locator("nav[aria-label='Main navigation']");
    await nav.waitFor();
    await (await openMoreMenuItem(page, /Settings/)).click();
    await page.getByText("Power management").first().waitFor();

    // Existing feature-scoped switches default to checked; always-on defaults off.
    const preventSleepSwitch = page.locator("#prevent-sleep-switch");
    await expect(preventSleepSwitch).toBeVisible();
    await expect(preventSleepSwitch).toHaveAttribute("data-state", "checked");

    const alwaysKeepAwakeSwitch = page.locator("#always-keep-awake-switch");
    await expect(alwaysKeepAwakeSwitch).toBeVisible();
    await expect(alwaysKeepAwakeSwitch).toHaveAttribute("data-state", "unchecked");

    // Toggle prevent-sleep off and verify persistence
    await preventSleepSwitch.click();
    await expect(preventSleepSwitch).toHaveAttribute("data-state", "unchecked");

    await page.reload();
    const navAfterReload = page.locator("nav[aria-label='Main navigation']");
    await navAfterReload.waitFor();
    await (await openMoreMenuItem(page, /Settings/)).click();
    await page.getByText("Power management").first().waitFor();

    await expect(page.locator("#prevent-sleep-switch")).toHaveAttribute("data-state", "unchecked");
    await expect(page.locator("#always-keep-awake-switch")).toHaveAttribute(
      "data-state",
      "unchecked",
    );
  });
});
