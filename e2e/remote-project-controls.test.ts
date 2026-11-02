// eslint-disable-next-line typescript/triple-slash-reference -- Electron preload globals are ambient.
/// <reference path="../electron/electron-env.d.ts" />
import { webkit } from "@playwright/test";

import type {} from "../src/remote/types";
import { chatInput } from "./helpers/marshal-chat-input";
import { test, expect } from "./marshal-fixtures";

test("phone collapses projects, persists pins, creates project chats and preserves project drafts", async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
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
    await phone.getByRole("button", { name: "Collapse General", exact: true }).tap();
    await expect(
      phone.getByRole("button", { name: "Expand General", exact: true }),
    ).toHaveAttribute("aria-expanded", "false");
    await phone.reload();
    await expect(phone.getByRole("button", { name: "Expand General", exact: true })).toBeVisible();
    await phone.getByRole("button", { name: "Expand General", exact: true }).tap();
    await phone.getByRole("button", { name: "New chat in General", exact: true }).tap();
    await expect(
      phone.getByRole("button", { name: "Project: General", exact: true }),
    ).toBeEnabled();
    const id = await phone.evaluate(() => localStorage.getItem("marshal.remote.session")!);
    await phone.evaluate(async (sessionId) => {
      await window.sessionsAPI.rename(sessionId, "Phone pinned project test");
    }, id);
    await phone.getByRole("button", { name: "Show sessions", exact: true }).tap();
    await phone.getByRole("button", { name: "Pin Phone pinned project test", exact: true }).tap();
    await expect(
      phone.getByRole("button", { name: "Unpin Phone pinned project test", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        phone.evaluate(
          async (sessionId) =>
            (await window.sessionsAPI.list()).sessions?.find((s) => s.id === sessionId)?.isPinned,
          id,
        ),
      )
      .toBe(true);
    await phone.reload();
    await phone.getByRole("button", { name: "Show sessions", exact: true }).tap();
    await phone.getByRole("button", { name: "Unpin Phone pinned project test", exact: true }).tap();
    await expect
      .poll(() =>
        phone.evaluate(
          async (sessionId) =>
            (await window.sessionsAPI.list()).sessions?.find((s) => s.id === sessionId)?.isPinned,
          id,
        ),
      )
      .toBe(false);
    const projects = await phone.evaluate(
      async () => (await window.workspaceAPI.listWorkspaces()).workspaces ?? [],
    );
    expect(projects.length).toBeGreaterThan(0);
    const name = projects[0];
    const desktopSelection = await page
      .locator('[data-testid="session-item"][data-active=true]')
      .getAttribute("data-session-id");
    await phone.getByRole("button", { name: `New chat in ${name}`, exact: true }).tap();
    await expect(
      phone.getByRole("button", { name: `Project: ${name}`, exact: true }),
    ).toBeEnabled();
    await chatInput(phone).fill("Keep my project draft");
    await phone
      .getByTestId("chat-file-input")
      .setInputFiles({
        name: "draft.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("project attachment"),
      });
    await expect(
      phone.getByTestId("visible-row").getByText("draft.txt", { exact: true }),
    ).toBeVisible();
    await phone.getByRole("button", { name: `Project: ${name}`, exact: true }).tap();
    await phone.getByRole("menuitemradio", { name: "General", exact: true }).tap();
    await expect(
      phone.getByRole("button", { name: "Project: General", exact: true }),
    ).toBeEnabled();
    await expect(chatInput(phone)).toContainText("Keep my project draft");
    await expect(
      phone.getByTestId("visible-row").getByText("draft.txt", { exact: true }),
    ).toBeVisible();
    await phone.getByRole("button", { name: "Project: General", exact: true }).tap();
    await phone.getByRole("menuitemradio", { name, exact: true }).tap();
    await expect(
      phone.getByRole("button", { name: `Project: ${name}`, exact: true }),
    ).toBeEnabled();
    await expect(chatInput(phone)).toContainText("Keep my project draft");
    await expect(page.locator('[data-testid="session-item"][data-active=true]')).toHaveAttribute(
      "data-session-id",
      desktopSelection!,
    );
    const current = await phone.evaluate(() => localStorage.getItem("marshal.remote.session")!);
    await expect
      .poll(() =>
        phone.evaluate(
          async (sessionId) => (await window.sessionsAPI.get(sessionId)).session?.workspaceName,
          current,
        ),
      )
      .toBe(name);
    await phone.screenshot({ path: testInfo.outputPath("project-composer.png") });
    await phone.getByRole("button", { name: "Send", exact: true }).tap();
    await expect(
      phone.getByRole("button", { name: `Project: ${name}`, exact: true }),
    ).toBeDisabled();
  } finally {
    await browser.close();
    await page.evaluate(() => window.remoteAccessAPI!.configure({ enabled: false, origin: "" }));
  }
});
