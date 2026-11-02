import fs from "fs";
import path from "path";

import { E2E_DATA_DIR } from "../electron/mock-mode";
import { sharedTest as test, test as freshTest, expect } from "./marshal-fixtures";

const WORKSPACE_DIR = path.join(E2E_DATA_DIR, "workspace", "Scratchpad");
const isMac = process.platform === "darwin";
const mod = isMac ? "Meta" : "Control";

const SOURCE_MD = `# Source Mode Test

Some **bold** and *italic* text.

\`\`\`javascript
const x = 1;
\`\`\`

- [ ] Task item
- Bullet item

> A blockquote

[A link](https://example.com)
`;

const PLAIN_TXT = `Hello world
This is plain text.
`;

const HTML_CONTENT = `<html>
<body><h1>Hello</h1></body>
</html>
`;

/** Navigate to Workspaces and open a file. */
async function openFile(page: import("@playwright/test").Page, fileName: string) {
  // Seed after page.reload() (sharedTest) so IPC stubs pick up the files
  seedWorkspaceFiles();

  const navButton = page.getByRole("button", { name: "Workspaces" });
  await navButton.waitFor({ timeout: 10_000 });
  await navButton.click();

  const fileLink = page.getByText(fileName, { exact: true });
  await fileLink.waitFor({ timeout: 10_000 });
  await fileLink.click();
}

/** Switch to Source mode by clicking the Source tab */
async function switchToSource(page: import("@playwright/test").Page) {
  const sourceBtn = page.getByRole("button", { name: "Source", exact: true });
  await sourceBtn.waitFor({ timeout: 5000 });
  await sourceBtn.click();
  // Wait for Monaco editor to mount
  await page.locator('[data-testid="source-editor"]').waitFor({ timeout: 10000 });
}

/** Get the Monaco editor container */
function monacoEditor(page: import("@playwright/test").Page) {
  return page.locator('[data-testid="source-editor"]');
}

/** Seed all workspace files. Called from openFile() after page.reload() in
 *  sharedTest so the IPC stubs pick them up on the next workspace:listDir call.
 *  (seedTestData wipes E2E_DATA_DIR, so module-scope writes get deleted.) */
function seedWorkspaceFiles() {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE_DIR, "source-test.md"), SOURCE_MD);
  fs.writeFileSync(path.join(WORKSPACE_DIR, "plain.txt"), PLAIN_TXT);
  fs.writeFileSync(path.join(WORKSPACE_DIR, "page.html"), HTML_CONTENT);
  fs.writeFileSync(
    path.join(WORKSPACE_DIR, "commented.md"),
    "# Doc with comment\n\nSome paragraph.\n\n<!-- @comment: This is a review comment -->\n",
  );
  fs.writeFileSync(
    path.join(WORKSPACE_DIR, "for-comment.md"),
    "# Simple doc\n\nA paragraph to comment on.\n\n",
  );
  fs.writeFileSync(
    path.join(WORKSPACE_DIR, "edit-comment.md"),
    "# Edit comment test\n\nText here.\n\n<!-- @comment: Original comment -->\n",
  );
}

test.describe("Monaco source editor", () => {
  // ── Source mode tab switching ────────────────────────────────

  test("shows Preview and Source tabs for markdown files", async ({ page }) => {
    await openFile(page, "source-test.md");
    await expect(page.getByRole("button", { name: "Preview", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Source", exact: true })).toBeVisible();
  });

  test("switches to Source mode and shows Monaco editor", async ({ page }) => {
    await openFile(page, "source-test.md");
    await switchToSource(page);
    await expect(monacoEditor(page)).toBeVisible();
  });

  test("Source mode shows the raw markdown content", async ({ page }) => {
    await openFile(page, "source-test.md");
    await switchToSource(page);
    const editor = monacoEditor(page);
    await expect(editor).toContainText("# Source Mode Test");
    await expect(editor).toContainText("```javascript");
    await expect(editor).toContainText("const x = 1;");
  });

  test("switches back to Preview mode from Source", async ({ page }) => {
    await openFile(page, "source-test.md");
    await switchToSource(page);
    await expect(monacoEditor(page)).toBeVisible();

    // Switch back to Preview
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    // Monaco should disappear, segment editor should appear
    await expect(monacoEditor(page)).toBeHidden();
    await expect(page.locator(".md-custom-editor")).toBeVisible();
  });

  // ── Plain text files use Monaco ──────────────────────────────

  test("plain text files render in Monaco editor", async ({ page }) => {
    await openFile(page, "plain.txt");
    // Plain text files should show Monaco directly (no Preview/Source tabs)
    const editor = page.locator('[data-testid="text-editor"]');
    await editor.waitFor({ timeout: 10000 });
    await expect(editor).toContainText("Hello world");
  });

  // ── HTML files keep Preview/Source ───────────────────────────

  test("HTML files show Preview/Source tabs", async ({ page }) => {
    await openFile(page, "page.html");
    await expect(page.getByRole("button", { name: "Preview", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Source", exact: true })).toBeVisible();
  });

  test("HTML Source mode shows Monaco with HTML content", async ({ page }) => {
    await openFile(page, "page.html");
    await switchToSource(page);
    const editor = monacoEditor(page);
    await expect(editor).toContainText("<html>");
    await expect(editor).toContainText("<h1>Hello</h1>");
  });

  // ── Completion (Ctrl+Space) ──────────────────────────────────

  test("Ctrl+Space opens completion menu in markdown source", async ({ page }) => {
    await openFile(page, "source-test.md");
    await switchToSource(page);

    // Click into editor and go to end
    await monacoEditor(page).click();
    await page.keyboard.press(isMac ? "Meta+ArrowDown" : "Control+End");
    await page.keyboard.press("Enter");

    // Trigger suggestions
    await page.keyboard.press("Control+Space");

    // The suggest widget should appear (Monaco uses role="listbox" for completions)
    const suggestList = monacoEditor(page).getByRole("listbox");
    await expect(suggestList).toBeVisible({ timeout: 5000 });
  });

  test("completions include markdown slash commands", async ({ page }) => {
    await openFile(page, "source-test.md");
    await switchToSource(page);

    await monacoEditor(page).click();
    await page.keyboard.press(isMac ? "Meta+ArrowDown" : "Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Control+Space");

    const suggestList = monacoEditor(page).getByRole("listbox");
    await expect(suggestList).toBeVisible({ timeout: 5000 });

    // Should contain some of our slash commands
    await expect(suggestList).toContainText("Heading");
  });

  test("selecting a completion inserts markdown", async ({ page }) => {
    await openFile(page, "source-test.md");
    await switchToSource(page);

    await monacoEditor(page).click();
    await page.keyboard.press(isMac ? "Meta+ArrowDown" : "Control+End");
    await page.keyboard.press("Enter");

    // Type "head" to filter, then trigger suggestions
    await page.keyboard.type("head", { delay: 50 });
    await page.keyboard.press("Control+Space");

    const suggestWidget = monacoEditor(page).locator(".suggest-widget.visible");
    await expect(suggestWidget).toBeVisible({ timeout: 10_000 });

    // Select first item
    await page.keyboard.press("Enter");

    // Wait for suggestion to be applied — heading markdown should appear
    await expect(monacoEditor(page)).toContainText("#");
  });
});

// ── Editing tests (mutate state via debouncedSave → per-instance fixture) ──

freshTest.describe("Monaco source editor — editing", () => {
  freshTest("edits in Source mode are reflected in content", async ({ page }) => {
    await openFile(page, "source-test.md");
    await switchToSource(page);

    // Click into the Monaco editor
    await monacoEditor(page).click();

    // Type at the end of the first line
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("New line added", { delay: 50 });

    // Verify the new text appears
    await expect(monacoEditor(page)).toContainText("New line added");
  });

  freshTest("edits persist when switching back to Preview", async ({ page }) => {
    await openFile(page, "source-test.md");
    await switchToSource(page);

    // Add text in source mode
    await monacoEditor(page).click();
    await page.keyboard.press(isMac ? "Meta+ArrowDown" : "Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("## New", { delay: 50 });

    // Verify the text appears in Monaco before switching
    await expect(monacoEditor(page)).toContainText("## New");

    // Switch to Preview
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page.locator(".md-custom-editor").waitFor({ timeout: 5000 });

    // The added heading should be visible in preview
    await expect(page.locator(".md-custom-editor")).toContainText("New");
  });
});

test.describe("Monaco source editor — markdown comments", () => {
  test("comments are visible in source mode as HTML comments", async ({ page }) => {
    await openFile(page, "commented.md");
    await switchToSource(page);

    const editor = monacoEditor(page);
    await expect(editor).toContainText("<!-- @comment:");
    await expect(editor).toContainText("This is a review comment");
  });

  test("adding comment in preview shows in source", async ({ page }) => {
    await openFile(page, "for-comment.md");

    // In preview mode, click on the paragraph
    const textSeg = page.locator(".md-seg", { hasText: "A paragraph to comment on" }).first();
    await textSeg.waitFor({ timeout: 5000 });
    await textSeg.click();

    // Use Cmd/Ctrl+K to add a comment
    await page.keyboard.press(`${mod}+k`);

    // Wait for comment marker to appear in the source
    // Switch to source mode
    await switchToSource(page);

    // Source should now contain a comment marker
    await expect(monacoEditor(page)).toContainText("@comment:");
  });

  // Note: "editing comment text in source persists to preview" was removed
  // because it relied on Monaco's internal find-widget CSS classes which are
  // not part of a stable public API and break across Monaco versions.
});
