import fs from "fs";
import path from "path";

import { E2E_DATA_DIR } from "../electron/mock-mode";
import { test, expect } from "./marshal-fixtures";

const WORKSPACE_DIR = path.join(E2E_DATA_DIR, "workspace", "Scratchpad");

const PARTIAL_MD = `# Partial Selection Test

Hello world and hello world again.

- Bullet with bold text here
- Plain bullet item

**bold** and *italic* text

Last paragraph of content.`;

/** Wait for two animation frames to let React + rAF handlers settle */
async function waitForRaf(page: import("@playwright/test").Page) {
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

/** Navigate to Workspaces and open a file. */
async function openFile(page: import("@playwright/test").Page, fileName: string) {
  const navButton = page.getByRole("button", { name: "Workspaces" });
  await navButton.waitFor({ timeout: 5000 });
  await navButton.click();

  const fileLink = page.getByText(fileName);
  await fileLink.waitFor({ timeout: 5000 });
  await fileLink.click();
  await page.locator(".md-seg").first().waitFor({ timeout: 5000 });

  // Wait for editor DOM to stabilize (file watcher debounce)
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const editor = document.querySelector(".md-custom-editor");
        if (!editor) {
          resolve(true);
          return;
        }
        let timer: ReturnType<typeof setTimeout> = setTimeout(() => {
          observer.disconnect();
          resolve(true);
        }, 800);
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            observer.disconnect();
            resolve(true);
          }, 800);
        });
        observer.observe(editor, { childList: true, subtree: true, characterData: true });
      }),
    undefined,
    { timeout: 10_000 },
  );
}

/**
 * Programmatically create a partial text selection within a rendered segment.
 * Finds the text node containing `text` inside the segment at `segIndex`,
 * then selects the substring from `startOffset` to `endOffset` within that node.
 */
async function selectTextInSegment(
  page: import("@playwright/test").Page,
  segIndex: number,
  text: string,
  startOffset?: number,
  endOffset?: number,
): Promise<boolean> {
  return page.evaluate(
    ({ segIndex: si, text: t, startOffset: so, endOffset: eo }) => {
      const editor = document.querySelector(".md-custom-editor");
      if (!editor) return false;
      const segEls = editor.querySelectorAll(".md-seg");
      const segEl = segEls[si];
      if (!segEl) return false;
      const rendered = segEl.querySelector(".md-seg-rendered") || segEl;

      // Walk text nodes to find one containing the target text
      const walker = document.createTreeWalker(rendered, NodeFilter.SHOW_TEXT);
      let nextNode = walker.nextNode();
      while (nextNode) {
        const idx = nextNode.textContent?.indexOf(t) ?? -1;
        if (idx >= 0) {
          const range = document.createRange();
          range.setStart(nextNode, so ?? idx);
          range.setEnd(nextNode, eo ?? idx + t.length);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(range);
          return true;
        }
        nextNode = walker.nextNode();
      }
      return false;
    },
    { segIndex, text, startOffset, endOffset },
  );
}

/** Read the current raw markdown content of the file from the textarea or the saved file */
async function getSegmentText(
  page: import("@playwright/test").Page,
  segIndex: number,
): Promise<string> {
  return page.evaluate((si) => {
    const editor = document.querySelector(".md-custom-editor");
    if (!editor) return "";
    const segEls = editor.querySelectorAll(".md-seg");
    const segEl = segEls[si];
    if (!segEl) return "";
    // If in edit mode, read from textarea; otherwise read rendered text
    const textarea = segEl.querySelector("textarea");
    if (textarea) return textarea.value;
    const rendered = segEl.querySelector(".md-seg-rendered") || segEl;
    return rendered.textContent || "";
  }, segIndex);
}

/**
 * E2E tests for partial-selection destructive operations using
 * the new AST offset-based editing infrastructure.
 *
 * These verify that when a user partially selects text within a rendered
 * markdown segment and presses a destructive key (Backspace, Delete, etc.),
 * only the selected text is affected — not the entire segment.
 */
test.describe("Partial selection edits", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "partial-test.md"), PARTIAL_MD);
    await openFile(page, "partial-test.md");
  });

  test.afterAll(() => {
    fs.rmSync(path.join(WORKSPACE_DIR, "partial-test.md"), { force: true });
  });

  test("partial Backspace removes only selected text", async ({ page }) => {
    // Segment 2 = "Hello world and hello world again."
    // Select "world" (first occurrence) in rendered mode
    const selected = await selectTextInSegment(page, 2, "world");
    expect(selected).toBe(true);

    await page.keyboard.press("Backspace");
    await waitForRaf(page);

    // Should enter edit mode with "world" removed
    await expect(page.locator(".md-seg-active")).toBeVisible({ timeout: 5000 });
    const text = await getSegmentText(page, 2);
    expect(text).toContain("Hello ");
    expect(text).toContain(" and hello world again.");
    // First "world" should be gone but second should remain
    expect(text.match(/world/g)?.length).toBe(1);
  });

  test("partial Delete removes only selected text", async ({ page }) => {
    // Select "again" from the paragraph
    const selected = await selectTextInSegment(page, 2, "again");
    expect(selected).toBe(true);

    await page.keyboard.press("Delete");
    await waitForRaf(page);

    await expect(page.locator(".md-seg-active")).toBeVisible({ timeout: 5000 });
    const text = await getSegmentText(page, 2);
    expect(text).not.toContain("again");
    expect(text).toContain("Hello world");
  });

  test("partial character typing replaces only selected text", async ({ page }) => {
    // Select "Hello" in rendered mode
    const selected = await selectTextInSegment(page, 2, "Hello");
    expect(selected).toBe(true);

    await page.keyboard.press("X");
    await waitForRaf(page);

    await expect(page.locator(".md-seg-active")).toBeVisible({ timeout: 5000 });
    const text = await getSegmentText(page, 2);
    expect(text).toMatch(/^X/);
    expect(text).toContain("world");
  });

  test("partial Ctrl+C copies only rendered selection, not full markdown", async ({ page }) => {
    // Select "Hello" in rendered mode
    const selected = await selectTextInSegment(page, 2, "Hello");
    expect(selected).toBe(true);

    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+c" : "Control+c");
    await waitForRaf(page);

    // Should NOT enter edit mode — copy is non-destructive
    await expect(page.locator(".md-seg-active")).not.toBeVisible({ timeout: 2000 });

    // Clipboard should have just "Hello", not the full segment markdown
    const clipText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipText).toBe("Hello");
  });

  test("partial Ctrl+X cuts selected text from segment", async ({ page }) => {
    // Select "and " from the paragraph
    const selected = await selectTextInSegment(page, 2, "and ");
    expect(selected).toBe(true);

    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+x" : "Control+x");
    await waitForRaf(page);

    // Should enter edit mode with "and " removed
    await expect(page.locator(".md-seg-active")).toBeVisible({ timeout: 5000 });
    const text = await getSegmentText(page, 2);
    expect(text).not.toContain("and ");

    // Clipboard should have the cut text
    const clipText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipText).toBe("and ");
  });

  test("partial Ctrl+V replaces selected text with clipboard", async ({ page }) => {
    // Pre-fill clipboard
    await page.evaluate(() => navigator.clipboard.writeText("PASTED"));

    // Select "Hello" in rendered mode
    const selected = await selectTextInSegment(page, 2, "Hello");
    expect(selected).toBe(true);

    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+v" : "Control+v");
    await waitForRaf(page);

    await expect(page.locator(".md-seg-active")).toBeVisible({ timeout: 5000 });
    const text = await getSegmentText(page, 2);
    expect(text).toContain("PASTED");
    expect(text).not.toMatch(/^Hello/);
  });

  test("full segment selection Backspace removes entire segment", async ({ page }) => {
    // Select ALL text within segment 2 (full selection, not partial)
    const selected = await page.evaluate(() => {
      const editor = document.querySelector(".md-custom-editor");
      if (!editor) return false;
      const segEls = editor.querySelectorAll(".md-seg");
      const segEl = segEls[2];
      if (!segEl) return false;
      const rendered = segEl.querySelector(".md-seg-rendered") || segEl;
      const range = document.createRange();
      range.selectNodeContents(rendered);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    });
    expect(selected).toBe(true);

    // Count segments before
    const beforeCount = await page.locator(".md-seg").count();

    await page.keyboard.press("Backspace");
    await waitForRaf(page);

    // Full segment selection should remove the segment (existing behavior)
    const afterCount = await page.locator(".md-seg").count();
    expect(afterCount).toBeLessThan(beforeCount);
  });

  test("Enter on partial selection replaces with newline", async ({ page }) => {
    // Select "and" from the paragraph
    const selected = await selectTextInSegment(page, 2, "and");
    expect(selected).toBe(true);

    await page.keyboard.press("Enter");
    await waitForRaf(page);

    // Should enter edit mode with "and" replaced by newline
    await expect(page.locator(".md-seg-active")).toBeVisible({ timeout: 5000 });
    const text = await getSegmentText(page, 2);
    expect(text).not.toContain("and");
    expect(text).toContain("\n");
  });

  // ── Context menu partial-selection tests ──
  // These exercise the captureContextInfo → contextInfoRef → handleContextCopy/Cut/Paste
  // pipeline, which is separate from the keyboard shortcut code path.

  /**
   * Right-click on a segment to open the custom context menu.
   * First creates a partial selection, then dispatches contextmenu on the segment.
   */
  async function openContextMenuOnPartialSelection(
    page: import("@playwright/test").Page,
    segIndex: number,
    text: string,
  ) {
    const selected = await selectTextInSegment(page, segIndex, text);
    expect(selected).toBe(true);

    // Right-click at the center of the selection so the browser preserves it.
    // A right-click outside the selected range clears the selection in Chromium.
    const selCenter = await page.evaluate(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return null;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    expect(selCenter).not.toBeNull();
    await page.mouse.click(selCenter!.x, selCenter!.y, { button: "right" });
    // Wait for custom context menu to appear
    await expect(page.locator("[role='menu'][aria-label='Text options']")).toBeVisible({
      timeout: 5000,
    });
  }

  test("context menu Copy copies only rendered selection", async ({ page }) => {
    await openContextMenuOnPartialSelection(page, 2, "Hello");

    // Click the Copy menu item
    await page.locator("[role='menuitem']").filter({ hasText: "Copy" }).click();
    await waitForRaf(page);

    // Should NOT enter edit mode — copy is non-destructive
    await expect(page.locator(".md-seg-active")).not.toBeVisible({ timeout: 2000 });

    // Clipboard should have just "Hello", not the full segment markdown
    const clipText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipText).toBe("Hello");
  });

  test("context menu Cut removes selected text", async ({ page }) => {
    await openContextMenuOnPartialSelection(page, 2, "and ");

    // Click the Cut menu item
    await page.locator("[role='menuitem']").filter({ hasText: "Cut" }).click();
    await waitForRaf(page);

    // Should enter edit mode with "and " removed
    await expect(page.locator(".md-seg-active")).toBeVisible({ timeout: 5000 });
    const text = await getSegmentText(page, 2);
    expect(text).not.toContain("and ");

    // Clipboard should have the cut text
    const clipText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipText).toBe("and ");
  });

  test("context menu Paste replaces selected text", async ({ page }) => {
    // Pre-fill clipboard
    await page.evaluate(() => navigator.clipboard.writeText("REPLACED"));

    await openContextMenuOnPartialSelection(page, 2, "Hello");

    // Click the Paste menu item
    await page.locator("[role='menuitem']").filter({ hasText: "Paste" }).click();
    await waitForRaf(page);

    await expect(page.locator(".md-seg-active")).toBeVisible({ timeout: 5000 });
    const text = await getSegmentText(page, 2);
    expect(text).toContain("REPLACED");
    expect(text).not.toMatch(/^Hello/);
  });

  test("context menu Cut on multi-segment selection removes all selected segments", async ({
    page,
  }) => {
    // Select across segments 4 and 5 (the two bullet list items)
    const selected = await page.evaluate(() => {
      const editor = document.querySelector(".md-custom-editor");
      if (!editor) return false;
      const segEls = editor.querySelectorAll(".md-seg");
      const startSeg = segEls[4];
      const endSeg = segEls[5];
      if (!startSeg || !endSeg) return false;
      const startRendered = startSeg.querySelector(".md-seg-rendered") || startSeg;
      const endRendered = endSeg.querySelector(".md-seg-rendered") || endSeg;

      // Walk text nodes to find matching content
      function findTextNode(root: Node, text: string) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          const idx = node.textContent?.indexOf(text) ?? -1;
          if (idx >= 0) return { node, idx };
          node = walker.nextNode();
        }
        return null;
      }
      const startMatch = findTextNode(startRendered, "Bullet");
      const endMatch = findTextNode(endRendered, "item");
      if (!startMatch || !endMatch) return false;

      const range = document.createRange();
      range.setStart(startMatch.node, startMatch.idx);
      range.setEnd(endMatch.node, endMatch.idx + "item".length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    });
    expect(selected).toBe(true);

    // Right-click at the center of the selection so the browser preserves it
    const selCenter = await page.evaluate(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return null;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    expect(selCenter).not.toBeNull();
    await page.mouse.click(selCenter!.x, selCenter!.y, { button: "right" });
    await expect(page.locator("[role='menu'][aria-label='Text options']")).toBeVisible({
      timeout: 5000,
    });

    const beforeCount = await page.locator(".md-seg").count();

    // Click Cut
    await page.locator("[role='menuitem']").filter({ hasText: "Cut" }).click();
    await waitForRaf(page);

    // Both bullet segments should be removed — segment count decreases
    const afterCount = await page.locator(".md-seg").count();
    expect(afterCount).toBeLessThan(beforeCount);

    // The rendered content should no longer contain the bullet text
    const editorText = await page.locator(".md-custom-editor").textContent();
    expect(editorText).not.toContain("Bullet");
    expect(editorText).not.toContain("Plain bullet");
  });

  test("partial Backspace inside bold removes selected chars", async ({ page }) => {
    // Segment 7 = "**bold** and *italic* text" (added to PARTIAL_MD)
    // Select "ol" from "bold" (partial selection within the bold span)
    const selected = await selectTextInSegment(page, 7, "bold", 1, 3);
    expect(selected).toBe(true);

    await page.keyboard.press("Backspace");
    await waitForRaf(page);

    // Should enter edit mode with "ol" removed, leaving "bd"
    await expect(page.locator(".md-seg-active")).toBeVisible({ timeout: 5000 });
    const text = await getSegmentText(page, 7);

    // The markdown should be "**bd** and *italic* text"
    expect(text).toContain("**bd**");
    expect(text).toContain("*italic*");
    expect(text).not.toContain("**bold**");
  });
});
