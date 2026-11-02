import fs from "fs";
import os from "os";
import path from "path";

import { sharedTest as test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";

test.describe("chat attachments — non-image upload under sandbox: true — Marshal flow", () => {
  let tempFilePath: string;

  test.beforeEach(async ({ page }) => {
    // Real temp file — setInputFiles + webUtils.getPathForFile resolves its absolute path.
    tempFilePath = path.join(os.tmpdir(), `e2e-report-${Date.now()}.pdf`);
    fs.writeFileSync(tempFilePath, "hello from e2e");

    await chatInput(page).waitFor();
  });

  test.afterEach(() => {
    fs.rmSync(tempFilePath, { force: true });
  });

  test("renders the attached file name on the sent message", async ({ page }) => {
    // ChatPanel.onMutate builds `fileNames` as `files.filter(f => f.path).map(f => f.name)`.
    // Pre-fix: f.path is "" (sandbox drops legacy File.path), so the filter removes it
    // and the user message renders with no file badge. Post-fix: workspaceAPI.getPathForFile
    // returns the real OS path, the badge renders with the file name.
    const fileName = path.basename(tempFilePath);

    // Drive the hidden file input — exercises addFileFromFile → workspaceAPI.getPathForFile.
    await page.getByTestId("chat-file-input").setInputFiles(tempFilePath);

    // Pill in the composer confirms addFileFromFile ran. The list renders both a hidden
    // measure-row and a visible-row for overflow handling, so scope to the visible copy.
    await expect(page.getByTestId("visible-row").getByText(fileName)).toBeVisible();

    const textarea = chatInput(page);
    await textarea.fill("what's in this file?");
    await textarea.press("Enter");

    // The user message must carry the file badge — proves the attachment survived the send
    // path and was not silently dropped by the `else if (f.path)` guard in sendMutation.
    const userMessage = page.locator('[data-testid="message-user"]').last();
    await expect(userMessage).toBeVisible();
    await expect(userMessage.getByText(fileName)).toBeVisible();
  });
});
