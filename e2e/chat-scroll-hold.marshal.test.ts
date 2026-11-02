/**
 * A reader who scrolled up stays on the message they are reading while new ones
 * arrive. Each arrival used to trim the oldest rows from the 20-message window,
 * which moved the text and, within 70px of the bottom, re-locked the view there.
 *
 * Run: node node_modules/@playwright/test/cli.js test --retries 0 e2e/chat-scroll-hold.marshal.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { E2E_DATA_DIR } from "../electron/mock-mode";
import { launchPersistentE2EApp, seedTestData } from "./marshal-fixtures";

function seedLongConversation() {
  const file = path.join(E2E_DATA_DIR, "marshal-sessions", "e2e-fresh.json");
  const session: Record<string, unknown> = JSON.parse(fs.readFileSync(file, "utf8"));
  const base = Date.now() - 3_600_000;
  const paragraph = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(12);
  session.messages = Array.from({ length: 40 }, (_, index) => ({
    id: `seed-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Marker ${index}. ${paragraph}\n\n${paragraph}`,
    timestamp: new Date(base + index * 60_000).toISOString(),
  }));
  fs.writeFileSync(file, JSON.stringify(session));
}

const position = (page: Page) =>
  page.getByTestId("messages-container").evaluate((element) => {
    const containerTop = element.getBoundingClientRect().top;
    const rows = [...element.querySelectorAll('[data-testid="timeline-virtual-row"]')];
    const anchor = rows.find((row) => row.getBoundingClientRect().bottom > containerTop + 40);
    return {
      fromBottom: Math.round(element.scrollHeight - element.scrollTop - element.clientHeight),
      height: element.scrollHeight,
      anchorText: anchor?.textContent?.match(/Marker \d+\.|arrival \d+/)?.[0] ?? null,
      anchorTop: Math.round(anchor?.getBoundingClientRect().top ?? 0),
    };
  });

async function arrival(page: Page, text: string) {
  await page.evaluate(async (body) => {
    const api: {
      send: (text: string, sessionId: string, files: undefined, id: string) => Promise<unknown>;
    } = Reflect.get(window, "copilotAPI");
    await api.send(body, "e2e-fresh", undefined, crypto.randomUUID());
  }, text);
}

async function goToBottom(page: Page) {
  await page.getByTestId("messages-container").hover();
  await page.mouse.wheel(0, 200_000);
  await expect.poll(async () => (await position(page)).fromBottom).toBeLessThanOrEqual(2);
}

async function expectHeldThroughArrival(page: Page, scrollUp: number, label: string) {
  await goToBottom(page);
  await page.mouse.wheel(0, -scrollUp);
  await expect.poll(async () => (await position(page)).fromBottom).toBeGreaterThan(scrollUp / 2);
  await expect
    .poll(async () => {
      const first = await position(page);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      return first.anchorTop === (await position(page)).anchorTop;
    })
    .toBe(true);
  const before = await position(page);

  await arrival(page, label);
  await expect.poll(async () => (await position(page)).height).toBeGreaterThan(before.height);

  const after = await position(page);
  expect(after.anchorText).toBe(before.anchorText);
  expect(Math.abs(after.anchorTop - before.anchorTop)).toBeLessThanOrEqual(2);
  expect(after.fromBottom).toBeGreaterThan(before.fromBottom);
}

test("scrolled-up reader is held through arrivals until they return to the bottom", async () => {
  test.setTimeout(120_000);
  seedTestData();
  seedLongConversation();
  const app = await launchPersistentE2EApp({
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "chat-scroll-hold-")),
    seed: false,
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.getByText("Marker 39.")).toBeVisible({ timeout: 60_000 });

    await expectHeldThroughArrival(page, 1500, "arrival 1");
    await expectHeldThroughArrival(page, 200, "arrival 2");
    await expectHeldThroughArrival(page, 60, "arrival 3");

    await goToBottom(page);
    const beforeFollow = await position(page);
    await arrival(page, "arrival 4");
    await expect.poll(async () => (await position(page)).height).not.toBe(beforeFollow.height);
    await expect.poll(async () => (await position(page)).fromBottom).toBeLessThanOrEqual(2);
  } finally {
    await app.close();
  }
});
