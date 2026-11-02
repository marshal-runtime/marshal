import fs from "fs";
import path from "path";

import { chatInput } from "./helpers/marshal-chat-input";
import { test, expect } from "./marshal-fixtures";

test("renders the global notice rail across priority, progress, theme, and width states", async ({
  app,
  page,
}, testInfo) => {
  const evidenceDir =
    process.env.GLOBAL_NOTICE_EVIDENCE_DIR ?? testInfo.outputPath("global-notice-rail-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });

  const capture = async (name: string) => {
    await page.screenshot({ path: path.join(evidenceDir, name), fullPage: false });
  };
  const setWindowSize = async (width: number, height: number) => {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
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
  const setTheme = async (theme: "light" | "dark") => {
    await page.evaluate((nextTheme) => {
      document.documentElement.setAttribute("data-theme", nextTheme);
    }, theme);
  };
  const raiseAuthError = async () => {
    await app.evaluate(({ BrowserWindow }) => {
      const webContents = BrowserWindow.getAllWindows()[0]?.webContents;
      webContents?.send("copilot:authError", "HTTP 401 Unauthorized");
      webContents?.send("runtimeAuth:authError", "HTTP 401 Unauthorized");
    });
  };
  await chatInput(page).waitFor();
  await setWindowSize(1180, 760);
  await setTheme("light");

  const rail = page.locator("[data-app-notice-rail]");
  await raiseAuthError();
  await expect(rail).toHaveCount(1);
  await expect(page.getByText("Copilot sign-in expired", { exact: true })).toBeVisible();
  await expect(rail).toHaveAttribute("data-primary-notice", "auth:copilot");
  await capture("01-critical-auth-light.png");

  await setTheme("dark");
  await capture("02-critical-auth-dark-wide.png");

  await setWindowSize(520, 720);
  const hideSidebar = page.getByTitle("Hide sidebar");
  await expect(hideSidebar).toBeVisible();
  await hideSidebar.click();
  const compactNav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(compactNav).toBeVisible();
  await expect(compactNav).toHaveClass(/w-14/);
  await expect(page.getByText("Copilot sign-in expired", { exact: true })).toHaveCount(1);
  await capture("03-narrow-520-dark.png");

  await setWindowSize(1180, 760);
  await setTheme("light");
  const showSidebar = page.getByTitle("Show sidebar");
  await expect(showSidebar).toBeVisible();
  await showSidebar.click();
});
