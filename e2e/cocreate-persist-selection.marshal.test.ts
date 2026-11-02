import fs from "fs";
import path from "path";

import { E2E_DATA_DIR } from "../electron/mock-mode";
import { sharedTest as test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";

const WORKSPACE_DIR = path.join(E2E_DATA_DIR, "workspace", "Scratchpad");

test.describe("CoCreate selected-file persistence", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "persist-me.md"), "# Hello\n");
    // Wait for app to be ready
    await chatInput(page).waitFor({ timeout: 10_000 });
    // Navigate to Workspaces
    const navButton = page.getByRole("button", { name: "Workspaces" });
    await navButton.waitFor({ timeout: 10_000 });
    await navButton.click();
  });

  test("restores selected file after navigating away and back", async ({ page }) => {
    // Select a file
    const fileLink = page.getByText("persist-me.md");
    await fileLink.waitFor({ timeout: 10_000 });
    await fileLink.click();
    await expect(page.getByTestId("file-preview-root")).toBeVisible({ timeout: 5000 });

    // Navigate away via Back button and return
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByTestId("file-preview-root")).toBeHidden();
    const navButton = page.getByRole("button", { name: "Workspaces" });
    await navButton.waitFor({ timeout: 10_000 });
    await navButton.click();

    // Same file should be restored without re-clicking
    await expect(page.getByTestId("file-preview-root")).toBeVisible({ timeout: 5000 });
  });
});
