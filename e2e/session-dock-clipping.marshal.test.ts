/**
 * ISOLATED E2E for the session dock's clipping: dockview stops resizing hidden
 * tabs, so after the window shrinks they stick out below the dock. They must
 * not make the app's `main` scrollable: scrolled, it hides the tab strip and
 * leaves a blank band under the composer until those tabs are closed.
 *
 * Run:
 *   mkdir -p /private/tmp/session-dock-clip-run/temp
 *   TMPDIR=/private/tmp/session-dock-clip-run/temp \
 *     MARSHAL_PLACEMENT_RUN_ROOT=/private/tmp/session-dock-clip-run \
 *     pnpm test:e2e:file e2e/session-dock-clipping.marshal.test.ts
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  acceptanceWorkspaceRoot,
  invokeCapability,
  layoutViews,
  requireRunRoot,
  requireView,
} from "./helpers/session-views";
import { launchPersistentE2EApp, seedTestData } from "./marshal-fixtures";

const RUN_ROOT = requireRunRoot();

test("hidden tabs left oversized by a window shrink cannot scroll the dock", async () => {
  test.setTimeout(120_000);
  seedTestData();
  const app = await launchPersistentE2EApp({
    userDataDir: path.join(RUN_ROOT, "user-data-clipping"),
    seed: false,
    extraEnv: {
      MARSHAL_RUNTIME_ACCEPTANCE: "1",
      MARSHAL_RUNTIME_ACCEPTANCE_TOKEN: randomBytes(16).toString("hex"),
      MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT: RUN_ROOT,
    },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.getByTestId("session-dock")).toBeVisible({ timeout: 60_000 });

    const workspaceRoot = await acceptanceWorkspaceRoot(page);
    const documentPath = path.join(workspaceRoot, "clip-tab.md");
    fs.writeFileSync(documentPath, "# Clip\n\nHidden tab.\n");
    await invokeCapability(
      page,
      "ui.document.open",
      { path: documentPath, idempotencyKey: "open" },
      "open",
    );
    const view = requireView(await layoutViews(page), "clip-tab");
    await invokeCapability(
      page,
      "ui.view.move",
      { instanceId: view.instanceId, placement: "chat-tab" },
      "move",
    );

    const tabs = page.getByTestId("session-dock-tab");
    await expect(tabs.filter({ hasText: "clip-tab.md" })).toHaveCount(1);
    await tabs.filter({ hasText: "Chat" }).first().click();
    await page.setViewportSize({ width: 1400, height: 780 });
    const main = page.locator("main");
    await expect
      .poll(() => main.evaluate((element) => element.getBoundingClientRect().bottom))
      .toBeLessThanOrEqual(780);
    await expect
      .poll(() =>
        page
          .getByTestId("session-dock-chat")
          .evaluate((element) => element.getBoundingClientRect().bottom),
      )
      .toBeLessThanOrEqual(780);

    const stripTop = () =>
      page.evaluate(
        () => document.querySelector(".dv-tabs-and-actions-container")?.getBoundingClientRect().top,
      );
    const topBefore = await stripTop();
    const after = await main.evaluate((element) => {
      element.scrollTop = 9_999;
      return {
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    });
    expect(after.scrollHeight).toBe(after.clientHeight);
    expect(after.scrollTop).toBe(0);
    expect(await stripTop()).toBe(topBefore);
    await expect(tabs.filter({ hasText: "Chat" }).first()).toBeInViewport();
  } finally {
    await app.close();
  }
});
