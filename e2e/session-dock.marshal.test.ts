/**
 * ISOLATED E2E for the session dock: real Electron app in an acceptance-enabled
 * E2E build with a fresh temp userData/run root (never the live profile).
 *
 * Flow: open two documents (two side-dock tabs, nothing replaced) -> read
 * ui.layout.get -> move views with ui.view.move (bottom, chat-tab, floating)
 * -> reload the renderer and prove the arrangement is restored -> drag a tab
 * with the mouse onto the side dock -> widen the side dock by dragging its
 * divider -> restart the app and prove views come back -> drag the floating tab
 * back into the bottom dock -> grow the bottom dock -> maximize and restore it
 * -> float a tab by dropping it on the "Drop here to float" pill -> move the
 * floating window by its grip and resize it from its corner -> maximize by
 * double-click -> close a tab with its ×. Screenshots + JSON evidence go to the
 * run root.
 *
 * Run:
 *   RUNROOT=/private/tmp/session-dock-run; rm -rf $RUNROOT; mkdir -p $RUNROOT/temp
 *   TMPDIR=$RUNROOT/temp MARSHAL_PLACEMENT_RUN_ROOT=$RUNROOT \
 *     pnpm test:e2e:file e2e/session-dock.marshal.test.ts
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  acceptanceWorkspaceRoot,
  dragMouse,
  invokeCapability,
  layoutViews,
  pick,
  requireBox,
  requireRunRoot,
  requireView,
} from "./helpers/session-views";
import { launchPersistentE2EApp, seedTestData } from "./marshal-fixtures";

const RUN_ROOT = requireRunRoot();
const OLD_SIDE_CAP_PX = 720;
const OLD_BOTTOM_CAP_PX = 360;
const evidenceDir = path.join(RUN_ROOT, "dock-evidence");
fs.mkdirSync(evidenceDir, { recursive: true });
const evidence: Record<string, unknown>[] = [];

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(evidenceDir, `${name}.png`) });
}

function viewField(page: Page, instanceId: string, field: "region" | "placement") {
  return async () => {
    const view = (await layoutViews(page)).find((candidate) => candidate.instanceId === instanceId);
    return field === "region" ? view?.dock?.region : view?.placement;
  };
}

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

function launchApp() {
  return launchPersistentE2EApp({
    userDataDir: path.join(RUN_ROOT, "user-data"),
    seed: false,
    extraEnv: {
      MARSHAL_RUNTIME_ACCEPTANCE: "1",
      MARSHAL_RUNTIME_ACCEPTANCE_TOKEN: randomBytes(16).toString("hex"),
      MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT: RUN_ROOT,
    },
  });
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** True when `inner` fills `outer` to within a couple of pixels. */
function covers(inner: Box, outer: Box): boolean {
  return (
    Math.abs(inner.x - outer.x) <= 2 &&
    Math.abs(inner.y - outer.y) <= 2 &&
    inner.width >= outer.width - 2 &&
    inner.height >= outer.height - 2
  );
}

/**
 * True when the element under a point belongs to the maximized tab: its
 * floating frame or the overlay dockview renders its content in.
 */
function maximizedOwns(page: Page, x: number, y: number): Promise<boolean> {
  return page.evaluate(
    (point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      if (!hit) return false;
      if (document.querySelector(".session-dock-maximized")?.contains(hit)) return true;
      return [...document.querySelectorAll(".dv-render-overlay")].some(
        (overlay) => overlay.textContent?.includes("First document.") && overlay.contains(hit),
      );
    },
    { x, y },
  );
}

/** The side dock width the agent's layout report holds (what was saved). */
async function savedSideSize(page: Page): Promise<number> {
  const report = await invokeCapability(page, "ui.layout.get", {}, `side-${Date.now()}`);
  const size = pick(report, "docks", "side", "size");
  return typeof size === "number" ? size : 0;
}

/**
 * A grab point on the dock divider nearest to `at`: a vertical divider near x
 * (grabbed low, below any floating group) or a horizontal one near y.
 */
async function sashNear(
  page: Page,
  axis: "vertical" | "horizontal",
  at: number,
): Promise<{ x: number; y: number }> {
  const found = await page.evaluate(
    ({ vertical, target }) => {
      const sashes = [...document.querySelectorAll(".dv-sash")]
        .map((element) => element.getBoundingClientRect())
        .filter((rect) =>
          vertical
            ? rect.height > rect.width && rect.height > 100
            : rect.width > rect.height && rect.width > 100,
        );
      const center = (rect: DOMRect) =>
        vertical ? rect.x + rect.width / 2 : rect.y + rect.height / 2;
      sashes.sort(
        (left, right) => Math.abs(center(left) - target) - Math.abs(center(right) - target),
      );
      const best = sashes.at(0);
      if (!best) return null;
      return vertical
        ? { x: best.x + best.width / 2, y: best.y + best.height * 0.9 }
        : { x: best.x + best.width * 0.9, y: best.y + best.height / 2 };
    },
    { vertical: axis === "vertical", target: at },
  );
  if (!found) throw new Error(`no ${axis} dock divider found`);
  return found;
}

test("session dock adds tabs, moves, closes, and restores views", async () => {
  seedTestData();
  let app = await launchApp();
  try {
    let page = await app.firstWindow();
    const invoke = (capability: string, input: unknown, key: string) =>
      invokeCapability(page, capability, input, key, evidence);
    page.on("pageerror", (error) => evidence.push({ pageerror: String(error).slice(0, 800) }));
    await page.setViewportSize({ width: 1400, height: 900 }).catch(() => undefined);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("session-dock")).toBeVisible({ timeout: 60_000 });
    await shot(page, "00-initial");

    const workspaceRoot = await acceptanceWorkspaceRoot(page);
    const docA = path.join(workspaceRoot, "dock-alpha.md");
    const docB = path.join(workspaceRoot, "dock-beta.md");
    fs.writeFileSync(docA, "# Alpha\n\nFirst document.\n");
    fs.writeFileSync(docB, "# Beta\n\nSecond document.\n");

    await invoke("ui.document.open", { path: docA, idempotencyKey: "open-a" }, "open-a");
    await invoke("ui.document.open", { path: docB, idempotencyKey: "open-b" }, "open-b");
    const tabs = page.getByTestId("session-dock-tab");
    await expect(tabs.filter({ hasText: "dock-alpha.md" })).toHaveCount(1);
    await expect(tabs.filter({ hasText: "dock-beta.md" })).toHaveCount(1);
    await shot(page, "01-two-docs-side");

    const opened = await layoutViews(page);
    evidence.push({ step: "after-open", views: opened });
    expect(opened.filter((view) => view.placement === "side")).toHaveLength(2);
    const alpha = requireView(opened, "dock-alpha");
    const beta = requireView(opened, "dock-beta");

    await invoke("ui.view.move", { instanceId: alpha.instanceId, placement: "bottom" }, "move-a");
    await expect.poll(viewField(page, alpha.instanceId, "region")).toBe("bottom");
    await shot(page, "02-alpha-bottom");

    await invoke("ui.view.move", { instanceId: beta.instanceId, placement: "chat-tab" }, "move-b");
    await expect.poll(viewField(page, beta.instanceId, "region")).toBe("chat");
    await shot(page, "03-beta-chat-tab");

    await invoke(
      "ui.view.move",
      { instanceId: alpha.instanceId, placement: "floating" },
      "move-a2",
    );
    await expect.poll(viewField(page, alpha.instanceId, "region")).toBe("floating");
    await shot(page, "04-alpha-floating");

    // Reload the renderer: views and their placements come back.
    await page.reload();
    await expect(page.getByTestId("session-dock")).toBeVisible({ timeout: 60_000 });
    await expect(tabs.filter({ hasText: "dock-beta.md" })).toHaveCount(1, { timeout: 30_000 });
    const reloaded = await layoutViews(page);
    evidence.push({ step: "after-reload", views: reloaded });
    expect(requireView(reloaded, "dock-beta").placement).toBe("chat-tab");
    expect(requireView(reloaded, "dock-alpha").placement).toBe("floating");
    await shot(page, "05-after-reload");

    // Real drag: beta's tab from the chat strip onto the side dock, which appears mid-drag.
    const from = await requireBox(tabs.filter({ hasText: "dock-beta.md" }));
    const size = page.viewportSize() ?? { width: 1400, height: 900 };
    await dragMouse(
      page,
      { x: from.x + from.width / 2, y: from.y + from.height / 2 },
      { x: size.width - 160, y: size.height / 2 },
      () => shot(page, "05b-dragging"),
    );
    await expect.poll(viewField(page, beta.instanceId, "region")).toBe("side");
    await expect.poll(viewField(page, beta.instanceId, "placement")).toBe("side");
    await shot(page, "05c-beta-dragged-side");

    // Widen the side dock by dragging its divider far left: it passes the old 720px
    // cap and stops where the chat column reaches its minimum width.
    const sideGroup = page
      .locator(".dv-groupview")
      .filter({ has: tabs.filter({ hasText: "dock-beta.md" }) })
      .last();
    const narrow = await requireBox(sideGroup);
    const sash = await sashNear(page, "vertical", narrow.x);
    const dockBox = await requireBox(page.getByTestId("session-dock"));
    await dragMouse(page, sash, { x: dockBox.x + 60, y: sash.y });
    await expect
      .poll(async () => (await requireBox(sideGroup)).width)
      .toBeGreaterThan(OLD_SIDE_CAP_PX);
    // The chat column is what remains left of the side dock; it keeps its minimum width.
    await expect
      .poll(async () => (await requireBox(sideGroup)).x - dockBox.x)
      .toBeGreaterThanOrEqual(316);
    evidence.push({
      step: "side-resize",
      before: narrow.width,
      after: (await requireBox(sideGroup)).width,
    });
    await shot(page, "05d-side-widened");

    // Restart the whole app on the same profile: views, placements and the dock width come back.
    await expect.poll(viewField(page, beta.instanceId, "placement")).toBe("side");
    await expect.poll(() => savedSideSize(page)).toBeGreaterThan(OLD_SIDE_CAP_PX);
    await app.close();
    app = await launchApp();
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 }).catch(() => undefined);
    await expect(page.getByTestId("session-dock")).toBeVisible({ timeout: 60_000 });
    const relaunchedTabs = page.getByTestId("session-dock-tab");
    await expect(relaunchedTabs.filter({ hasText: "dock-beta.md" })).toHaveCount(1, {
      timeout: 30_000,
    });
    const restarted = await layoutViews(page);
    evidence.push({ step: "after-restart", views: restarted });
    expect(requireView(restarted, "dock-beta").placement).toBe("side");
    expect(requireView(restarted, "dock-alpha").placement).toBe("floating");
    const restartedSide = page
      .locator(".dv-groupview")
      .filter({ has: relaunchedTabs.filter({ hasText: "dock-beta.md" }) })
      .last();
    await expect
      .poll(async () => (await requireBox(restartedSide)).width)
      .toBeGreaterThan(OLD_SIDE_CAP_PX);
    await shot(page, "05e-after-restart");

    // Redock by drag: alpha's tab from its floating window onto the bottom edge under the chat.
    const alphaTab = relaunchedTabs.filter({ hasText: "dock-alpha.md" });
    const alphaFrom = await requireBox(alphaTab);
    const restartedDock = await requireBox(page.getByTestId("session-dock"));
    await dragMouse(
      page,
      { x: alphaFrom.x + alphaFrom.width / 2, y: alphaFrom.y + alphaFrom.height / 2 },
      {
        x: restartedDock.x + 150,
        y: restartedDock.y + restartedDock.height - 40,
      },
    );
    await expect.poll(viewField(page, alpha.instanceId, "region")).toBe("bottom");
    await expect.poll(viewField(page, alpha.instanceId, "placement")).toBe("bottom");
    await shot(page, "05f-alpha-redocked-bottom");

    // Grow the bottom dock past the old 360px cap; the chat keeps its minimum height.
    const bottomGroup = page.locator(".dv-groupview").filter({ has: alphaTab }).last();
    const low = await requireBox(bottomGroup);
    const bottomSash = await sashNear(page, "horizontal", low.y);
    await dragMouse(page, bottomSash, { x: bottomSash.x, y: restartedDock.y + 20 });
    await expect
      .poll(async () => (await requireBox(bottomGroup)).height)
      .toBeGreaterThan(OLD_BOTTOM_CAP_PX);
    await expect
      .poll(async () => (await requireBox(bottomGroup)).y - restartedDock.y)
      .toBeGreaterThanOrEqual(236);
    evidence.push({
      step: "bottom-resize",
      before: low.height,
      after: (await requireBox(bottomGroup)).height,
    });
    await shot(page, "05g-bottom-grown");

    // Maximize the bottom dock over the whole dock area; restore with the button, then with Escape.
    const grown = await requireBox(bottomGroup);
    const maximize = bottomGroup.getByTestId("session-dock-maximize");
    const maximizedFrame = page.locator(".session-dock-maximized");
    const coversDock = async () => covers(await requireBox(maximizedFrame), restartedDock);
    const restoredHeight = async () => Math.round((await requireBox(bottomGroup)).height);
    await maximize.click();
    await expect(maximize).toHaveAttribute("aria-label", "Restore layout");
    await expect.poll(coversDock).toBe(true);
    // Nothing else draws over it, its content renders, and it is not reported as a move.
    await expect(page.getByText("First document.")).toBeVisible();
    const alphaText = await requireBox(page.getByText("First document."));
    const rightEdge = restartedDock.x + restartedDock.width - 40;
    expect(await maximizedOwns(page, rightEdge, restartedDock.y + 18)).toBe(true);
    expect(await maximizedOwns(page, rightEdge, restartedDock.y + restartedDock.height / 2)).toBe(
      true,
    );
    expect(await maximizedOwns(page, alphaText.x + 4, alphaText.y + alphaText.height / 2)).toBe(
      true,
    );
    expect(
      (await layoutViews(page)).find((view) => view.instanceId === alpha.instanceId)?.placement,
    ).toBe("bottom");
    await shot(page, "05h-bottom-maximized");
    await maximize.click();
    await expect(maximize).toHaveAttribute("aria-label", "Maximize");
    await expect.poll(restoredHeight).toBe(Math.round(grown.height));
    await expect.poll(viewField(page, alpha.instanceId, "region")).toBe("bottom");
    await expect(maximizedFrame).toHaveCount(0);
    await shot(page, "05i-bottom-restored");
    await maximize.click();
    await expect.poll(coversDock).toBe(true);
    await page.keyboard.press("Escape");
    await expect(maximize).toHaveAttribute("aria-label", "Maximize");
    await expect.poll(restoredHeight).toBe(Math.round(grown.height));

    // The agent's fullscreen placement uses the same maximize; moving it on drops it.
    await invokeCapability(
      page,
      "ui.view.move",
      { instanceId: alpha.instanceId, placement: "fullscreen" },
      "move-a-fullscreen",
    );
    await expect.poll(coversDock).toBe(true);
    await expect(page.getByText("First document.")).toBeVisible();
    await shot(page, "05j-alpha-fullscreen");
    await invokeCapability(
      page,
      "ui.view.move",
      { instanceId: alpha.instanceId, placement: "bottom" },
      "move-a-bottom-again",
    );
    await expect(maximizedFrame).toHaveCount(0);
    await expect.poll(viewField(page, alpha.instanceId, "region")).toBe("bottom");
    await expect.poll(viewField(page, alpha.instanceId, "placement")).toBe("bottom");

    // Float by drag: mid-drag a "Drop here to float" pill appears; dropping on it floats the tab.
    const floatFrom = await requireBox(alphaTab);
    await page.mouse.move(floatFrom.x + floatFrom.width / 2, floatFrom.y + floatFrom.height / 2);
    await page.mouse.down();
    await page.mouse.move(floatFrom.x + floatFrom.width / 2 + 20, floatFrom.y - 30, { steps: 6 });
    const floatZone = page.getByTestId("session-dock-float-zone");
    await expect(floatZone).toBeVisible();
    const zone = await requireBox(floatZone);
    await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height / 2, { steps: 12 });
    await expect(floatZone).toHaveAttribute("data-over", "true");
    await expect(floatZone).toHaveCSS("opacity", "1");
    await expect(floatZone).not.toHaveCSS("background-color", "rgb(239, 236, 254)");
    evidence.push({
      step: "float-zone-hover",
      style: await floatZone.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          color: style.color,
          opacity: style.opacity,
          topmost: document
            .elementFromPoint(
              element.getBoundingClientRect().left + 20,
              element.getBoundingClientRect().top + 20,
            )
            ?.closest("[data-testid]")
            ?.getAttribute("data-testid"),
        };
      }),
    });
    await shot(page, "05k-float-zone");
    await page.mouse.up();
    await expect.poll(viewField(page, alpha.instanceId, "region")).toBe("floating");
    await expect(floatZone).toHaveCount(0);
    const floatingWindow = page.locator(".dv-resize-container").filter({ has: alphaTab });
    const floated = await requireBox(floatingWindow);
    // The window lands under the drop point, near the top of the dock.
    expect(floated.y - restartedDock.y).toBeLessThan(80);
    await shot(page, "05l-alpha-floated");

    // Its grip moves it; the move is a layout change the agent sees, not a redock.
    const grip = await requireBox(floatingWindow.locator(".dv-floating-titlebar"));
    await dragMouse(
      page,
      { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 },
      { x: grip.x + grip.width / 2 - 180, y: grip.y + grip.height / 2 + 140 },
    );
    const moved = await requireBox(floatingWindow);
    evidence.push({ step: "grip-move", floated, moved });
    expect(moved.y - floated.y).toBeGreaterThan(100);
    await expect.poll(viewField(page, alpha.instanceId, "region")).toBe("floating");

    // Its bottom-right corner resizes it; like a macOS window, the grab area sits just outside.
    const corner = { x: moved.x + moved.width + 6, y: moved.y + moved.height + 6 };
    const cornerTarget = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.className,
      [corner.x, corner.y],
    );
    expect(String(cornerTarget)).toContain("dv-resize-handle-bottomright");
    // Floating windows may span the whole dock, not just the chat column beside the side dock.
    expect(Math.round((await requireBox(page.locator(".dv-floating-overlay-host"))).width)).toBe(
      Math.round(restartedDock.width),
    );
    await dragMouse(page, corner, { x: corner.x + 120, y: corner.y + 80 });
    const resized = await requireBox(floatingWindow);
    evidence.push({ step: "corner-resize", moved, resized });
    expect(resized.width - moved.width).toBeGreaterThan(80);
    expect(resized.height - moved.height).toBeGreaterThan(50);
    await shot(page, "05m-alpha-resized");

    // Double-clicking a tab maximizes it; double-clicking again restores it.
    await relaunchedTabs.filter({ hasText: "dock-beta.md" }).dblclick();
    await expect.poll(coversDock).toBe(true);
    await relaunchedTabs.filter({ hasText: "dock-beta.md" }).dblclick();
    await expect(maximizedFrame).toHaveCount(0);
    await expect.poll(viewField(page, beta.instanceId, "region")).toBe("side");

    // Close a tab with its × and prove the view is gone for the agent too.
    await page
      .getByTestId("session-dock-tab")
      .filter({ hasText: "dock-beta.md" })
      .getByTestId("session-dock-tab-close")
      .click();
    await expect.poll(async () => (await layoutViews(page)).length).toBe(1);
    await shot(page, "06-beta-closed");
  } finally {
    fs.writeFileSync(path.join(evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2));
    await app.close();
  }
});
