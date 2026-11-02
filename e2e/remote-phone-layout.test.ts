// eslint-disable-next-line typescript/triple-slash-reference -- Electron globals.
/// <reference path="../electron/electron-env.d.ts" />
import { webkit, type Locator } from "@playwright/test";

import type {} from "../src/remote/types";
import type {} from "../src/vite-env";
import { chatInput } from "./helpers/marshal-chat-input";
import { test, expect } from "./marshal-fixtures";

test("phone touch navigation, model selection, and approvals fit small and reduced-height viewports", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const state = await page.evaluate(() =>
    window.remoteAccessAPI!.configure({ enabled: true, origin: "" }),
  );
  expect(state.running, state.error).toBe(true);
  const browser = await webkit.launch({ headless: true });
  try {
    const phone = await browser.newPage({
      viewport: { width: 375, height: 667 },
      isMobile: true,
      hasTouch: true,
    });
    const errors: string[] = [];
    phone.on("pageerror", (error) => errors.push(error.message));
    const visibleBounds = async (locator: Locator, minHeight = 0) => {
      await expect(locator).toBeVisible();
      expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        phone.viewportSize()!.width,
      );
      const box = await locator.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(phone.viewportSize()!.width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(phone.viewportSize()!.height + 1);
      expect(box!.height).toBeGreaterThanOrEqual(minHeight);
      return box;
    };
    await phone.goto(`http://127.0.0.1:7332/#key=${encodeURIComponent(state.accessKey)}`);
    await phone.getByRole("button", { name: "New conversation", exact: false }).tap();
    await chatInput(phone).waitFor();
    const first = await phone.evaluate(() => localStorage.getItem("marshal.remote.session"));
    await phone.getByRole("button", { name: "New chat", exact: true }).tap();
    await expect
      .poll(() => phone.evaluate(() => localStorage.getItem("marshal.remote.session")))
      .not.toBe(first);
    const second = await phone.evaluate(() => localStorage.getItem("marshal.remote.session"));
    await phone.getByRole("button", { name: "Show sessions" }).tap();
    const drawer = phone.getByRole("dialog", { name: "Conversations" });
    await visibleBounds(drawer);
    await phone.screenshot({ path: testInfo.outputPath("phone-375-drawer.png"), fullPage: true });
    await drawer.locator('nav .remote-session-open:not([aria-current="page"])').first().tap();
    await expect(drawer).toHaveCount(0);
    await expect
      .poll(() => phone.evaluate(() => localStorage.getItem("marshal.remote.session")))
      .not.toBe(second);
    await chatInput(phone).fill("Small-screen send after model choice");
    const send = phone.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeEnabled();
    await visibleBounds(send, 44);
    await visibleBounds(phone.getByRole("button", { name: "Models", exact: true }), 44);
    await visibleBounds(phone.getByTestId("attachment-popover"), 44);
    await phone.getByRole("button", { name: "Models", exact: true }).tap();
    const menu = phone.getByRole("menu");
    await visibleBounds(menu);
    await expect(menu).toHaveCSS("opacity", "1");
    await menu.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    await phone.screenshot({ path: testInfo.outputPath("phone-375-models.png"), fullPage: true });
    const model = menu.locator('[role="menuitemradio"][aria-checked="false"]').first();
    const modelLabel = await model.innerText();
    const modelBounds = await visibleBounds(model, 44);
    await model.tap();
    await expect(menu).toHaveCount(0);
    await phone.getByRole("button", { name: "Models", exact: true }).tap();
    await expect(menu.getByRole("menuitemradio").filter({ hasText: modelLabel })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await phone.keyboard.press("Escape");
    await phone.setViewportSize({ width: 393, height: 500 });
    await expect(send).toBeEnabled();
    const sendBounds = await visibleBounds(send, 44);
    await visibleBounds(chatInput(phone));
    await phone.screenshot({
      path: testInfo.outputPath("phone-reduced-height-compose.png"),
      fullPage: true,
    });
    const surface = await phone.getByTestId("chat-composer-surface").boundingBox();
    expect(Math.abs(500 - surface!.y - surface!.height)).toBeLessThanOrEqual(1);
    expect(surface!.height).toBeLessThanOrEqual(160);
    await chatInput(phone).fill("/");
    const picker = phone.getByTestId("context-picker-menu");
    await visibleBounds(picker);
    const pickerBounds = await picker.boundingBox();
    expect(pickerBounds!.height).toBeLessThan(240);
    await phone.screenshot({ path: testInfo.outputPath("compact-slash-picker.png") });
    await chatInput(phone).fill("@");
    await visibleBounds(picker);
    await picker.getByRole("tab", { name: "Files", exact: true }).tap();
    await expect(picker.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(picker.getByText("/goal", { exact: true })).toHaveCount(0);
    const fileSearch = await phone.evaluate(() => window.workspaceAPI.searchFiles(undefined, ""));
    expect(fileSearch.success, fileSearch.error).toBe(true);
    await expect(
      picker.getByText("Couldn’t search local workspace files.", { exact: true }),
    ).toHaveCount(0);

    await phone.screenshot({ path: testInfo.outputPath("compact-mention-picker.png") });
    await chatInput(phone).fill("Small-screen send after model choice");
    await send.tap();
    await expect(
      phone.getByTestId("message-user").filter({ hasText: "Small-screen send after model choice" }),
    ).toBeVisible();
    await chatInput(phone).fill("Preserved collapsed draft");
    await chatInput(phone).evaluate((element: HTMLElement) => element.blur());
    const compactComposer = phone.getByTestId("chat-composer-surface");
    await expect
      .poll(async () => (await compactComposer.boundingBox())!.height)
      .toBeLessThanOrEqual(56);
    await visibleBounds(phone.getByTestId("send-btn"), 44);
    await phone.screenshot({ path: testInfo.outputPath("collapsed-composer.png") });
    await chatInput(phone).tap();
    await expect
      .poll(async () => (await compactComposer.boundingBox())!.height)
      .toBeGreaterThan(70);
    await expect(chatInput(phone)).toContainText("Preserved collapsed draft");
    await chatInput(phone).fill("");
    await chatInput(phone).evaluate((element: HTMLElement) => element.blur());
    await visibleBounds(phone.getByTestId("stop-btn"), 44);
    const filter = phone.getByTestId("timeline-filter-trigger");
    await expect(
      phone.locator(".remote-header-actions").getByTestId("timeline-filter-trigger"),
    ).toBeVisible();
    await filter.tap();
    await expect(phone.getByTestId("timeline-filter-popover")).toBeVisible();
    await phone.keyboard.press("Escape");
    await phone.getByRole("button", { name: "Stop", exact: true }).tap();
    const sentSession = await phone.evaluate(() => localStorage.getItem("marshal.remote.session"));
    await phone.getByRole("button", { name: "New chat", exact: true }).tap();
    await expect
      .poll(() => phone.evaluate(() => localStorage.getItem("marshal.remote.session")))
      .not.toBe(sentSession);
    await expect(chatInput(phone)).toBeEmpty();
    await chatInput(phone).fill("permission test");
    await phone.getByRole("button", { name: "Send", exact: true }).tap();
    const shell = phone.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="shell"]',
    );
    await expect(shell).toBeVisible({ timeout: 20000 });
    const runningId = await phone.evaluate(() => localStorage.getItem("marshal.remote.session")!);
    await phone.getByRole("button", { name: "Show sessions" }).tap();
    await expect(
      phone
        .locator(`[data-session-id="${runningId}"]`)
        .getByRole("status", { name: "Running", exact: true }),
    ).toBeVisible();
    await phone.getByRole("button", { name: "Close sessions" }).tap();

    const allow = shell.getByRole("button", { name: "Allow once" });
    await allow.scrollIntoViewIfNeeded();
    const allowBounds = await visibleBounds(allow, 44);
    await visibleBounds(shell.getByRole("button", { name: "Not now" }), 44);
    await visibleBounds(phone.getByRole("button", { name: "Stop", exact: true }), 44);
    await phone.screenshot({
      path: testInfo.outputPath("phone-reduced-height-approval.png"),
      fullPage: true,
    });
    await phone.setViewportSize({ width: 393, height: 852 });
    await expect
      .poll(() =>
        phone.evaluate(() => document.documentElement.style.getPropertyValue("--remote-height")),
      )
      .toBe("852px");
    await phone.evaluate(() =>
      document.documentElement.style.setProperty("--remote-height", "500px"),
    );
    await expect(phone.locator(".remote-shell")).toHaveCSS("height", "500px");
    await allow.scrollIntoViewIfNeeded();
    const keyboardAllow = await visibleBounds(allow, 44);
    expect(
      await allow.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
        );
      }),
    ).toBe(true);
    const keyboardStop = await visibleBounds(
      phone.getByRole("button", { name: "Stop", exact: true }),
      44,
    );
    await phone.screenshot({
      path: testInfo.outputPath("phone-simulated-keyboard-approval.png"),
      fullPage: true,
    });
    expect(keyboardAllow!.y + keyboardAllow!.height).toBeLessThanOrEqual(500);
    expect(keyboardStop!.y + keyboardStop!.height).toBeLessThanOrEqual(500);
    await phone.setViewportSize({ width: 852, height: 393 });
    await expect
      .poll(() =>
        phone.evaluate(() => document.documentElement.style.getPropertyValue("--remote-height")),
      )
      .toBe("393px");
    await allow.scrollIntoViewIfNeeded();
    await visibleBounds(allow, 44);
    await visibleBounds(phone.getByRole("button", { name: "Stop", exact: true }), 44);
    await phone.screenshot({
      path: testInfo.outputPath("phone-landscape-approval.png"),
      fullPage: true,
    });
    await allow.tap();
    const write = phone.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="write"]',
    );
    await expect(write).toBeVisible({ timeout: 15000 });
    await write.getByRole("button", { name: "Not now" }).tap();
    await expect(phone.locator('[data-testid="permission-card"]:not([data-resolved])')).toHaveCount(
      0,
    );
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      852,
    );
    expect(errors).toEqual([]);
    await testInfo.attach("touch-observations", {
      body: JSON.stringify(
        { modelLabel, modelBounds, sendBounds, allowBounds, keyboardAllow, keyboardStop, errors },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await browser.close();
    await page.evaluate(() => window.remoteAccessAPI!.configure({ enabled: false, origin: "" }));
  }
});
