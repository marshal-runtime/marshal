import fs from "fs";
import path from "path";

import type { Page } from "@playwright/test";

import { E2E_DATA_DIR } from "../electron/mock-mode";
import { test, expect } from "./marshal-fixtures";
import { chatInput } from "./helpers/marshal-chat-input";
import { openMoreMenuItem } from "./helpers/marshal-nav";

const SETTINGS_FILE = path.join(E2E_DATA_DIR, "marshal-settings.json");

/**
 * E2E coverage for the "Allow everywhere" pattern-generalisation feature
 * (wire action: `always-allow`).
 *
 * Three flows:
 *   1. Settings → Shell Commands: add / edit-in-place / Escape / blur-with-Remove race.
 *   2. Auto-approve read-only: toggle ON suppresses the card; toggle OFF shows it again.
 *   3. Pattern persistence end-to-end: mocked classifier produces a writes-category
 *      classification; clicking "Allow everywhere" persists the classifier's pattern
 *      (not the literal command) to Settings → Permissions → Shell Commands.
 */

async function openPermissions(page: Page) {
  await (await openMoreMenuItem(page, /Settings/)).click();
  await page.getByTestId("manage-permissions-btn").click();
  await expect(page.getByText("Approved patterns")).toBeVisible();
}

async function closeSettings(page: Page) {
  // Neither the Settings nav button nor the panel Close buttons map cleanly
  // back to the chat view across the two nested panels. Reload the page —
  // E2E fixture's default route returns to chat.
  await page.reload();
  await page.locator("nav[aria-label='Main navigation']").waitFor();
  await chatInput(page).waitFor({ timeout: 10_000 });
}

async function addShellPattern(page: Page, pattern: string) {
  const input = page.getByPlaceholder("e.g., npm run *");
  await input.fill(pattern);
  await input.press("Enter");
}

test.describe("Settings → Shell patterns — edit-in-place", () => {
  test("add / edit / Escape-cancel / blur-with-Remove preserve data correctly", async ({
    page,
  }) => {
    await openPermissions(page);

    await addShellPattern(page, "npm run *");
    const row0 = page.getByTestId("pattern-row-0");
    await expect(row0).toContainText("npm run *");
    await expect(row0.getByText("Literal")).toHaveCount(0);

    await addShellPattern(page, "rm file.txt");
    const row1 = page.getByTestId("pattern-row-1");
    await expect(row1).toContainText("rm file.txt");
    await expect(row1.getByText("Literal")).toBeVisible();

    // Edit row 0 — click the edit trigger (exact match to avoid matching the
    // Remove button whose aria-label also contains the pattern string).
    await row0.getByRole("button", { name: "npm run *", exact: true }).click();
    const editInput = row0.locator("input");
    await editInput.fill("npm run build *");
    await editInput.press("Enter");
    await expect(row0).toContainText("npm run build *");

    // Escape cancels.
    await row0.getByRole("button", { name: "npm run build *", exact: true }).click();
    const editInput2 = row0.locator("input");
    await editInput2.fill("junk-should-not-save");
    await editInput2.press("Escape");
    await expect(row0).toContainText("npm run build *");
    await expect(row0).not.toContainText("junk-should-not-save");

    // Start editing row 0, then click Remove on row 1. Cross-row blur must
    // NOT commit row 0's in-progress edit (onBlur relatedTarget guard).
    await row0.getByRole("button", { name: "npm run build *", exact: true }).click();
    const editInput3 = row0.locator("input");
    await editInput3.fill("should-not-save-either");
    await row1.getByRole("button", { name: "Remove rm file.txt" }).click();

    await expect(page.getByText("rm file.txt")).toHaveCount(0);
    await expect(row0).toContainText("npm run build *");
    await expect(row0).not.toContainText("should-not-save-either");
  });
});

test.describe("Auto-approve read-only", () => {
  test("readonly shell command is suppressed when toggle is ON, card appears when OFF", async ({
    page,
  }) => {
    await openPermissions(page);
    const toggle = page.getByRole("switch").first(); // "Auto-approve read-only operations"
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await closeSettings(page);

    const textarea = chatInput(page);
    await textarea.fill("readonly-shell please");
    await textarea.press("Enter");

    await expect(page.locator('[data-testid="message-assistant"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('[data-testid="permission-card"][data-kind="shell"]')).toHaveCount(0);

    // Toggle OFF — card should appear on the next send.
    await openPermissions(page);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await closeSettings(page);

    await textarea.fill("readonly-shell please 2");
    await textarea.press("Enter");
    await expect(
      page.locator('[data-testid="permission-card"]:not([data-resolved])[data-kind="shell"]'),
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("Card decoupling — slow classifier", () => {
  test("card appears immediately; secondary 'Allow similar actions everywhere' arrives when classifier resolves", async ({
    page,
  }) => {
    const textarea = chatInput(page);
    await textarea.waitFor();
    await textarea.fill("slow-classifier please");
    await textarea.press("Enter");

    // Card must appear before the classifier resolves. Classifier is delayed
    // 2s in the mock; card should appear within a few hundred ms.
    const card = page.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="shell"]',
    );
    await expect(card).toBeVisible({ timeout: 1_500 });

    // Secondary must NOT be visible at t=0 — the classifier hasn't resolved.
    await card.getByTestId("permission-scope-trigger").click();
    await expect(page.getByTestId("allow-broader-pattern")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // After the classifier's 2s delay the secondary should appear with the
    // LLM's broader suggestion ("npm install *" — differs from literal).
    await expect(card.getByText("Writes files")).toBeVisible({ timeout: 10_000 });
    await card.getByTestId("permission-scope-trigger").click();
    await expect(page.getByTestId("allow-broader-pattern")).toBeVisible({ timeout: 5_000 });

    // Deny to clean up so the test doesn't persist a rule.
    await page.keyboard.press("Escape");
    await card.getByRole("button", { name: "Not now" }).click();
  });
});

async function readAllowList(): Promise<string[]> {
  if (!fs.existsSync(SETTINGS_FILE)) return [];
  const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return [];
  const perms = (parsed as { permissions?: { allow?: unknown } }).permissions;
  if (!Array.isArray(perms?.allow)) return [];
  return perms.allow.filter((p): p is string => typeof p === "string");
}

test.describe("Pattern persistence end-to-end", () => {
  test("clicking primary 'Allow everywhere' stores the heuristic-generalised pattern", async ({
    page,
  }) => {
    const textarea = chatInput(page);
    await textarea.waitFor();
    await textarea.fill("classified-write please");
    await textarea.press("Enter");

    const card = page.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="shell"]',
    );
    await card.waitFor({ timeout: 20_000 });

    await card.getByTestId("permission-scope-trigger").click();
    const alwaysAllowBtn = page.getByTestId("allow-primary-pattern");
    await expect(alwaysAllowBtn).toBeVisible();
    // Pattern is not surfaced on the primary button at all.
    await expect(card.getByText("Always allow npm install *")).toHaveCount(0);

    await alwaysAllowBtn.click();

    // Primary stores the heuristic; classifier's broader pattern is NOT stored.
    await expect
      .poll(() => readAllowList(), { timeout: 10_000 })
      .toEqual(["npm install --save-dev *"]);

    await openPermissions(page);
    const firstRow = page.getByTestId("pattern-row-0");
    await expect(firstRow).toContainText("npm install --save-dev *", { timeout: 5_000 });
    await expect(page.getByText("npm install --save-dev lodash")).toHaveCount(0);
  });

  test("clicking secondary 'Allow similar actions everywhere' stores the LLM's broader suggestion", async ({
    page,
  }) => {
    const textarea = chatInput(page);
    await textarea.waitFor();
    await textarea.fill("classified-write please");
    await textarea.press("Enter");

    const card = page.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="shell"]',
    );
    await card.waitFor({ timeout: 20_000 });

    // Wait for the classifier to resolve so the secondary surfaces.
    await expect(card.getByText("Writes files")).toBeVisible({ timeout: 10_000 });
    await card.getByTestId("permission-scope-trigger").click();
    const broader = page.getByTestId("allow-broader-pattern");
    await expect(broader).toBeVisible({ timeout: 5_000 });
    await broader.click();

    // Secondary stores the broader LLM pattern; heuristic primary is NOT stored.
    await expect.poll(() => readAllowList(), { timeout: 10_000 }).toEqual(["npm install *"]);
  });
});
