/**
 * E2E smoke test for the ErrorBoundary crash flow.
 *
 * Uses `window.__triggerCrash()` (registered by CrashTrigger in non-release builds)
 * to force a React render error. Verifies fallback UI, button states, and email draft.
 */
import { sharedTest as test, expect } from "./marshal-fixtures";

test("error boundary crash flow — fallback UI renders and email drafts on click — Marshal flow", async ({
  page,
}) => {
  await page.locator("header").waitFor();
  await page.locator('[data-testid="messages-container"]').waitFor();

  // Assert the hook exists before calling it (avoids silent no-op timeout)
  await expect
    .poll(() =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- E2E test hook
      page.evaluate(() => typeof (window as unknown as Record<string, unknown>).__triggerCrash),
    )
    .toBe("function");

  // Trigger crash
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- E2E test hook
    (window as unknown as Record<string, () => void>).__triggerCrash();
  });

  // Fallback UI
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible({
    timeout: 5000,
  });
  await expect(page.getByText(/The app hit a problem/)).toBeVisible();

  // Both buttons visible and enabled
  const tryAgainBtn = page.getByRole("button", { name: "Try again" });
  const reportBtn = page.getByRole("button", { name: "Email crash report" });
  await expect(tryAgainBtn).toBeVisible();
  await expect(tryAgainBtn).toBeEnabled();
  await expect(reportBtn).toBeVisible();
  await expect(reportBtn).toBeEnabled();

  // Email crash report → email drafted
  await reportBtn.click();
  await expect(page.getByRole("button", { name: "Email draft opened" })).toBeVisible({
    timeout: 5000,
  });
  await expect(page.getByText("An email draft has been opened")).toBeVisible();
});
