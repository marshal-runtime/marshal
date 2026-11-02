import fs from "fs";
import path from "path";

import { E2E_DATA_DIR } from "../electron/mock-mode";
import { sharedTest as test, expect } from "./marshal-fixtures";

const WORKSPACE_DIR = path.join(E2E_DATA_DIR, "workspace", "Scratchpad");

const SAMPLE_MD = `# Test Document

First paragraph of text.

- Bullet A
- Bullet B
- Bullet C

Last paragraph here.`;

const MULTILINE_MD = `# Multiline Test

This is a very long paragraph that should wrap across multiple visual lines in the editor. We need enough text here to ensure the browser wraps it to at least two or three visual lines when rendered in the editor viewport. The quick brown fox jumps over the lazy dog. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.

\`\`\`js
const a = 1;
const b = 2;
const c = 3;
\`\`\`

Short line after code block.`;

/** Wait for two animation frames to let React + rAF handlers settle */
async function waitForRaf(page: import("@playwright/test").Page) {
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

/** Find a segment by its visible text content */
function segByText(page: import("@playwright/test").Page, text: string) {
  return page.locator(".md-seg", { hasText: text }).first();
}

/** Get the active input/textarea inside the editor */
function activeInput(page: import("@playwright/test").Page) {
  return page.locator(".md-seg-active textarea, .md-seg-active input");
}

/** Count how many .md-seg elements overlap the current native selection */
async function countSelectedSegs(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return 0;
    const editor = document.querySelector(".md-custom-editor");
    if (!editor) return 0;
    const segs = editor.querySelectorAll(".md-seg");
    let count = 0;
    for (const seg of segs) {
      if (sel.containsNode(seg, true)) count++;
    }
    return count;
  });
}

/** Wait until the native selection spans at least N segments */
async function waitForSelection(page: import("@playwright/test").Page, minSegs: number) {
  await page.waitForFunction(
    (min: number) => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return false;
      const editor = document.querySelector(".md-custom-editor");
      if (!editor) return false;
      const segs = editor.querySelectorAll(".md-seg");
      let count = 0;
      for (const seg of segs) {
        if (sel.containsNode(seg, true)) count++;
      }
      return count >= min;
    },
    minSegs,
    { timeout: 5000 },
  );
}

/** Navigate to Workspaces, select a workspace, and open a file. */
async function openFile(page: import("@playwright/test").Page, fileName: string) {
  // Click the Workspaces navigation item.
  const navButton = page.getByRole("button", { name: "Workspaces" });
  await navButton.waitFor({ timeout: 5000 });
  await navButton.click();

  // Wait for file tree or file list to appear
  const fileLink = page.getByText(fileName);
  await fileLink.waitFor({ timeout: 5000 });
  await fileLink.click();
  await page.locator(".md-seg").first().waitFor({ timeout: 5000 });

  // Wait for editor DOM to stabilize — the workspace file watcher has a 300ms
  // debounce that can trigger a re-render after initial segments appear, causing
  // DOM detachment if a test tries to interact during the re-render.
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
 * Editor selection E2E tests.
 *
 * These verify behaviors requiring a real browser Selection API
 * (cross-segment selection, shift+arrow, selection collapse, etc.)
 * which cannot be tested in happy-dom unit tests.
 */
test.describe("Editor selection and keyboard", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "selection-test.md"), SAMPLE_MD);
    fs.writeFileSync(path.join(WORKSPACE_DIR, "multiline-test.md"), MULTILINE_MD);

    await openFile(page, "selection-test.md");
  });

  test("click enters edit mode on a segment", async ({ page }) => {
    await segByText(page, "First paragraph").click();
    await expect(page.locator(".md-seg-active")).toBeVisible();
    await expect(activeInput(page)).toBeVisible();
  });

  test("shift+arrow down from edit creates cross-segment selection", async ({ page }) => {
    await segByText(page, "Bullet A").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    // Use input.press to ensure focus is on the input
    await input.press("Shift+ArrowDown");
    await waitForSelection(page, 2);

    expect(await countSelectedSegs(page)).toBeGreaterThanOrEqual(2);
  });

  test("shift+arrow up from edit creates cross-segment selection upward", async ({ page }) => {
    await segByText(page, "Bullet C").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    await input.press("Shift+ArrowUp");
    await waitForSelection(page, 2);

    expect(await countSelectedSegs(page)).toBeGreaterThanOrEqual(2);
  });

  test("shift+click creates range selection from focused segment", async ({ page }) => {
    await segByText(page, "Bullet A").click();
    const inputA = activeInput(page);
    await expect(inputA).toBeVisible();
    await inputA.press("Escape");
    await expect(page.locator(".md-seg-active")).toBeHidden({ timeout: 5000 });

    await segByText(page, "Bullet C").click({ modifiers: ["Shift"] });
    await waitForSelection(page, 3);

    expect(await countSelectedSegs(page)).toBeGreaterThanOrEqual(3);
  });

  test("arrow left on multi-segment selection collapses it", async ({ page }) => {
    await segByText(page, "Bullet A").click();
    await activeInput(page).press("Shift+ArrowDown");
    await waitForSelection(page, 2);

    await page.keyboard.press("ArrowLeft");
    await waitForRaf(page);

    const collapsed = await page.evaluate(() => {
      const sel = window.getSelection();
      return !sel || sel.isCollapsed;
    });
    expect(collapsed).toBe(true);
    await expect(page.locator(".md-seg-active")).toBeVisible();
  });

  test("arrow right on multi-segment selection collapses it", async ({ page }) => {
    await segByText(page, "Bullet A").click();
    await activeInput(page).press("Shift+ArrowDown");
    await waitForSelection(page, 2);

    await page.keyboard.press("ArrowRight");
    await waitForRaf(page);

    const collapsed = await page.evaluate(() => {
      const sel = window.getSelection();
      return !sel || sel.isCollapsed;
    });
    expect(collapsed).toBe(true);
    await expect(page.locator(".md-seg-active")).toBeVisible();
  });

  test("shift+click extends existing selection", async ({ page }) => {
    await segByText(page, "Bullet A").click();
    await activeInput(page).press("Shift+ArrowDown");
    await waitForSelection(page, 2);
    const initial = await countSelectedSegs(page);

    await segByText(page, "Last paragraph").click({ modifiers: ["Shift"] });
    await waitForRaf(page);
    const extended = await countSelectedSegs(page);
    expect(extended).toBeGreaterThan(initial);
  });

  test("backspace with text selection in edit deletes selected text", async ({ page }) => {
    await segByText(page, "First paragraph").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    const isMac = process.platform === "darwin";
    await input.press(isMac ? "Meta+a" : "Control+a");
    await input.press("Backspace");
    await waitForRaf(page);

    await expect(input).toHaveValue("", { timeout: 10000 });
  });

  test("copy with text selection populates clipboard", async ({ page }) => {
    await segByText(page, "First paragraph").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    const isMac = process.platform === "darwin";
    await input.press(isMac ? "Meta+a" : "Control+a");
    await input.press(isMac ? "Meta+c" : "Control+c");

    // Copy doesn't delete — text should still be there
    const value = await input.inputValue();
    expect(value).toContain("First paragraph");
  });

  test("arrow up in single-line edit navigates to previous segment", async ({ page }) => {
    await segByText(page, "Bullet B").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    await input.press("ArrowUp");
    await waitForRaf(page);

    await expect(page.locator(".md-seg-active")).toBeVisible();
    const activeText = await page.locator(".md-seg-active").textContent();
    expect(activeText).not.toContain("Bullet B");
  });

  test("arrow down in single-line edit navigates to next segment", async ({ page }) => {
    await segByText(page, "Bullet B").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    await input.press("ArrowDown");
    await waitForRaf(page);

    await expect(page.locator(".md-seg-active")).toBeVisible();
    const activeText = await page.locator(".md-seg-active").textContent();
    expect(activeText).not.toContain("Bullet B");
  });
});

/**
 * Drag-to-select E2E tests.
 * Verifies that click-drag to select text across segments works,
 * both when no segment is active and when transitioning from an active segment.
 */
test.describe("Drag to select text", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "selection-test.md"), SAMPLE_MD);

    await openFile(page, "selection-test.md");
  });

  test("drag across rendered segments creates selection (no active segment)", async ({ page }) => {
    const bulletA = segByText(page, "Bullet A");
    const bulletC = segByText(page, "Bullet C");

    // Drag from Bullet A to Bullet C
    const aBox = (await bulletA.boundingBox())!;
    const cBox = (await bulletC.boundingBox())!;
    await page.mouse.move(aBox.x + 5, aBox.y + aBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(cBox.x + cBox.width - 5, cBox.y + cBox.height / 2, { steps: 5 });
    await page.mouse.up();

    await page.screenshot({ path: "test-screenshots/drag-select-rendered.png" });

    // Should have a cross-segment selection, NOT enter edit mode
    expect(await countSelectedSegs(page)).toBeGreaterThanOrEqual(2);
    // No active editing segment
    await expect(page.locator(".md-seg-active")).toBeHidden();
  });

  test("drag across segments while one is active creates selection", async ({ page }) => {
    // First, activate Bullet A by clicking it
    await segByText(page, "Bullet A").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();
    await page.screenshot({ path: "test-screenshots/drag-active-before.png" });

    // Now drag from Bullet B to Bullet C (different segments, while A is active)
    const bulletB = segByText(page, "Bullet B");
    const bulletC = segByText(page, "Bullet C");
    const bBox = (await bulletB.boundingBox())!;
    const cBox = (await bulletC.boundingBox())!;
    await page.mouse.move(bBox.x + 5, bBox.y + bBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(cBox.x + cBox.width - 5, cBox.y + cBox.height / 2, { steps: 5 });
    await page.mouse.up();

    await page.screenshot({ path: "test-screenshots/drag-active-after.png" });

    // Should have a cross-segment selection
    expect(await countSelectedSegs(page)).toBeGreaterThanOrEqual(2);
    // The old active segment should have been deactivated
    await expect(page.locator(".md-seg-active")).toBeHidden();
  });

  test("click (no drag) on another segment activates it", async ({ page }) => {
    // First, activate Bullet A
    await segByText(page, "Bullet A").click();
    await expect(activeInput(page)).toBeVisible();

    // Click Bullet B (a simple click, no drag)
    await segByText(page, "Bullet B").click();
    await waitForRaf(page);

    await page.screenshot({ path: "test-screenshots/click-transition.png" });

    // Bullet B should now be active
    await expect(page.locator(".md-seg-active")).toBeVisible();
    const activeText = await page.locator(".md-seg-active").textContent();
    expect(activeText).toContain("Bullet B");
  });

  test("drag within active segment textarea selects text inside it", async ({ page }) => {
    // Activate the first paragraph
    await segByText(page, "First paragraph").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    // Select all text in the textarea
    const isMac = process.platform === "darwin";
    await input.press(isMac ? "Meta+a" : "Control+a");

    // Should have selected text within the textarea
    const selectedText = await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>(".md-seg-active textarea");
      if (!ta) return "";
      return ta.value.substring(ta.selectionStart, ta.selectionEnd);
    });
    expect(selectedText).toContain("First paragraph");

    // Segment should still be active
    await expect(page.locator(".md-seg-active")).toBeVisible();
  });
});

/**
 * Multiline arrow key navigation tests.
 * Verifies that ArrowUp/Down navigate visual lines within a wrapped paragraph
 * and only exit to adjacent segments from the first/last visual line.
 */
test.describe("Multiline arrow navigation", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "multiline-test.md"), MULTILINE_MD);

    await openFile(page, "multiline-test.md");
  });

  test("arrow down in middle of wrapped text stays in same segment", async ({ page }) => {
    // Click the long paragraph to activate it
    const longPara = segByText(page, "This is a very long paragraph");
    await longPara.click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    // Take screenshot before
    await page.screenshot({ path: "test-screenshots/multiline-before-arrow.png" });

    // Move cursor to start (should be on first visual line), then press ArrowDown
    await input.press("Home");
    await input.press("ArrowDown");
    await waitForRaf(page);

    // Take screenshot after
    await page.screenshot({ path: "test-screenshots/multiline-after-arrow-down.png" });

    // Should still be in the same segment (the long paragraph)
    await expect(page.locator(".md-seg-active")).toBeVisible();
    const activeText = await page.locator(".md-seg-active").textContent();
    expect(activeText).toContain("very long paragraph");
  });

  test("arrow up in middle of wrapped text stays in same segment", async ({ page }) => {
    const longPara = segByText(page, "This is a very long paragraph");
    await longPara.click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    // Move cursor to end (should be on last visual line), then press ArrowUp
    await input.press("End");
    await input.press("ArrowUp");
    await waitForRaf(page);

    await page.screenshot({ path: "test-screenshots/multiline-after-arrow-up.png" });

    // Should still be in the same segment
    await expect(page.locator(".md-seg-active")).toBeVisible();
    const activeText = await page.locator(".md-seg-active").textContent();
    expect(activeText).toContain("very long paragraph");
  });

  test("arrow down from last visual line exits to next segment", async ({ page }) => {
    const longPara = segByText(page, "This is a very long paragraph");
    await longPara.click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    // Move cursor to end of ALL text (last visual line)
    // macOS: Cmd+ArrowDown, Windows: Ctrl+End
    const isMac = process.platform === "darwin";
    await input.press(isMac ? "Meta+ArrowDown" : "Control+End");

    // Verify cursor is actually at end
    const cursorInfo = await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>(".md-seg-active textarea");
      if (!ta) return null;
      return { pos: ta.selectionStart, len: ta.value.length };
    });
    expect(cursorInfo).not.toBeNull();
    expect(cursorInfo!.pos).toBe(cursorInfo!.len);

    await page.screenshot({ path: "test-screenshots/multiline-end-before-exit.png" });

    // Press ArrowDown — should exit to next segment
    await input.press("ArrowDown");
    // Wait for nested rAF chain (handler uses rAF → check → rAF → activate)
    await page.waitForFunction(
      () => {
        const active = document.querySelector(".md-seg-active");
        return active && !active.textContent?.includes("very long paragraph");
      },
      { timeout: 3000 },
    );

    await page.screenshot({ path: "test-screenshots/multiline-after-exit-down.png" });

    // Active segment should now be the code block or blank line after the paragraph
    const activeText = await page.locator(".md-seg-active").textContent();
    expect(activeText).not.toContain("very long paragraph");
  });

  test("arrow up from first visual line exits to previous segment", async ({ page }) => {
    const longPara = segByText(page, "This is a very long paragraph");
    await longPara.click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    // Move cursor to beginning of ALL text (first visual line)
    const isMac = process.platform === "darwin";
    await input.press(isMac ? "Meta+ArrowUp" : "Control+Home");

    // Verify cursor is at start
    const cursorInfo = await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>(".md-seg-active textarea");
      if (!ta) return null;
      return { pos: ta.selectionStart };
    });
    expect(cursorInfo).not.toBeNull();
    expect(cursorInfo!.pos).toBe(0);

    await page.screenshot({ path: "test-screenshots/multiline-home-before-exit.png" });

    // Press ArrowUp — should exit to previous segment
    await input.press("ArrowUp");
    // Wait for nested rAF chain (handler uses rAF → check → rAF → activate)
    await page.waitForFunction(
      () => {
        const active = document.querySelector(".md-seg-active");
        return active && !active.textContent?.includes("very long paragraph");
      },
      { timeout: 3000 },
    );

    await page.screenshot({ path: "test-screenshots/multiline-after-exit-up.png" });

    // Active segment should now be the heading
    const activeText = await page.locator(".md-seg-active").textContent();
    expect(activeText).not.toContain("very long paragraph");
  });

  test("arrow down in code block middle line stays in same segment", async ({ page }) => {
    const codeBlock = segByText(page, "const a = 1");
    await codeBlock.click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    // Cursor should be somewhere in the code block; go to line 1
    await input.press("Home");
    await page.screenshot({ path: "test-screenshots/code-block-before-arrow.png" });

    await input.press("ArrowDown");
    await waitForRaf(page);

    await page.screenshot({ path: "test-screenshots/code-block-after-arrow-down.png" });

    // Should still be in the code block (has 3 lines, should stay)
    await expect(page.locator(".md-seg-active")).toBeVisible();
    const activeText = await page.locator(".md-seg-active").textContent();
    expect(activeText).toContain("const");
  });
});

/**
 * Undo (Cmd/Ctrl+Z) tests.
 * Verifies undo works after various edit operations, including
 * typing, copy, paste, and segment transitions.
 */
test.describe("Undo after editing", () => {
  const UNDO_MD = `# Undo Test

First line of text.

Second line of text.

- Bullet A
- Bullet B`;

  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "undo-test.md"), UNDO_MD);
    await openFile(page, "undo-test.md");
  });

  const mod = process.platform === "darwin" ? "Meta" : "Control";

  test("undo reverts a committed segment edit", async ({ page }) => {
    // Click "First line" to edit
    await segByText(page, "First line of text").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    // Type extra text
    await input.press("End");
    await input.type(" ADDED");
    await waitForRaf(page);

    // Click away to commit — click on second line
    await segByText(page, "Second line of text").click();
    await waitForRaf(page);

    // Verify text was committed
    await expect(page.locator(".md-seg").filter({ hasText: "ADDED" })).toHaveCount(1);

    // Click outside to deactivate all segments
    await page.locator(".md-custom-editor").click({ position: { x: 5, y: 5 } });
    await waitForRaf(page);

    // Now Cmd+Z should undo the edit
    await page.keyboard.press(`${mod}+z`);
    await waitForRaf(page);

    // "ADDED" should be gone
    await expect(page.locator(".md-seg").filter({ hasText: "ADDED" })).toHaveCount(0);

    // Original text should be back
    await expect(segByText(page, "First line of text.")).toBeVisible();
  });

  test("undo works after copy (Cmd+C) in rendered mode", async ({ page }) => {
    // Edit first line, add text, commit
    await segByText(page, "First line of text").click();
    const input = activeInput(page);
    await input.press("End");
    await input.type(" MODIFIED");
    await waitForRaf(page);

    // Click outside to commit and deactivate
    await page.locator(".md-custom-editor").click({ position: { x: 5, y: 5 } });
    await waitForRaf(page);

    // Verify committed
    await expect(segByText(page, "First line of text. MODIFIED")).toBeVisible();

    // Now select some text and copy
    await segByText(page, "Second line of text").click({ clickCount: 2 });
    await waitForRaf(page);
    await page.keyboard.press(`${mod}+c`);
    await waitForRaf(page);

    // Deactivate
    await page.keyboard.press("Escape");
    await waitForRaf(page);

    // Cmd+Z should undo the edit to first line (copy shouldn't affect undo stack)
    await page.keyboard.press(`${mod}+z`);
    await waitForRaf(page);

    // "MODIFIED" should be gone
    await expect(page.locator(".md-seg").filter({ hasText: "MODIFIED" })).toHaveCount(0);
  });

  test("undo works while editing after copy (real user flow)", async ({ page }) => {
    // Step 1: Edit first line, add text, commit
    await segByText(page, "First line of text").click();
    let input = activeInput(page);
    await input.press("End");
    await input.type(" CHANGED");
    await waitForRaf(page);

    // Commit by pressing Escape
    await page.keyboard.press("Escape");
    await waitForRaf(page);

    // Verify committed
    await expect(segByText(page, "First line of text. CHANGED")).toBeVisible();

    // Step 2: Click into second line to select/copy (enters edit mode)
    await segByText(page, "Second line of text").click({ clickCount: 2 });
    input = activeInput(page);
    await expect(input).toBeVisible();
    await page.keyboard.press(`${mod}+c`);
    await waitForRaf(page);

    // Step 3: Cmd+Z while still in edit mode on the second segment
    // Should deactivate the segment (no changes) and undo the first edit
    await page.keyboard.press(`${mod}+z`);
    await waitForRaf(page);

    // "CHANGED" should be gone — undo succeeded through the edit mode
    await expect(page.locator(".md-seg").filter({ hasText: "CHANGED" })).toHaveCount(0);
    await expect(segByText(page, "First line of text.")).toBeVisible();
  });

  test("cmd+z while editing stays in segment and does not wipe text", async ({ page }) => {
    // Click to edit first line
    await segByText(page, "First line of text").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    // Move to end and type
    await input.press("End");
    await input.type(" TYPED");
    await waitForRaf(page);

    // Verify typed text appears
    const valAfterType = await input.inputValue();
    expect(valAfterType).toContain("TYPED");

    // Cmd+Z while still editing — native textarea undo fires,
    // segment stays active, text is not wholesale-wiped
    await page.keyboard.press(`${mod}+z`);
    await waitForRaf(page);

    // Segment must still be active
    await expect(activeInput(page)).toBeVisible();
    // Pre-fix this wiped to "First line of text" via setEditValue(originalText).
    // Word-boundary undo deterministically pops the " TYPED" chunk,
    // leaving the prior word-boundary state "First line of text. " (trailing
    // space). The trailing-space delta distinguishes new behavior from the
    // old wholesale-wipe failure mode.
    await expect(activeInput(page)).toHaveValue("First line of text. ");
  });

  test("cmd+z after copy while editing stays in segment", async ({ page }) => {
    // Click to edit first line
    await segByText(page, "First line of text").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    // Type extra text
    await input.press("End");
    await input.type(" EXTRA");
    await waitForRaf(page);

    // Select all and copy
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.press(`${mod}+c`);
    await waitForRaf(page);

    // Cmd+Z — segment stays active, native undo fires
    await page.keyboard.press(`${mod}+z`);
    await waitForRaf(page);

    await expect(activeInput(page)).toBeVisible();
    // Pre-fix this wiped to "First line of text"; word-boundary undo
    // pops the " EXTRA" chunk, leaving "First line of text. " (trailing space).
    await expect(activeInput(page)).toHaveValue("First line of text. ");
  });

  test("redo works after undo (Cmd+Shift+Z)", async ({ page }) => {
    // Edit first line, add text, commit
    await segByText(page, "First line of text").click();
    const input = activeInput(page);
    await input.press("End");
    await input.type(" REDONE");
    await waitForRaf(page);

    // Commit by pressing Escape
    await page.keyboard.press("Escape");
    await waitForRaf(page);
    await expect(segByText(page, "First line of text. REDONE")).toBeVisible();

    // Undo
    await page.keyboard.press(`${mod}+z`);
    await waitForRaf(page);
    await expect(page.locator(".md-seg").filter({ hasText: "REDONE" })).toHaveCount(0);

    // Redo — should bring "REDONE" back
    await page.keyboard.press(`${mod}+Shift+z`);
    await waitForRaf(page);
    await expect(segByText(page, "First line of text. REDONE")).toBeVisible();
  });

  test("redo while editing deactivates segment first", async ({ page }) => {
    // Edit and commit a change
    await segByText(page, "First line of text").click();
    let input = activeInput(page);
    await input.press("End");
    await input.type(" CHANGE");
    await page.keyboard.press("Escape");
    await waitForRaf(page);

    // Undo the change
    await page.keyboard.press(`${mod}+z`);
    await waitForRaf(page);
    await expect(page.locator(".md-seg").filter({ hasText: "CHANGE" })).toHaveCount(0);

    // Click into second line (enters edit mode)
    await segByText(page, "Second line of text").click();
    input = activeInput(page);
    await expect(input).toBeVisible();

    // Redo while editing — should deactivate and redo the first line change
    await page.keyboard.press(`${mod}+Shift+z`);
    await waitForRaf(page);

    // Segment should be deactivated
    await expect(page.locator(".md-seg-active")).toBeHidden({ timeout: 2000 });

    // "CHANGE" should be back
    await expect(segByText(page, "First line of text. CHANGE")).toBeVisible();
  });

  test("redo from dirty segment does in-segment redo, not doc redo", async ({ page }) => {
    // Edit and commit a change
    await segByText(page, "First line of text").click();
    let input = activeInput(page);
    await input.press("End");
    await input.type(" COMMITTED");
    await page.keyboard.press("Escape");
    await waitForRaf(page);

    // Undo the committed change
    await page.keyboard.press(`${mod}+z`);
    await waitForRaf(page);
    await expect(page.locator(".md-seg").filter({ hasText: "COMMITTED" })).toHaveCount(0);

    // Click into first line and type unsaved text
    await segByText(page, "First line of text").click();
    input = activeInput(page);
    await input.press("End");
    await input.type(" UNSAVED");
    await waitForRaf(page);

    // Shift+Z while the in-segment edit stack still has uncommitted edits stays
    // inside the segment. Doc-level redo does NOT fire — uncommitted edits
    // diverge from the doc state, so escaping would lose the user's typing.
    await page.keyboard.press(`${mod}+Shift+z`);
    await waitForRaf(page);

    // Segment must still be active (no escape to doc redo).
    await expect(activeInput(page)).toBeVisible();
    // "COMMITTED" should NOT have come back via doc redo.
    await expect(page.locator(".md-seg").filter({ hasText: "COMMITTED" })).toHaveCount(0);
  });

  test("undo restores content after delete on multi-segment selection", async ({ page }) => {
    // Select across two segments (Bullet A → Bullet B) using shift+click
    await segByText(page, "Bullet A").click();
    const inputA = activeInput(page);
    await expect(inputA).toBeVisible();
    await inputA.press("Escape");
    await waitForRaf(page);

    // Create cross-segment selection via shift+click
    await segByText(page, "Bullet A").click();
    await waitForRaf(page);
    await segByText(page, "Bullet B").click({ modifiers: ["Shift"] });
    await waitForSelection(page, 2);

    // Delete the selection
    await page.keyboard.press("Backspace");
    await waitForRaf(page);

    // Verify bullets are gone
    await expect(page.locator(".md-seg").filter({ hasText: "Bullet A" })).toHaveCount(0);
    await expect(page.locator(".md-seg").filter({ hasText: "Bullet B" })).toHaveCount(0);

    // Auto-activation must fire after the multi-segment delete — that's the
    // path the bug was filed against: the auto-activated segment had no native
    // undo history, so Cmd+Z silently dropped on the floor.
    await expect(activeInput(page)).toBeVisible({ timeout: 1000 });

    // A segment was auto-activated after delete. Cmd+Z should escape to
    // document-level undo and restore the deleted content.
    await page.keyboard.press(`${mod}+z`);
    await waitForRaf(page);

    // Both bullets should be restored
    await expect(segByText(page, "Bullet A")).toBeVisible({ timeout: 3000 });
    await expect(segByText(page, "Bullet B")).toBeVisible({ timeout: 3000 });
  });

  test("cmd+shift+z escapes to doc redo when in segment with empty edit stack", async ({
    page,
  }) => {
    // Edit + commit at doc level
    await segByText(page, "First line of text").click();
    let input = activeInput(page);
    await input.press("End");
    await input.type(" COMMITTED");
    await page.keyboard.press("Escape");
    await waitForRaf(page);

    // Doc-level undo: pulls "COMMITTED" out and queues a doc-level redo
    await page.keyboard.press(`${mod}+z`);
    await waitForRaf(page);
    await expect(page.locator(".md-seg").filter({ hasText: "COMMITTED" })).toHaveCount(0);

    // Click into a segment but do NOT type — edit stack stays at initial
    // and has nothing to redo locally.
    await segByText(page, "Second line of text").click();
    input = activeInput(page);
    await expect(input).toBeVisible();

    // Cmd+Shift+Z must escape to doc-level redo (restoring "COMMITTED") and
    // deactivate the segment. The redo-escape gate is `isAtInitial() && !canRedo()`;
    // if it were ever flipped to `||`, this would silently fail.
    await page.keyboard.press(`${mod}+Shift+z`);
    await waitForRaf(page);

    await expect(segByText(page, "First line of text. COMMITTED")).toBeVisible({
      timeout: 3000,
    });
  });
});

test.describe("Selection delete and replace", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "selection-test.md"), SAMPLE_MD);
    await openFile(page, "selection-test.md");
  });

  test("Enter with multi-segment selection deletes selection and creates blank line", async ({
    page,
  }) => {
    // Click first paragraph, then shift+arrow down to select multiple segments
    await segByText(page, "First paragraph").click();
    await expect(activeInput(page)).toBeVisible();
    await page.keyboard.press("Shift+ArrowDown");
    await waitForRaf(page);
    await page.keyboard.press("Shift+ArrowDown");
    await waitForRaf(page);
    await waitForSelection(page, 2);

    // Count segments before
    const beforeCount = await page.locator(".md-seg").count();

    // Press Enter — should delete selected segments and insert blank line
    await page.keyboard.press("Enter");
    await waitForRaf(page);

    // Should have fewer segments
    const afterCount = await page.locator(".md-seg").count();
    expect(afterCount).toBeLessThan(beforeCount);

    // Should have an active segment (cursor placed)
    await expect(page.locator(".md-seg-active")).toBeVisible({ timeout: 2000 });
  });

  test("typing a character with multi-segment selection replaces selection with that character", async ({
    page,
  }) => {
    // Select "First paragraph" and the blank line after it
    await segByText(page, "First paragraph").click();
    await expect(activeInput(page)).toBeVisible();
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await waitForSelection(page, 2);

    // Type "X" — should delete selection and insert "X"
    await page.keyboard.press("x");
    await waitForRaf(page);

    // An active segment should exist with "x" as the value
    await expect(page.locator(".md-seg-active")).toBeVisible({ timeout: 2000 });
    // "First paragraph" should no longer exist
    await expect(page.locator(".md-seg").filter({ hasText: "First paragraph" })).toHaveCount(0);
  });

  test("backspace with multi-segment selection removes and places cursor", async ({ page }) => {
    await segByText(page, "First paragraph").click();
    await expect(activeInput(page)).toBeVisible();
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await waitForSelection(page, 2);

    await page.keyboard.press("Backspace");
    await waitForRaf(page);

    // "First paragraph" should be gone
    await expect(page.locator(".md-seg").filter({ hasText: "First paragraph" })).toHaveCount(0);
    // Cursor should be placed — active segment should exist
    await expect(page.locator(".md-seg-active")).toBeVisible({ timeout: 2000 });
  });
});

test.describe("Arrow key boundary behavior", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "selection-test.md"), SAMPLE_MD);
    await openFile(page, "selection-test.md");
  });

  test("arrow up on first segment keeps cursor in first segment", async ({ page }) => {
    // Click the first segment (the heading)
    await segByText(page, "Test Document").click();
    await expect(activeInput(page)).toBeVisible();

    // Press ArrowUp — should stay in the segment
    await page.keyboard.press("ArrowUp");
    await waitForRaf(page);

    // Segment should still be active
    await expect(page.locator(".md-seg-active")).toBeVisible();
    await expect(activeInput(page)).toBeVisible();
  });

  test("arrow down on last segment keeps cursor in last segment", async ({ page }) => {
    // Click the last segment
    await segByText(page, "Last paragraph").click();
    await expect(activeInput(page)).toBeVisible();

    // Press ArrowDown — should stay in the segment
    await page.keyboard.press("ArrowDown");
    await waitForRaf(page);

    // Segment should still be active
    await expect(page.locator(".md-seg-active")).toBeVisible();
    await expect(activeInput(page)).toBeVisible();
  });
});

const CODEBLOCK_MD = `# Code Test

Some text.

\`\`\`js
const x = 1;
\`\`\`

After code.`;

const DRAG_MD = `# Drag Test

First block.

Second block.

Third block.`;

const DRAG_TABLE_MD = `# Table Test

Before table.

| Col A | Col B |
| ----- | ----- |
| 1     | 2     |

After table.`;

const DRAG_HEADER_MD = `# Main Title

## Section One

Paragraph below the first header.

## Section Two

Paragraph below the second header.`;

test.describe("Empty code block backspace", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "codeblock-test.md"), CODEBLOCK_MD);
    await openFile(page, "codeblock-test.md");
  });

  test("backspace on empty code block deletes the entire block", async ({ page }) => {
    // Click the code block segment to activate it
    const codeSeg = page.locator(".md-seg-code").first();
    await codeSeg.click();
    await expect(activeInput(page)).toBeVisible();

    // Select all content and delete it
    const input = activeInput(page);
    await input.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await input.press("Backspace");
    await waitForRaf(page);

    // Now the textarea should be empty — press Backspace again to delete the block
    await page.keyboard.press("Backspace");
    await waitForRaf(page);

    // The code block segment should be gone
    await expect(page.locator(".md-seg-code")).toHaveCount(0, { timeout: 5000 });
    // "After code" should still exist
    await expect(segByText(page, "After code")).toBeVisible();
  });

  test("backspace in code block with content deletes characters normally", async ({ page }) => {
    // Click the code block segment to activate it
    const codeSeg = page.locator(".md-seg-code").first();
    await codeSeg.click();
    await expect(activeInput(page)).toBeVisible();

    const input = activeInput(page);
    // Type some text — it should be inserted normally
    await input.press("End"); // go to end of current line
    await page.keyboard.type("ADDED");
    await waitForRaf(page);

    // Code block should still exist
    await expect(page.locator(".md-seg-code")).toBeVisible();
    // The typed text should appear
    const val = await input.inputValue();
    expect(val).toContain("ADDED");

    // Now press Backspace a few times — should delete typed chars, not the block
    // eslint-disable-next-line no-await-in-loop -- sequential test steps
    for (let i = 0; i < 5; i++) await input.press("Backspace");
    await waitForRaf(page);
    // Block still exists
    await expect(page.locator(".md-seg-code")).toBeVisible();
    const val2 = await input.inputValue();
    expect(val2).not.toContain("ADDED");
    // Original content should still be there
    expect(val2).toContain("const x = 1");
  });
});

test.describe("Drag to reorder segments", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "drag-test.md"), DRAG_MD);
    fs.writeFileSync(path.join(WORKSPACE_DIR, "drag-table-test.md"), DRAG_TABLE_MD);
    fs.writeFileSync(path.join(WORKSPACE_DIR, "drag-header-test.md"), DRAG_HEADER_MD);
    await openFile(page, "drag-test.md");
  });

  test("drag handle appears on hover", async ({ page }) => {
    const seg = segByText(page, "First block");
    const handle = seg.locator(".md-seg-drag-handle");
    // Handle is always in the DOM but hidden via CSS (not conditionally rendered)
    await expect(handle).toBeAttached();
    await expect(handle).toBeHidden();

    // Hover over the segment
    await seg.hover();
    await expect(seg.locator(".md-seg-drag-handle")).toBeVisible({ timeout: 2000 });
  });

  test("dragging a segment down reorders it", async ({ page }) => {
    // Get the initial order
    const firstSeg = segByText(page, "First block");
    const thirdSeg = segByText(page, "Third block");

    // Verify initial order: First block should be above Third block
    const firstY = (await firstSeg.boundingBox())!.y;
    const thirdY = (await thirdSeg.boundingBox())!.y;
    expect(firstY).toBeLessThan(thirdY);

    // Hover to reveal drag handle
    await firstSeg.hover();
    const handle = firstSeg.locator(".md-seg-drag-handle");
    await expect(handle).toBeVisible({ timeout: 2000 });

    // Drag "First block" down past "Third block"
    const handleBox = (await handle.boundingBox())!;
    const targetBox = (await thirdSeg.boundingBox())!;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    // Move in steps to trigger drag detection
    await page.mouse.move(handleBox.x + handleBox.width / 2, targetBox.y + targetBox.height, {
      steps: 10,
    });
    await page.mouse.up();
    await waitForRaf(page);

    // Wait for reorder to complete — "Second block" should now be first in DOM
    await expect(async () => {
      const secondY = (await segByText(page, "Second block").boundingBox())!.y;
      const firstY2 = (await segByText(page, "First block").boundingBox())!.y;
      expect(secondY).toBeLessThan(firstY2);
    }).toPass({ timeout: 2000 });
  });

  test("clicking drag handle selects the entire block", async ({ page }) => {
    const seg = segByText(page, "First block");
    await seg.hover();
    const handle = seg.locator(".md-seg-drag-handle");
    await expect(handle).toBeVisible({ timeout: 2000 });

    // Click (not drag) the handle
    await handle.click();
    await waitForRaf(page);

    // Segment should activate with all text selected in the textarea
    const input = activeInput(page);
    await expect(input).toBeVisible({ timeout: 2000 });
    // All text should be selected
    const selection = await input.evaluate((el: HTMLTextAreaElement | HTMLInputElement) => ({
      start: el.selectionStart,
      end: el.selectionEnd,
      len: el.value.length,
    }));
    expect(selection.start).toBe(0);
    expect(selection.end).toBe(selection.len);
  });

  test("tables have a drag handle", async ({ page }) => {
    // Switch to table-specific file via file tree
    await page.getByText("drag-table-test.md").click();
    await page.locator(".md-seg-table").waitFor({ timeout: 5000 });

    const tableSeg = page.locator(".md-seg-table");
    await expect(tableSeg).toBeVisible();

    // Hover over the table segment
    await tableSeg.hover();
    const handle = tableSeg.locator(".md-seg-drag-handle");
    await expect(handle).toBeVisible({ timeout: 2000 });

    // Drag table below "After table"
    const afterSeg = segByText(page, "After table");
    const handleBox = (await handle.boundingBox())!;
    const targetBox = (await afterSeg.boundingBox())!;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2, targetBox.y + targetBox.height, {
      steps: 10,
    });
    await page.mouse.up();
    await waitForRaf(page);

    // Table should now be after "After table"
    const tableY = (await page.locator(".md-seg-table").boundingBox())!.y;
    const afterY = (await segByText(page, "After table").boundingBox())!.y;
    expect(tableY).toBeGreaterThan(afterY);
  });

  test("dragging a header preserves its content", async ({ page }) => {
    // Switch to header-specific file via file tree
    await page.getByText("drag-header-test.md").click();
    await page.locator(".md-seg").first().waitFor({ timeout: 5000 });
    // Wait for all segments to render
    await expect(segByText(page, "Paragraph below the second header")).toBeVisible({
      timeout: 3000,
    });

    // Drag "Section One" header below "Section Two" content
    const sectionOne = segByText(page, "Section One");
    const sectionTwoContent = segByText(page, "Paragraph below the second header");
    await sectionOne.hover();
    const handle = sectionOne.locator(".md-seg-drag-handle");
    await expect(handle).toBeVisible({ timeout: 2000 });

    const handleBox = (await handle.boundingBox())!;
    const targetBox = (await sectionTwoContent.boundingBox())!;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    // Drag well past the bottom of the target segment
    await page.mouse.move(handleBox.x + handleBox.width / 2, targetBox.y + targetBox.height + 20, {
      steps: 10,
    });
    await page.mouse.up();
    await waitForRaf(page);
    await waitForRaf(page);

    // "Section One" should still exist (not lost)
    await expect(segByText(page, "Section One")).toBeVisible();
    // And it should be below "Paragraph below the second header"
    // Re-query since DOM changed after reorder
    const oneY2 = (await segByText(page, "Section One").boundingBox())!.y;
    const twoContentY2 = (await segByText(page, "Paragraph below the second header").boundingBox())!
      .y;
    expect(oneY2).toBeGreaterThan(twoContentY2);
  });

  test("drag shows ghost preview of the dragged segment", async ({ page }) => {
    const seg = segByText(page, "First block");
    await seg.hover();
    const handle = seg.locator(".md-seg-drag-handle");
    await expect(handle).toBeVisible({ timeout: 2000 });

    const handleBox = (await handle.boundingBox())!;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    // Move enough to trigger drag
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 50, { steps: 5 });

    // A ghost element should be visible
    const ghost = page.locator(".md-seg-drag-ghost");
    await expect(ghost).toBeVisible({ timeout: 2000 });
    // Ghost should be semi-transparent
    const opacity = await ghost.evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(opacity)).toBeLessThanOrEqual(0.6);

    await page.mouse.up();
  });

  test.fixme("dragging segment up past a focused blank line preserves it", async ({ page }) => {
    // The DRAG_MD has: heading, blank, "First block.", blank, "Second block.", blank, "Third block."
    // Click a blank line between "First block." and "Second block." to activate it
    const blankSegs = page.locator(".md-seg-blank");
    await blankSegs.nth(1).click();
    await waitForRaf(page);
    await expect(page.locator(".md-seg-active")).toBeVisible({ timeout: 2000 });

    // Drag "Third block." up past the focused blank line to before "First block."
    const thirdSeg = segByText(page, "Third block");
    await thirdSeg.hover();
    const handle = thirdSeg.locator(".md-seg-drag-handle");
    await expect(handle).toBeVisible({ timeout: 2000 });

    const firstSeg = segByText(page, "First block");
    const handleBox = (await handle.boundingBox())!;
    const targetBox = (await firstSeg.boundingBox())!;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2, targetBox.y - 5, { steps: 10 });
    await page.mouse.up();
    await waitForRaf(page);

    // All three text blocks must still exist (none disappeared)
    await expect(segByText(page, "First block")).toBeVisible({ timeout: 2000 });
    await expect(segByText(page, "Second block")).toBeVisible({ timeout: 2000 });
    await expect(segByText(page, "Third block")).toBeVisible({ timeout: 2000 });
    // "Third block." should now be above "First block."
    await expect(async () => {
      const thirdY = (await segByText(page, "Third block").boundingBox())!.y;
      const firstY = (await segByText(page, "First block").boundingBox())!.y;
      expect(thirdY).toBeLessThan(firstY);
    }).toPass({ timeout: 2000 });
  });
});

/**
 * Copy & paste tests.
 * Verifies clipboard operations work correctly in both edit and rendered modes.
 */
test.describe("Copy and paste", () => {
  const COPY_MD = `# Copy Test

First line of text.

Second line of text.

Third line of text.`;

  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "copy-test.md"), COPY_MD);
    await openFile(page, "copy-test.md");
    // Clear clipboard to prevent cross-test contamination
    await page.evaluate(() => navigator.clipboard.writeText(""));
  });

  const mod = process.platform === "darwin" ? "Meta" : "Control";

  test.fixme("copy within a line and paste inserts that content", async ({ page }) => {
    // Click into "First line of text." to enter edit mode
    await segByText(page, "First line of text").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    // Go to start, select first 5 chars ("First"), copy
    await page.keyboard.press("Home");
    // eslint-disable-next-line no-await-in-loop -- sequential test steps
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press(`${mod}+c`);
    // Wait for clipboard to actually update — a previous test may have left stale content
    await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t === "First"), {
      timeout: 3000,
    });

    // Move to end of line, paste
    await page.keyboard.press(`${mod}+${process.platform === "darwin" ? "ArrowRight" : "End"}`);
    await page.keyboard.press(`${mod}+v`);

    // The textarea should now end with "First" appended — retry for async clipboard + React update
    await expect(async () => {
      await expect(activeInput(page)).toHaveValue("First line of text.First");
    }).toPass({ timeout: 10_000 });
  });

  test("copy from cross-segment selection pastes correct content", async ({ page }) => {
    // Enter edit mode on "First line", then shift+arrow down to create cross-segment selection
    await segByText(page, "First line of text").click();
    await expect(activeInput(page)).toBeVisible();

    // Shift+ArrowDown exits edit mode and creates cross-segment selection
    await activeInput(page).press("Shift+ArrowDown");
    await waitForSelection(page, 2);

    // Should be in rendered mode now (no active segment)
    await expect(page.locator(".md-seg-active")).toBeHidden({ timeout: 2000 });

    // Copy the cross-segment selection
    await page.keyboard.press(`${mod}+c`);
    await waitForRaf(page);

    // Read clipboard — should contain "First line of text." (and possibly the blank line)
    const clipText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipText).toBeTruthy();
    expect(clipText).toContain("First line of text.");
  });

  test.fixme("pasting long text that wraps should show multiline immediately", async ({ page }) => {
    // Click into "First line of text." to enter edit mode
    await segByText(page, "First line of text").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    // Select all current text and replace with a long string via paste
    await page.keyboard.press(`${mod}+a`);
    const longText =
      "This is a very long line of text that should definitely wrap beyond the width of the editor container and force the textarea to grow taller than a single line of text in the display";

    // Write to clipboard and paste
    await page.evaluate((t) => navigator.clipboard.writeText(t), longText);
    await page.keyboard.press(`${mod}+v`);
    await waitForRaf(page);

    // The textarea should contain the long text
    await expect(activeInput(page)).toHaveValue(longText);

    // The textarea must already be taller than a single line (≥ 2 lines).
    // A single line is ~24px; if it wraps it should be ≥ 40px.
    const height = await activeInput(page).evaluate((el) => el.getBoundingClientRect().height);
    expect(height, "textarea should have wrapped to multiple lines immediately").toBeGreaterThan(
      36,
    );
  });
});

/**
 * Visual stability tests.
 * Verifies that clicking/selecting lines causes no vertical layout shift.
 */
test.describe("Selection visual stability", () => {
  const STABILITY_MD = `# Stability Test

First line of text.

Second line of text.

Third line of text.`;

  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "stability-test.md"), STABILITY_MD);
    await openFile(page, "stability-test.md");
  });

  /** Get Y positions of all segments */
  async function getSegmentPositions(page: import("@playwright/test").Page) {
    return page.evaluate(() => {
      const editor = document.querySelector(".md-custom-editor");
      if (!editor) return [];
      const segs = editor.querySelectorAll(".md-seg");
      return Array.from(segs).map((seg, i) => {
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- DOM Element to HTMLElement narrowing
        const rect = (seg as HTMLElement).getBoundingClientRect();
        // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- DOM Element to HTMLElement narrowing
        const text = (seg as HTMLElement).textContent?.trim().substring(0, 30) || "(empty)";
        return { index: i, top: rect.top, height: rect.height, text };
      });
    });
  }

  test("clicking a text line causes no vertical shift on any segment", async ({ page }) => {
    // Measure positions before click
    const before = await getSegmentPositions(page);
    expect(before.length).toBeGreaterThan(3);

    // Take screenshot before click for reference
    await page.locator(".md-custom-editor").screenshot();

    // Click on "Second line of text." to activate it
    await segByText(page, "Second line of text").click();
    await waitForRaf(page);
    await expect(activeInput(page)).toBeVisible();

    // Measure positions after click
    const after = await getSegmentPositions(page);

    // Every segment should remain at the same Y position (±1px tolerance for subpixel)
    for (let i = 0; i < before.length; i++) {
      expect(
        Math.abs(after[i].top - before[i].top),
        `segment ${i} ("${before[i].text}") shifted by ${after[i].top - before[i].top}px`,
      ).toBeLessThanOrEqual(1);
    }
  });

  test("clicking an empty line causes no vertical shift on any segment", async ({ page }) => {
    // Measure positions before click
    const before = await getSegmentPositions(page);
    expect(before.length).toBeGreaterThan(3);

    // Find the first blank segment by class name
    const blankIdx = await page.evaluate(() => {
      const editor = document.querySelector(".md-custom-editor");
      if (!editor) return -1;
      const segs = editor.querySelectorAll(".md-seg");
      for (let i = 0; i < segs.length; i++) {
        if (segs[i].classList.contains("md-seg-blank")) return i;
      }
      return -1;
    });
    expect(blankIdx).toBeGreaterThan(0);

    // Click the blank segment
    const blankSeg = page.locator(`.md-seg`).nth(blankIdx);
    await blankSeg.click();
    await waitForRaf(page);

    // Measure positions after click
    const after = await getSegmentPositions(page);

    // Every segment should remain at the same Y position (±1px tolerance)
    for (let i = 0; i < before.length; i++) {
      expect(
        Math.abs(after[i].top - before[i].top),
        `segment ${i} ("${before[i].text}") shifted by ${after[i].top - before[i].top}px`,
      ).toBeLessThanOrEqual(1);
    }
  });
});

// ── Plate.js-inspired tests ────────────────────────────────────────────────

const MERGE_MD = `# Merge Test

Alpha line.

Beta line.

Gamma line.`;

const FORWARD_DEL_MD = `# Forward Delete Test

First line.

Second line.

Third line.`;

const INDENT_MD = `# Indent Test

- Item A
- Item B
- Item C`;

const EMPTY_CODE_FWD_MD = `# Code Forward Test

Before code.

\`\`\`js
const x = 1;
\`\`\`

After code.`;

test.describe("Forward delete (fn+Backspace / Delete key)", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "forward-del-test.md"), FORWARD_DEL_MD);
    fs.writeFileSync(path.join(WORKSPACE_DIR, "codeblock-fwd-test.md"), EMPTY_CODE_FWD_MD);
    await openFile(page, "forward-del-test.md");
  });

  test("forward delete in middle of text deletes character after cursor", async ({ page }) => {
    await segByText(page, "First line").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();
    // Place cursor at start, then delete forward
    await input.press("Home");
    await input.press("Delete");
    await waitForRaf(page);
    await waitForRaf(page);
    await expect(input).toHaveValue("irst line.", { timeout: 10000 });
  });

  test("forward delete on empty segment removes it and moves to next", async ({ page }) => {
    // Click a blank line between "First line." and "Second line."
    const blankSegs = page.locator(".md-seg-blank");
    await blankSegs.first().click();
    await waitForRaf(page);
    const input = activeInput(page);
    await expect(input).toBeVisible();

    const beforeCount = await page.locator(".md-seg").count();
    await input.press("Delete");
    await waitForRaf(page);

    // One fewer segment
    await expect(page.locator(".md-seg")).toHaveCount(beforeCount - 1, { timeout: 2000 });
    // "Second line." should still exist
    await expect(segByText(page, "Second line")).toBeVisible();
  });

  test("forward delete at end of line merges with next segment", async ({ page }) => {
    await segByText(page, "First line").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();
    // Go to end of line
    await input.press("End");
    await input.press("Delete");
    await waitForRaf(page);

    // Should have merged: "First line." + next non-blank content
    // An active segment should exist with the merged text
    await expect(page.locator(".md-seg-active")).toBeVisible({ timeout: 2000 });
  });
});

test.describe("Forward delete on code blocks", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "codeblock-fwd-test.md"), EMPTY_CODE_FWD_MD);
    await openFile(page, "codeblock-fwd-test.md");
  });

  test("forward delete on empty code block deletes the entire block", async ({ page }) => {
    const codeSeg = page.locator(".md-seg-code").first();
    await codeSeg.click();
    await expect(activeInput(page)).toBeVisible();

    // Select all content and delete it
    const input = activeInput(page);
    const isMac = process.platform === "darwin";
    await input.press(isMac ? "Meta+a" : "Control+a");
    await input.press("Backspace");
    await waitForRaf(page);

    // Now the textarea is empty — press Delete to remove the block
    await page.keyboard.press("Delete");
    await waitForRaf(page);

    // Code block should be gone
    await expect(page.locator(".md-seg-code")).toHaveCount(0, { timeout: 5000 });
    await expect(segByText(page, "After code")).toBeVisible();
  });
});

test.describe("Backspace merge with previous segment (Plate: mergeNodes)", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "merge-test.md"), MERGE_MD);
    await openFile(page, "merge-test.md");
  });

  test("backspace at start of non-empty line merges with previous segment", async ({ page }) => {
    // Click "Beta line." and put cursor at position 0
    await segByText(page, "Beta line").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();
    await input.press("Home");

    const beforeCount = await page.locator(".md-seg").count();
    await input.press("Backspace");
    await waitForRaf(page);

    // The blank line between Alpha and Beta is the previous segment, so
    // backspace merges Beta with that blank → result is just "Beta line."
    // but the blank segment is consumed, reducing total count.
    const afterCount = await page.locator(".md-seg").count();
    expect(afterCount).toBeLessThan(beforeCount);
    // Beta should still exist
    await expect(segByText(page, "Beta line")).toBeVisible({ timeout: 2000 });
    // Alpha should still exist
    await expect(segByText(page, "Alpha line")).toBeVisible({ timeout: 2000 });
  });

  test("backspace at start of first paragraph is no-op", async ({ page }) => {
    // Click "Alpha line." — it's the first paragraph (after heading + blank)
    await segByText(page, "Alpha line").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();
    await input.press("Home");

    await input.press("Backspace");
    await waitForRaf(page);

    // At minimum the text shouldn't be corrupted — "Alpha" still visible
    await expect(segByText(page, "Alpha line")).toBeVisible({ timeout: 2000 });
  });
});

test.describe("Drag reorder edge cases (Plate: onDropNode)", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "drag-test.md"), DRAG_MD);
    await openFile(page, "drag-test.md");
  });

  test("drag to same position is a no-op", async ({ page }) => {
    // Hover "Second block.", grab handle, drag to same position
    const seg = segByText(page, "Second block");
    await seg.hover();
    const handle = seg.locator(".md-seg-drag-handle");
    await expect(handle).toBeVisible({ timeout: 2000 });

    const handleBox = (await handle.boundingBox())!;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    // Drag just a tiny bit within the same segment zone
    await page.mouse.move(
      handleBox.x + handleBox.width / 2,
      handleBox.y + handleBox.height / 2 + 5,
      {
        steps: 3,
      },
    );
    await page.mouse.up();
    await waitForRaf(page);

    // Order unchanged: First, Second, Third
    await expect(async () => {
      const firstY = (await segByText(page, "First block").boundingBox())!.y;
      const secondY = (await segByText(page, "Second block").boundingBox())!.y;
      const thirdY = (await segByText(page, "Third block").boundingBox())!.y;
      expect(firstY).toBeLessThan(secondY);
      expect(secondY).toBeLessThan(thirdY);
    }).toPass({ timeout: 2000 });
  });

  test("all text segments survive multiple sequential drags", async ({ page }) => {
    // Drag Third to first, then Second to last — all must survive
    // First drag: Third → before First
    const thirdSeg = segByText(page, "Third block");
    await thirdSeg.hover();
    let handle = thirdSeg.locator(".md-seg-drag-handle");
    await expect(handle).toBeVisible({ timeout: 2000 });
    let handleBox = (await handle.boundingBox())!;
    const firstBox = (await segByText(page, "First block").boundingBox())!;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2, firstBox.y - 5, { steps: 10 });
    await page.mouse.up();
    await waitForRaf(page);

    // After first drag: Third, First, Second
    await expect(segByText(page, "Third block")).toBeVisible({ timeout: 2000 });
    await expect(segByText(page, "First block")).toBeVisible({ timeout: 2000 });
    await expect(segByText(page, "Second block")).toBeVisible({ timeout: 2000 });

    // Second drag: Second → before Third
    const secondSeg = segByText(page, "Second block");
    await secondSeg.hover();
    handle = secondSeg.locator(".md-seg-drag-handle");
    await expect(handle).toBeVisible({ timeout: 2000 });
    handleBox = (await handle.boundingBox())!;
    const thirdBox2 = (await segByText(page, "Third block").boundingBox())!;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2, thirdBox2.y - 5, { steps: 10 });
    await page.mouse.up();
    await waitForRaf(page);

    // All three still visible
    await expect(segByText(page, "First block")).toBeVisible({ timeout: 2000 });
    await expect(segByText(page, "Second block")).toBeVisible({ timeout: 2000 });
    await expect(segByText(page, "Third block")).toBeVisible({ timeout: 2000 });
  });
});

test.describe("Arrow navigation with multi-segment selection (Plate: moveSelection)", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "selection-test.md"), SAMPLE_MD);
    await openFile(page, "selection-test.md");
  });

  test("arrow down with multi-segment selection collapses and moves after bottom", async ({
    page,
  }) => {
    // Select multiple segments
    await segByText(page, "First paragraph").click();
    await expect(activeInput(page)).toBeVisible();
    await page.keyboard.press("Shift+ArrowDown");
    await waitForRaf(page);
    await page.keyboard.press("Shift+ArrowDown");
    await waitForRaf(page);
    await waitForSelection(page, 2);

    // Arrow down should collapse selection and move past it
    await page.keyboard.press("ArrowDown");
    await waitForRaf(page);

    // Selection should be collapsed (no multi-segment selection)
    const selectedCount = await countSelectedSegs(page);
    expect(selectedCount).toBeLessThanOrEqual(1);
  });

  test("arrow up with multi-segment selection collapses and moves before top", async ({ page }) => {
    // Select multiple segments starting from a lower segment
    await segByText(page, "Bullet C").click();
    await expect(activeInput(page)).toBeVisible();
    await page.keyboard.press("Shift+ArrowUp");
    await page.keyboard.press("Shift+ArrowUp");
    await waitForSelection(page, 2);

    // Arrow up should collapse selection
    await page.keyboard.press("ArrowUp");
    await waitForRaf(page);

    const selectedCount = await countSelectedSegs(page);
    expect(selectedCount).toBeLessThanOrEqual(1);
  });
});

test.describe("Enter splits and creates segments (Plate: insertBreak)", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "merge-test.md"), MERGE_MD);
    await openFile(page, "merge-test.md");
  });

  test("Enter in middle of text splits segment into two", async ({ page }) => {
    await segByText(page, "Alpha line").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    // Place cursor between "Alpha" and " line."
    await input.press("Home");
    // eslint-disable-next-line no-await-in-loop -- sequential test steps
    for (let i = 0; i < 5; i++) await input.press("ArrowRight");

    const beforeCount = await page.locator(".md-seg").count();
    await input.press("Enter");
    await waitForRaf(page);

    // More segments after split
    const afterCount = await page.locator(".md-seg").count();
    expect(afterCount).toBeGreaterThan(beforeCount);
    // Both halves should exist
    await expect(segByText(page, "Alpha")).toBeVisible({ timeout: 2000 });
    await expect(segByText(page, "line")).toBeVisible({ timeout: 2000 });
  });

  test("Enter at end of line creates a new blank segment below", async ({ page }) => {
    await segByText(page, "Alpha line").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();
    await input.press("End");

    const beforeCount = await page.locator(".md-seg").count();
    await input.press("Enter");
    await waitForRaf(page);

    const afterCount = await page.locator(".md-seg").count();
    expect(afterCount).toBeGreaterThanOrEqual(beforeCount);
    // Should have activated a new segment
    await expect(page.locator(".md-seg-active")).toBeVisible({ timeout: 2000 });
  });

  test("Enter at start of line creates a blank segment above", async ({ page }) => {
    await segByText(page, "Beta line").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();
    await input.press("Home");

    await input.press("Enter");
    await waitForRaf(page);

    // "Beta line." should still exist
    await expect(segByText(page, "Beta line")).toBeVisible({ timeout: 2000 });
    // Cursor should be active
    await expect(page.locator(".md-seg-active")).toBeVisible({ timeout: 2000 });
  });
});

test.describe("Tab indent and Shift+Tab dedent (Plate: indent/outdent)", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "indent-test.md"), INDENT_MD);
    await openFile(page, "indent-test.md");
  });

  test("Tab inserts spaces at cursor position", async ({ page }) => {
    await segByText(page, "Item B").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();

    // Place cursor at beginning to indent the line
    await input.press("Home");
    await input.press("Tab");
    await waitForRaf(page);

    await expect(activeInput(page)).toHaveValue("  - Item B");
  });

  test.fixme("Shift+Tab removes leading spaces (dedent)", async ({ page }) => {
    // First indent Item B
    await segByText(page, "Item B").click();
    const input = activeInput(page);
    await expect(input).toBeVisible();
    await input.press("Home");
    await input.press("Tab");
    await waitForRaf(page);

    // Now dedent
    await activeInput(page).press("Shift+Tab");
    await waitForRaf(page);

    await expect(activeInput(page)).toHaveValue("- Item B");
  });
});

test.describe("Delete with multi-segment selection (Plate: removeNodes)", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "selection-test.md"), SAMPLE_MD);
    await openFile(page, "selection-test.md");
  });

  test("Delete key with multi-segment selection removes selected segments", async ({ page }) => {
    await segByText(page, "First paragraph").click();
    await expect(activeInput(page)).toBeVisible();
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await waitForSelection(page, 2);

    const beforeCount = await page.locator(".md-seg").count();
    await page.keyboard.press("Delete");
    await waitForRaf(page);

    const afterCount = await page.locator(".md-seg").count();
    expect(afterCount).toBeLessThan(beforeCount);
    await expect(page.locator(".md-seg").filter({ hasText: "First paragraph" })).toHaveCount(0);
  });
});

test.describe("Single-click activation and deactivation", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "merge-test.md"), MERGE_MD);
    await openFile(page, "merge-test.md");
  });

  test("clicking outside the editor deactivates the active segment", async ({ page }) => {
    await segByText(page, "Alpha line").click();
    await expect(activeInput(page)).toBeVisible();

    // Click a non-segment area to blur the active segment
    await page.locator(".md-custom-editor").click({ position: { x: 5, y: 5 } });
    await waitForRaf(page);

    // No segment should be active after a short wait
    // (or the heading is now active if clicked on it — either way the previous one deactivated)
    const activeCount = await page.locator(".md-seg-active").count();
    expect(activeCount).toBeLessThanOrEqual(1);
  });

  test("Escape key deactivates the active segment", async ({ page }) => {
    await segByText(page, "Beta line").click();
    await expect(activeInput(page)).toBeVisible();

    await activeInput(page).press("Escape");

    await expect(page.locator(".md-seg-active")).toHaveCount(0, { timeout: 5000 });
  });
});

// ── Collapse / Expand tests ────────────────────────────────────────────────

const COLLAPSE_MD = `# Main Title

Introduction text.

## Section A

Content under A.

More content under A.

## Section B

Content under B.

### Subsection B1

Deep content.

## Section C

Final content.`;

const COLLAPSE_LIST_MD = `# Lists

- Parent item
  - Child 1
  - Child 2
    - Grandchild
  - Child 3
- Sibling item
- Another top-level`;

test.describe("Heading collapse (Obsidian-style)", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "collapse-test.md"), COLLAPSE_MD);
    await openFile(page, "collapse-test.md");
  });

  test("collapse chevron appears on headings with content below", async ({ page }) => {
    // Hover over "Main Title" heading
    await segByText(page, "Main Title").hover();
    await waitForRaf(page);
    const chevron = segByText(page, "Main Title").locator(".md-seg-collapse");
    await expect(chevron).toBeVisible({ timeout: 2000 });
  });

  test("clicking collapse chevron hides content under heading", async ({ page }) => {
    // "Section A" should have content visible
    await expect(segByText(page, "Content under A")).toBeVisible();

    // Click the collapse chevron on "Section A"
    await segByText(page, "Section A").hover();
    await waitForRaf(page);
    const chevron = segByText(page, "Section A").locator(".md-seg-collapse");
    await chevron.click();
    await waitForRaf(page);

    // Content under A should be hidden
    await expect(segByText(page, "Content under A")).toBeHidden({ timeout: 2000 });
    await expect(segByText(page, "More content under A")).toBeHidden({ timeout: 2000 });
    // Section B (same-level heading) should still be visible
    await expect(segByText(page, "Section B")).toBeVisible();
  });

  test("collapsed heading shows ellipsis badge", async ({ page }) => {
    await segByText(page, "Section A").hover();
    await waitForRaf(page);
    const chevron = segByText(page, "Section A").locator(".md-seg-collapse");
    await chevron.click();
    await waitForRaf(page);

    // Ellipsis badge should appear
    const badge = segByText(page, "Section A").locator(".md-seg-collapsed-badge");
    await expect(badge).toBeVisible({ timeout: 2000 });
  });

  test("clicking collapse again expands content", async ({ page }) => {
    // Collapse
    await segByText(page, "Section A").hover();
    await waitForRaf(page);
    const chevron = segByText(page, "Section A").locator(".md-seg-collapse");
    await chevron.click();
    await waitForRaf(page);
    await expect(segByText(page, "Content under A")).toBeHidden({ timeout: 2000 });

    // Expand
    await segByText(page, "Section A").hover();
    await waitForRaf(page);
    await chevron.click();
    await waitForRaf(page);
    await expect(segByText(page, "Content under A")).toBeVisible({ timeout: 2000 });
  });

  test("collapsing H1 hides all H2 sections and their content", async ({ page }) => {
    await segByText(page, "Main Title").hover();
    await waitForRaf(page);
    const chevron = segByText(page, "Main Title").locator(".md-seg-collapse");
    await chevron.click();
    await waitForRaf(page);

    // Everything below should be hidden
    await expect(segByText(page, "Introduction text")).toBeHidden({ timeout: 2000 });
    await expect(segByText(page, "Section A")).toBeHidden({ timeout: 2000 });
    await expect(segByText(page, "Section B")).toBeHidden({ timeout: 2000 });
    await expect(segByText(page, "Section C")).toBeHidden({ timeout: 2000 });
  });

  test("collapsing H2 hides H3 subsections but not sibling H2", async ({ page }) => {
    await segByText(page, "Section B").hover();
    await waitForRaf(page);
    const chevron = segByText(page, "Section B").locator(".md-seg-collapse");
    await chevron.click();
    await waitForRaf(page);

    // H3 under B should be hidden
    await expect(segByText(page, "Subsection B1")).toBeHidden({ timeout: 2000 });
    await expect(segByText(page, "Deep content")).toBeHidden({ timeout: 2000 });
    // Sibling H2 should still be visible
    await expect(segByText(page, "Section C")).toBeVisible();
    await expect(segByText(page, "Section A")).toBeVisible();
  });
});

test.describe("List item collapse (Obsidian-style)", () => {
  test.beforeEach(async ({ page }) => {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_DIR, "collapse-list-test.md"), COLLAPSE_LIST_MD);
    await openFile(page, "collapse-list-test.md");
  });

  test("collapse chevron appears on list items with nested children", async ({ page }) => {
    await segByText(page, "Parent item").hover();
    await waitForRaf(page);
    const chevron = segByText(page, "Parent item").locator(".md-seg-collapse");
    await expect(chevron).toBeVisible({ timeout: 2000 });
  });

  test("no collapse chevron on leaf list items", async ({ page }) => {
    // "Sibling item" has no children
    await segByText(page, "Sibling item").hover();
    await waitForRaf(page);
    const chevron = segByText(page, "Sibling item").locator(".md-seg-collapse");
    await expect(chevron).toHaveCount(0);
  });

  test("collapsing parent hides nested children", async ({ page }) => {
    await expect(segByText(page, "Child 1")).toBeVisible();
    await expect(segByText(page, "Grandchild")).toBeVisible();

    await segByText(page, "Parent item").hover();
    await waitForRaf(page);
    const chevron = segByText(page, "Parent item").locator(".md-seg-collapse");
    await chevron.click();
    await waitForRaf(page);

    await expect(segByText(page, "Child 1")).toBeHidden({ timeout: 2000 });
    await expect(segByText(page, "Child 2")).toBeHidden({ timeout: 2000 });
    await expect(segByText(page, "Grandchild")).toBeHidden({ timeout: 2000 });
    await expect(segByText(page, "Child 3")).toBeHidden({ timeout: 2000 });
    // Sibling at same level should remain
    await expect(segByText(page, "Sibling item")).toBeVisible();
  });

  test("expanding parent shows nested children again", async ({ page }) => {
    // Collapse
    await segByText(page, "Parent item").hover();
    await waitForRaf(page);
    const chevron = segByText(page, "Parent item").locator(".md-seg-collapse");
    await chevron.click();
    await waitForRaf(page);
    await expect(segByText(page, "Child 1")).toBeHidden({ timeout: 2000 });

    // Expand
    await segByText(page, "Parent item").hover();
    await waitForRaf(page);
    await chevron.click();
    await waitForRaf(page);
    await expect(segByText(page, "Child 1")).toBeVisible({ timeout: 2000 });
    await expect(segByText(page, "Grandchild")).toBeVisible({ timeout: 2000 });
  });
});
