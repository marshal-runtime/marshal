// eslint-disable-next-line typescript/triple-slash-reference -- Electron preload globals are declared in an ambient script, not an importable module.
/// <reference path="../electron/electron-env.d.ts" />
import { readFileSync } from "node:fs";

import { chromium, webkit, type Browser } from "@playwright/test";

import type {} from "../src/remote/types";
import type {} from "../src/vite-env";
import { chatInput } from "./helpers/marshal-chat-input";
import { test, expect } from "./marshal-fixtures";

for (const engine of [chromium, webkit])
  test(`${engine.name()} phone view authenticates, shares chat, sends, and recovers after reconnect`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const state = await page.evaluate(() =>
      window.remoteAccessAPI!.configure({ enabled: true, origin: "" }),
    );
    expect(state.running, state.error).toBe(true);
    let browser: Browser | undefined;
    try {
      browser = await engine.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 393, height: 852 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      });
      const phone = await context.newPage();
      const errors: string[] = [];
      const startupAssets: string[] = [];
      const recordStartupAsset = (request: { url(): string }) => startupAssets.push(request.url());
      phone.on("request", recordStartupAsset);
      phone.on("pageerror", (error) => errors.push(error.message));
      // eslint-disable-next-line playwright/no-conditional-in-test -- Exercise both supported login paths across the browser matrix.
      if (engine.name() === "webkit") {
        await phone.goto(`http://127.0.0.1:7332/#key=${encodeURIComponent(state.accessKey)}`);
      } else {
        await phone.goto("http://127.0.0.1:7332");
        await phone.getByLabel("Access key from Marshal settings").fill(state.accessKey);
        await phone.getByRole("button", { name: "Connect to Mac" }).click();
      }
      await expect(phone).toHaveURL("http://127.0.0.1:7332/");
      await expect(phone.getByRole("dialog", { name: "Conversations" })).toBeVisible();
      phone.off("request", recordStartupAsset);
      // Desktop editors must stay lazy: a phone should be usable before these
      // multi-megabyte bundles are downloaded, even on a fresh browser cache.
      expect(
        startupAssets.filter((url) => /\/(?:MonacoEditor|editor\.api|FilePreview)-/.test(url)),
      ).toEqual([]);
      await phone.getByRole("button", { name: "New conversation", exact: false }).click();
      await chatInput(phone).waitFor();
      const peer = await context.newPage();
      await peer.goto("http://127.0.0.1:7332");
      await chatInput(peer).waitFor();
      await phone.bringToFront();
      await phone.locator('input[type="file"]').setInputFiles([
        {
          name: "phone-notes.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Attachment from iPhone"),
        },
        {
          name: "phone-photo.png",
          mimeType: "image/png",
          buffer: readFileSync("public/remote-icon.png"),
        },
      ]);
      await expect(
        phone.getByTestId("visible-row").getByText("phone-notes.txt", { exact: true }),
      ).toBeVisible();
      await expect(
        phone.getByTestId("visible-row").getByAltText("phone-photo.png", { exact: true }),
      ).toBeVisible();
      await chatInput(phone).fill("Remote phone acceptance: explain the auth system");
      // Phone keyboards use Return for a newline; submit through the touch control.
      await phone.getByRole("button", { name: "Send", exact: true }).click();
      await expect(phone.locator('[data-testid="message-user"]').first()).toBeVisible();
      await expect(phone.locator('[data-testid="message-assistant"]').first()).toBeVisible({
        timeout: 30000,
      });
      await expect(
        peer.locator('[data-testid="message-user"]').filter({ hasText: "Remote phone acceptance" }),
      ).toBeVisible();
      await peer.close();
      await expect(phone.getByTestId("assistant-run-avatar").first()).toBeHidden();
      const replyText = phone.getByTestId("message-assistant").getByTestId("message-text").first();
      await expect(replyText).toBeVisible();
      const replyBounds = await replyText.boundingBox();
      expect(replyBounds!.x).toBeLessThanOrEqual(13);
      expect(replyBounds!.width).toBeGreaterThanOrEqual(367);
      await phone.screenshot({ path: testInfo.outputPath("phone-chat.png"), fullPage: true });
      expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        393,
      );
      await phone.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(phone.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
      await chatInput(phone).fill("Draft survives refresh");
      await phone.reload();
      await expect(chatInput(phone)).toContainText("Draft survives refresh");
      // WebKit's emulated offline mode leaves localhost sockets usable, and a brief
      // blip no longer shows the banner, so make the Mac genuinely unreachable.
      await page.evaluate(() => window.remoteAccessAPI!.configure({ enabled: false, origin: "" }));
      await expect(phone.locator('.remote-banner[role="status"]')).toContainText(
        "Waiting for connection",
      );
      await page.evaluate(() => window.remoteAccessAPI!.configure({ enabled: true, origin: "" }));
      await expect(
        phone.locator(".remote-shell > .remote-header small").filter({ hasText: "General ·" }),
      ).toBeVisible({
        timeout: 15000,
      });
      await expect(chatInput(phone)).toContainText("Draft survives refresh");
      await phone.setViewportSize({ width: 852, height: 393 });
      await expect(phone.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await phone.screenshot({ path: testInfo.outputPath("phone-landscape.png"), fullPage: true });
      await phone.getByRole("button", { name: "Send", exact: true }).click();
      await expect
        .poll(() =>
          phone.evaluate(async () => {
            const id = localStorage.getItem("marshal.remote.session")!;
            const result = await window.sessionsAPI.get(id);
            return result.session?.messages.some(
              (message) => message.role === "user" && message.content === "Draft survives refresh",
            );
          }),
        )
        .toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      await page.evaluate(() => window.remoteAccessAPI!.configure({ enabled: false, origin: "" }));
    }
  });

test("phone receives and resolves live permissions after the Mac window closes", async ({
  page,
  app,
}, testInfo) => {
  // eslint-disable-next-line playwright/no-skipped-test -- Closing all windows exits the app on non-Mac platforms.
  test.skip(process.platform !== "darwin", "Mac window-close lifecycle");
  test.setTimeout(90_000);
  const state = await page.evaluate(() =>
    window.remoteAccessAPI!.configure({ enabled: true, origin: "" }),
  );
  expect(state.running, state.error).toBe(true);
  const browser = await webkit.launch({ headless: true });
  try {
    const phone = await browser.newPage({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
    });
    const errors: string[] = [];
    phone.on("pageerror", (e) => errors.push(e.message));
    await phone.goto("http://127.0.0.1:7332");
    await phone.getByLabel("Access key from Marshal settings").fill(state.accessKey);
    await phone.getByRole("button", { name: "Connect to Mac" }).click();
    const before = await page
      .locator('[data-testid="session-item"][data-active=true]')
      .getAttribute("data-session-id");
    await phone.getByRole("button", { name: "New conversation", exact: false }).click();
    await chatInput(phone).waitFor();
    await expect(page.locator('[data-testid="session-item"][data-active=true]')).toHaveAttribute(
      "data-session-id",
      before!,
    );
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.close();
    });
    await chatInput(phone).fill("permission test");
    await chatInput(phone).press("Enter");
    const shell = phone.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="shell"]',
    );
    await expect(shell).toBeVisible({ timeout: 20000 });
    await phone.screenshot({ path: testInfo.outputPath("phone-approval.png"), fullPage: true });
    await shell.getByRole("button", { name: "Allow once" }).click();
    const write = phone.locator(
      '[data-testid="permission-card"]:not([data-resolved])[data-kind="write"]',
    );
    await expect(write).toBeVisible({ timeout: 15000 });
    await write.getByRole("button", { name: "Not now" }).click();
    await expect(phone.locator('[data-testid="permission-card"]:not([data-resolved])')).toHaveCount(
      0,
      { timeout: 10000 },
    );
    await expect(
      phone.locator('[data-testid="message-assistant"]').filter({ hasText: /cleaned up|report/i }),
    ).toBeVisible({ timeout: 15000 });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
