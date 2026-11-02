import { sharedTest as test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";

test("data-theme is set before app fully loads", async ({ app }) => {
  // Regression guard: marshal-theme-init.js must set data-theme="dark"|"light" synchronously
  // so Tailwind CSS variables resolve correctly on the first frame.
  const window = await app.firstWindow();
  const theme = await window.evaluate(() => document.documentElement.getAttribute("data-theme"));
  expect(theme).toMatch(/^(dark|light)$/);
});

test("data-theme-mode preserves system setting across boot", async ({ app }) => {
  // Regression guard: the boot sequence must set data-theme-mode="system" so
  // vibrancy CSS selectors match. The unit test in theme.test.ts covers the
  // localStorage round-trip; this test verifies the full Electron boot path.
  const window = await app.firstWindow();
  const themeMode = await window.evaluate(() =>
    document.documentElement.getAttribute("data-theme-mode"),
  );
  expect(themeMode).toBe("system");

  // localStorage must also have "system", not a resolved "light"/"dark"
  const cached = await window.evaluate(() => localStorage.getItem("theme-mode"));
  expect(cached).toBe("system");
});

test("macOS vibrancy attribute is set when theme is system", async ({ app }) => {
  // Regression guard: applyTheme must set data-vibrancy on <html> when the
  // platform is apple and theme-mode is system. This is the single gate that
  // all vibrancy CSS selectors depend on.
  const window = await app.firstWindow();
  const platform = await window.evaluate(() =>
    document.documentElement.getAttribute("data-platform"),
  );
  const hasVibrancy = await window.evaluate(() =>
    document.documentElement.hasAttribute("data-vibrancy"),
  );
  // On macOS vibrancy should be active; on other platforms it should not
  expect(hasVibrancy).toBe(platform === "apple");
});

test("app renders main UI", async ({ page }) => {
  await expect(page.locator('[data-testid="consent-screen"]')).toHaveCount(0);
  await expect(page.locator("header")).toBeVisible();
  await expect(page.locator('[data-testid="messages-container"]')).toBeVisible();
  await expect(chatInput(page)).toBeVisible();
});

test("welcome state renders greeting", async ({ page }) => {
  await expect(page.locator('[data-testid="welcome-state"]')).toBeVisible();
  await expect(page.locator('[data-testid="welcome-greeting"]')).toBeVisible();
});

test("no critical console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      const isExpected =
        text.includes("auth") ||
        text.includes("token") ||
        text.includes("ECONNREFUSED") ||
        text.includes("net::") ||
        text.includes("Copilot") ||
        // Radix UI components (ScrollArea, Label, Switch) inject inline style attributes
        // that are blocked by style-src 'self' on Windows. The app still functions correctly.
        text.includes("Content Security Policy");
      if (!isExpected) errors.push(text);
    }
  });
  // Wait for app to be fully loaded and any async errors to surface
  await page.locator("header").waitFor();
  await page.locator('[data-testid="messages-container"]').waitFor();
  expect(errors).toHaveLength(0);
});

test("takes screenshot", async ({ page }) => {
  const screenshot = await page.screenshot({ path: "test-screenshots/e2e-smoke.png" });
  expect(screenshot.byteLength).toBeGreaterThan(0);
});
