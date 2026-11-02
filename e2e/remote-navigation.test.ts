// eslint-disable-next-line typescript/triple-slash-reference -- Electron preload globals are ambient.
/// <reference path="../electron/electron-env.d.ts" />
import { webkit } from "@playwright/test";

import type {} from "../src/remote/types";
import { chatInput } from "./helpers/marshal-chat-input";
import { test, expect } from "./marshal-fixtures";

test("mobile full-screen projects, search, app setup and panned keyboard viewport", async ({
  page,
}, testInfo) => {
  const state = await page.evaluate(() =>
    window.remoteAccessAPI!.configure({ enabled: true, origin: "" }),
  );
  const browser = await webkit.launch();
  try {
    const phone = await browser.newPage({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
    });
    await phone.goto(`http://127.0.0.1:${state.port}/#key=${encodeURIComponent(state.accessKey)}`);
    const list = phone.getByRole("dialog", { name: "Conversations", exact: true });
    await expect(list).toBeVisible();
    await expect.poll(async () => (await list.boundingBox())?.width).toBe(393);
    await expect(phone.locator(".remote-conversations .remote-header small")).not.toHaveText(
      /Your Mac$/,
    );
    await phone.getByRole("button", { name: "New conversation", exact: true }).tap();
    await chatInput(phone).waitFor();
    const id = await phone.evaluate(() => localStorage.getItem("marshal.remote.session")!);
    await phone.evaluate(async (sessionId) => {
      await window.sessionsAPI.rename(sessionId, "Mobile search unique title");
    }, id);
    await phone.getByRole("button", { name: "Show sessions" }).tap();
    await phone.getByRole("searchbox", { name: "Search chats" }).fill("Mobile search unique title");
    await expect(
      list.getByRole("button").filter({ hasText: "Mobile search unique title" }),
    ).toHaveCount(1);
    await phone.getByRole("searchbox", { name: "Search chats" }).fill("");
    await phone.getByRole("button", { name: "Open navigation" }).tap();
    await phone.getByRole("button", { name: "Projects", exact: true }).tap();
    await expect(phone.getByRole("navigation", { name: "Projects" })).toBeVisible();
    await phone.getByRole("navigation", { name: "Projects" }).getByRole("button").first().tap();
    await expect(phone.getByRole("button", { name: "All chats", exact: false })).toBeVisible();
    await phone.getByRole("button", { name: "Open navigation" }).tap();
    await phone.getByRole("button", { name: "This computer & app setup" }).tap();
    await expect(phone.getByText("Add Marshal to your Home Screen", { exact: true })).toBeVisible();
    await phone.getByRole("button", { name: "Close sessions" }).tap();
    await chatInput(phone).fill("Keep the composer visible");
    // Simulate iOS moving the visual viewport as well as shrinking it.
    await phone.evaluate(() => {
      const v = window.visualViewport!;
      Object.defineProperty(v, "height", { configurable: true, value: 420 });
      Object.defineProperty(v, "offsetTop", { configurable: true, value: 190 });
      v.dispatchEvent(new Event("resize"));
      v.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(async () => (await phone.locator("#root").boundingBox())?.y).toBe(190);
    const header = await phone.locator(".remote-shell > .remote-header").boundingBox();
    const send = await phone.getByTestId("send-btn").boundingBox();
    expect(header!.y).toBeGreaterThanOrEqual(190);
    expect(send!.y + send!.height).toBeLessThanOrEqual(610);
    await expect(chatInput(phone)).toContainText("Keep the composer visible");
    await phone.evaluate(() => {
      const v = window.visualViewport!;
      Object.defineProperty(v, "height", { configurable: true, value: 852 });
      Object.defineProperty(v, "offsetTop", { configurable: true, value: 0 });
      v.dispatchEvent(new Event("resize"));
      v.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(async () => (await phone.locator("#root").boundingBox())?.y).toBe(0);
    await phone.getByTestId("send-btn").tap();
    await phone.getByRole("button", { name: "Show sessions" }).tap();
    const row = phone.locator(`[data-session-id="${id}"]`);
    await expect(row.locator(".remote-unread")).toBeVisible({ timeout: 20000 });
    await row.locator(".remote-session-open").tap();
    await expect
      .poll(() =>
        phone.evaluate(
          async (sessionId) =>
            (await window.sessionsAPI.list()).sessions?.find((session) => session.id === sessionId)
              ?.hasUnread,
          id,
        ),
      )
      .toBe(false);
    await phone.getByRole("button", { name: "Show sessions" }).tap();
    await expect(row.locator(".remote-unread")).toHaveCount(0);
    await phone.screenshot({ path: testInfo.outputPath("full-screen-chats.png") });
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBe(393);
  } finally {
    await browser.close();
    await page.evaluate(() => window.remoteAccessAPI!.configure({ enabled: false, origin: "" }));
  }
});
